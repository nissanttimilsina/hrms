import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, addDays } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { upload, checkUpload, saveUpload, sendFile } from '../../services/uploads.js';
import { EMP_ATTRS, empRef, empName, scopesOf, isCompany, myEmployeeId, employeeIdsIn, employeeInScope, optText, toCsv } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Training and development: a course catalogue, scheduled sessions, enrolments (by HR or managers, or requested by
 * employees and approved), completion with scores and certificates (with expiry), feedback, and a compliance view
 * of mandatory courses.
 *   training:view (scoped) · create (enrol people in scope / request for yourself) · approve (decide requests in scope)
 *   edit (record completion in scope) · manage (courses and sessions) · export
 */
export const trainingRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const DELIVERY = ['IN_PERSON', 'ONLINE', 'EXTERNAL', 'ON_THE_JOB'];
const num = (v) => (v == null ? null : Number(v));
const addMonths = (ymd, m) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const today = (req) => localDate(new Date(), req.auth.ctx.tenant.timezone);
const isHr = (req) => isCompany(scopesOf(req, 'training:manage'));

const courseView = (c, extra = {}) => ({
  id: c.id, title: c.title, category: c.category, description: c.description, delivery: c.delivery, provider: c.provider,
  durationHours: num(c.durationHours), costPerPerson: num(c.costPerPerson), certificateValidMonths: c.certificateValidMonths,
  mandatory: c.mandatory, selfEnroll: c.selfEnroll, active: c.active, ...extra,
});
const sessionView = (s, extra = {}) => ({ id: s.id, courseId: s.courseId, startsAt: s.startsAt, endsAt: s.endsAt, location: s.location, trainer: s.trainer, capacity: s.capacity, status: s.status, ...extra });
function enrollmentView(e, todayYmd, extra = {}) {
  return {
    id: e.id, status: e.status, courseId: e.courseId, course: e.course ? { id: e.course.id, title: e.course.title, category: e.course.category, durationHours: num(e.course.durationHours), delivery: e.course.delivery } : undefined,
    session: e.session ? sessionView(e.session) : null, employee: e.employee ? empRef(e.employee) : undefined, requestNote: e.requestNote, decisionNote: e.decisionNote,
    completedOn: e.completedOn, score: num(e.score), certificateExpiresOn: e.certificateExpiresOn, hasCertificate: !!e.certificateFileId,
    certificateState: !e.certificateExpiresOn ? null : e.certificateExpiresOn < todayYmd ? 'EXPIRED' : e.certificateExpiresOn <= addDays(todayYmd, 60) ? 'EXPIRING' : 'VALID',
    feedbackRating: e.feedbackRating, feedbackComment: e.feedbackComment, createdAt: e.createdAt, ...extra,
  };
}
const E_INCLUDE = () => [
  { model: app.TrainingCourse, as: 'course' }, { model: app.TrainingSession, as: 'session' }, { model: app.Employee, as: 'employee', attributes: EMP_ATTRS },
];

// =========================================================================== courses
const courseBody = z.object({
  title: z.string().trim().min(3, 'Give the course a title').max(160), category: z.string().trim().min(1).max(60).default('General'), description: optText(z, 4000),
  delivery: z.enum(DELIVERY).default('IN_PERSON'), provider: optText(z, 120), durationHours: z.number().positive().max(10000).nullish(),
  costPerPerson: z.number().min(0).max(1e9).nullish(), certificateValidMonths: z.number().int().min(1).max(120).nullish(),
  mandatory: z.boolean().default(false), selfEnroll: z.boolean().default(true), active: z.boolean().default(true),
}).strict();

