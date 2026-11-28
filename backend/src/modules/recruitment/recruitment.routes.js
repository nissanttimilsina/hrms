import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import PDFDocument from 'pdfkit';
import { app, withTenant } from '../../database/index.js';
import { requirePermission, requireFeature } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { env } from '../../config/env.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate } from '../../services/hr/calendar.js';
import { longDate } from '../../services/letters.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { storage } from '../../services/storage.service.js';
import { getTenantContext, evaluateAccess, assertStorageAvailable, addUsage } from '../../services/subscription.service.js';
import { upload, checkUpload, sendFile, sniffOk } from '../../services/uploads.js';
import { EMP_ATTRS, empRef, scopesOf, isCompany, holds, nextNumber, userNames, like, getSetting, optText } from '../../services/module-kit.js';
import { createEmployee } from '../employees/employees.routes.js';
import { startJourney } from '../onboarding/onboarding.routes.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Recruitment: job openings, a public careers page per company, applications with CVs, a stage pipeline,
 * interviews with scorecards, offer letters, and hiring straight into an employee record (and onboarding).
 *   recruitment:view | create (openings, add candidates) | edit (move candidates, interviews) | approve (offers, hire)
 * Interviewers do not need recruitment rights: they see and score the interviews they are part of.
 */
export const recruitmentRouter = Router();
export const careersRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const JOB_STATUSES = ['DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED', 'FILLED'];
const STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];
const ACTIVE = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
const SOURCES = ['CAREERS', 'REFERRAL', 'JOB_PORTAL', 'SOCIAL', 'WALK_IN', 'AGENCY', 'OTHER'];
const EMPLOYMENT_TYPES = ['PERMANENT', 'CONTRACT', 'PROBATION', 'PART_TIME', 'INTERN', 'TEMPORARY'];
const num = (v) => (v == null ? null : Number(v));
const money = (n) => `NPR ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';

function jobView(j, extra = {}) {
  return {
    id: j.id, key: `JOB-${j.number}`, slug: j.slug, title: j.title, departmentId: j.departmentId, department: j.department?.name ?? null,
    branchId: j.branchId, branch: j.branch?.name ?? null, designationId: j.designationId, designation: j.designation?.name ?? null,
    employmentType: j.employmentType, location: j.location, positions: j.positions, description: j.description, requirements: j.requirements,
    salaryMin: num(j.salaryMin), salaryMax: num(j.salaryMax), showSalary: j.showSalary, status: j.status, published: j.published,
    closesOn: j.closesOn, hiringManager: j.hiringManager ? empRef(j.hiringManager) : null, hiringManagerId: j.hiringManagerId,
    openedAt: j.openedAt, closedAt: j.closedAt, createdAt: j.createdAt, ...extra,
  };
}
function candView(c, extra = {}) {
  return {
    id: c.id, key: `CAN-${c.number}`, jobId: c.jobId, job: c.job ? { id: c.job.id, title: c.job.title, key: `JOB-${c.job.number}` } : undefined,
    name: `${c.firstName} ${c.lastName}`, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, currentTitle: c.currentTitle,
    experienceYears: num(c.experienceYears), expectedSalary: num(c.expectedSalary), noticeDays: c.noticeDays, source: c.source, coverNote: c.coverNote,
    hasCv: !!c.cvFileId, stage: c.stage, rating: c.rating, offer: c.offer, rejectReason: c.rejectReason, employeeId: c.employeeId,
    stageChangedAt: c.stageChangedAt, createdAt: c.createdAt, ...extra,
  };
}
const JOB_INCLUDE = [
  { model: app.Department, as: 'department', attributes: ['name'] }, { model: app.Branch, as: 'branch', attributes: ['name'] },
  { model: app.Designation, as: 'designation', attributes: ['name'] }, { model: app.Employee, as: 'hiringManager', attributes: EMP_ATTRS },
];
const event = (req, t, candidateId, type, data = {}) => app.CandidateEvent.create({ tenantId: req.auth?.tenantId ?? t.tenantId, candidateId, type, data, authorId: req.auth?.userId ?? null }, { transaction: t });
const recruiters = (t) => usersWithPermission(t, 'recruitment:edit');

// =========================================================================== job openings
const optNum = (max, int = false) => z.preprocess((v) => (v === '' || v == null ? undefined : v), (int ? z.coerce.number().int() : z.coerce.number()).min(0).max(max).optional());
const jobFields = {
  title: z.string().trim().min(3, 'Give the job a title').max(120),
  departmentId: z.string().uuid().nullish(), branchId: z.string().uuid().nullish(), designationId: z.string().uuid().nullish(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('PERMANENT'), location: optText(z, 120),
  positions: z.number().int().min(1).max(500).default(1),
  description: z.string().trim().min(20, 'Describe the role in at least a few sentences').max(8000),
  requirements: optText(z, 4000),
  salaryMin: z.number().min(0).max(1e9).nullish(), salaryMax: z.number().min(0).max(1e9).nullish(), showSalary: z.boolean().default(false),
  published: z.boolean().default(true), closesOn: z.string().date().nullish(), hiringManagerId: z.string().uuid().nullish(),
};
const jobBody = z.object(jobFields).strict().refine((b) => b.salaryMin == null || b.salaryMax == null || b.salaryMax >= b.salaryMin, { message: 'The maximum salary is below the minimum', path: ['salaryMax'] });
const jobPatch = z.object({
  ...jobFields, employmentType: z.enum(EMPLOYMENT_TYPES), positions: z.number().int().min(1).max(500), showSalary: z.boolean(), published: z.boolean(),
}).partial().strict();

recruitmentRouter.get('/jobs', requirePermission('recruitment:view'), validate({ query: z.object({ status: z.enum(JOB_STATUSES).optional(), search: z.string().trim().max(100).optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const where = { ...(req.query.status && { status: req.query.status }), ...(req.query.search && { title: { [Op.iLike]: like(req.query.search) } }) };
    const jobs = await app.JobOpening.findAll({ where, include: JOB_INCLUDE, order: [['status', 'ASC'], ['createdAt', 'DESC']], transaction: t });
    const counts = await app.Candidate.findAll({ attributes: ['jobId', 'stage', [app.Candidate.sequelize.fn('count', '*'), 'n']], group: ['jobId', 'stage'], raw: true, transaction: t });
    return jobs.map((j) => {
      const by = Object.fromEntries(STAGES.map((s) => [s, 0]));
      counts.filter((c) => c.jobId === j.id).forEach((c) => { by[c.stage] = Number(c.n); });
      return jobView(j, { pipeline: by, active: ACTIVE.reduce((n, s) => n + by[s], 0), hired: by.HIRED });
    });
  });
  return ok(res, out);
}));

async function uniqueSlug(t, title, exceptId) {
  const base = slugify(title);
  for (let i = 0; i < 50; i += 1) {
    const slug = i ? `${base}-${i + 1}` : base;
    if (!(await app.JobOpening.count({ where: { slug, ...(exceptId && { id: { [Op.ne]: exceptId } }) }, transaction: t }))) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

recruitmentRouter.post('/jobs', requirePermission('recruitment:create'), validate({ body: jobBody }), asyncHandler(async (req, res) => {
  const j = await req.tx(async (t) => {
    const row = await app.JobOpening.create({ ...req.body, tenantId: req.auth.tenantId, number: await nextNumber(t, 'job_openings'), slug: await uniqueSlug(t, req.body.title), status: 'DRAFT', createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.job_create', entityType: 'job_opening', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, jobView(j));
}));

recruitmentRouter.patch('/jobs/:id', requirePermission('recruitment:create'), validate({ ...idParam, body: jobPatch }), asyncHandler(async (req, res) => {
  const j = await req.tx(async (t) => {
    const row = await app.JobOpening.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Job opening');
    const next = { ...row.toJSON(), ...req.body };
    if (next.salaryMin != null && next.salaryMax != null && Number(next.salaryMax) < Number(next.salaryMin)) throw BadRequest('The maximum salary is below the minimum', [{ path: 'salaryMax', message: 'Below the minimum' }]);
    const before = row.toJSON();
    await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.job_update', entityType: 'job_opening', entityId: row.id, before: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k]])), after: req.body, req });
    return row;
  });
  return ok(res, jobView(j));
}));

recruitmentRouter.post('/jobs/:id/status', requirePermission('recruitment:create'), validate({ ...idParam, body: z.object({ status: z.enum(['OPEN', 'ON_HOLD', 'CLOSED', 'FILLED']) }).strict() }), asyncHandler(async (req, res) => {
  const j = await req.tx(async (t) => {
    const row = await app.JobOpening.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Job opening');
    if (row.status === req.body.status) throw Conflict(`The opening is already ${row.status.replace('_', ' ').toLowerCase()}.`);
    const s = req.body.status;
    await row.update({ status: s, ...(s === 'OPEN' && !row.openedAt && { openedAt: new Date() }), ...(['CLOSED', 'FILLED'].includes(s) ? { closedAt: new Date() } : { closedAt: null }) }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.job_status', entityType: 'job_opening', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, jobView(j));
}));

recruitmentRouter.get('/jobs/:id', requirePermission('recruitment:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const j = await app.JobOpening.findByPk(req.params.id, { include: JOB_INCLUDE, transaction: t });
    if (!j) throw NotFound('Job opening');
    const cands = await app.Candidate.findAll({ where: { jobId: j.id }, order: [['stageChangedAt', 'DESC']], transaction: t });
    return jobView(j, {
      candidates: cands.map((c) => candView(c)),
      careersUrl: `https://${req.auth.ctx.tenant.slug}.${env.ROOT_DOMAIN}/careers/${j.slug}`,
      abilities: { edit: holds(req, 'recruitment:create'), move: holds(req, 'recruitment:edit') },
    });
  });
  return ok(res, out);
}));

