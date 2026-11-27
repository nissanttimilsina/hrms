import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import crypto from 'node:crypto';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate } from '../../services/hr/calendar.js';
import { notifyUsers, userIdForEmployee } from '../../services/hr/notify.js';
import { EMP_ATTRS, empRef, empName, scopesOf, isCompany, myEmployeeId, optText } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, NotFound } from '../../utils/errors.js';

/**
 * Employee engagement: pulse and engagement surveys (anonymous by default, with eNPS) and peer recognition.
 * Anonymous answers are stored without the person, and participation is kept in a separate table, so nobody —
 * including HR — can link an answer to a name. Results are shown only when at least `minGroup` people answered,
 * and the same rule applies to every department breakdown.
 *   engagement:view (take surveys, see recognition) · create (give recognition) · manage (surveys, results, moderation)
 */
export const engagementRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const isManager = (req) => isCompany(scopesOf(req, 'engagement:manage'));
export const KUDOS_VALUES = {
  TEAMWORK: 'Teamwork', CUSTOMER_FIRST: 'Customer first', OWNERSHIP: 'Ownership', INNOVATION: 'New ideas', HELPFUL: 'Always helpful', LEADERSHIP: 'Leadership', EXTRA_MILE: 'Went the extra mile',
};

export const SURVEY_TEMPLATES = [
  { key: 'pulse', title: 'Monthly pulse check', description: 'Five quick questions about how work is going. Your answers are anonymous.', questions: [
    { type: 'ENPS', text: 'How likely are you to recommend this company as a place to work to a friend?' },
    { type: 'RATING', text: 'I have what I need to do my job well.' },
    { type: 'RATING', text: 'My manager supports me and gives useful feedback.' },
    { type: 'RATING', text: 'I feel recognised for good work.' },
    { type: 'TEXT', text: 'What is one thing we could change to make work better?', required: false },
  ] },
  { key: 'engagement', title: 'Annual engagement survey', description: 'A fuller look at how people feel about their work, team and future here.', questions: [
    { type: 'ENPS', text: 'How likely are you to recommend this company as a place to work to a friend?' },
    { type: 'RATING', text: 'I understand how my work contributes to the company\'s goals.' },
    { type: 'RATING', text: 'I see a future for myself here.' },
    { type: 'RATING', text: 'I am paid fairly for the work I do.' },
    { type: 'RATING', text: 'My workload is manageable.' },
    { type: 'RATING', text: 'There are good chances to learn and grow.' },
    { type: 'RATING', text: 'People in my team respect each other.' },
    { type: 'CHOICE', text: 'What matters most to you right now?', options: ['Pay and benefits', 'Career growth', 'Work-life balance', 'Recognition', 'Training', 'Job security'] },
    { type: 'TEXT', text: 'What do you like most about working here?', required: false },
    { type: 'TEXT', text: 'What should leadership improve first?', required: false },
  ] },
];

// =========================================================================== surveys
const question = z.object({
  id: z.string().max(40).optional(), type: z.enum(['RATING', 'ENPS', 'CHOICE', 'TEXT']), text: z.string().trim().min(5).max(300),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(10).optional(), required: z.boolean().default(true),
}).strict().refine((q) => q.type !== 'CHOICE' || (q.options?.length ?? 0) >= 2, { message: 'Add at least two choices', path: ['options'] });
const surveyBody = z.object({
  title: z.string().trim().min(3).max(160), description: optText(z, 1000), anonymous: z.boolean().default(true), closesOn: z.string().date().nullish(),
  audience: z.object({ departmentIds: z.array(z.string().uuid()).max(100).optional(), branchIds: z.array(z.string().uuid()).max(100).optional() }).strict().default({}),
  questions: z.array(question).min(1, 'Add at least one question').max(40), minGroup: z.number().int().min(1).max(20).default(3),
}).strict();

