import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Email delivery. Templates are rendered here (subject + text + minimal HTML).
 * The tenant-customisable notification engine stores overrides in
 * notification_templates and falls back to these defaults.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const link = (url, label) => ({ text: `${label}: ${url}`, html: `<p><a href="${esc(url)}" style="background:#2453d6;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${esc(label)}</a></p>` });

export const TEMPLATES = {
  'tenant.welcome': (d) => ({ subject: `Your ${d.companyName} workspace is ready`, lines: [`Welcome to Lishnu HRMS. Your workspace for ${d.companyName} is ready.`], cta: link(d.workspaceUrl, 'Open your workspace') }),
  'tenant.invitation': (d) => ({ subject: `You've been invited to ${d.companyName}`, lines: [`An administrator created a Lishnu HRMS workspace for ${d.companyName}. Set your password to get started. The link expires in 7 days.`], cta: link(`${d.workspaceUrl}/accept-invite?token=${d.token}`, 'Set your password') }),
  'user.invitation': (d) => ({ subject: `Join ${d.companyName} on Lishnu HRMS`, lines: [`You have been invited to ${d.companyName}'s HR workspace. The link expires in 7 days.`], cta: link(`${d.workspaceUrl}/accept-invite?token=${d.token}`, 'Accept invitation') }),
  'auth.verify_email': (d) => ({ subject: 'Confirm your email to activate your workspace', lines: [`Thanks for signing up${d.companyName ? ` ${d.companyName}` : ''}. Confirm your email address to activate your workspace. The link expires in 48 hours.`], cta: link(d.url, 'Confirm email') }),
  'auth.password_reset': (d) => ({ subject: 'Reset your password', lines: ['We received a request to reset your password. The link expires in 30 minutes. If you did not request this, ignore this email.'], cta: d.url ? link(d.url, 'Reset password') : undefined }),
  'billing.invoice': (d) => ({ subject: `Invoice ${d.number} — NPR ${d.total}`, lines: [`A new invoice ${d.number} for NPR ${d.total} is due on ${d.dueDate}.`], cta: link(d.url, 'View and pay') }),
  'billing.receipt': (d) => ({ subject: `Payment received — ${d.number}`, lines: [`We received NPR ${d.total} for invoice ${d.number}. Thank you.`, d.periodEnd ? `Your subscription is active until ${d.periodEnd}.` : ''], cta: d.url ? link(d.url, 'View invoice') : undefined }),
  'billing.payment_failed': (d) => ({ subject: `Payment could not be confirmed — ${d.number}`, lines: [`Your payment for invoice ${d.number} could not be confirmed${d.reason ? `: ${d.reason}` : ''}. No changes were made to your subscription.`], cta: d.url ? link(d.url, 'Try again') : undefined }),
  'billing.bank_transfer_received': (d) => ({ subject: `Bank transfer submitted — ${d.number}`, lines: [`We have recorded your bank transfer details for invoice ${d.number}. Our finance team will verify it, usually within one business day.`] }),
  'subscription.grace_period': () => ({ subject: 'Your subscription has expired — grace period started', lines: ['Your subscription has expired. You still have full access during the grace period. Renew to avoid interruption.'] }),
  'subscription.suspended': () => ({ subject: 'Your workspace is now read-only', lines: ['Your grace period has ended. Your data is safe and can still be viewed, but changes are paused until you renew.'] }),
  'subscription.expired': () => ({ subject: 'Your subscription has ended', lines: ['Your cancelled subscription has ended. Your data is preserved and read-only. Renew any time to continue.'] }),
  'subscription.active': () => ({ subject: 'Your subscription is active', lines: ['Thank you. Your subscription is active.'] }),
  'sales.new_lead': (d) => ({ subject: `New ${d.source} lead: ${d.company || d.name}`, lines: [`${d.name} <${d.email}> ${d.phone || ''}`, `Company: ${d.company || '-'} · Employees: ${d.employeeCount ?? '-'}`, d.message || ''], cta: link(`${env.ADMIN_URL}/crm/leads/${d.id}`, 'Open lead') }),
  'lead.acknowledgement': (d) => ({ subject: d.source === 'DEMO' ? 'Your demo request has been received' : 'Thanks for contacting Lishnu HRMS', lines: [`Hi ${d.name}, thanks for reaching out. Our team will contact you within one business day.`] }),
  'support.reply': (d) => ({ subject: `[Ticket #${d.number}] ${d.subject}`, lines: ['Our support team replied to your ticket:', d.body], cta: d.url ? link(d.url, 'View ticket') : undefined }),
  'support.new_ticket': (d) => ({ subject: `New ${d.priority} ticket #${d.number}: ${d.subject}`, lines: [`From ${d.tenant}`], cta: link(`${env.ADMIN_URL}/support/${d.id}`, 'Open ticket') }),
  'notification.generic': (d) => ({ subject: d.title, lines: [d.body], cta: d.url ? link(d.url, d.cta || 'Open') : undefined }),
};

export function render(template, data = {}) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`Unknown email template ${template}`);
  const { subject, lines, cta } = t(data);
  const body = lines.filter(Boolean);
  const text = [...body, cta?.text ?? '', '', '— Lishnu HRMS'].join('\n');
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:15px;color:#334155;max-width:560px">
${body.map((l) => `<p>${esc(l)}</p>`).join('\n')}${cta?.html ?? ''}
<p style="color:#94a3b8;font-size:12px;margin-top:32px">Lishnu HRMS · Lishnu Tech Pvt. Ltd., Kathmandu, Nepal</p></div>`;
  return { subject, text, html };
}

let transporter;
function smtp() {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendEmail({ to, template, data, tenantId }) {
  const msg = render(template, data);
  if (env.EMAIL_TRANSPORT === 'smtp') {
    const info = await smtp().sendMail({ from: env.EMAIL_FROM, to, subject: msg.subject, text: msg.text, html: msg.html });
    logger.info({ to, template, tenantId, messageId: info.messageId }, 'email sent');
    return { delivered: true, messageId: info.messageId };
  }
  logger.info({ to, template, tenantId, subject: msg.subject, ...(env.NODE_ENV === 'development' && { text: msg.text }) }, 'email (log transport)');
  return { delivered: true, transport: 'log' };
}