// =========================================================================== candidates
const candQ = z.object({
  jobId: z.string().uuid().optional(), stage: z.enum(STAGES).optional(), active: z.coerce.boolean().optional(), search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
recruitmentRouter.get('/candidates', requirePermission('recruitment:view'), validate({ query: candQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const out = await req.tx(async (t) => {
    const and = [];
    if (q.jobId) and.push({ jobId: q.jobId });
    if (q.stage) and.push({ stage: q.stage });
    if (q.active) and.push({ stage: ACTIVE });
    if (q.search) {
      const s = like(q.search);
      and.push({ [Op.or]: [{ firstName: { [Op.iLike]: s } }, { lastName: { [Op.iLike]: s } }, { email: { [Op.iLike]: s } }, { phone: { [Op.iLike]: s } }, { currentTitle: { [Op.iLike]: s } }] });
    }
    const { rows, count } = await app.Candidate.findAndCountAll({ where: and.length ? { [Op.and]: and } : {}, include: [{ model: app.JobOpening, as: 'job', attributes: ['id', 'title', 'number'] }], order: [['createdAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, transaction: t });
    return { rows: rows.map((c) => candView(c)), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

const candFields = {
  firstName: z.string().trim().min(1, 'Enter the first name').max(80), lastName: z.string().trim().min(1, 'Enter the last name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254), phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number').nullish().or(z.literal('').transform(() => null)),
  currentTitle: optText(z, 120), experienceYears: optNum(60), expectedSalary: optNum(1e9), noticeDays: optNum(365, true), coverNote: optText(z, 3000),
};
const emptyToUndef = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? undefined : v]));

async function createCandidate({ t, tenantId, job, data, file, source, createdBy, referredBy, consent }) {
  const dup = await app.Candidate.findOne({ where: { jobId: job.id, email: { [Op.iLike]: data.email }, stage: { [Op.notIn]: ['REJECTED', 'WITHDRAWN'] } }, transaction: t });
  if (dup) throw Conflict(createdBy ? `${dup.firstName} ${dup.lastName} has already applied for this job (CAN-${dup.number}).` : 'You have already applied for this job. We will be in touch.', 'ALREADY_APPLIED');
  const id = crypto.randomUUID();
  let cvFileId = null;
  if (file) {
    const fid = crypto.randomUUID();
    const key = `tenants/${tenantId}/cvs/${fid}`;
    await storage.put(key, file.buffer, file.mimetype);
    await app.File.create({
      id: fid, tenantId, ownerType: 'CANDIDATE_CV', ownerId: id, storageKey: key, filename: file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'cv.pdf',
      mimeType: file.mimetype, sizeBytes: file.size, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), category: 'CV', uploadedBy: createdBy ?? null,
    }, { transaction: t });
    await addUsage(tenantId, 'storage_bytes', file.size, t);
    cvFileId = fid;
  }
  const c = await app.Candidate.create({
    id, tenantId, number: await nextNumber(t, 'candidates'), jobId: job.id, ...data, cvFileId, source, referredBy: referredBy ?? null,
    stage: 'APPLIED', stageChangedAt: new Date(), consentAt: consent ? new Date() : null, createdBy: createdBy ?? null,
  }, { transaction: t });
  await app.CandidateEvent.create({ tenantId, candidateId: id, type: 'APPLIED', data: { source, job: job.title }, authorId: createdBy ?? null }, { transaction: t });
  const who = `${data.firstName} ${data.lastName}`;
  const managerUser = job.hiringManagerId ? await userIdForEmployee(t, job.hiringManagerId) : null;
  await notifyUsers(t, [...(await recruiters(t)), managerUser].filter((u) => u && u !== createdBy), { type: 'recruitment.applied', title: `New applicant for ${job.title}`, body: `${who}${data.currentTitle ? ` · ${data.currentTitle}` : ''}`, link: `/recruitment/candidates/${id}` });
  return c;
}

recruitmentRouter.post('/candidates', requirePermission('recruitment:create'), upload.single('cv'), validate({
  body: z.object({ jobId: z.string().uuid(), source: z.enum(SOURCES).default('OTHER'), ...candFields }).strict(),
}), asyncHandler(async (req, res) => {
  if (req.file) checkUpload(req.file, 'cv');
  const c = await req.tx(async (t) => {
    const job = await app.JobOpening.findByPk(req.body.jobId, { transaction: t });
    if (!job) throw BadRequest('Choose a job opening', [{ path: 'jobId', message: 'Not found' }]);
    if (req.file) await assertStorageAvailable(req.auth.ctx, req.file.size, t);
    const { jobId, source, ...data } = req.body;
    const row = await createCandidate({ t, tenantId: req.auth.tenantId, job, data, file: req.file, source, createdBy: req.auth.userId, consent: false });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.candidate_add', entityType: 'candidate', entityId: row.id, after: { jobId, source, name: `${data.firstName} ${data.lastName}` }, req });
    return row;
  });
  return created(res, candView(c));
}));

async function loadCandidate(t, id, { lock = false } = {}) {
  const c = await app.Candidate.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!c) throw NotFound('Candidate');
  c.job = await app.JobOpening.findByPk(c.jobId, { transaction: t });
  return c;
}

recruitmentRouter.get('/candidates/:id', requirePermission('recruitment:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadCandidate(t, req.params.id);
    const events = await app.CandidateEvent.findAll({ where: { candidateId: c.id }, order: [['createdAt', 'DESC']], transaction: t });
    const interviews = await app.Interview.findAll({ where: { candidateId: c.id }, include: [{ model: app.InterviewFeedback, as: 'feedback' }], order: [['scheduledAt', 'ASC']], transaction: t });
    const names = await userNames(t, [...events.map((e) => e.authorId), ...interviews.flatMap((i) => [...i.interviewerIds, ...i.feedback.map((f) => f.authorId)])]);
    const others = await app.Candidate.findAll({ where: { email: { [Op.iLike]: c.email }, id: { [Op.ne]: c.id } }, include: [{ model: app.JobOpening, as: 'job', attributes: ['id', 'title', 'number'] }], transaction: t });
    return candView(c, {
      timeline: events.map((e) => ({ id: e.id, type: e.type, data: e.data, at: e.createdAt, by: names[e.authorId] ?? null })),
      interviews: interviews.map((i) => interviewView(i, names)),
      otherApplications: others.map((o) => ({ id: o.id, job: o.job?.title, stage: o.stage, createdAt: o.createdAt })),
      abilities: {
        move: holds(req, 'recruitment:edit') && ACTIVE.includes(c.stage),
        interview: holds(req, 'recruitment:edit') && ACTIVE.includes(c.stage),
        offer: holds(req, 'recruitment:approve') && ['INTERVIEW', 'OFFER', 'SCREENING'].includes(c.stage),
        hire: holds(req, 'recruitment:approve') && holds(req, 'employees:create') && c.stage === 'OFFER',
        startOnboarding: req.auth.ctx.features.includes('onboarding') && isCompany(scopesOf(req, 'onboarding:manage')),
      },
    });
  });
  return ok(res, out);
}));

recruitmentRouter.get('/candidates/:id/cv', requirePermission('recruitment:view'), validate(idParam), asyncHandler(async (req, res) => {
  const file = await req.tx(async (t) => {
    const c = await app.Candidate.findByPk(req.params.id, { transaction: t });
    if (!c?.cvFileId) throw NotFound('CV');
    return app.File.findByPk(c.cvFileId, { transaction: t });
  });
  if (!file) throw NotFound('CV');
  return sendFile(res, file);
}));

recruitmentRouter.patch('/candidates/:id', requirePermission('recruitment:edit'), validate({ ...idParam, body: z.object({ ...candFields, rating: z.number().int().min(1).max(5).nullable() }).partial().strict() }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await loadCandidate(t, req.params.id, { lock: true });
    await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.candidate_update', entityType: 'candidate', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, candView(c));
}));

recruitmentRouter.post('/candidates/:id/notes', requirePermission('recruitment:view'), validate({ ...idParam, body: z.object({ note: z.string().trim().min(1).max(3000) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const c = await loadCandidate(t, req.params.id);
    await event(req, t, c.id, 'NOTE', { note: req.body.note });
  });
  return created(res, { added: true });
}));

const stageBody = z.object({
  stage: z.enum(['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN']),
  reason: optText(z, 500), note: optText(z, 1000), notifyCandidate: z.boolean().default(false),
}).strict();

recruitmentRouter.post('/candidates/:id/stage', requirePermission('recruitment:edit'), validate({ ...idParam, body: stageBody }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await loadCandidate(t, req.params.id, { lock: true });
    const b = req.body;
    if (!ACTIVE.includes(row.stage)) throw Conflict(`This candidate is ${row.stage.toLowerCase()}. Their application is closed.`, 'CLOSED');
    if (row.stage === b.stage) throw Conflict('The candidate is already at that stage.');
    if (b.stage === 'REJECTED' && !b.reason) throw BadRequest('Give a reason (for your records; it is not sent to the candidate)', [{ path: 'reason', message: 'Required' }]);
    if (b.stage === 'OFFER') throw BadRequest('Use "Make an offer" to move a candidate to the offer stage.');
    const from = row.stage;
    await row.update({ stage: b.stage, stageChangedAt: new Date(), ...(b.stage === 'REJECTED' && { rejectReason: b.reason }) }, { transaction: t });
    await event(req, t, row.id, 'STAGE', { from, to: b.stage, reason: b.reason, note: b.note });
    if (b.stage === 'REJECTED' && b.notifyCandidate) {
      const company = req.auth.ctx.tenant.name;
      t.afterCommit(() => enqueueEmail({ tenantId: req.auth.tenantId, to: row.email, template: 'notification.generic', data: {
        title: `Your application for ${row.job.title}`, body: `Dear ${row.firstName}, thank you for your interest in ${row.job.title} at ${company}. After careful review we will not be moving forward with your application this time. We will keep your details on file and wish you every success.`,
      } }));
      await event(req, t, row.id, 'EMAIL', { subject: 'Application outcome', kind: 'REJECTION' });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.stage', entityType: 'candidate', entityId: row.id, before: { stage: from }, after: b, req });
    return row;
  });
  return ok(res, candView(c));
}));

// =========================================================================== interviews and scorecards
function interviewView(i, names = {}, extra = {}) {
  return {
    id: i.id, candidateId: i.candidateId, round: i.round, scheduledAt: i.scheduledAt, durationMinutes: i.durationMinutes, mode: i.mode, location: i.location, status: i.status,
    interviewers: i.interviewerIds.map((u) => ({ id: u, name: names[u] ?? 'Former user' })),
    feedback: (i.feedback ?? []).map((f) => ({ authorId: f.authorId, by: names[f.authorId] ?? null, rating: f.rating, recommendation: f.recommendation, scores: f.scores, notes: f.notes, at: f.updatedAt })),
    ...extra,
  };
}

const interviewBody = z.object({
  round: z.string().trim().min(2).max(80), scheduledAt: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(10).max(480).default(45),
  mode: z.enum(['IN_PERSON', 'PHONE', 'VIDEO']).default('IN_PERSON'), location: optText(z, 300),
  interviewerIds: z.array(z.string().uuid()).min(1, 'Choose at least one interviewer').max(10), notifyCandidate: z.boolean().default(true),
}).strict();

recruitmentRouter.post('/candidates/:id/interviews', requirePermission('recruitment:edit'), validate({ ...idParam, body: interviewBody }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadCandidate(t, req.params.id, { lock: true });
    if (!ACTIVE.includes(c.stage)) throw Conflict('This application is closed.', 'CLOSED');
    const { notifyCandidate, ...b } = req.body;
    const users = await app.User.findAll({ where: { id: b.interviewerIds, status: 'ACTIVE' }, attributes: ['id'], transaction: t });
    if (users.length !== new Set(b.interviewerIds).size) throw BadRequest('Choose interviewers who have an active login', [{ path: 'interviewerIds', message: 'Not found' }]);
    const i = await app.Interview.create({ ...b, interviewerIds: [...new Set(b.interviewerIds)], tenantId: req.auth.tenantId, candidateId: c.id, status: 'SCHEDULED', createdBy: req.auth.userId }, { transaction: t });
    if (['APPLIED', 'SCREENING'].includes(c.stage)) {
      await event(req, t, c.id, 'STAGE', { from: c.stage, to: 'INTERVIEW' });
      await c.update({ stage: 'INTERVIEW', stageChangedAt: new Date() }, { transaction: t });
    }
    const when = new Date(b.scheduledAt).toLocaleString('en-GB', { timeZone: req.auth.ctx.tenant.timezone, dateStyle: 'medium', timeStyle: 'short' });
    await event(req, t, c.id, 'INTERVIEW', { round: b.round, scheduledAt: b.scheduledAt, mode: b.mode });
    await notifyUsers(t, i.interviewerIds, { type: 'recruitment.interview', title: `Interview: ${c.firstName} ${c.lastName} for ${c.job.title}`, body: `${b.round} · ${when}${b.location ? ` · ${b.location}` : ''}`, link: `/interviews/${i.id}`, email: true });
    if (notifyCandidate) {
      const mode = { IN_PERSON: 'in person', PHONE: 'by phone', VIDEO: 'by video call' }[b.mode];
      t.afterCommit(() => enqueueEmail({ tenantId: req.auth.tenantId, to: c.email, template: 'notification.generic', data: {
        title: `Interview for ${c.job.title} at ${req.auth.ctx.tenant.name}`,
        body: `Dear ${c.firstName}, we would like to invite you to an interview (${b.round}) ${mode} on ${when} (Nepal time)${b.location ? ` at ${b.location}` : ''}. It will take about ${b.durationMinutes} minutes. Please reply to confirm.`,
      } }));
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.interview_schedule', entityType: 'candidate', entityId: c.id, after: b, req });
    return i;
  });
  return created(res, interviewView(out));
}));

