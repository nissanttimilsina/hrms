import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

/**
 * Private object storage. Files are NEVER served from public URLs: downloads go
 * through authenticated, permission-checked API endpoints that stream the bytes.
 * Keys are always prefixed by tenant: tenants/<tenantId>/<uuid>.
 */
let s3;
const client = () => (s3 ??= new S3Client({
  region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
}));
const localPath = (key) => {
  const p = path.resolve(env.STORAGE_DIR, key);
  if (!p.startsWith(path.resolve(env.STORAGE_DIR) + path.sep)) throw new Error('Invalid storage key');
  return p;
};

export const storage = {
  async put(key, buffer, contentType) {
    if (env.STORAGE_DRIVER === 's3') {
      await client().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: 'AES256' }));
      return;
    }
    const p = localPath(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(p, buffer, { mode: 0o600 });
  },
  async stream(key) {
    if (env.STORAGE_DRIVER === 's3') return (await client().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))).Body;
    return fs.createReadStream(localPath(key));
  },
  async remove(key) {
    if (env.STORAGE_DRIVER === 's3') return client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    await fs.promises.rm(localPath(key), { force: true });
  },
};
