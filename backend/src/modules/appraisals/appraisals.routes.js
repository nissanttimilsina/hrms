import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { performance } from '../../services/work.service.js';
import { EMP_ATTRS, empRef, empName, scopesOf, isCompany, myEmployeeId, employeeIdsIn, employeeInScope, optText, toCsv } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Goals and appraisals.
 *  - Goals (KPIs) with a measure, target, weight and progress, per employee and optionally per review cycle.
 *  - Review cycles: HR sets the period, competencies and the goals/competencies balance, then launches it for
 *    a group. Each person gets an appraisal: self review → manager review (with optional 360° feedback from
 *    colleagues) → HR calibration and sign-off → the employee reads and acknowledges it.
 * Ratings use a 1–5 scale. The manager's ratings make the calculated rating; HR may calibrate it with a note.
 */
export const appraisalsRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
export const RATING_LABELS = { 1: 'Unsatisfactory', 2: 'Needs improvement', 3: 'Meets expectations', 4: 'Exceeds expectations', 5: 'Outstanding' };
export const DEFAULT_COMPETENCIES = [
  { key: 'knowledge', name: 'Job knowledge', description: 'Understands the work, tools and procedures of the role.' },
  { key: 'quality', name: 'Quality of work', description: 'Accurate, thorough work that rarely needs to be redone.' },
  { key: 'productivity', name: 'Productivity', description: 'Gets the expected amount of work done on time.' },
  { key: 'communication', name: 'Communication', description: 'Shares information clearly with colleagues and customers.' },
  { key: 'teamwork', name: 'Teamwork', description: 'Works well with others and helps the team succeed.' },
  { key: 'initiative', name: 'Initiative', description: 'Spots problems and improvements and acts on them.' },
  { key: 'reliability', name: 'Reliability', description: 'Keeps commitments, is punctual and dependable.' },
];
const RECOMMENDATIONS = ['NONE', 'CONFIRM', 'INCREMENT', 'PROMOTION', 'TRAINING', 'PIP', 'EXTEND_PROBATION'];
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const num = (v) => (v == null ? null : Number(v));
const isHr = (req) => isCompany(scopesOf(req, 'appraisals:approve')) || isCompany(scopesOf(req, 'appraisals:configure'));
const hrUsers = (t) => usersWithPermission(t, 'appraisals:approve');

// =========================================================================== goals
const goalView = (g, extra = {}) => ({
  id: g.id, employeeId: g.employeeId, employee: g.employee ? empRef(g.employee) : undefined, cycleId: g.cycleId, title: g.title, description: g.description,
  measure: g.measure, target: g.target, actual: g.actual, weight: g.weight, progress: g.progress, dueDate: g.dueDate, status: g.status, createdAt: g.createdAt, ...extra,
});

/** Who may set or change goals for an employee: the employee themself, or someone with appraisals:edit over them. */
function goalRights(req, emp) {
  const self = emp.id === req.auth.principal.employeeId;
  const manager = !self && employeeInScope(req, scopesOf(req, 'appraisals:edit'), emp);
  return { self, manager: manager || (isHr(req) && !self), any: self ? scopesOf(req, 'appraisals:edit').length > 0 : manager || isHr(req) };
}

async function checkWeights(t, employeeId, cycleId, adding, exceptId) {
  const rows = await app.Goal.findAll({ where: { employeeId, cycleId: cycleId ?? null, status: { [Op.ne]: 'DROPPED' }, ...(exceptId && { id: { [Op.ne]: exceptId } }) }, attributes: ['weight'], raw: true, transaction: t });
  const total = rows.reduce((n, r) => n + r.weight, 0) + adding;
  if (total > 100) throw BadRequest(`Goal weights would add up to ${total}%. Keep the total at 100% or less.`, [{ path: 'weight', message: `Total ${total}%` }]);
}

appraisalsRouter.get('/goals', requirePermission('appraisals:view'), validate({ query: z.object({ employeeId: z.string().uuid().optional(), cycleId: z.string().uuid().optional(), status: z.string().optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const me = req.auth.principal.employeeId;
    const target = req.query.employeeId ?? me;
    if (!target) return [];
    const emp = await app.Employee.findByPk(target, { attributes: EMP_ATTRS, transaction: t });
    if (!emp || !(target === me || employeeInScope(req, req.scopes, emp))) throw NotFound('Employee');
    const goals = await app.Goal.findAll({ where: { employeeId: target, ...(req.query.cycleId && { cycleId: req.query.cycleId }) }, order: [['status', 'ASC'], ['dueDate', 'ASC'], ['createdAt', 'ASC']], transaction: t });
    const rights = goalRights(req, emp);
    return goals.map((g) => goalView(g, { canEdit: rights.any }));
  });
  return ok(res, out);
}));