/** Interviews: the ones I take part in (any login), or all (recruiters). Gated only by the recruitment module. */
recruitmentRouter.get('/interviews', requireFeature('recruitment'), validate({ query: z.object({ scope: z.enum(['mine', 'all']).default('mine'), upcoming: z.stringbool().default(true) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const all = req.query.scope === 'all' && holds(req, 'recruitment:view');
    const where = { ...(!all && { interviewerIds: { [Op.contains]: [req.auth.userId] } }), ...(req.query.upcoming && { scheduledAt: { [Op.gte]: new Date(Date.now() - 12 * 3600_000) }, status: 'SCHEDULED' }) };
    const rows = await app.Interview.findAll({ where, include: [{ model: app.Candidate, as: 'candidate', include: [{ model: app.JobOpening, as: 'job', attributes: ['id', 'title', 'number'] }] }, { model: app.InterviewFeedback, as: 'feedback' }], order: [['scheduledAt', req.query.upcoming ? 'ASC' : 'DESC']], limit: 100, transaction: t });
    const names = await userNames(t, rows.flatMap((i) => i.interviewerIds));
    return rows.map((i) => interviewView(i, names, { candidate: { id: i.candidate.id, name: `${i.candidate.firstName} ${i.candidate.lastName}`, job: i.candidate.job?.title }, myFeedback: i.feedback.some((f) => f.authorId === req.auth.userId) }));
  });
  return ok(res, out);
}));

