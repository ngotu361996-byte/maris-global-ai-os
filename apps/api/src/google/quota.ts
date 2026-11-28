import { YOUTUBE_QUOTA_TIMEZONE, type ApiPriority, type QuotaResponse } from '@maris/contracts';
import { allows, levelLabel, stateFor } from '../meta/governor';

/**
 * Google quota rules (spec Part 15 applied to Google, Part 16), as pure functions. The YouTube
 * Data API counts units per Google Cloud project per day, from midnight Pacific time. MARIS applies
 * the same thresholds as for Meta (75% puts off background work, 85% essential only, 90% stops)
 * and never sends a call that would go past the daily quota.
 */

/** Minutes east of UTC that a time zone is at this instant (Los Angeles: -480 or -420). */
function offsetMinutes(at: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Midnight of the day `at` falls in, in the quota's time zone. */
export function quotaDayStart(at: Date, timeZone: string = YOUTUBE_QUOTA_TIMEZONE): Date {
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, mo - 1, d);
  // The offset at midnight itself, which differs from now's on the days clocks change.
  let start = utcMidnight - offsetMinutes(at, timeZone) * 60_000;
  start = utcMidnight - offsetMinutes(new Date(start), timeZone) * 60_000;
  return new Date(start);
}

/** When the quota starts again: the next midnight in the quota's time zone. */
export function quotaResetAt(at: Date, timeZone: string = YOUTUBE_QUOTA_TIMEZONE): Date {
  const start = quotaDayStart(at, timeZone);
  return quotaDayStart(new Date(start.getTime() + 26 * 3600_000), timeZone);
}

export interface QuotaState {
  used: number;
  quota: number;
  pct: number;
  state: Exclude<QuotaResponse['state'], 'blocked'>;
  level: string;
}

export function quotaState(used: number, quota: number): QuotaState {
  const pct = quota > 0 ? Math.round((used / quota) * 1000) / 10 : used > 0 ? 100 : 0;
  return { used, quota, pct, state: stateFor(pct), level: levelLabel(pct) };
}

/**
 * Why a call of this cost and priority may not go out now, or null when it may. A call that
 * would pass the daily quota is refused whatever its priority: Google would refuse it anyway.
 */
export function quotaRefusal(
  used: number,
  quota: number,
  cost: number,
  priority: ApiPriority,
): string | null {
  const s = quotaState(used, quota);
  if (used + cost > quota)
    return `Hạn mức YouTube hôm nay còn ${Math.max(0, quota - used)} đơn vị, lượt này cần ${cost}`;
  if (allows(s.state, priority)) return null;
  if (s.state === 'paused')
    return `Hạn mức YouTube đã dùng ${s.pct}% (${used}/${quota}); tạm dừng tới khi Google tính lại`;
  return `Hạn mức YouTube đã dùng ${s.pct}%; chỉ chạy việc ${s.state === 'essential_only' ? 'thiết yếu' : 'cần ngay'}, việc này để sau`;
}

export type GoogleErrorKind =
  'quota' | 'rate' | 'upload_limit' | 'token' | 'permission' | 'transient' | 'other';

/** Google API errors: {error: {code, message, errors: [{reason}]}} or OAuth's {error: "..."}. */
export function googleErrorKind(status: number, body: unknown): GoogleErrorKind {
  const err = (body as { error?: unknown } | null)?.error;
  const reasons =
    err && typeof err === 'object'
      ? ((err as { errors?: { reason?: string }[] }).errors ?? []).map((e) => e.reason ?? '')
      : [];
  const oauth = typeof err === 'string' ? err : '';
  if (reasons.some((r) => r === 'quotaExceeded' || r === 'dailyLimitExceeded')) return 'quota';
  if (reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'))
    return 'rate';
  if (reasons.includes('uploadLimitExceeded')) return 'upload_limit';
  if (status === 401 || oauth === 'invalid_grant' || reasons.includes('authError')) return 'token';
  if (
    status === 403 &&
    reasons.some((r) =>
      [
        'insufficientPermissions',
        'forbidden',
        'youtubeSignupRequired',
        'accessNotConfigured',
      ].includes(r),
    )
  )
    return 'permission';
  // Newer Google APIs (Analytics, Search Console) send a status name instead of reasons.
  const statusName =
    err && typeof err === 'object' ? String((err as { status?: unknown }).status ?? '') : '';
  if (status === 403 && statusName === 'PERMISSION_DENIED') return 'permission';
  if (status === 429) return 'rate';
  if (status >= 500 || reasons.includes('backendError')) return 'transient';
  return 'other';
}

/** Google's own message for an error, short and without anything after the first line. */
export function googleErrorMessage(status: number, body: unknown): string {
  const err = (body as { error?: unknown; error_description?: unknown } | null) ?? null;
  const e = err?.error;
  const text =
    e && typeof e === 'object'
      ? String((e as { message?: unknown }).message ?? '')
      : String(err?.error_description ?? e ?? '');
  return (text.split('\n')[0] || `HTTP ${status}`).slice(0, 300);
}

/** The first reason in a Google error, for the call log: "quotaExceeded". */
export function googleErrorReason(body: unknown): string | null {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err.slice(0, 50);
  const r = (err as { errors?: { reason?: string }[] } | undefined)?.errors?.[0]?.reason;
  return r ? r.slice(0, 50) : null;
}
