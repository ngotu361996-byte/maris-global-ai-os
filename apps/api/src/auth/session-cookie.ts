import type { CookieOptions, Request, Response } from 'express';

export const SESSION_COOKIE = 'maris_session';
/** Browsers ask for cookie mode with this header; other clients get the token in the body. */
export const SESSION_MODE_HEADER = 'x-maris-session';
/** Required on cookie-authenticated writes. A cross-site form cannot set a custom header. */
export const CSRF_HEADER = 'x-maris-csrf';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

export function wantsCookie(req: Request): boolean {
  return req.headers[SESSION_MODE_HEADER] === 'cookie';
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export type TokenSource = 'bearer' | 'cookie';

export function sessionTokenWithSource(req: Request): { token: string; source: TokenSource } | null {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && TOKEN_RE.test(bearer)) return { token: bearer, source: 'bearer' };
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && TOKEN_RE.test(cookie)) return { token: cookie, source: 'cookie' };
  return null;
}

export function sessionTokenFrom(req: Request): string | null {
  return sessionTokenWithSource(req)?.token ?? null;
}

export function cookieOptions(secure: boolean, expires?: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/api', ...(expires ? { expires } : {}) };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions(secure, expiresAt));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}
