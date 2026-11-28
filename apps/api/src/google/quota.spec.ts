import { googleErrorKind, quotaDayStart, quotaRefusal, quotaResetAt, quotaState } from './quota';
import {
  effectivePrivacy,
  metadataErrors,
  receivedBytes,
  shortProblem,
  tagsLength,
  uploadWarnings,
} from './youtube-rules';

describe('Google quota rules', () => {
  it('counts the day from midnight Pacific time, winter and summer', () => {
    // 08:00 UTC on 28 Nov is 00:00 PST (UTC-8).
    expect(quotaDayStart(new Date('2026-11-28T10:00:00Z')).toISOString()).toBe(
      '2026-11-28T08:00:00.000Z',
    );
    expect(quotaDayStart(new Date('2026-11-28T07:59:00Z')).toISOString()).toBe(
      '2026-11-27T08:00:00.000Z',
    );
    // In July Los Angeles is UTC-7.
    expect(quotaDayStart(new Date('2026-07-10T12:00:00Z')).toISOString()).toBe(
      '2026-07-10T07:00:00.000Z',
    );
    expect(quotaResetAt(new Date('2026-11-28T10:00:00Z')).toISOString()).toBe(
      '2026-11-29T08:00:00.000Z',
    );
    // The day clocks go back (1 Nov 2026): midnight is still PDT.
    expect(quotaResetAt(new Date('2026-10-31T20:00:00Z')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
  });

  it('applies the 75/85/90% thresholds and never passes the quota', () => {
    expect(quotaState(7400, 10000).state).toBe('ok');
    expect(quotaState(7500, 10000).state).toBe('no_background');
    expect(quotaState(8600, 10000).state).toBe('essential_only');
    expect(quotaState(9000, 10000).state).toBe('paused');
    expect(quotaRefusal(1000, 10000, 1600, 'essential')).toBeNull();
    expect(quotaRefusal(7600, 10000, 1, 'background')).toMatch(/để sau/);
    expect(quotaRefusal(7600, 10000, 1, 'normal')).toBeNull();
    expect(quotaRefusal(8600, 10000, 1, 'normal')).toMatch(/thiết yếu/);
    expect(quotaRefusal(8600, 10000, 1600, 'essential')).toMatch(/còn 1400 đơn vị/);
    expect(quotaRefusal(9100, 10000, 1, 'essential')).toMatch(/tạm dừng/);
  });

  it('sorts Google errors by what to do about them', () => {
    const e = (reason: string) => ({ error: { code: 403, message: 'x', errors: [{ reason }] } });
    expect(googleErrorKind(403, e('quotaExceeded'))).toBe('quota');
    expect(googleErrorKind(403, e('rateLimitExceeded'))).toBe('rate');
    expect(googleErrorKind(400, e('uploadLimitExceeded'))).toBe('upload_limit');
    expect(googleErrorKind(403, e('insufficientPermissions'))).toBe('permission');
    expect(googleErrorKind(401, e('authError'))).toBe('token');
    expect(googleErrorKind(400, { error: 'invalid_grant' })).toBe('token');
    expect(googleErrorKind(503, e('backendError'))).toBe('transient');
    expect(googleErrorKind(429, null)).toBe('rate');
    expect(googleErrorKind(400, e('invalidTitle'))).toBe('other');
  });
});

describe('YouTube upload rules', () => {
  it('checks title, description and tags as YouTube does', () => {
    expect(metadataErrors({ title: 'Áo thun mới', description: 'Mô tả', tags: ['áo'] })).toEqual(
      [],
    );
    expect(metadataErrors({ title: 'a'.repeat(101), description: '', tags: [] })).toHaveLength(1);
    expect(metadataErrors({ title: 'x <b>', description: '', tags: [] })[0]).toMatch(/</);
    // 5,000 bytes, not characters: Vietnamese letters with marks take 2 or 3 bytes.
    expect(metadataErrors({ title: 'x', description: 'ế'.repeat(1700), tags: [] })[0]).toMatch(
      /byte/,
    );
    expect(tagsLength(['a b', 'c'])).toBe(7);
    expect(metadataErrors({ title: 'x', description: '', tags: ['a,b'] })).toHaveLength(1);
    expect(
      metadataErrors({ title: 'x', description: '', tags: Array(30).fill('mười tám ký tự') }),
    ).toHaveLength(1);
  });

  it('knows which videos can be Shorts and what to warn about', () => {
    expect(shortProblem(1080, 1920, 40_000)).toBeNull();
    expect(shortProblem(1080, 1080, 180_000)).toBeNull();
    expect(shortProblem(1920, 1080, 40_000)).toMatch(/dọc/);
    expect(shortProblem(1080, 1920, 181_000)).toMatch(/3 phút/);
    expect(
      uploadWarnings({
        format: 'video',
        durationMs: 20 * 60_000,
        longUploads: 'eligible',
        audited: true,
        privacy: 'public',
      }),
    ).toHaveLength(1);
    expect(
      uploadWarnings({
        format: 'video',
        durationMs: 20 * 60_000,
        longUploads: 'allowed',
        audited: true,
        privacy: 'public',
      }),
    ).toEqual([]);
    expect(
      uploadWarnings({
        format: 'video',
        durationMs: 1000,
        longUploads: null,
        audited: false,
        privacy: 'public',
      })[0],
    ).toMatch(/Riêng tư/);
    expect(effectivePrivacy('public', false)).toBe('private');
    expect(effectivePrivacy('unlisted', true)).toBe('unlisted');
    expect(receivedBytes('bytes=0-524287')).toBe(524288);
    expect(receivedBytes(null)).toBe(0);
  });
});