async function loadInterviewFor(req, t, id) {
  const i = await app.Interview.findByPk(id, { include: [{ model: app.InterviewFeedback, as: 'feedback' }], transaction: t });
  if (!i) throw NotFound('Interview');
  const mine = i.interviewerIds.includes(req.auth.userId);
  if (!mine && !holds(req, 'recruitment:view')) throw NotFound('Interview');
  return { i, mine };
}

recruitmentRouter.get('/interviews/:id', requireFeature('recruitment'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { i, mine } = await loadInterviewFor(req, t, req.params.id);
    const c = await loadCandidate(t, i.candidateId);
    const names = await userNames(t, [...i.interviewerIds, ...i.feedback.map((f) => f.authorId)]);
    const recruiter = holds(req, 'recruitment:view');
    // Interviewers see their own scorecard only until they submit, so scores stay independent.
    const submitted = i.feedback.some((f) => f.authorId === req.auth.userId);
    if (!recruiter && !submitted) i.feedback = i.feedback.filter((f) => f.authorId === req.auth.userId);
    return interviewView(i, names, {
      candidate: { ...candView(c), coverNote: c.coverNote },
      canGiveFeedback: (mine || holds(req, 'recruitment:edit')) && i.status !== 'CANCELLED',
      mine: (() => { const f = i.feedback.find((x) => x.authorId === req.auth.userId); return f ? { rating: f.rating, recommendation: f.recommendation, scores: f.scores, notes: f.notes } : null; })(),
      canManage: holds(req, 'recruitment:edit'),
    });
  });
  return ok(res, out);
}));

