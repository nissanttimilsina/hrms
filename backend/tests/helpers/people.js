import { makeTenant, login, as, makeUser } from './context.js';
import { localDate, fiscalYear, fiscalYearRange } from '../../src/services/hr/calendar.js';

/**
 * A small company for module tests:
 *   owner · boss (team leader, manages staff and other) · staff · other · hr (HR manager, linked to an employee)
 *   officer (HR officer) · finance (payroll manager) · dept (department manager of Sales)
 */
export async function company(slug, plan = 'BUSINESS') {
  const T = await makeTenant(slug, plan);
  const owner = as(slug, (await login(slug, T.ownerEmail)).token);
  const hq = (await owner.get('/branches')).body.data[0];
  const sales = (await owner.post('/departments').send({ code: 'SALES', name: 'Sales', branchId: hq.id })).body.data;
  const today = localDate(new Date(), 'Asia/Kathmandu');
  const fy = fiscalYearRange(fiscalYear(today));
  const emp = {};
  const mk = async (k, extra = {}) => {
    const r = await owner.post('/employees').send({ firstName: k[0].toUpperCase() + k.slice(1), lastName: 'Test', joinedOn: fy.start, branchId: hq.id, departmentId: sales?.id, ...extra });
    if (r.status !== 201) throw new Error(`employee ${k}: ${JSON.stringify(r.body)}`);
    emp[k] = r.body.data;
  };
  await mk('boss', { gender: 'MALE' });
  await mk('staff', { managerId: emp.boss.id, gender: 'FEMALE' });
  await mk('other', { managerId: emp.boss.id });
  await mk('hr');
  await mk('dept');
  await makeUser(T.id, { email: `boss@${slug}.test`, roles: ['team_leader', 'employee'], employeeId: emp.boss.id });
  await makeUser(T.id, { email: `staff@${slug}.test`, roles: ['employee'], employeeId: emp.staff.id });
  await makeUser(T.id, { email: `other@${slug}.test`, roles: ['employee'], employeeId: emp.other.id });
  await makeUser(T.id, { email: `hr@${slug}.test`, roles: ['hr_manager', 'employee'], employeeId: emp.hr.id });
  await makeUser(T.id, { email: `dept@${slug}.test`, roles: ['department_manager', 'employee'], employeeId: emp.dept.id });
  await makeUser(T.id, { email: `officer@${slug}.test`, roles: ['hr_officer'] });
  await makeUser(T.id, { email: `finance@${slug}.test`, roles: ['payroll_manager'] });
  const tok = async (u) => as(slug, (await login(slug, `${u}@${slug}.test`)).token);
  const users = { owner };
  for (const u of ['boss', 'staff', 'other', 'hr', 'dept', 'officer', 'finance']) users[u] = await tok(u);
  return { T, slug, hq, sales, emp, today, fy, ...users };
}