const surveyView = (s, extra = {}) => ({
  id: s.id, title: s.title, description: s.description, anonymous: s.anonymous, status: s.status, closesOn: s.closesOn, audience: s.audience,
  questions: s.questions, minGroup: s.minGroup, openedAt: s.openedAt, closedAt: s.closedAt, createdAt: s.createdAt, ...extra,
});
const withIds = (qs) => qs.map((q) => ({ ...q, id: q.id || crypto.randomBytes(4).toString('hex'), ...(q.type !== 'CHOICE' && { options: undefined }) }));

engagementRouter.get('/survey-templates', requirePermission('engagement:manage'), asyncHandler(async (req, res) => ok(res, SURVEY_TEMPLATES)));

engagementRouter.get('/surveys', requirePermission('engagement:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const me = req.auth.principal.employeeId;
    if (isManager(req)) {
      const rows = await app.Survey.findAll({ order: [['createdAt', 'DESC']], transaction: t });
      const parts = await app.SurveyParticipant.findAll({ where: { surveyId: rows.map((s) => s.id) }, attributes: ['surveyId', 'employeeId', 'responded'], raw: true, transaction: t });
      return rows.map((s) => {
        const p = parts.filter((x) => x.surveyId === s.id);
        return surveyView(s, { invited: p.length, responded: p.filter((x) => x.responded).length, myTurn: !!me && p.some((x) => x.employeeId === me && !x.responded) && s.status === 'OPEN' });
      });
    }
    if (!me) return [];
    const mine = await app.SurveyParticipant.findAll({ where: { employeeId: me }, raw: true, transaction: t });
    const rows = await app.Survey.findAll({ where: { id: mine.map((p) => p.surveyId), status: { [Op.ne]: 'DRAFT' } }, order: [['openedAt', 'DESC']], transaction: t });
    return rows.map((s) => surveyView(s, { questions: undefined, questionCount: s.questions.length, responded: mine.find((p) => p.surveyId === s.id).responded, myTurn: s.status === 'OPEN' && !mine.find((p) => p.surveyId === s.id).responded }));
  });
  return ok(res, out);
}));

engagementRouter.post('/surveys', requirePermission('engagement:manage'), validate({ body: surveyBody }), asyncHandler(async (req, res) => {
  const s = await req.tx(async (t) => {
    const row = await app.Survey.create({ ...req.body, questions: withIds(req.body.questions), tenantId: req.auth.tenantId, status: 'DRAFT', createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'survey.create', entityType: 'survey', entityId: row.id, after: { title: row.title }, req });
    return row;
  });
  return created(res, surveyView(s));
}));

engagementRouter.put('/surveys/:id', requirePermission('engagement:manage'), validate({ ...idParam, body: surveyBody }), asyncHandler(async (req, res) => {
  const s = await req.tx(async (t) => {
    const row = await app.Survey.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Survey');
    if (row.status !== 'DRAFT') {
      // Once people are answering, only the closing date can move.
      await row.update({ closesOn: req.body.closesOn ?? null }, { transaction: t });
    } else await row.update({ ...req.body, questions: withIds(req.body.questions) }, { transaction: t });
    return row;
  });
  return ok(res, surveyView(s));
}));