/** Goals of the people I manage, for a team overview. */
appraisalsRouter.get('/goals/team', requirePermission('appraisals:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const scopes = req.scopes.filter((s) => s.scope !== 'OWN');
    if (!scopes.length) return [];
    const ids = await employeeIdsIn(t, req, scopes);
    const goals = await app.Goal.findAll({ where: { status: { [Op.ne]: 'DROPPED' }, ...(ids && { employeeId: ids.filter((x) => x !== req.auth.principal.employeeId) }) }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS, where: { status: { [Op.ne]: 'TERMINATED' } } }], order: [['dueDate', 'ASC']], limit: 500, transaction: t });
    return goals.map((g) => goalView(g));
  });
  return ok(res, out);
}));

const goalBody = z.object({
  employeeId: z.string().uuid().optional(), cycleId: z.string().uuid().nullish(), title: z.string().trim().min(3, 'Describe the goal').max(200),
  description: optText(z, 2000), measure: optText(z, 200), target: optText(z, 120), weight: z.number().int().min(0).max(100).default(0),
  dueDate: z.string().date().nullish(),
}).strict();

appraisalsRouter.post('/goals', requirePermission('appraisals:edit'), validate({ body: goalBody }), asyncHandler(async (req, res) => {
  const g = await req.tx(async (t) => {
    const employeeId = req.body.employeeId ?? myEmployeeId(req);
    const emp = await app.Employee.findOne({ where: { id: employeeId, deletedAt: null }, attributes: EMP_ATTRS, transaction: t });
    if (!emp) throw NotFound('Employee');
    if (!goalRights(req, emp).any) throw Forbidden('You can set goals for yourself and the people you manage.');
    if (req.body.cycleId) {
      const c = await app.AppraisalCycle.findByPk(req.body.cycleId, { transaction: t });
      if (!c || c.status === 'CLOSED') throw BadRequest('Choose an open review cycle', [{ path: 'cycleId', message: 'Closed or not found' }]);
    }
    await checkWeights(t, emp.id, req.body.cycleId, req.body.weight);
    const row = await app.Goal.create({ ...req.body, employeeId: emp.id, tenantId: req.auth.tenantId, status: 'ACTIVE', progress: 0, createdBy: req.auth.userId }, { transaction: t });
    if (emp.id !== req.auth.principal.employeeId) await notifyUsers(t, [await userIdForEmployee(t, emp.id)], { type: 'goal.set', title: `New goal: ${row.title}`, body: row.target ? `Target: ${row.target}` : undefined, link: '/me/goals' });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'goal.create', entityType: 'goal', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, goalView(g));
}));

appraisalsRouter.patch('/goals/:id', requirePermission('appraisals:edit'), validate({ ...idParam, body: z.object({
  title: z.string().trim().min(3).max(200), description: optText(z, 2000), measure: optText(z, 200), target: optText(z, 120), actual: optText(z, 120),
  weight: z.number().int().min(0).max(100), progress: z.number().int().min(0).max(100), dueDate: z.string().date().nullish(),
  status: z.enum(['ACTIVE', 'ACHIEVED', 'PARTLY_ACHIEVED', 'MISSED', 'DROPPED']),
}).partial().strict() }), asyncHandler(async (req, res) => {
  const g = await req.tx(async (t) => {
    const row = await app.Goal.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Goal');
    const emp = await app.Employee.findByPk(row.employeeId, { attributes: EMP_ATTRS, transaction: t });
    const rights = goalRights(req, emp);
    if (!rights.any) throw NotFound('Goal');
    // Employees update progress and the actual result; changing what was agreed (title, target, weight, outcome) is for the manager.
    const agreed = ['title', 'measure', 'target', 'weight', 'dueDate', 'status'].filter((k) => k in req.body);
    if (rights.self && !rights.manager && agreed.length && row.createdBy !== req.auth.userId) throw Forbidden('Your manager set this goal. You can update progress and the result; ask them to change the rest.', 'MANAGER_GOAL');
    if ('weight' in req.body) await checkWeights(t, row.employeeId, row.cycleId, req.body.weight, row.id);
    const patch = { ...req.body };
    if (patch.status === 'ACHIEVED' && patch.progress == null) patch.progress = 100;
    const before = row.toJSON();
    await row.update(patch, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'goal.update', entityType: 'goal', entityId: row.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), after: patch, req });
    return row;
  });
  return ok(res, goalView(g));
}));

