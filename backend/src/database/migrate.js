/**
 * Minimal, dependency-free SQL migration runner.
 *  - Applies src/database/migrations/*.sql in lexical order, each in its own transaction.
 *  - Records name + sha256 checksum in schema_migrations.
 *  - Refuses to run if an already-applied file was edited (checksum mismatch).
 *  - Takes a Postgres advisory lock so concurrent deploys cannot race.
 * Runs as the OWNER role (DATABASE_URL_OWNER).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 727_001;

export async function migrate(connectionString = process.env.DATABASE_URL_OWNER, { log = console.log } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        }
        continue;
      }
      log(`→ applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    log(count ? `✓ ${count} migration(s) applied` : '✓ database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  migrate().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
