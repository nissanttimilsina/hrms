import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import crypto from 'node:crypto';
import { app, appDb, withTenant } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { scopeWhere, recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, toBS } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { LETTER_TYPES, renderLetterPdf, longDate } from '../../services/letters.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * HR letters on request: an employee asks for a letter (employment, salary, experience, bank, no objection),
 * HR reviews and issues it, and the employee downloads a PDF on the company letterhead with a reference
 * number and a verification code that anyone can check at <company>.<domain>/verify/<code>.
 */
export const lettersRouter = Router();
export const letterVerifyRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const TYPES = Object.keys(LETTER_TYPES);
const EMP_ATTRS = ['id', 'firstName', 'lastName', 'employeeCode', 'managerId', 'departmentId', 'branchId'];

// --------------------------------------------------------------------------- letterhead settings
const DEFAULT_LETTERHEAD = { legalName: '', address: '', phone: '', email: '', website: '', pan: '', signatoryName: '', signatoryTitle: '', referencePrefix: 'LTR' };
async function getLetterhead(t) {
  const row = await app.TenantSetting.findOne({ where: { key: 'letters.letterhead' }, transaction: t });
  return { ...DEFAULT_LETTERHEAD, ...(row?.value ?? {}) };
}
const s = (max) => z.string().trim().max(max);
const letterheadBody = z.object({
  legalName: s(160), address: s(300), phone: s(60), email: z.union([z.literal(''), z.string().trim().email().max(120)]), website: s(120), pan: s(20),
  signatoryName: s(120), signatoryTitle: s(120), referencePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/, 'Use up to 12 letters, numbers or -'),
}).strict();

lettersRouter.get('/settings', requirePermission('letters:approve'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => getLetterhead(t)))));
lettersRouter.put('/settings', requirePermission('letters:configure'), validate({ body: letterheadBody }), asyncHandler(async (req, res) => {
  const value = await req.tx(async (t) => {
    const before = await getLetterhead(t);
    const [row] = await app.TenantSetting.findOrCreate({ where: { key: 'letters.letterhead' }, defaults: { tenantId: req.auth.tenantId, value: req.body }, transaction: t });
    await row.update({ value: req.body }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letters.letterhead_update', entityType: 'setting', entityId: 'letters.letterhead', before, after: req.body, req });
    return req.body;
  });
  return ok(res, value);
}));

lettersRouter.get('/types', requirePermission('letters:view'), (_req, res) => ok(res, TYPES.map((k) => ({ value: k, ...LETTER_TYPES[k] }))));

// --------------------------------------------------------------------------- helpers
function myEmployeeId(req) {
  if (!req.auth.principal.employeeId) throw BadRequest('Your account is not linked to an employee record. Ask HR to link it.', [{ path: 'employee', message: 'Not linked' }]);
  return req.auth.principal.employeeId;
}
const scopesOf = (req, key) => req.auth.grants.get(key)?.scopes ?? [];

function view(l, req) {
  const own = !!req.auth.principal.employeeId && l.employeeId === req.auth.principal.employeeId;
  const appr = scopesOf(req, 'letters:approve');
  const canDecide = !own && appr.length > 0 && !!l.employee && recordInScope(appr, req.auth.principal, l.employee);
  return {
    id: l.id, key: `L-${l.number}`, type: l.type, typeLabel: LETTER_TYPES[l.type].label, purpose: l.purpose, addressedTo: l.addressedTo, details: l.details,
    status: l.revokedAt ? 'REVOKED' : l.status, reference: l.reference, issuedAt: l.issuedAt, decidedAt: l.decidedAt, decisionNote: l.decisionNote,
    revokedAt: l.revokedAt, revokeReason: l.revokeReason, createdAt: l.createdAt,
    employee: l.employee ? { id: l.employee.id, name: `${l.employee.firstName} ${l.employee.lastName}`, code: l.employee.employeeCode } : undefined,
    abilities: {
      issue: canDecide && l.status === 'PENDING',
      reject: canDecide && l.status === 'PENDING',
      revoke: canDecide && l.status === 'ISSUED' && !l.revokedAt,
      cancel: own && l.status === 'PENDING',
      download: l.status === 'ISSUED' && (!l.revokedAt || !own),
    },
  };
}

async function loadLetter(req, t, id, scopes, { lock = false } = {}) {
  const l = await app.LetterRequest.findByPk(id, { include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!l) throw NotFound('Letter request');
  const own = l.employeeId === req.auth.principal.employeeId;
  if (!own && !(scopes.length && recordInScope(scopes, req.auth.principal, l.employee))) throw NotFound('Letter request');
  return l;
}

async function nextNumber(t) {
  await appDb.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `letter_requests:${t.tenantId}` }, transaction: t });
  const [{ n }] = await appDb.query('SELECT coalesce(max(number), 0) + 1 AS n FROM letter_requests', { type: QueryTypes.SELECT, transaction: t });
  return Number(n);
}

