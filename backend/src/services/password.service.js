import argon2 from 'argon2';
import { z } from 'zod';

// OWASP 2024 recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (plain) => argon2.hash(plain, ARGON);

export const verifyPassword = async (hash, plain) => {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};

// Used when the user does not exist, so response time does not reveal account existence.
let dummyHash;
export const burnVerify = async (plain) => {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummyHash, plain);
  return false;
};

export const passwordPolicy = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), {
    message: 'Password must contain upper-case, lower-case and a number',
  });