// =========================================================================== cycles
const competency = z.object({ key: z.string().trim().regex(/^[a-z0-9_]{2,30}$/), name: z.string().trim().min(2).max(60), description: optText(z, 300) }).strict();
const cycleBody = z.object({
  name: z.string().trim().min(3).max(120), periodStart: z.string().date(), periodEnd: z.string().date(),
  selfReviewDue: z.string().date().nullish(), managerReviewDue: z.string().date().nullish(),
  competencies: z.array(competency).max(15).default(DEFAULT_COMPETENCIES).refine((c) => new Set(c.map((x) => x.key)).size === c.length, 'Each competency needs its own key'),
  goalWeight: z.number().int().min(0).max(100).default(60), peerFeedback: z.boolean().default(true),
}).strict().refine((b) => b.periodEnd >= b.periodStart, { message: 'The period ends before it starts', path: ['periodEnd'] })
  .refine((b) => b.goalWeight === 100 || b.competencies.length > 0, { message: 'Add competencies, or base the rating fully on goals', path: ['competencies'] });

const cycleView = (c, extra = {}) => ({
  id: c.id, name: c.name, periodStart: c.periodStart, periodEnd: c.periodEnd, selfReviewDue: c.selfReviewDue, managerReviewDue: c.managerReviewDue,
  status: c.status, competencies: c.competencies, goalWeight: c.goalWeight, peerFeedback: c.peerFeedback, launchedAt: c.launchedAt, closedAt: c.closedAt, createdAt: c.createdAt, ...extra,
});

appraisalsRouter.get('/cycles', requirePermission('appraisals:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const cycles = await app.AppraisalCycle.findAll({ where: isHr(req) ? {} : { status: { [Op.ne]: 'DRAFT' } }, order: [['periodEnd', 'DESC']], transaction: t });
    const counts = await app.Appraisal.findAll({ where: { cycleId: cycles.map((c) => c.id) }, attributes: ['cycleId', 'status'], raw: true, transaction: t });
    return cycles.map((c) => {
      const mine = counts.filter((x) => x.cycleId === c.id);
      return cycleView(c, { total: mine.length, completed: mine.filter((x) => ['COMPLETED', 'ACKNOWLEDGED'].includes(x.status)).length });
    });
  });
  return ok(res, out);
}));

appraisalsRouter.post('/cycles', requirePermission('appraisals:configure'), validate({ body: cycleBody }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await app.AppraisalCycle.create({ ...req.body, tenantId: req.auth.tenantId, status: 'DRAFT', createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.cycle_create', entityType: 'appraisal_cycle', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, cycleView(c));
}));

appraisalsRouter.put('/cycles/:id', requirePermission('appraisals:configure'), validate({ ...idParam, body: cycleBody }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await app.AppraisalCycle.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Review cycle');
    if (row.status !== 'DRAFT') {
      // After launch only dates can move: the form people fill in must not change under them.
      const { selfReviewDue, managerReviewDue } = req.body;
      await row.update({ selfReviewDue, managerReviewDue }, { transaction: t });
    } else await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.cycle_update', entityType: 'appraisal_cycle', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, cycleView(c));
}));

appraisalsRouter.post('/cycles/:id/launch', requirePermission('appraisals:configure'), validate({ ...idParam, body: z.object({
  departmentIds: z.array(z.string().uuid()).max(100).optional(), branchIds: z.array(z.string().uuid()).max(100).optional(), employeeIds: z.array(z.string().uuid()).max(2000).optional(),
}).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await app.AppraisalCycle.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) throw NotFound('Review cycle');
    if (c.status === 'CLOSED') throw Conflict('This cycle is closed.');
    const b = req.body;
    const where = { deletedAt: null, status: { [Op.ne]: 'TERMINATED' }, joinedOn: { [Op.lte]: c.periodEnd } };
    if (b.employeeIds?.length) where.id = b.employeeIds;
    if (b.departmentIds?.length) where.departmentId = b.departmentIds;
    if (b.branchIds?.length) where.branchId = b.branchIds;
    const emps = await app.Employee.findAll({ where, attributes: EMP_ATTRS, transaction: t });
    const existing = new Set((await app.Appraisal.findAll({ where: { cycleId: c.id }, attributes: ['employeeId'], raw: true, transaction: t })).map((x) => x.employeeId));
    const add = emps.filter((e) => !existing.has(e.id));
    if (!add.length) throw BadRequest(existing.size ? 'Everyone in that group is already in this cycle.' : 'No current employees match that group.');
    await app.Appraisal.bulkCreate(add.map((e) => ({ tenantId: req.auth.tenantId, cycleId: c.id, employeeId: e.id, reviewerId: e.managerId ?? null, status: 'SELF_REVIEW' })), { transaction: t });
    // Goals set for the period without a cycle become part of this review.
    await app.Goal.update({ cycleId: c.id }, { where: { employeeId: add.map((e) => e.id), cycleId: null, status: { [Op.ne]: 'DROPPED' }, [Op.or]: [{ dueDate: null }, { dueDate: { [Op.between]: [c.periodStart, c.periodEnd] } }] }, transaction: t });
    if (c.status === 'DRAFT') await c.update({ status: 'ACTIVE', launchedAt: new Date() }, { transaction: t });
    const users = (await Promise.all(add.map((e) => userIdForEmployee(t, e.id)))).filter(Boolean);
    await notifyUsers(t, users, { type: 'appraisal.started', title: `${c.name}: your self review`, body: c.selfReviewDue ? `Please complete it by ${c.selfReviewDue}.` : 'Rate your goals and competencies, then submit it to your manager.', link: '/me/appraisals', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.cycle_launch', entityType: 'appraisal_cycle', entityId: c.id, after: { ...b, added: add.length }, req });
    return { added: add.length, withoutManager: add.filter((e) => !e.managerId).length };
  });
  return ok(res, out);
}));

