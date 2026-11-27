/**
 * Check the email (SMTP) settings and send one test message.
 *   docker compose exec api node src/scripts/send-test-email.js you@example.com
 * Prints the exact reason when the connection or login fails.
 */
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const to = process.argv[2];
if (!to || !to.includes('@')) { console.error('Usage: node src/scripts/send-test-email.js you@example.com'); process.exit(2); }

console.log(`Transport: ${env.EMAIL_TRANSPORT}`);
if (env.EMAIL_TRANSPORT !== 'smtp') { console.error('EMAIL_TRANSPORT is not "smtp", so emails are only written to the log. Set EMAIL_TRANSPORT=smtp in .env.'); process.exit(1); }
console.log(`Server:    ${env.SMTP_HOST}:${env.SMTP_PORT} (${env.SMTP_SECURE ? 'SSL' : 'STARTTLS'})`);
console.log(`Login:     ${env.SMTP_USER || '(none)'}`);
console.log(`From:      ${env.EMAIL_FROM}`);

const t = nodemailer.createTransport({
  host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  connectionTimeout: 15000, greetingTimeout: 15000,
});
try {
  await t.verify();
  console.log('Connected and logged in.');
  const info = await t.sendMail({ from: env.EMAIL_FROM, to, subject: 'Lishnu HRMS test email', text: 'Email from your Lishnu HRMS server is working.' });
  console.log(`Sent. Message ID ${info.messageId}. Check the inbox (and spam folder) of ${to}.`);
  process.exit(0);
} catch (e) {
  console.error(`FAILED: ${e.code || ''} ${e.message}`);
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'ECONNECTION'].includes(e.code)) console.error('The server could not reach the mail server. Check SMTP_HOST/SMTP_PORT, and that your VPS provider allows outgoing connections on that port.');
  if (e.code === 'EAUTH') console.error('The mail server rejected the login. Check SMTP_USER and SMTP_PASS (Gmail needs an app password, not your normal password).');
  process.exit(1);
}