// No 0/O or 1/I, so codes are easy to read out and type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const verifyCode = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')).join('-');
const verifyUrl = (slug, code) => `${new URL(env.APP_URL).protocol}//${slug}.${env.ROOT_DOMAIN}/verify/${code}`;

async function hrUsers(t, exceptUserId) {
  return (await usersWithPermission(t, 'letters:approve')).filter((u) => u !== exceptUserId);
}

// --------------------------------------------------------------------------- list
lettersRouter.get('/', requirePermission('letters:view'), validate({ query: z.object({ view: z.enum(['mine', 'all']).default('mine'), status: z.enum(['PENDING', 'ISSUED', 'REJECTED', 'CANCELLED']).optional() }).strict() }), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const where = { ...(req.query.status && { status: req.query.status }) };
    if (req.query.view === 'mine') {
      if (!req.auth.principal.employeeId) return [];
      where.employeeId = req.auth.principal.employeeId;
    } else {
      const sw = scopeWhere(req.scopes, req.auth.principal);
      if (Object.keys(sw).length || Object.getOwnPropertySymbols(sw).length) {
        const ids = (await app.Employee.findAll({ where: sw, attributes: ['id'], raw: true, transaction: t })).map((e) => e.id);
        where.employeeId = ids;
      }
    }
    const list = await app.LetterRequest.findAll({ where, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], order: [['createdAt', 'DESC']], limit: 300, transaction: t });
    return list.map((l) => view(l, req));
  });
  return ok(res, rows);
}));

// --------------------------------------------------------------------------- request
const requestBody = z.object({
  type: z.enum(TYPES),
  purpose: z.string().trim().min(3, 'Say what the letter is for').max(300),
  addressedTo: z.string().trim().max(300).optional().transform((v) => v || null),
  details: z.string().trim().max(1000).optional().transform((v) => v || null),
}).strict().refine((b) => b.type !== 'BANK' || !!b.addressedTo, { message: 'Enter the bank name and branch the letter is for', path: ['addressedTo'] });