trainingRouter.get('/courses', requirePermission('training:view'), validate({ query: z.object({ all: z.coerce.boolean().default(false), search: z.string().trim().max(100).optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const where = { ...(!(req.query.all && isHr(req)) && { active: true }), ...(req.query.search && { title: { [Op.iLike]: `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%` } }) };
    const courses = await app.TrainingCourse.findAll({ where, order: [['mandatory', 'DESC'], ['title', 'ASC']], transaction: t });
    const sessions = await app.TrainingSession.findAll({ where: { courseId: courses.map((c) => c.id), status: 'SCHEDULED', startsAt: { [Op.gte]: new Date() } }, order: [['startsAt', 'ASC']], transaction: t });
    const me = req.auth.principal.employeeId;
    const mine = me ? await app.TrainingEnrollment.findAll({ where: { employeeId: me, status: { [Op.in]: ['REQUESTED', 'ENROLLED', 'COMPLETED'] } }, attributes: ['courseId', 'status'], raw: true, transaction: t }) : [];
    return courses.map((c) => courseView(c, {
      nextSessions: sessions.filter((s) => s.courseId === c.id).slice(0, 3).map((s) => sessionView(s)),
      myStatus: mine.find((m) => m.courseId === c.id && m.status !== 'COMPLETED')?.status ?? (mine.some((m) => m.courseId === c.id) ? 'COMPLETED' : null),
    }));
  });
  return ok(res, out);
}));

trainingRouter.post('/courses', requirePermission('training:manage'), validate({ body: courseBody }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await app.TrainingCourse.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.course_create', entityType: 'training_course', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, courseView(c));
}));

trainingRouter.patch('/courses/:id', requirePermission('training:manage'), validate({ ...idParam, body: z.object({
  title: z.string().trim().min(3).max(160), category: z.string().trim().min(1).max(60), description: optText(z, 4000), delivery: z.enum(DELIVERY), provider: optText(z, 120),
  durationHours: z.number().positive().max(10000).nullish(), costPerPerson: z.number().min(0).max(1e9).nullish(), certificateValidMonths: z.number().int().min(1).max(120).nullish(),
  mandatory: z.boolean(), selfEnroll: z.boolean(), active: z.boolean(),
}).partial().strict() }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => {
    const row = await app.TrainingCourse.findByPk(req.params.id, { transaction: t });
    if (!row) throw NotFound('Course');
    await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.course_update', entityType: 'training_course', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, courseView(c));
}));

trainingRouter.get('/courses/:id', requirePermission('training:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await app.TrainingCourse.findByPk(req.params.id, { transaction: t });
    if (!c || (!c.active && !isHr(req))) throw NotFound('Course');
    const sessions = await app.TrainingSession.findAll({ where: { courseId: c.id }, order: [['startsAt', 'DESC']], transaction: t });
    const ids = await employeeIdsIn(t, req, req.scopes);
    const list = await app.TrainingEnrollment.findAll({ where: { courseId: c.id, ...(ids && { employeeId: ids }) }, include: E_INCLUDE(), order: [['createdAt', 'DESC']], transaction: t });
    const counts = Object.fromEntries(sessions.map((s) => [s.id, list.filter((e) => e.sessionId === s.id && ['ENROLLED', 'COMPLETED'].includes(e.status)).length]));
    const ymd = today(req);
    return courseView(c, {
      sessions: sessions.map((s) => sessionView(s, { enrolled: counts[s.id] ?? 0 })),
      enrollments: list.map((e) => enrollmentView(e, ymd, { abilities: abilities(req, e) })),
      abilities: { manage: isHr(req), enrol: scopesOf(req, 'training:create').some((s) => s.scope !== 'OWN'), request: !!req.auth.principal.employeeId && c.selfEnroll && c.active },
    });
  });
  return ok(res, out);
}));

// =========================================================================== sessions
const sessionBody = z.object({
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), location: optText(z, 300), trainer: optText(z, 120),
  capacity: z.number().int().min(1).max(1000).nullish(),
}).strict().refine((b) => new Date(b.endsAt) > new Date(b.startsAt), { message: 'The session must end after it starts', path: ['endsAt'] });

