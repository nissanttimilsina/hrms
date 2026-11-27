import { Op, QueryTypes } from 'sequelize';
import { app, appDb } from '../database/index.js';
import { scopeWhere, recordInScope } from './rbac.service.js';
import { BadRequest } from '../utils/errors.js';

/**
 * Small helpers shared by the HR modules (assets, onboarding, recruitment, helpdesk, training,
 * appraisals, engagement, workforce planning, request workflows).
 */
export const EMP_ATTRS = ['id', 'firstName', 'lastName', 'employeeCode', 'managerId', 'departmentId', 'branchId', 'designationId', 'status', 'joinedOn'];
export const empName = (e) => (e ? `${e.firstName} ${e.lastName}` : null);
export const empRef = (e) => (e ? { id: e.id, name: empName(e), code: e.employeeCode } : null);

export const scopesOf = (req, key) => req.auth.grants.get(key)?.scopes ?? [];
export const isCompany = (scopes) => scopes.some((s) => s.scope === 'COMPANY');
export const holds = (req, key) => req.auth.grants.has(key);

/** The caller's employee record id, or a clear error when the login is not linked to one. */
export function myEmployeeId(req) {
  if (!req.auth.principal.employeeId) throw BadRequest('Your account is not linked to an employee record. Ask HR to link it.', [{ path: 'employee', message: 'Not linked' }]);
  return req.auth.principal.employeeId;
}

/** Employee ids inside a set of scopes; null means every employee (COMPANY). */
export async function employeeIdsIn(t, req, scopes) {
  if (isCompany(scopes)) return null;
  if (!scopes.length) return [];
  const rows = await app.Employee.findAll({ where: { [Op.and]: [scopeWhere(scopes, req.auth.principal), { deletedAt: null }] }, attributes: ['id'], raw: true, transaction: t });
  return rows.map((r) => r.id);
}

/** Is this employee (record with branchId/departmentId/managerId) inside the scopes, or the caller themself? */
export function employeeInScope(req, scopes, emp) {
  if (!emp) return false;
  if (emp.id === req.auth.principal.employeeId && scopes.length) return true;
  return scopes.length > 0 && recordInScope(scopes, req.auth.principal, emp);
}

/** Next per-company number for a table with a "number" column, under an advisory lock. */
export async function nextNumber(t, table) {
  await appDb.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `${table}:${t.tenantId}` }, transaction: t });
  const [{ n }] = await appDb.query(`SELECT coalesce(max(number), 0) + 1 AS n FROM ${table}`, { type: QueryTypes.SELECT, transaction: t });
  return Number(n);
}

/** Map of user id → full name. */
export async function userNames(t, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const users = await app.User.findAll({ where: { id: list }, attributes: ['id', 'fullName'], transaction: t });
  return Object.fromEntries(users.map((u) => [u.id, u.fullName]));
}

/** Map of employee id → employee (EMP_ATTRS). */
export async function employeesById(t, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await app.Employee.findAll({ where: { id: list }, attributes: EMP_ATTRS, transaction: t });
  return Object.fromEntries(rows.map((e) => [e.id, e]));
}

/** Read a tenant setting with defaults. */
export async function getSetting(t, key, defaults) {
  const row = await app.TenantSetting.findOne({ where: { key }, transaction: t });
  return { ...defaults, ...(row?.value ?? {}) };
}
export async function putSetting(t, tenantId, key, value) {
  const [row] = await app.TenantSetting.findOrCreate({ where: { key }, defaults: { tenantId, value }, transaction: t });
  await row.update({ value }, { transaction: t });
  return value;
}

/** Escape text for an ILIKE search. */
export const like = (s) => `%${String(s).replace(/[%_\\]/g, '\\$&')}%`;

/** CSV body with a BOM, formula-injection safe. */
export function toCsv(header, lines) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@\t]/, "'$&")}"`;
  return `﻿${[header.map(esc).join(','), ...lines.map((l) => l.map(esc).join(','))].join('\r\n')}`;
}

/** Optional trimmed text that becomes null when empty. */
export const optText = (z, max) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);
