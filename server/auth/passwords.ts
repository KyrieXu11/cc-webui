// Password hashing with node:crypto's scrypt — no bcrypt/argon2 dependency.
//
// scrypt is memory-hard and built in, which matters more here than shaving
// milliseconds: this is a handful of colleagues on one machine, not a login
// endpoint under load.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): {
  hash: string;
  salt: string;
} {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  return { hash: scryptSync(password, salt, KEY_LEN).toString("hex"), salt };
}

export function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = scryptSync(password, salt, KEY_LEN);
  // Constant-time: a length-independent compare would leak how much of the
  // hash matched.
  return timingSafeEqual(actual, expected);
}