appraisalsRouter.post('/cycles/:id/close', requirePermission('appraisals:configure'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await app.AppraisalCycle.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) throw NotFound('Review cycle');
    if (c.status !== 'ACTIVE') throw Conflict('Only an active cycle can be closed.');
    const open = await app.Appraisal.count({ where: { cycleId: c.id, status: { [Op.notIn]: ['COMPLETED', 'ACKNOWLEDGED'] } }, transaction: t });
    await c.update({ status: 'CLOSED', closedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.cycle_close', entityType: 'appraisal_cycle', entityId: c.id, after: { unfinished: open }, req });
    return { status: 'CLOSED', unfinished: open };
  });
  return ok(res, out);
}));

// =========================================================================== appraisals
function rights(req, a, emp) {
  const me = req.auth.principal.employeeId;
  const self = !!me && a.employeeId === me;
  const reviewer = !self && ((!!me && a.reviewerId === me) || employeeInScope(req, scopesOf(req, 'appraisals:edit').filter((s) => s.scope !== 'OWN'), emp));
  const hr = isHr(req) && !self;
  return { self, reviewer, hr, see: self || reviewer || hr || employeeInScope(req, scopesOf(req, 'appraisals:view').filter((s) => s.scope !== 'OWN'), emp) };
}

function aView(a, extra = {}) {
  return {
    id: a.id, cycleId: a.cycleId, cycle: a.cycle ? { id: a.cycle.id, name: a.cycle.name, periodStart: a.cycle.periodStart, periodEnd: a.cycle.periodEnd, status: a.cycle.status, selfReviewDue: a.cycle.selfReviewDue, managerReviewDue: a.cycle.managerReviewDue } : undefined,
    employee: a.employee ? empRef(a.employee) : undefined, reviewer: a.reviewer ? empRef(a.reviewer) : null, status: a.status,
    finalRating: num(a.finalRating), calculatedRating: num(a.calculatedRating), recommendation: a.recommendation,
    selfSubmittedAt: a.selfSubmittedAt, managerSubmittedAt: a.managerSubmittedAt, finalizedAt: a.finalizedAt, acknowledgedAt: a.acknowledgedAt, ...extra,
  };
}
const A_INCLUDE = () => [{ model: app.AppraisalCycle, as: 'cycle' }, { model: app.Employee, as: 'employee', attributes: EMP_ATTRS }, { model: app.Employee, as: 'reviewer', attributes: EMP_ATTRS }];

appraisalsRouter.get('/', requirePermission('appraisals:view'), validate({ query: z.object({ view: z.enum(['mine', 'review', 'all']).default('mine'), cycleId: z.string().uuid().optional(), status: z.string().optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const me = req.auth.principal.employeeId;
    const and = [];
    if (req.query.view === 'mine') { if (!me) return []; and.push({ employeeId: me }); }
    if (req.query.view === 'review') {
      const scopes = scopesOf(req, 'appraisals:edit').filter((s) => s.scope !== 'OWN');
      const ids = scopes.length ? await employeeIdsIn(t, req, scopes) : [];
      and.push({ [Op.or]: [...(me ? [{ reviewerId: me }] : []), ...(ids === null ? [{ id: { [Op.ne]: null } }] : ids.length ? [{ employeeId: ids }] : [])] });
      if (me) and.push({ employeeId: { [Op.ne]: me } });
    }
    if (req.query.view === 'all') {
      if (!isHr(req)) { const ids = await employeeIdsIn(t, req, req.scopes.filter((s) => s.scope !== 'OWN')); if (ids) and.push({ employeeId: ids }); }
    }
    if (req.query.cycleId) and.push({ cycleId: req.query.cycleId });
    if (req.query.status) and.push({ status: req.query.status.split(',') });
    const rows = await app.Appraisal.findAll({ where: { [Op.and]: and }, include: A_INCLUDE(), order: [[{ model: app.AppraisalCycle, as: 'cycle' }, 'periodEnd', 'DESC'], ['createdAt', 'ASC']], transaction: t });
    const hide = (a) => req.query.view === 'mine' && !['COMPLETED', 'ACKNOWLEDGED'].includes(a.status);
    return rows.map((a) => aView(a, hide(a) ? { finalRating: null, calculatedRating: null, recommendation: null } : {}));
  });
  return ok(res, out);
}));