recruitmentRouter.get('/interviews/:id/cv', requireFeature('recruitment'), validate(idParam), asyncHandler(async (req, res) => {
  const file = await req.tx(async (t) => {
    const { i } = await loadInterviewFor(req, t, req.params.id);
    const c = await app.Candidate.findByPk(i.candidateId, { transaction: t });
    return c?.cvFileId ? app.File.findByPk(c.cvFileId, { transaction: t }) : null;
  });
  if (!file) throw NotFound('CV');
  return sendFile(res, file);
}));

recruitmentRouter.put('/interviews/:id/feedback', requireFeature('recruitment'), validate({ ...idParam, body: z.object({
  rating: z.number().int().min(1).max(5), recommendation: z.enum(['STRONG_YES', 'YES', 'NO', 'STRONG_NO']),
  scores: z.partialRecord(z.enum(['skills', 'experience', 'communication', 'attitude', 'culture']), z.number().int().min(1).max(5)).default({}),
  notes: optText(z, 3000),
}).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { i, mine } = await loadInterviewFor(req, t, req.params.id);
    if (!mine && !holds(req, 'recruitment:edit')) throw Forbidden('Only the interviewers can score this interview.');
    if (i.status === 'CANCELLED') throw Conflict('This interview was cancelled.');
    const existing = await app.InterviewFeedback.findOne({ where: { interviewId: i.id, authorId: req.auth.userId }, transaction: t });
    if (existing) await existing.update(req.body, { transaction: t });
    else await app.InterviewFeedback.create({ ...req.body, tenantId: req.auth.tenantId, interviewId: i.id, authorId: req.auth.userId }, { transaction: t });
    if (i.status === 'SCHEDULED' && new Date(i.scheduledAt) <= new Date()) await i.update({ status: 'DONE' }, { transaction: t });
    await event(req, t, i.candidateId, 'FEEDBACK', { round: i.round, rating: req.body.rating, recommendation: req.body.recommendation });
    const c = await app.Candidate.findByPk(i.candidateId, { transaction: t });
    await notifyUsers(t, (await recruiters(t)).filter((u) => u !== req.auth.userId), { type: 'recruitment.feedback', title: `Scorecard for ${c.firstName} ${c.lastName}`, body: `${i.round}: ${req.body.rating}/5, ${req.body.recommendation.replace('_', ' ').toLowerCase()}`, link: `/recruitment/candidates/${c.id}` });
  });
  return ok(res, { saved: true });
}));

