import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Shared Redis connection (cache, rate limiting, token revocation).
 * BullMQ creates its own connections from the same URL.
 * When REDIS_URL is unset (local tooling), an in-process Map is used instead;
 * production must always configure Redis so multiple API instances agree.
 */
export const redis = env.REDIS_URL
  ? new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false })
  : null;

redis?.on('error', (err) => logger.error({ err }, 'redis error'));

const memory = new Map();

export const cache = {
  async get(key) {
    if (redis) {
      const v = await redis.get(key);
      return v == null ? null : JSON.parse(v);
    }
    const hit = memory.get(key);
    if (!hit || hit.exp < Date.now()) return null;
    return hit.value;
  },
  async set(key, value, ttlSeconds) {
    if (redis) return redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    memory.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
  },
  async del(...keys) {
    if (redis) return keys.length && redis.del(...keys);
    keys.forEach((k) => memory.delete(k));
  },
};

export async function checkRedis() {
  if (!redis) return 'disabled';
  return redis.ping();
}

export async function closeRedis() {
  if (redis) await redis.quit().catch(() => {});
}