async function loadAppraisal(req, t, id, { lock = false } = {}) {
  const a = await app.Appraisal.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!a) throw NotFound('Appraisal');
  a.cycle = await app.AppraisalCycle.findByPk(a.cycleId, { transaction: t });
  a.employee = await app.Employee.findByPk(a.employeeId, { attributes: EMP_ATTRS, transaction: t });
  a.reviewer = a.reviewerId ? await app.Employee.findByPk(a.reviewerId, { attributes: EMP_ATTRS, transaction: t }) : null;
  const r = rights(req, a, a.employee);
  if (!r.see) throw NotFound('Appraisal');
  return { a, r };
}
const cycleGoals = (t, a) => app.Goal.findAll({ where: { employeeId: a.employeeId, cycleId: a.cycleId, status: { [Op.ne]: 'DROPPED' } }, order: [['createdAt', 'ASC']], transaction: t });

appraisalsRouter.get('/:id', requirePermission('appraisals:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id);
    const goals = await cycleGoals(t, a);
    const done = ['COMPLETED', 'ACKNOWLEDGED'].includes(a.status);
    const showSelf = r.self || ((r.reviewer || r.hr) && !!a.selfSubmittedAt) || done;
    const showManager = r.reviewer || r.hr || (r.self && done);
    const feedback = r.reviewer || r.hr ? await app.AppraisalFeedback.findAll({ where: { appraisalId: a.id }, include: [{ model: app.Employee, as: 'from', attributes: EMP_ATTRS }], transaction: t }) : [];
    const locked = a.cycle.status === 'CLOSED';
    return aView(a, {
      ratingLabels: RATING_LABELS, competencies: a.cycle.competencies, goalWeight: a.cycle.goalWeight, peerFeedbackEnabled: a.cycle.peerFeedback,
      goals: goals.map((g) => goalView(g)),
      selfReview: showSelf ? a.selfReview : null, managerReview: showManager ? a.managerReview : null,
      goalScore: showManager ? num(a.goalScore) : null, competencyScore: showManager ? num(a.competencyScore) : null,
      calculatedRating: showManager ? num(a.calculatedRating) : null, finalRating: done || r.hr || r.reviewer ? num(a.finalRating) : null,
      calibrationNote: r.hr || done ? a.calibrationNote : null, recommendation: showManager ? a.recommendation : null,
      workScore: r.reviewer || r.hr || done ? a.workScore : null, employeeComment: a.employeeComment,
      peerFeedback: feedback.map((f) => ({ id: f.id, from: empRef(f.from), submittedAt: f.submittedAt, rating: f.rating, strengths: f.strengths, improvements: f.improvements })),
      abilities: {
        selfReview: r.self && a.status === 'SELF_REVIEW' && !locked,
        managerReview: (r.reviewer || r.hr) && ['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status) && !locked,
        managerCanSubmit: a.status === 'MANAGER_REVIEW' || (!!a.cycle.selfReviewDue && a.cycle.selfReviewDue < localDate(new Date(), req.auth.ctx.tenant.timezone)) || r.hr,
        requestFeedback: (r.reviewer || r.hr) && a.cycle.peerFeedback && ['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status) && !locked,
        finalize: r.hr && a.status === 'HR_REVIEW',
        reopen: r.hr && a.status === 'HR_REVIEW',
        acknowledge: r.self && a.status === 'COMPLETED',
        changeReviewer: r.hr && !done,
      },
    });
  });
  return ok(res, out);
}));

const ratingMap = z.record(z.string().max(60), z.object({ rating: z.number().int().min(1).max(5).nullable().optional(), comment: optText(z, 2000) }).strict());
const selfBody = z.object({ goals: ratingMap.default({}), competencies: ratingMap.default({}), summary: optText(z, 4000), submit: z.boolean().default(false) }).strict();

function requireComplete(cycle, goals, review, who) {
  const missingGoals = goals.filter((g) => !review.goals?.[g.id]?.rating);
  const missingComp = cycle.goalWeight < 100 ? cycle.competencies.filter((c) => !review.competencies?.[c.key]?.rating) : [];
  if (missingGoals.length || missingComp.length) {
    const what = [...missingGoals.map((g) => `goal "${g.title}"`), ...missingComp.map((c) => c.name)];
    throw BadRequest(`Rate every item before submitting. Missing: ${what.slice(0, 4).join(', ')}${what.length > 4 ? ` and ${what.length - 4} more` : ''}.`, [{ path: who, message: 'Incomplete' }]);
  }
}