trainingRouter.post('/courses/:id/sessions', requirePermission('training:manage'), validate({ ...idParam, body: sessionBody }), asyncHandler(async (req, res) => {
  const s = await req.tx(async (t) => {
    const c = await app.TrainingCourse.findByPk(req.params.id, { transaction: t });
    if (!c) throw NotFound('Course');
    const row = await app.TrainingSession.create({ ...req.body, tenantId: req.auth.tenantId, courseId: c.id, status: 'SCHEDULED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.session_create', entityType: 'training_session', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, sessionView(s));
}));

trainingRouter.post('/sessions/:id/status', requirePermission('training:manage'), validate({ ...idParam, body: z.object({ status: z.enum(['COMPLETED', 'CANCELLED']), note: optText(z, 500) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const s = await app.TrainingSession.findByPk(req.params.id, { include: [{ model: app.TrainingCourse, as: 'course' }], transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw NotFound('Session');
    if (s.status !== 'SCHEDULED') throw Conflict('This session is already closed.');
    await s.update({ status: req.body.status }, { transaction: t });
    const people = await app.TrainingEnrollment.findAll({ where: { sessionId: s.id, status: 'ENROLLED' }, transaction: t });
    if (req.body.status === 'CANCELLED') {
      await app.TrainingEnrollment.update({ sessionId: null }, { where: { sessionId: s.id, status: 'ENROLLED' }, transaction: t });
      const users = await Promise.all(people.map((e) => userIdForEmployee(t, e.employeeId)));
      await notifyUsers(t, users, { type: 'training.cancelled', title: `Training session cancelled: ${s.course.title}`, body: req.body.note ?? 'You stay enrolled on the course and will hear about the next session.', link: '/me/training', email: true });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.session_status', entityType: 'training_session', entityId: s.id, after: req.body, req });
    return { status: s.status, enrolled: people.length };
  });
  return ok(res, out);
}));

trainingRouter.get('/sessions', requirePermission('training:view'), validate({ query: z.object({ from: z.string().date().optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00+05:45`) : new Date(Date.now() - 86_400_000);
    const rows = await app.TrainingSession.findAll({ where: { startsAt: { [Op.gte]: from } }, include: [{ model: app.TrainingCourse, as: 'course', where: { active: true } }], order: [['startsAt', 'ASC']], limit: 100, transaction: t });
    const counts = await app.TrainingEnrollment.findAll({ where: { sessionId: rows.map((s) => s.id), status: ['ENROLLED', 'COMPLETED'] }, attributes: ['sessionId'], raw: true, transaction: t });
    return rows.map((s) => sessionView(s, { course: courseView(s.course), enrolled: counts.filter((c) => c.sessionId === s.id).length }));
  });
  return ok(res, out);
}));

// =========================================================================== enrolments
function abilities(req, e) {
  const own = e.employeeId === req.auth.principal.employeeId;
  const inScope = (key) => !own && employeeInScope(req, scopesOf(req, key), e.employee);
  return {
    decide: e.status === 'REQUESTED' && (inScope('training:approve') || (isHr(req) && !own)),
    complete: e.status === 'ENROLLED' && (inScope('training:edit') || (isHr(req) && !own)),
    cancel: ['REQUESTED', 'ENROLLED'].includes(e.status) && (own || inScope('training:create') || isHr(req)),
    feedback: own && e.status === 'COMPLETED' && !e.feedbackRating,
    certificate: own && e.status === 'COMPLETED',
  };
}

async function approvers(t, emp) {
  const mgr = emp.managerId ? await userIdForEmployee(t, emp.managerId) : null;
  return mgr ? [mgr] : usersWithPermission(t, 'training:manage');
}

async function checkSession(t, course, sessionId) {
  if (!sessionId) return null;
  const s = await app.TrainingSession.findOne({ where: { id: sessionId, courseId: course.id }, transaction: t, lock: t.LOCK.UPDATE });
  if (!s) throw BadRequest('Choose a session of this course', [{ path: 'sessionId', message: 'Not found' }]);
  if (s.status !== 'SCHEDULED' || new Date(s.endsAt) < new Date()) throw Conflict('That session is no longer open for enrolment.', 'SESSION_CLOSED');
  return s;
}
async function seatsLeft(t, s, adding) {
  if (!s?.capacity) return;
  const taken = await app.TrainingEnrollment.count({ where: { sessionId: s.id, status: ['ENROLLED', 'COMPLETED'] }, transaction: t });
  if (taken + adding > s.capacity) throw Conflict(`Only ${Math.max(0, s.capacity - taken)} seat${s.capacity - taken === 1 ? '' : 's'} left in that session.`, 'SESSION_FULL');
}

trainingRouter.post('/enrollments', requirePermission('training:create'), validate({ body: z.object({
  courseId: z.string().uuid(), sessionId: z.string().uuid().nullish(), employeeIds: z.array(z.string().uuid()).min(1).max(200).optional(), note: optText(z, 500),
}).strict() }), asyncHandler(async (req, res) => {
  const b = req.body;
  const out = await req.tx(async (t) => {
    const course = await app.TrainingCourse.findByPk(b.courseId, { transaction: t });
    if (!course || !course.active) throw NotFound('Course');
    const session = await checkSession(t, course, b.sessionId);
    const me = req.auth.principal.employeeId;
    const selfOnly = !b.employeeIds || (b.employeeIds.length === 1 && b.employeeIds[0] === me);
    if (selfOnly) {
      const empId = myEmployeeId(req);
      if (!course.selfEnroll && !isHr(req)) throw Forbidden('This course is by invitation. Ask your manager or HR.', 'INVITE_ONLY');
      if (await app.TrainingEnrollment.count({ where: { courseId: course.id, employeeId: empId, status: ['REQUESTED', 'ENROLLED'] }, transaction: t })) throw Conflict('You have already asked for or are enrolled on this course.', 'ALREADY_ENROLLED');
      const emp = await app.Employee.findByPk(empId, { attributes: EMP_ATTRS, transaction: t });
      const e = await app.TrainingEnrollment.create({ tenantId: req.auth.tenantId, courseId: course.id, sessionId: session?.id ?? null, employeeId: empId, status: 'REQUESTED', requestedBy: req.auth.userId, requestNote: b.note }, { transaction: t });
      await notifyUsers(t, (await approvers(t, emp)).filter((u) => u !== req.auth.userId), { type: 'training.request', title: `Training request: ${course.title}`, body: `${empName(emp)}${b.note ? ` · ${b.note}` : ''}`, link: '/training?tab=requests', email: true });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.request', entityType: 'training_enrollment', entityId: e.id, after: b, req });
      return { requested: 1, enrolled: 0, skipped: [] };
    }
    const scopes = req.scopes.filter((s) => s.scope !== 'OWN');
    if (!scopes.length && !isHr(req)) throw Forbidden('You can only ask for training for yourself.');
    const emps = await app.Employee.findAll({ where: { id: b.employeeIds, deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, attributes: EMP_ATTRS, transaction: t });
    const allowed = emps.filter((e) => isHr(req) || employeeInScope(req, scopes, e));
    if (allowed.length !== new Set(b.employeeIds).size) throw BadRequest('Some of the people chosen are not in your team', [{ path: 'employeeIds', message: 'Out of scope' }]);
    const existing = await app.TrainingEnrollment.findAll({ where: { courseId: course.id, employeeId: allowed.map((e) => e.id), status: ['REQUESTED', 'ENROLLED'] }, transaction: t });
    const skip = new Set(existing.map((e) => e.employeeId));
    const add = allowed.filter((e) => !skip.has(e.id));
    await seatsLeft(t, session, add.length);
    // A request already waiting is approved by enrolling the same person.
    for (const ex of existing.filter((x) => x.status === 'REQUESTED')) await ex.update({ status: 'ENROLLED', decidedBy: req.auth.userId, sessionId: session?.id ?? ex.sessionId }, { transaction: t });
    await app.TrainingEnrollment.bulkCreate(add.map((e) => ({ tenantId: req.auth.tenantId, courseId: course.id, sessionId: session?.id ?? null, employeeId: e.id, status: 'ENROLLED', requestedBy: req.auth.userId, decidedBy: req.auth.userId })), { transaction: t });
    const users = await Promise.all([...add, ...emps.filter((e) => existing.some((x) => x.employeeId === e.id && x.status === 'REQUESTED'))].map((e) => userIdForEmployee(t, e.id)));
    const when = session ? ` on ${new Date(session.startsAt).toLocaleString('en-GB', { timeZone: req.auth.ctx.tenant.timezone, dateStyle: 'medium', timeStyle: 'short' })}` : '';
    await notifyUsers(t, users, { type: 'training.enrolled', title: `You are enrolled: ${course.title}`, body: `${course.mandatory ? 'Mandatory training' : 'Training'}${when}${session?.location ? ` · ${session.location}` : ''}`, link: '/me/training', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.enrol', entityType: 'training_course', entityId: course.id, after: { sessionId: session?.id, employees: add.map((e) => e.id) }, req });
    return { requested: 0, enrolled: add.length + existing.filter((x) => x.status === 'REQUESTED').length, skipped: allowed.filter((e) => existing.some((x) => x.employeeId === e.id && x.status === 'ENROLLED')).map((e) => empName(e)) };
  });
  return created(res, out);
}));

const listQ = z.object({
  view: z.enum(['mine', 'team', 'requests']).default('mine'), status: z.enum(['REQUESTED', 'ENROLLED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'REJECTED']).optional(),
  courseId: z.string().uuid().optional(), certificates: z.enum(['expiring', 'expired']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

trainingRouter.get('/enrollments', requirePermission('training:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const ymd = today(req);
  const out = await req.tx(async (t) => {
    const and = [];
    if (q.view === 'mine') {
      if (!req.auth.principal.employeeId) return { rows: [], count: 0 };
      and.push({ employeeId: req.auth.principal.employeeId });
    } else if (q.view === 'requests') {
      const scopes = isHr(req) ? [{ scope: 'COMPANY' }] : scopesOf(req, 'training:approve');
      if (!scopes.length) return { rows: [], count: 0 };
      const ids = await employeeIdsIn(t, req, scopes);
      if (ids) and.push({ employeeId: ids });
      and.push({ status: 'REQUESTED' });
      if (req.auth.principal.employeeId) and.push({ employeeId: { [Op.ne]: req.auth.principal.employeeId } });
    } else {
      const ids = await employeeIdsIn(t, req, req.scopes);
      if (ids) and.push({ employeeId: ids });
    }
    if (q.status) and.push({ status: q.status });
    if (q.courseId) and.push({ courseId: q.courseId });
    if (q.certificates === 'expiring') and.push({ status: 'COMPLETED', certificateExpiresOn: { [Op.between]: [ymd, addDays(ymd, 60)] } });
    if (q.certificates === 'expired') and.push({ status: 'COMPLETED', certificateExpiresOn: { [Op.lt]: ymd } });
    const { rows, count } = await app.TrainingEnrollment.findAndCountAll({ where: and.length ? { [Op.and]: and } : {}, include: E_INCLUDE(), order: [['createdAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, distinct: true, transaction: t });
    return { rows: rows.map((e) => enrollmentView(e, ymd, { abilities: abilities(req, e) })), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

async function loadEnrollment(req, t, id) {
  const e = await app.TrainingEnrollment.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!e) throw NotFound('Enrolment');
  e.course = await app.TrainingCourse.findByPk(e.courseId, { transaction: t });
  e.employee = await app.Employee.findByPk(e.employeeId, { attributes: EMP_ATTRS, transaction: t });
  e.session = e.sessionId ? await app.TrainingSession.findByPk(e.sessionId, { transaction: t }) : null;
  const own = e.employeeId === req.auth.principal.employeeId;
  if (!own && !isHr(req) && !employeeInScope(req, scopesOf(req, 'training:view'), e.employee)) throw NotFound('Enrolment');
  return e;
}

trainingRouter.post('/enrollments/:id/decide', requirePermission('training:view'), validate({ ...idParam, body: z.object({ approve: z.boolean(), sessionId: z.string().uuid().nullish(), note: optText(z, 500) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    if (!abilities(req, e).decide) throw Forbidden('You cannot decide this request.');
    if (!req.body.approve && !req.body.note) throw BadRequest('Say why', [{ path: 'note', message: 'Give a reason' }]);
    let session = e.session;
    if (req.body.approve && req.body.sessionId) session = await checkSession(t, e.course, req.body.sessionId);
    if (req.body.approve) await seatsLeft(t, session, 1);
    await e.update({ status: req.body.approve ? 'ENROLLED' : 'REJECTED', sessionId: req.body.approve ? session?.id ?? null : e.sessionId, decidedBy: req.auth.userId, decisionNote: req.body.note }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, e.employeeId)], { type: 'training.decided', title: req.body.approve ? `Approved: ${e.course.title}` : `Not approved: ${e.course.title}`, body: req.body.note, link: '/me/training', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: req.body.approve ? 'training.approve' : 'training.reject', entityType: 'training_enrollment', entityId: e.id, after: req.body, req });
    return { status: e.status };
  });
  return ok(res, out);
}));

trainingRouter.post('/enrollments/:id/complete', requirePermission('training:view'), upload.single('certificate'), validate({ ...idParam, body: z.object({
  outcome: z.enum(['COMPLETED', 'NO_SHOW']), completedOn: z.string().date().optional(),
  score: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().min(0).max(100).optional()),
}).strict() }), asyncHandler(async (req, res) => {
  if (req.file) checkUpload(req.file, 'certificate');
  const out = await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    if (!abilities(req, e).complete) throw Forbidden('You cannot record the result for this person.');
    const ymd = today(req);
    const on = req.body.completedOn ?? ymd;
    if (on > ymd) throw BadRequest('The completion date is in the future', [{ path: 'completedOn', message: 'Future date' }]);
    const done = req.body.outcome === 'COMPLETED';
    const file = done && req.file ? await saveUpload(req, t, req.file, { ownerType: 'TRAINING_CERTIFICATE', ownerId: e.id, category: 'Training certificate', folder: 'training' }) : null;
    await e.update({
      status: req.body.outcome, completedOn: done ? on : null, score: done ? req.body.score ?? null : null,
      certificateExpiresOn: done && e.course.certificateValidMonths ? addMonths(on, e.course.certificateValidMonths) : null,
      ...(file && { certificateFileId: file.id }),
    }, { transaction: t });
    if (done) await notifyUsers(t, [await userIdForEmployee(t, e.employeeId)], { type: 'training.completed', title: `Completed: ${e.course.title}`, body: 'Well done. Tell us how the training was so we can improve it.', link: '/me/training' });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.complete', entityType: 'training_enrollment', entityId: e.id, after: { ...req.body, certificate: !!file }, req });
    return enrollmentView(e, ymd);
  });
  return ok(res, out);
}));

trainingRouter.post('/enrollments/:id/certificate', requirePermission('training:view'), upload.single('certificate'), validate(idParam), asyncHandler(async (req, res) => {
  if (!req.file) throw BadRequest('Attach the certificate', [{ path: 'certificate', message: 'Required' }]);
  checkUpload(req.file, 'certificate');
  await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    const own = e.employeeId === req.auth.principal.employeeId;
    if (e.status !== 'COMPLETED' || !(own || abilities(req, { ...e.toJSON(), status: 'ENROLLED', employee: e.employee }).complete)) throw Forbidden('You cannot add a certificate to this training.');
    const file = await saveUpload(req, t, req.file, { ownerType: 'TRAINING_CERTIFICATE', ownerId: e.id, category: 'Training certificate', folder: 'training' });
    await e.update({ certificateFileId: file.id }, { transaction: t });
  });
  return ok(res, { saved: true });
}));

trainingRouter.get('/enrollments/:id/certificate', requirePermission('training:view'), validate(idParam), asyncHandler(async (req, res) => {
  const file = await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    return e.certificateFileId ? app.File.findByPk(e.certificateFileId, { transaction: t }) : null;
  });
  if (!file) throw NotFound('Certificate');
  return sendFile(res, file);
}));

trainingRouter.post('/enrollments/:id/cancel', requirePermission('training:view'), validate({ ...idParam, body: z.object({ note: optText(z, 500) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    if (!abilities(req, e).cancel) throw Forbidden('You cannot cancel this enrolment.');
    await e.update({ status: 'CANCELLED', decisionNote: req.body.note ?? e.decisionNote }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.cancel', entityType: 'training_enrollment', entityId: e.id, after: req.body, req });
  });
  return ok(res, { status: 'CANCELLED' });
}));

trainingRouter.post('/enrollments/:id/feedback', requirePermission('training:view'), validate({ ...idParam, body: z.object({ rating: z.number().int().min(1).max(5), comment: optText(z, 1000) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const e = await loadEnrollment(req, t, req.params.id);
    if (!abilities(req, e).feedback) throw Forbidden('You can rate a training you completed, once.');
    await e.update({ feedbackRating: req.body.rating, feedbackComment: req.body.comment }, { transaction: t });
  });
  return ok(res, { saved: true });
}));

// =========================================================================== summary and compliance
trainingRouter.get('/summary', requirePermission('training:view'), asyncHandler(async (req, res) => {
  const ymd = today(req);
  const out = await req.tx(async (t) => {
    const me = req.auth.principal.employeeId;
    let mine = null;
    if (me) {
      const list = await app.TrainingEnrollment.findAll({ where: { employeeId: me }, include: [{ model: app.TrainingCourse, as: 'course' }, { model: app.TrainingSession, as: 'session' }], transaction: t });
      const fy = ymd.slice(5) >= '07-17' ? `${ymd.slice(0, 4)}-07-17` : `${Number(ymd.slice(0, 4)) - 1}-07-17`;
      mine = {
        upcoming: list.filter((e) => e.status === 'ENROLLED').length, requested: list.filter((e) => e.status === 'REQUESTED').length,
        completedThisYear: list.filter((e) => e.status === 'COMPLETED' && e.completedOn >= fy).length,
        hoursThisYear: list.filter((e) => e.status === 'COMPLETED' && e.completedOn >= fy).reduce((n, e) => n + Number(e.course.durationHours ?? 0), 0),
        expiring: list.filter((e) => e.status === 'COMPLETED' && e.certificateExpiresOn && e.certificateExpiresOn <= addDays(ymd, 60)).length,
      };
    }
    const apprScopes = isHr(req) ? [{ scope: 'COMPANY' }] : scopesOf(req, 'training:approve');
    let team = null;
    if (apprScopes.length || req.scopes.some((s) => s.scope !== 'OWN')) {
      const ids = await employeeIdsIn(t, req, apprScopes.length ? apprScopes : req.scopes);
      const base = ids ? { employeeId: ids } : {};
      team = {
        requests: apprScopes.length ? await app.TrainingEnrollment.count({ where: { ...base, status: 'REQUESTED', ...(me && { employeeId: ids ? ids.filter((x) => x !== me) : { [Op.ne]: me } }) }, transaction: t }) : 0,
        expiring: await app.TrainingEnrollment.count({ where: { ...base, status: 'COMPLETED', certificateExpiresOn: { [Op.between]: [ymd, addDays(ymd, 60)] } }, transaction: t }),
        expired: await app.TrainingEnrollment.count({ where: { ...base, status: 'COMPLETED', certificateExpiresOn: { [Op.lt]: ymd } }, transaction: t }),
        upcomingSessions: await app.TrainingSession.count({ where: { status: 'SCHEDULED', startsAt: { [Op.gte]: new Date() } }, transaction: t }),
      };
    }
    return { mine, team };
  });
  return ok(res, out);
}));

/** Mandatory courses: who has a valid completion, who is enrolled, who has nothing. */
async function compliance(req, t) {
  const ymd = today(req);
  const ids = await employeeIdsIn(t, req, req.scopes);
  const emps = await app.Employee.findAll({ where: { deletedAt: null, status: { [Op.ne]: 'TERMINATED' }, ...(ids && { id: ids }) }, attributes: EMP_ATTRS, order: [['firstName', 'ASC']], transaction: t });
  const courses = await app.TrainingCourse.findAll({ where: { mandatory: true, active: true }, order: [['title', 'ASC']], transaction: t });
  const enr = await app.TrainingEnrollment.findAll({ where: { courseId: courses.map((c) => c.id), employeeId: emps.map((e) => e.id), status: ['ENROLLED', 'COMPLETED'] }, raw: true, transaction: t });
  return {
    courses: courses.map((c) => ({ id: c.id, title: c.title })),
    rows: emps.map((e) => ({
      employee: empRef(e),
      courses: Object.fromEntries(courses.map((c) => {
        const mine = enr.filter((x) => x.courseId === c.id && x.employeeId === e.id);
        const best = mine.filter((x) => x.status === 'COMPLETED').sort((a, b) => String(b.completedOn).localeCompare(String(a.completedOn)))[0];
        const state = best ? (best.certificateExpiresOn && best.certificateExpiresOn < ymd ? 'EXPIRED' : 'DONE') : mine.some((x) => x.status === 'ENROLLED') ? 'ENROLLED' : 'MISSING';
        return [c.id, { state, completedOn: best?.completedOn ?? null, expiresOn: best?.certificateExpiresOn ?? null }];
      })),
    })),
  };
}

trainingRouter.get('/compliance', requirePermission('training:view'), asyncHandler(async (req, res) => {
  if (!req.scopes.some((s) => s.scope !== 'OWN')) throw Forbidden();
  return ok(res, await req.tx((t) => compliance(req, t)));
}));

trainingRouter.get('/export', requirePermission('training:export'), validate({ query: z.object({ from: z.string().date(), to: z.string().date() }).strict() }), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const rows = await req.tx(async (t) => {
    const ids = await employeeIdsIn(t, req, req.scopes);
    const list = await app.TrainingEnrollment.findAll({ where: { status: 'COMPLETED', completedOn: { [Op.between]: [from, to] }, ...(ids && { employeeId: ids }) }, include: E_INCLUDE(), order: [['completedOn', 'ASC']], transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'training.export', after: { from, to, count: list.length }, req });
    return list;
  });
  const header = ['Employee ID', 'Employee', 'Course', 'Category', 'Delivery', 'Hours', 'Completed on', 'Score', 'Certificate valid until', 'Cost (NPR)', 'Feedback'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="training-${from}-to-${to}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, rows.map((e) => [e.employee.employeeCode, empName(e.employee), e.course.title, e.course.category, e.course.delivery.replace(/_/g, ' ').toLowerCase(), num(e.course.durationHours) ?? '', e.completedOn, num(e.score) ?? '', e.certificateExpiresOn ?? '', num(e.course.costPerPerson) ?? '', e.feedbackRating ?? ''])));
}));

