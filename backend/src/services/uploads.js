import crypto from 'node:crypto';
import multer from 'multer';
import { app } from '../database/index.js';
import { env } from '../config/env.js';
import { storage } from './storage.service.js';
import { assertStorageAvailable, addUsage } from './subscription.service.js';
import { BadRequest } from '../utils/errors.js';

/**
 * Shared handling for small private uploads (receipts, attachments).
 * Files are checked by their first bytes, not only by the declared type,
 * and stored under the tenant's private prefix. Downloads always go through
 * permission-checked endpoints.
 */
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

const SIGNATURES = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] };
export const sniffOk = (buf, mime) => !!SIGNATURES[mime] && SIGNATURES[mime].every((b, i) => buf[i] === b);

/** Validate an uploaded file; throws a field error on `field` when the type is not allowed. */
export function checkUpload(file, field = 'file') {
  if (!sniffOk(file.buffer, file.mimetype)) throw BadRequest('Only PDF, PNG or JPEG files are allowed', [{ path: field, message: 'Use a PDF, PNG or JPEG file' }]);
}

/** Store a checked upload and create its File row inside the caller's tenant transaction. */
export async function saveUpload(req, t, file, { ownerType, ownerId, category, folder }) {
  await assertStorageAvailable(req.auth.ctx, file.size, t);
  const id = crypto.randomUUID();
  const key = `tenants/${req.auth.tenantId}/${folder}/${id}`;
  await storage.put(key, file.buffer, file.mimetype);
  const row = await app.File.create({
    id, tenantId: req.auth.tenantId, ownerType, ownerId, storageKey: key,
    filename: file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'file', mimeType: file.mimetype, sizeBytes: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), category, uploadedBy: req.auth.userId,
  }, { transaction: t });
  await addUsage(req.auth.tenantId, 'storage_bytes', file.size, t);
  return row;
}

/** Stream a stored file as a download. */
export async function sendFile(res, file) {
  res.set({ 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  (await storage.stream(file.storageKey)).pipe(res);
}