engagementRouter.post('/surveys/:id/open', requirePermission('engagement:manage'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const s = await app.Survey.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw NotFound('Survey');
    if (s.status !== 'DRAFT') throw Conflict('This survey has already been sent.');
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    if (s.closesOn && s.closesOn < today) throw BadRequest('The closing date has passed. Change it first.', [{ path: 'closesOn', message: 'In the past' }]);
    const where = { deletedAt: null, status: { [Op.ne]: 'TERMINATED' } };
    if (s.audience?.departmentIds?.length) where.departmentId = s.audience.departmentIds;
    if (s.audience?.branchIds?.length) where.branchId = s.audience.branchIds;
    const emps = await app.Employee.findAll({ where, attributes: ['id'], raw: true, transaction: t });
    if (emps.length < s.minGroup) throw BadRequest(`Only ${emps.length} people are in this audience. Results need at least ${s.minGroup} answers, so widen the audience or lower the minimum.`);
    await app.SurveyParticipant.bulkCreate(emps.map((e) => ({ tenantId: req.auth.tenantId, surveyId: s.id, employeeId: e.id, responded: false })), { transaction: t });
    await s.update({ status: 'OPEN', openedAt: new Date() }, { transaction: t });
    const users = (await app.User.findAll({ where: { employeeId: emps.map((e) => e.id), status: 'ACTIVE' }, attributes: ['id'], transaction: t })).map((u) => u.id);
    await notifyUsers(t, users, { type: 'survey.open', title: `Survey: ${s.title}`, body: `${s.anonymous ? 'Anonymous. ' : ''}${s.questions.length} question${s.questions.length === 1 ? '' : 's'}${s.closesOn ? `, open until ${s.closesOn}` : ''}.`, link: `/surveys/${s.id}`, email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'survey.open', entityType: 'survey', entityId: s.id, after: { invited: emps.length }, req });
    return { invited: emps.length };
  });
  return ok(res, out);
}));

engagementRouter.post('/surveys/:id/close', requirePermission('engagement:manage'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const s = await app.Survey.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw NotFound('Survey');
    if (s.status !== 'OPEN') throw Conflict('Only an open survey can be closed.');
    await s.update({ status: 'CLOSED', closedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'survey.close', entityType: 'survey', entityId: s.id, req });
  });
  return ok(res, { status: 'CLOSED' });
}));

const closedByDate = (s, today) => s.status === 'OPEN' && s.closesOn && s.closesOn < today;

engagementRouter.get('/surveys/:id', requirePermission('engagement:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const s = await app.Survey.findByPk(req.params.id, { transaction: t });
    if (!s) throw NotFound('Survey');
    const me = req.auth.principal.employeeId;
    const part = me ? await app.SurveyParticipant.findOne({ where: { surveyId: s.id, employeeId: me }, transaction: t }) : null;
    if (!isManager(req) && (!part || s.status === 'DRAFT')) throw NotFound('Survey');
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    return surveyView(s, { canAnswer: !!part && !part.responded && s.status === 'OPEN' && !closedByDate(s, today), responded: !!part?.responded, canManage: isManager(req) });
  });
  return ok(res, out);
}));

engagementRouter.post('/surveys/:id/respond', requirePermission('engagement:view'), validate({ ...idParam, body: z.object({ answers: z.record(z.string().max(40), z.union([z.number(), z.string().max(2000), z.null()])) }).strict() }), asyncHandler(async (req, res) => {
  const me = myEmployeeId(req);
  await req.tx(async (t) => {
    const s = await app.Survey.findByPk(req.params.id, { transaction: t });
    if (!s) throw NotFound('Survey');
    const part = await app.SurveyParticipant.findOne({ where: { surveyId: s.id, employeeId: me }, transaction: t, lock: t.LOCK.UPDATE });
    if (!part) throw NotFound('Survey');
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    if (s.status !== 'OPEN' || closedByDate(s, today)) throw Conflict('This survey is closed.', 'CLOSED');
    if (part.responded) throw Conflict('You have already answered this survey. Thank you!', 'ALREADY_ANSWERED');
    const answers = {};
    for (const q of s.questions) {
      const v = req.body.answers[q.id];
      const empty = v == null || v === '';
      if (empty) { if (q.required !== false && q.type !== 'TEXT') throw BadRequest(`Answer: ${q.text}`, [{ path: q.id, message: 'Required' }]); continue; }
      if (q.type === 'RATING' && !(Number.isInteger(v) && v >= 1 && v <= 5)) throw BadRequest('Ratings go from 1 to 5', [{ path: q.id, message: 'Invalid' }]);
      if (q.type === 'ENPS' && !(Number.isInteger(v) && v >= 0 && v <= 10)) throw BadRequest('Choose a number from 0 to 10', [{ path: q.id, message: 'Invalid' }]);
      if (q.type === 'CHOICE' && !q.options.includes(v)) throw BadRequest('Choose one of the options', [{ path: q.id, message: 'Invalid' }]);
      if (q.type === 'TEXT' && typeof v !== 'string') throw BadRequest('Write your answer as text', [{ path: q.id, message: 'Invalid' }]);
      answers[q.id] = q.type === 'TEXT' ? String(v).trim().slice(0, 2000) : v;
    }
    const emp = await app.Employee.findByPk(me, { attributes: ['departmentId'], transaction: t });
    await app.SurveyResponse.create({ tenantId: req.auth.tenantId, surveyId: s.id, employeeId: s.anonymous ? null : me, departmentId: emp.departmentId, answers, submittedOn: today }, { transaction: t });
    await part.update({ responded: true }, { transaction: t });
  });
  return created(res, { thanks: true });
}));