recruitmentRouter.post('/interviews/:id/status', requirePermission('recruitment:edit'), validate({ ...idParam, body: z.object({ status: z.enum(['DONE', 'CANCELLED']), note: optText(z, 500) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const i = await app.Interview.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!i) throw NotFound('Interview');
    await i.update({ status: req.body.status }, { transaction: t });
    await event(req, t, i.candidateId, 'INTERVIEW', { round: i.round, status: req.body.status, note: req.body.note });
    if (req.body.status === 'CANCELLED') await notifyUsers(t, i.interviewerIds.filter((u) => u !== req.auth.userId), { type: 'recruitment.interview', title: `Interview cancelled: ${i.round}`, body: req.body.note, link: `/interviews/${i.id}` });
  });
  return ok(res, { status: req.body.status });
}));

// =========================================================================== offers and hiring
const offerBody = z.object({
  salary: z.number().positive('Enter the monthly salary').max(1e9), joiningDate: z.string().date(), designationId: z.string().uuid().nullish(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('PERMANENT'), probationMonths: z.number().int().min(0).max(12).default(0),
  expiresOn: z.string().date(), terms: optText(z, 2000),
}).strict();

recruitmentRouter.post('/candidates/:id/offer', requirePermission('recruitment:approve'), validate({ ...idParam, body: offerBody }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await loadCandidate(t, req.params.id, { lock: true });
    if (!ACTIVE.includes(row.stage)) throw Conflict('This application is closed.', 'CLOSED');
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    if (req.body.expiresOn < today) throw BadRequest('The offer would already have expired', [{ path: 'expiresOn', message: 'In the past' }]);
    if (req.body.joiningDate < today) throw BadRequest('The joining date is in the past', [{ path: 'joiningDate', message: 'In the past' }]);
    const designation = req.body.designationId ? await app.Designation.findByPk(req.body.designationId, { transaction: t }) : row.job.designationId ? await app.Designation.findByPk(row.job.designationId, { transaction: t }) : null;
    const offer = { ...req.body, designationId: designation?.id ?? null, designation: designation?.name ?? row.job.title, issuedOn: today, sentAt: new Date().toISOString(), status: 'SENT', reference: `OFR/${today.slice(0, 4)}/${String(row.number).padStart(4, '0')}` };
    const from = row.stage;
    await row.update({ stage: 'OFFER', stageChangedAt: new Date(), offer }, { transaction: t });
    await event(req, t, row.id, 'OFFER', { salary: offer.salary, joiningDate: offer.joiningDate, from });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.offer', entityType: 'candidate', entityId: row.id, after: offer, req });
    return row;
  });
  return ok(res, candView(c));
}));

recruitmentRouter.post('/candidates/:id/offer/response', requirePermission('recruitment:approve'), validate({ ...idParam, body: z.object({ accepted: z.boolean(), note: optText(z, 500) }).strict() }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await loadCandidate(t, req.params.id, { lock: true });
    if (row.stage !== 'OFFER' || !row.offer) throw Conflict('There is no open offer for this candidate.');
    const offer = { ...row.offer, status: req.body.accepted ? 'ACCEPTED' : 'DECLINED', respondedAt: new Date().toISOString(), responseNote: req.body.note };
    await row.update({ offer, ...(!req.body.accepted && { stage: 'WITHDRAWN', stageChangedAt: new Date(), rejectReason: req.body.note ?? 'Declined the offer' }) }, { transaction: t });
    await event(req, t, row.id, 'OFFER', { status: offer.status, note: req.body.note });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.offer_response', entityType: 'candidate', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, candView(c));
}));