appraisalsRouter.put('/:id/self', requirePermission('appraisals:view'), validate({ ...idParam, body: selfBody }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!r.self) throw Forbidden('Only the employee writes the self review.');
    if (a.status !== 'SELF_REVIEW' || a.cycle.status === 'CLOSED') throw Conflict('Your self review has already been submitted.', 'SUBMITTED');
    const { submit, ...review } = req.body;
    const goals = await cycleGoals(t, a);
    if (submit) requireComplete(a.cycle, goals, review, 'selfReview');
    await a.update({ selfReview: review, ...(submit && { status: 'MANAGER_REVIEW', selfSubmittedAt: new Date() }) }, { transaction: t });
    if (submit) {
      const to = a.reviewerId ? [await userIdForEmployee(t, a.reviewerId)] : await hrUsers(t);
      await notifyUsers(t, to, { type: 'appraisal.self_done', title: `${empName(a.employee)} submitted their self review`, body: a.cycle.name, link: `/appraisals/${a.id}`, email: true });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.self_submit', entityType: 'appraisal', entityId: a.id, req });
    }
    return { status: a.status };
  });
  return ok(res, out);
}));

const managerBody = selfBody.extend({
  strengths: optText(z, 3000), improvements: optText(z, 3000), recommendation: z.enum(RECOMMENDATIONS).default('NONE'),
});

function score(cycle, goals, review) {
  const gr = goals.map((g) => ({ w: g.weight, r: review.goals?.[g.id]?.rating })).filter((x) => x.r);
  const tw = gr.reduce((n, x) => n + x.w, 0);
  const goalScore = gr.length ? (tw > 0 ? gr.reduce((n, x) => n + x.r * x.w, 0) / tw : gr.reduce((n, x) => n + x.r, 0) / gr.length) : null;
  const cr = cycle.competencies.map((c) => review.competencies?.[c.key]?.rating).filter(Boolean);
  const competencyScore = cr.length ? cr.reduce((n, x) => n + x, 0) / cr.length : null;
  let overall = null;
  if (goalScore != null && competencyScore != null) overall = (goalScore * cycle.goalWeight + competencyScore * (100 - cycle.goalWeight)) / 100;
  else overall = goalScore ?? competencyScore;
  return { goalScore: r2(goalScore), competencyScore: r2(competencyScore), calculatedRating: r2(overall) };
}

appraisalsRouter.put('/:id/manager', requirePermission('appraisals:view'), validate({ ...idParam, body: managerBody }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!(r.reviewer || r.hr)) throw Forbidden('Only the reviewer or HR writes the manager review.');
    if (!['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status) || a.cycle.status === 'CLOSED') throw Conflict('The manager review has already been submitted.', 'SUBMITTED');
    const { submit, ...review } = req.body;
    const goals = await cycleGoals(t, a);
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    const patch = { managerReview: review, recommendation: review.recommendation };
    if (submit) {
      const selfLate = !!a.cycle.selfReviewDue && a.cycle.selfReviewDue < today;
      if (a.status === 'SELF_REVIEW' && !selfLate && !r.hr) throw Conflict('Wait for the self review, or until its due date has passed.', 'WAITING_FOR_SELF');
      requireComplete(a.cycle, goals, review, 'managerReview');
      Object.assign(patch, score(a.cycle, goals, review), { status: 'HR_REVIEW', managerSubmittedAt: new Date() });
      // Day-to-day evidence: the work score (tasks, daily reports, punctuality) over the review period.
      try {
        const [p] = await performance(t, { ids: [a.employeeId], from: a.cycle.periodStart, to: a.cycle.periodEnd < today ? a.cycle.periodEnd : today, tz: req.auth.ctx.tenant.timezone, today });
        patch.workScore = p?.score ?? null;
      } catch { patch.workScore = null; }
    }
    await a.update(patch, { transaction: t });
    if (submit) {
      await notifyUsers(t, (await hrUsers(t)).filter((u) => u !== req.auth.userId), { type: 'appraisal.manager_done', title: `Appraisal ready for sign-off: ${empName(a.employee)}`, body: `${a.cycle.name} · calculated rating ${patch.calculatedRating ?? '—'}`, link: `/appraisals/${a.id}` });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.manager_submit', entityType: 'appraisal', entityId: a.id, after: { calculatedRating: patch.calculatedRating, recommendation: review.recommendation }, req });
    }
    return { status: a.status, calculatedRating: num(a.calculatedRating) };
  });
  return ok(res, out);
}));