/** Aggregated results. Nothing is shown for a group smaller than the survey's minimum. */
engagementRouter.get('/surveys/:id/results', requirePermission('engagement:manage'), validate({ ...idParam, query: z.object({ departmentId: z.string().uuid().optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const s = await app.Survey.findByPk(req.params.id, { transaction: t });
    if (!s) throw NotFound('Survey');
    const parts = await app.SurveyParticipant.findAll({ where: { surveyId: s.id }, attributes: ['responded'], raw: true, transaction: t });
    const all = await app.SurveyResponse.findAll({ where: { surveyId: s.id }, transaction: t });
    const depts = await app.Department.findAll({ where: { id: [...new Set(all.map((r) => r.departmentId).filter(Boolean))] }, attributes: ['id', 'name'], transaction: t });
    const groups = depts.map((d) => ({ id: d.id, name: d.name, responses: all.filter((r) => r.departmentId === d.id).length })).filter((g) => g.responses >= s.minGroup);
    const rows = req.query.departmentId ? all.filter((r) => r.departmentId === req.query.departmentId) : all;
    const base = { survey: surveyView(s), invited: parts.length, responses: all.length, responseRate: parts.length ? Math.round((all.length / parts.length) * 100) : 0, groups };
    if (rows.length < s.minGroup) return { ...base, hidden: true, shown: rows.length, questions: [] };
    const questions = s.questions.map((q) => {
      const vals = rows.map((r) => r.answers[q.id]).filter((v) => v != null && v !== '');
      if (q.type === 'RATING') {
        const dist = [1, 2, 3, 4, 5].map((n) => vals.filter((v) => v === n).length);
        return { ...q, answered: vals.length, average: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, favourable: vals.length ? Math.round((vals.filter((v) => v >= 4).length / vals.length) * 100) : null, distribution: dist };
      }
      if (q.type === 'ENPS') {
        const pro = vals.filter((v) => v >= 9).length; const det = vals.filter((v) => v <= 6).length;
        return { ...q, answered: vals.length, enps: vals.length ? Math.round(((pro - det) / vals.length) * 100) : null, promoters: pro, passives: vals.length - pro - det, detractors: det, distribution: Array.from({ length: 11 }, (_, n) => vals.filter((v) => v === n).length) };
      }
      if (q.type === 'CHOICE') return { ...q, answered: vals.length, counts: q.options.map((o) => ({ option: o, count: vals.filter((v) => v === o).length })) };
      // Free text: shuffled so the order does not follow who answered first.
      const texts = vals.map(String).map((v) => [crypto.randomInt(1e9), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      return { ...q, answered: texts.length, comments: texts };
    });
    return { ...base, hidden: false, shown: rows.length, questions };
  });
  return ok(res, out);
}));

// =========================================================================== recognition (kudos)
const kudosView = (k, extra = {}) => ({ id: k.id, from: empRef(k.from), to: empRef(k.to), value: k.value, valueLabel: KUDOS_VALUES[k.value], message: k.message, createdAt: k.createdAt, hidden: !!k.hiddenAt, ...extra });

engagementRouter.get('/kudos', requirePermission('engagement:view'), validate({ query: z.object({ employeeId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const where = { ...(!isManager(req) && { hiddenAt: null }), ...(req.query.employeeId && { [Op.or]: [{ toEmployeeId: req.query.employeeId }, { fromEmployeeId: req.query.employeeId }] }) };
    const rows = await app.Kudos.findAll({ where, include: [{ model: app.Employee, as: 'from', attributes: EMP_ATTRS }, { model: app.Employee, as: 'to', attributes: EMP_ATTRS }], order: [['createdAt', 'DESC']], limit: 30, offset: (req.query.page - 1) * 30, transaction: t });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const top = await app.Kudos.findAll({ where: { hiddenAt: null, createdAt: { [Op.gte]: since } }, attributes: ['toEmployeeId', [app.Kudos.sequelize.fn('count', '*'), 'n']], group: ['toEmployeeId'], order: [[app.Kudos.sequelize.literal('n'), 'DESC']], limit: 5, raw: true, transaction: t });
    const topEmps = await app.Employee.findAll({ where: { id: top.map((x) => x.toEmployeeId) }, attributes: EMP_ATTRS, transaction: t });
    const me = req.auth.principal.employeeId;
    return {
      items: rows.map((k) => kudosView(k, { canHide: isManager(req) })),
      topThisMonth: top.map((x) => ({ employee: empRef(topEmps.find((e) => e.id === x.toEmployeeId)), count: Number(x.n) })).filter((x) => x.employee),
      mine: me ? { received: await app.Kudos.count({ where: { toEmployeeId: me, hiddenAt: null }, transaction: t }), given: await app.Kudos.count({ where: { fromEmployeeId: me }, transaction: t }) } : null,
      values: KUDOS_VALUES,
    };
  });
  return ok(res, out);
}));

engagementRouter.post('/kudos', requirePermission('engagement:create'), validate({ body: z.object({ toEmployeeId: z.string().uuid(), value: z.enum(Object.keys(KUDOS_VALUES)), message: z.string().trim().min(5, 'Say what they did').max(500) }).strict() }), asyncHandler(async (req, res) => {
  const me = myEmployeeId(req);
  const k = await req.tx(async (t) => {
    if (req.body.toEmployeeId === me) throw BadRequest('Recognise a colleague, not yourself', [{ path: 'toEmployeeId', message: 'Choose someone else' }]);
    const to = await app.Employee.findOne({ where: { id: req.body.toEmployeeId, deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, attributes: EMP_ATTRS, transaction: t });
    if (!to) throw BadRequest('Choose a current colleague', [{ path: 'toEmployeeId', message: 'Not found' }]);
    const today = await app.Kudos.count({ where: { fromEmployeeId: me, createdAt: { [Op.gte]: new Date(Date.now() - 86_400_000) } }, transaction: t });
    if (today >= 10) throw Conflict('You have given a lot of recognition today. Try again tomorrow.', 'LIMIT');
    const row = await app.Kudos.create({ tenantId: req.auth.tenantId, fromEmployeeId: me, ...req.body }, { transaction: t });
    const from = await app.Employee.findByPk(me, { attributes: EMP_ATTRS, transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, to.id)], { type: 'kudos', title: `${empName(from)} recognised you: ${KUDOS_VALUES[req.body.value]}`, body: req.body.message, link: '/recognition', email: true });
    row.from = from; row.to = to;
    return row;
  });
  return created(res, kudosView(k));
}));

engagementRouter.post('/kudos/:id/hide', requirePermission('engagement:manage'), validate({ ...idParam, body: z.object({ hidden: z.boolean() }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const k = await app.Kudos.findByPk(req.params.id, { transaction: t });
    if (!k) throw NotFound('Recognition');
    await k.update(req.body.hidden ? { hiddenAt: new Date(), hiddenBy: req.auth.userId } : { hiddenAt: null, hiddenBy: null }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: req.body.hidden ? 'kudos.hide' : 'kudos.show', entityType: 'kudos', entityId: k.id, req });
  });
  return ok(res, { hidden: req.body.hidden });
}));