lettersRouter.post('/', requirePermission('letters:create'), validate({ body: requestBody }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const out = await req.tx(async (t) => {
    const pending = await app.LetterRequest.count({ where: { employeeId, type: req.body.type, status: 'PENDING' }, transaction: t });
    if (pending) throw Conflict(`You already have a pending request for a ${LETTER_TYPES[req.body.type].label.toLowerCase()}`, 'ALREADY_PENDING');
    const emp = await app.Employee.findByPk(employeeId, { attributes: EMP_ATTRS, transaction: t });
    const l = await app.LetterRequest.create({ tenantId: req.auth.tenantId, number: await nextNumber(t), employeeId, ...req.body, status: 'PENDING', requestedBy: req.auth.userId }, { transaction: t });
    await notifyUsers(t, await hrUsers(t, req.auth.userId), { type: 'letter.requested', title: `${LETTER_TYPES[l.type].label} requested`, body: `${emp.firstName} ${emp.lastName} · ${l.purpose}`, link: '/letters', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.request', entityType: 'letter_request', entityId: l.id, after: req.body, req });
    l.employee = emp;
    return view(l, req);
  });
  return created(res, out);
}));

lettersRouter.post('/:id/cancel', requirePermission('letters:create'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const l = await loadLetter(req, t, req.params.id, [], { lock: true });
    if (l.status !== 'PENDING') throw Conflict('Only pending requests can be cancelled', 'INVALID_STATE');
    await l.update({ status: 'CANCELLED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.cancel', entityType: 'letter_request', entityId: l.id, req });
    return view(l, req);
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- HR decisions
async function buildContent(req, t, l, body) {
  const tz = req.auth.ctx.tenant.timezone;
  const today = localDate(new Date(), tz);
  const e = await app.Employee.findByPk(l.employeeId, {
    include: [{ model: app.Designation, as: 'designation', attributes: ['name'] }, { model: app.Department, as: 'department', attributes: ['name'] }, { model: app.Branch, as: 'branch', attributes: ['name'] }], transaction: t,
  });
  const head = await getLetterhead(t);
  const tenant = await app.Tenant.findByPk(req.auth.tenantId, { attributes: ['name', 'legalName', 'slug'], transaction: t });
  let salary = null;
  if (['SALARY', 'BANK'].includes(l.type)) {
    const asOf = e.exitedOn && e.exitedOn < today ? e.exitedOn : today;
    const sal = await app.EmployeeSalary.findOne({ where: { employeeId: e.id, effectiveFrom: { [Op.lte]: asOf } }, order: [['effectiveFrom', 'DESC']], transaction: t });
    if (!sal) throw BadRequest(`Set ${e.firstName}'s salary in payroll before issuing this letter. It shows the monthly salary.`, [{ path: 'type', message: 'No salary on record' }]);
    const defs = await app.SalaryComponent.findAll({ transaction: t });
    const components = (sal.components ?? []).map((c) => ({ def: defs.find((d) => d.code === c.code), amount: Number(c.amount) }))
      .filter((c) => c.def && c.def.kind === 'EARNING' && c.amount > 0).map((c) => ({ name: c.def.name, amount: c.amount }));
    const basic = Number(sal.basic);
    salary = { basic, components, gross: Math.round((basic + components.reduce((n, c) => n + c.amount, 0)) * 100) / 100, effectiveFrom: sal.effectiveFrom };
  }
  const code = verifyCode();
  return {
    code,
    content: {
      type: l.type, purpose: l.purpose, addressedTo: l.addressedTo, extraParagraph: body.extraParagraph ?? null, issuedOn: today,
      company: { name: tenant.name, legalName: head.legalName || tenant.legalName || tenant.name, address: head.address, phone: head.phone, email: head.email, website: head.website, pan: head.pan },
      employee: {
        name: `${e.firstName} ${e.lastName}`, lastName: e.lastName, code: e.employeeCode, gender: e.gender, designation: e.designation?.name ?? null,
        department: e.department?.name ?? null, branch: e.branch?.name ?? null, joinedOn: e.joinedOn, exitedOn: e.exitedOn, employmentType: e.employmentType, contractEndOn: e.contractEndOn,
      },
      salary,
      bank: l.type === 'BANK' && e.bank?.bankName ? { bankName: e.bank.bankName, last4: e.bank.last4 ?? null } : null,
      signatory: { name: body.signatoryName || head.signatoryName || null, title: body.signatoryTitle || head.signatoryTitle || null },
      verifyCode: code, verifyUrl: verifyUrl(tenant.slug, code),
    },
    prefix: head.referencePrefix || 'LTR',
    bsYear: toBS(today).year,
  };
}

const issueBody = z.object({
  extraParagraph: z.string().trim().max(1500).optional().transform((v) => v || undefined),
  signatoryName: z.string().trim().max(120).optional(),
  signatoryTitle: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

lettersRouter.post('/:id/issue', requirePermission('letters:approve'), validate({ ...idParam, body: issueBody }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const l = await loadLetter(req, t, req.params.id, req.scopes, { lock: true });
    if (l.employeeId === req.auth.principal.employeeId) throw Forbidden('Someone else in HR must issue your own letter', 'SELF_APPROVAL');
    if (!recordInScope(req.scopes, req.auth.principal, l.employee)) throw NotFound('Letter request');
    if (l.status !== 'PENDING') throw Conflict(`This request is already ${l.status.toLowerCase()}`, 'INVALID_STATE');
    const { code, content, prefix, bsYear } = await buildContent(req, t, l, req.body);
    const reference = `${prefix}/${bsYear}/${String(l.number).padStart(4, '0')}`;
    content.reference = reference;
    await l.update({ status: 'ISSUED', decidedBy: req.auth.userId, decidedAt: new Date(), decisionNote: req.body.note ?? null, reference, verifyCode: code, content, issuedAt: new Date() }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, l.employeeId)], { type: 'letter.issued', title: `Your ${LETTER_TYPES[l.type].label.toLowerCase()} is ready`, body: `Reference ${reference}. Download it from My letters.`, link: '/me/letters', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.issue', entityType: 'letter_request', entityId: l.id, after: { reference, type: l.type }, req });
    return view(l, req);
  });
  return ok(res, out);
}));

lettersRouter.post('/:id/reject', requirePermission('letters:approve'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3, 'Give a reason the employee can act on').max(500) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const l = await loadLetter(req, t, req.params.id, req.scopes, { lock: true });
    if (l.employeeId === req.auth.principal.employeeId) throw Forbidden('Someone else in HR must decide on your own request', 'SELF_APPROVAL');
    if (!recordInScope(req.scopes, req.auth.principal, l.employee)) throw NotFound('Letter request');
    if (l.status !== 'PENDING') throw Conflict(`This request is already ${l.status.toLowerCase()}`, 'INVALID_STATE');
    await l.update({ status: 'REJECTED', decidedBy: req.auth.userId, decidedAt: new Date(), decisionNote: req.body.reason }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, l.employeeId)], { type: 'letter.rejected', title: `Letter request not approved`, body: req.body.reason, link: '/me/letters', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.reject', entityType: 'letter_request', entityId: l.id, after: req.body, req });
    return view(l, req);
  });
  return ok(res, out);
}));