appraisalsRouter.post('/:id/finalize', requirePermission('appraisals:approve'), validate({ ...idParam, body: z.object({ finalRating: z.number().min(1).max(5).optional(), calibrationNote: optText(z, 1000), recommendation: z.enum(RECOMMENDATIONS).optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!r.hr) throw Forbidden('HR signs off appraisals, and not their own.');
    if (a.status !== 'HR_REVIEW') throw Conflict('This appraisal is not waiting for sign-off.');
    const calc = num(a.calculatedRating);
    const final = req.body.finalRating != null ? r2(req.body.finalRating) : calc;
    if (final == null) throw BadRequest('Enter the final rating', [{ path: 'finalRating', message: 'Required' }]);
    if (calc != null && Math.abs(final - calc) >= 0.01 && !req.body.calibrationNote) throw BadRequest('Explain why the rating changed from the calculated one', [{ path: 'calibrationNote', message: 'Required when calibrating' }]);
    await a.update({ finalRating: final, calibrationNote: req.body.calibrationNote ?? null, ...(req.body.recommendation && { recommendation: req.body.recommendation }), status: 'COMPLETED', finalizedAt: new Date(), finalizedBy: req.auth.userId }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, a.employeeId)], { type: 'appraisal.completed', title: `Your appraisal for ${a.cycle.name} is ready`, body: 'Read it, then acknowledge it. You can add your comments.', link: `/appraisals/${a.id}`, email: true });
    if (a.reviewerId) await notifyUsers(t, [await userIdForEmployee(t, a.reviewerId)], { type: 'appraisal.completed', title: `Appraisal signed off: ${empName(a.employee)}`, link: `/appraisals/${a.id}` });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.finalize', entityType: 'appraisal', entityId: a.id, before: { calculatedRating: calc }, after: req.body, req });
    return { status: 'COMPLETED', finalRating: final };
  });
  return ok(res, out);
}));

appraisalsRouter.post('/:id/reopen', requirePermission('appraisals:approve'), validate({ ...idParam, body: z.object({ note: z.string().trim().min(3).max(500) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!r.hr || a.status !== 'HR_REVIEW') throw Conflict('Only an appraisal waiting for sign-off can go back to the manager.');
    await a.update({ status: 'MANAGER_REVIEW', managerSubmittedAt: null }, { transaction: t });
    if (a.reviewerId) await notifyUsers(t, [await userIdForEmployee(t, a.reviewerId)], { type: 'appraisal.reopened', title: `HR sent back the appraisal of ${empName(a.employee)}`, body: req.body.note, link: `/appraisals/${a.id}`, email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.reopen', entityType: 'appraisal', entityId: a.id, after: req.body, req });
  });
  return ok(res, { status: 'MANAGER_REVIEW' });
}));

appraisalsRouter.post('/:id/acknowledge', requirePermission('appraisals:view'), validate({ ...idParam, body: z.object({ comment: optText(z, 2000) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!r.self || a.status !== 'COMPLETED') throw Conflict('There is nothing to acknowledge.');
    await a.update({ status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), employeeComment: req.body.comment }, { transaction: t });
    if (req.body.comment) await notifyUsers(t, await hrUsers(t), { type: 'appraisal.comment', title: `${empName(a.employee)} commented on their appraisal`, body: req.body.comment.slice(0, 200), link: `/appraisals/${a.id}` });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.acknowledge', entityType: 'appraisal', entityId: a.id, req });
  });
  return ok(res, { status: 'ACKNOWLEDGED' });
}));

appraisalsRouter.post('/:id/reviewer', requirePermission('appraisals:approve'), validate({ ...idParam, body: z.object({ reviewerId: z.string().uuid() }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id, { lock: true });
    if (!r.hr) throw Forbidden();
    if (req.body.reviewerId === a.employeeId) throw BadRequest('People cannot review themselves');
    const emp = await app.Employee.findOne({ where: { id: req.body.reviewerId, deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, transaction: t });
    if (!emp) throw BadRequest('Choose a current employee', [{ path: 'reviewerId', message: 'Not found' }]);
    await a.update({ reviewerId: emp.id }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, emp.id)], { type: 'appraisal.reviewer', title: `You review ${empName(a.employee)} in ${a.cycle.name}`, link: `/appraisals/${a.id}` });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.reviewer', entityType: 'appraisal', entityId: a.id, after: req.body, req });
  });
  return ok(res, { saved: true });
}));

