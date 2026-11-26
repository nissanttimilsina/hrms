import crypto from 'node:crypto';
import { env } from '../../config/env.js';

/** AES-256-GCM for sensitive fields at rest (e.g. bank account numbers). Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
const key = () => Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');

export function encryptField(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptField(token) {
  if (!token) return null;
  const [v, iv, tag, data] = token.split('.');
  if (v !== 'v1') throw new Error('Unknown encryption version');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