recruitmentRouter.get('/candidates/:id/offer.pdf', requirePermission('recruitment:approve'), validate(idParam), asyncHandler(async (req, res) => {
  const { c, head } = await req.tx(async (t) => ({ c: await loadCandidate(t, req.params.id), head: await getSetting(t, 'letters.letterhead', {}) }));
  if (!c.offer) throw NotFound('Offer');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="offer-letter-CAN-${c.number}.pdf"`, 'Cache-Control': 'private, no-store' });
  renderOfferPdf(res, { company: { name: req.auth.ctx.tenant.name, ...head }, candidate: c, job: c.job, offer: c.offer, color: req.auth.ctx.tenant.branding?.primaryColor });
}));

function renderOfferPdf(out, { company, candidate: c, job, offer: o, color }) {
  const brand = /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#1D4ED8';
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 60, left: 64, right: 64 }, info: { Title: `Offer of employment · ${o.reference}` } });
  doc.pipe(out);
  const L = 64; const W = doc.page.width - 128; const ink = '#0f1729'; const grey = '#64748b';
  const name = company.legalName || company.name;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(brand).text(name, L, 50, { width: W });
  doc.font('Helvetica').fontSize(9).fillColor(grey);
  [company.address, [company.phone, company.email, company.website].filter(Boolean).join('  ·  '), company.pan && `PAN ${company.pan}`].filter(Boolean).forEach((l) => doc.text(l, { width: W }));
  const y0 = doc.y + 8;
  doc.moveTo(L, y0).lineTo(L + W, y0).lineWidth(1.2).strokeColor(brand).stroke();
  doc.fontSize(10).fillColor(ink).text(`Ref: ${o.reference}`, L, y0 + 14);
  doc.text(`Date: ${longDate(o.issuedOn)}`, L, y0 + 14, { width: W, align: 'right' });
  doc.moveDown(2).font('Helvetica').fontSize(11).text(`${c.firstName} ${c.lastName}`, L).fillColor(grey).text(c.email, L).fillColor(ink).moveDown();
  doc.font('Helvetica-Bold').text('Subject: Offer of employment', L, doc.y, { underline: true }).moveDown();
  const p = (s) => { doc.font('Helvetica').fontSize(11).fillColor(ink).text(s, L, doc.y, { width: W, align: 'justify', lineGap: 3 }); doc.moveDown(0.8); };
  p(`Dear ${c.firstName},`);
  p(`We are pleased to offer you the position of ${o.designation} at ${name}${job.location ? `, based in ${job.location}` : ''}. This offer follows your application and interviews with us.`);
  const rows = [
    ['Position', o.designation], ['Employment type', o.employmentType.replace('_', ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase())],
    ['Gross monthly salary', `${money(o.salary)} before statutory deductions`], ['Joining date', longDate(o.joiningDate)],
    ...(o.probationMonths ? [['Probation', `${o.probationMonths} month${o.probationMonths === 1 ? '' : 's'}`]] : []),
  ];
  rows.forEach(([k, v]) => { const y = doc.y; doc.font('Helvetica').fillColor(grey).text(k, L, y, { width: 170 }); doc.fillColor(ink).font('Helvetica-Bold').text(v, L + 180, y, { width: W - 180 }); doc.moveDown(0.4); });
  doc.moveDown(0.6);
  if (o.terms) p(o.terms);
  p('Income tax, social security fund contributions and other deductions required by Nepal law apply to your salary. Your employment will also be governed by the Labour Act 2074 and the company\'s policies.');
  p(`Please confirm your acceptance by signing and returning a copy of this letter by ${longDate(o.expiresOn)}. After that date this offer lapses.`);
  p('We look forward to welcoming you to the team.');
  doc.moveDown(0.4).text('Yours sincerely,', L);
  const sy = doc.y + 44;
  doc.moveTo(L, sy).lineTo(L + 180, sy).lineWidth(0.6).strokeColor('#94a3b8').stroke();
  doc.font('Helvetica-Bold').fillColor(ink).text(company.signatoryName || 'Authorised signatory', L, sy + 6);
  doc.font('Helvetica').fillColor(grey).fontSize(10);
  if (company.signatoryTitle) doc.text(company.signatoryTitle, L);
  doc.text(`For ${name}`, L);
  doc.moveTo(L + 290, sy).lineTo(L + W, sy).strokeColor('#94a3b8').stroke();
  doc.fillColor(grey).fontSize(9).text('Accepted by the candidate (signature and date)', L + 290, sy + 6, { width: W - 290 });
  doc.end();
}

const hireBody = z.object({
  joinedOn: z.string().date(), branchId: z.string().uuid(), departmentId: z.string().uuid().nullish(), designationId: z.string().uuid().nullish(),
  managerId: z.string().uuid().nullish(), employmentType: z.enum(EMPLOYMENT_TYPES).optional(), startOnboarding: z.boolean().default(true),
}).strict();

recruitmentRouter.post('/candidates/:id/hire', requirePermission('recruitment:approve'), validate({ ...idParam, body: hireBody }), asyncHandler(async (req, res) => {
  if (!holds(req, 'employees:create')) throw Forbidden('You also need permission to add employees.');
  const out = await req.tx(async (t) => {
    const c = await loadCandidate(t, req.params.id, { lock: true });
    if (c.stage !== 'OFFER') throw Conflict('Make an offer before hiring.', 'NO_OFFER');
    if (c.offer?.status === 'DECLINED') throw Conflict('The candidate declined the offer.');
    const b = req.body;
    const emp = await createEmployee(req, t, {
      firstName: c.firstName, lastName: c.lastName, personalEmail: c.email, phone: c.phone && /^\+?[0-9 -]{7,20}$/.test(c.phone) ? c.phone : null,
      branchId: b.branchId, departmentId: b.departmentId ?? c.job.departmentId ?? null, designationId: b.designationId ?? c.offer?.designationId ?? c.job.designationId ?? null,
      managerId: b.managerId ?? c.job.hiringManagerId ?? null, employmentType: b.employmentType ?? c.offer?.employmentType ?? c.job.employmentType ?? 'PERMANENT',
      joinedOn: b.joinedOn, status: 'ACTIVE',
    });
    await c.update({ stage: 'HIRED', stageChangedAt: new Date(), employeeId: emp.id, offer: { ...(c.offer ?? {}), status: 'ACCEPTED', respondedAt: c.offer?.respondedAt ?? new Date().toISOString() } }, { transaction: t });
    await event(req, t, c.id, 'HIRED', { employeeId: emp.id, employeeCode: emp.employeeCode, joinedOn: b.joinedOn });
    const hired = await app.Candidate.count({ where: { jobId: c.jobId, stage: 'HIRED' }, transaction: t });
    let jobFilled = false;
    if (hired >= c.job.positions && ['OPEN', 'ON_HOLD'].includes(c.job.status)) { await c.job.update({ status: 'FILLED', closedAt: new Date() }, { transaction: t }); jobFilled = true; }
    let journeyId = null;
    if (b.startOnboarding && req.auth.ctx.features.includes('onboarding') && isCompany(scopesOf(req, 'onboarding:manage'))) {
      journeyId = (await startJourney(req, t, { kind: 'ONBOARDING', employeeId: emp.id, startDate: b.joinedOn })).id;
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'recruitment.hire', entityType: 'candidate', entityId: c.id, after: { employeeId: emp.id, ...b }, req });
    return { employeeId: emp.id, employeeCode: emp.employeeCode, jobFilled, journeyId };
  });
  return ok(res, out);
}));

// =========================================================================== public careers page (company address, no sign-in)
const applyLimiter = rateLimit({ windowMs: 60 * 60_000, limit: env.isTest ? 1000 : 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many applications from this connection. Try again later.' } } });

async function careersTenant(req) {
  if (!req.hostTenantId) throw NotFound('Careers page');
  const ctx = await getTenantContext(req.hostTenantId);
  if (!ctx || !ctx.features.includes('recruitment') || evaluateAccess(ctx).state === 'BLOCKED') throw NotFound('Careers page');
  return ctx;
}
const publicJob = (j) => ({
  slug: j.slug, title: j.title, department: j.department?.name ?? null, branch: j.branch?.name ?? null, location: j.location, employmentType: j.employmentType,
  positions: j.positions, description: j.description, requirements: j.requirements, closesOn: j.closesOn, postedOn: j.openedAt,
  salary: j.showSalary && (j.salaryMin != null || j.salaryMax != null) ? { min: num(j.salaryMin), max: num(j.salaryMax) } : null,
});
const openWhere = (today) => ({ status: 'OPEN', published: true, [Op.or]: [{ closesOn: null }, { closesOn: { [Op.gte]: today } }] });
const PUBLIC_INCLUDE = () => [{ model: app.Department, as: 'department', attributes: ['name'] }, { model: app.Branch, as: 'branch', attributes: ['name'] }];

careersRouter.get('/', asyncHandler(async (req, res) => {
  const ctx = await careersTenant(req);
  const today = localDate(new Date(), ctx.tenant.timezone);
  const jobs = await withTenant(ctx.tenant.id, (t) => app.JobOpening.findAll({ where: openWhere(today), include: PUBLIC_INCLUDE(), order: [['openedAt', 'DESC']], transaction: t }));
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, { company: ctx.tenant.name, jobs: jobs.map(publicJob) });
}));

careersRouter.get('/:slug', validate({ params: z.object({ slug: z.string().regex(/^[a-z0-9-]{3,90}$/) }) }), asyncHandler(async (req, res) => {
  const ctx = await careersTenant(req);
  const today = localDate(new Date(), ctx.tenant.timezone);
  const j = await withTenant(ctx.tenant.id, (t) => app.JobOpening.findOne({ where: { slug: req.params.slug, ...openWhere(today) }, include: PUBLIC_INCLUDE(), transaction: t }));
  if (!j) throw NotFound('Job');
  return ok(res, { company: ctx.tenant.name, job: publicJob(j) });
}));

careersRouter.post('/:slug/apply', applyLimiter, upload.single('cv'), validate({
  params: z.object({ slug: z.string().regex(/^[a-z0-9-]{3,90}$/) }),
  body: z.object({ ...candFields, consent: z.enum(['true']), website: z.string().max(200).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const ctx = await careersTenant(req);
  // Honeypot: real visitors never fill the hidden "website" field.
  if (req.body.website) return created(res, { received: true });
  if (!req.file) throw BadRequest('Attach your CV as a PDF', [{ path: 'cv', message: 'CV required' }]);
  if (req.file.mimetype !== 'application/pdf' || !sniffOk(req.file.buffer, 'application/pdf')) throw BadRequest('Attach your CV as a PDF file', [{ path: 'cv', message: 'Use a PDF file' }]);
  const today = localDate(new Date(), ctx.tenant.timezone);
  const { consent, website, ...data } = emptyToUndef(req.body);
  await withTenant(ctx.tenant.id, async (t) => {
    const job = await app.JobOpening.findOne({ where: { slug: req.params.slug, ...openWhere(today) }, transaction: t, lock: t.LOCK.SHARE });
    if (!job) throw NotFound('Job');
    await assertStorageAvailable(ctx, req.file.size, t);
    const c = await createCandidate({ t, tenantId: ctx.tenant.id, job, data, file: req.file, source: 'CAREERS', consent: true });
    await audit({ transaction: t, tenantId: ctx.tenant.id, actor: { type: 'SYSTEM' }, action: 'recruitment.apply', entityType: 'candidate', entityId: c.id, after: { job: job.title }, req });
    t.afterCommit(() => enqueueEmail({ tenantId: ctx.tenant.id, to: data.email, template: 'notification.generic', data: {
      title: `We received your application for ${job.title}`, body: `Dear ${data.firstName}, thank you for applying to ${ctx.tenant.name}. Our team will review your application and contact you if your profile matches the role.`,
    } }));
  });
  return created(res, { received: true });
}));