// --------------------------------------------------------------------------- 360° feedback
appraisalsRouter.post('/:id/feedback-requests', requirePermission('appraisals:view'), validate({ ...idParam, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(8) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { a, r } = await loadAppraisal(req, t, req.params.id);
    if (!(r.reviewer || r.hr) || !a.cycle.peerFeedback || !['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status)) throw Forbidden('You cannot ask for feedback on this appraisal.');
    const ids = [...new Set(req.body.employeeIds)].filter((x) => x !== a.employeeId);
    const emps = await app.Employee.findAll({ where: { id: ids, deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, attributes: EMP_ATTRS, transaction: t });
    const have = new Set((await app.AppraisalFeedback.findAll({ where: { appraisalId: a.id }, attributes: ['fromEmployeeId'], raw: true, transaction: t })).map((x) => x.fromEmployeeId));
    const add = emps.filter((e) => !have.has(e.id));
    await app.AppraisalFeedback.bulkCreate(add.map((e) => ({ tenantId: req.auth.tenantId, appraisalId: a.id, fromEmployeeId: e.id, requestedBy: req.auth.userId })), { transaction: t });
    const users = (await Promise.all(add.map((e) => userIdForEmployee(t, e.id)))).filter(Boolean);
    await notifyUsers(t, users, { type: 'appraisal.feedback_request', title: `Feedback requested about ${empName(a.employee)}`, body: `${a.cycle.name}. Your answers go to their reviewer, not to them.`, link: '/me/appraisals?tab=feedback', email: true });
    return { requested: add.length };
  });
  return created(res, out);
}));

appraisalsRouter.get('/feedback/mine', requirePermission('appraisals:view'), asyncHandler(async (req, res) => {
  const me = req.auth.principal.employeeId;
  if (!me) return ok(res, []);
  const out = await req.tx(async (t) => {
    const rows = await app.AppraisalFeedback.findAll({ where: { fromEmployeeId: me }, order: [['createdAt', 'DESC']], limit: 50, transaction: t });
    const apps = await app.Appraisal.findAll({ where: { id: rows.map((x) => x.appraisalId) }, include: A_INCLUDE(), transaction: t });
    const by = Object.fromEntries(apps.map((a) => [a.id, a]));
    return rows.filter((x) => by[x.appraisalId]).map((x) => {
      const a = by[x.appraisalId];
      return { id: x.id, about: empRef(a.employee), cycle: a.cycle.name, submittedAt: x.submittedAt, rating: x.rating, strengths: x.strengths, improvements: x.improvements, open: !x.submittedAt && ['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status) && a.cycle.status !== 'CLOSED' };
    });
  });
  return ok(res, out);
}));

appraisalsRouter.put('/feedback/:id', requirePermission('appraisals:view'), validate({ ...idParam, body: z.object({ rating: z.number().int().min(1).max(5), strengths: z.string().trim().min(3, 'Write at least a few words').max(2000), improvements: optText(z, 2000) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const f = await app.AppraisalFeedback.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!f || f.fromEmployeeId !== req.auth.principal.employeeId) throw NotFound('Feedback request');
    if (f.submittedAt) throw Conflict('You already sent this feedback.');
    const a = await app.Appraisal.findByPk(f.appraisalId, { include: [{ model: app.AppraisalCycle, as: 'cycle' }, { model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], transaction: t });
    if (!['SELF_REVIEW', 'MANAGER_REVIEW'].includes(a.status) || a.cycle.status === 'CLOSED') throw Conflict('This review is past the feedback stage.');
    await f.update({ ...req.body, submittedAt: new Date() }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, a.reviewerId), f.requestedBy], { type: 'appraisal.feedback', title: `New feedback about ${empName(a.employee)}`, link: `/appraisals/${a.id}` });
  });
  return ok(res, { saved: true });
}));

// --------------------------------------------------------------------------- export of results
appraisalsRouter.get('/cycles/:id/export', requirePermission('appraisals:export'), validate(idParam), asyncHandler(async (req, res) => {
  const { c, rows } = await req.tx(async (t) => {
    const cycle = await app.AppraisalCycle.findByPk(req.params.id, { transaction: t });
    if (!cycle) throw NotFound('Review cycle');
    const ids = await employeeIdsIn(t, req, req.scopes);
    const list = await app.Appraisal.findAll({ where: { cycleId: cycle.id, ...(ids && { employeeId: ids }) }, include: A_INCLUDE(), order: [[{ model: app.Employee, as: 'employee' }, 'firstName', 'ASC']], transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'appraisal.export', entityType: 'appraisal_cycle', entityId: cycle.id, req });
    return { c: cycle, rows: list };
  });
  const header = ['Employee ID', 'Employee', 'Reviewer', 'Status', 'Goals score', 'Competencies score', 'Calculated rating', 'Final rating', 'Rating', 'Recommendation', 'Work score', 'Calibration note'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="appraisals-${c.name.replace(/[^\w-]+/g, '-')}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, rows.map((a) => [a.employee.employeeCode, empName(a.employee), a.reviewer ? empName(a.reviewer) : '', a.status.replace(/_/g, ' ').toLowerCase(), num(a.goalScore) ?? '', num(a.competencyScore) ?? '', num(a.calculatedRating) ?? '', num(a.finalRating) ?? '', a.finalRating ? RATING_LABELS[Math.round(Number(a.finalRating))] : '', (a.recommendation ?? '').replace(/_/g, ' ').toLowerCase(), a.workScore ?? '', a.calibrationNote ?? ''])));
}));
