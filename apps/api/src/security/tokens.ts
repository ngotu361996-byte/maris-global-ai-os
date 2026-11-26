import { createHash, randomBytes } from 'node:crypto';

/** Opaque bearer token; only its SHA-256 is stored. */
export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