lettersRouter.post('/:id/revoke', requirePermission('letters:approve'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const l = await loadLetter(req, t, req.params.id, req.scopes, { lock: true });
    if (!recordInScope(req.scopes, req.auth.principal, l.employee) || l.employeeId === req.auth.principal.employeeId) throw Forbidden('You cannot revoke this letter', 'FORBIDDEN');
    if (l.status !== 'ISSUED' || l.revokedAt) throw Conflict('Only issued letters can be revoked', 'INVALID_STATE');
    await l.update({ revokedAt: new Date(), revokeReason: req.body.reason }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.revoke', entityType: 'letter_request', entityId: l.id, after: req.body, req });
    return view(l, req);
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- PDF
lettersRouter.get('/:id/pdf', requirePermission('letters:view'), validate(idParam), asyncHandler(async (req, res) => {
  const { l, color } = await req.tx(async (t) => {
    const x = await loadLetter(req, t, req.params.id, req.scopes);
    if (x.status !== 'ISSUED') throw NotFound('Letter');
    if (x.revokedAt && x.employeeId === req.auth.principal.employeeId) throw Conflict('This letter was withdrawn by HR. Request a new one if you still need it.', 'REVOKED');
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'letter.download', entityType: 'letter_request', entityId: x.id, req });
    const branding = await app.TenantSetting.findOne({ where: { key: 'branding' }, transaction: t });
    return { l: x, color: branding?.value?.primaryColor };
  });
  const file = `${l.type.toLowerCase()}-letter-${l.reference.replace(/[^\w-]+/g, '-')}.pdf`;
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'private, no-store' });
  renderLetterPdf(res, l.content, { color: /^#[0-9a-fA-F]{6}$/.test(color ?? '') ? color : undefined });
}));

// --------------------------------------------------------------------------- public verification
/** Anyone holding a letter can check it on the company's address. Shows only what the letter itself states, never pay. */
letterVerifyRouter.get('/letters/:code', validate({ params: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/) }) }), asyncHandler(async (req, res) => {
  if (!req.hostTenantId) throw NotFound('Letter');
  const l = await withTenant(req.hostTenantId, (t) => app.LetterRequest.findOne({ where: { verifyCode: req.params.code, status: 'ISSUED' }, transaction: t }));
  if (!l) throw NotFound('Letter');
  const c = l.content;
  res.set('Cache-Control', 'no-store');
  return ok(res, {
    status: l.revokedAt ? 'REVOKED' : 'VALID', reference: l.reference, type: LETTER_TYPES[l.type].label, issuedOn: longDate(c.issuedOn),
    company: c.company.legalName || c.company.name, employee: c.employee.name, designation: c.employee.designation,
    ...(l.revokedAt && { revokedOn: longDate(localDate(new Date(l.revokedAt))) }),
  });
}));
