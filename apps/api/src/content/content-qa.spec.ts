import { qaReport, type QaInput } from './content-qa';

const text = (body: string, more: Partial<QaInput> = {}) =>
  qaReport({
    kind: 'text',
    platform: 'facebook',
    language: 'vi',
    version: 1,
    body,
    mime: null,
    width: null,
    height: null,
    durationMs: null,
    ...more,
  });
const file = (more: Partial<QaInput>) =>
  qaReport({
    kind: 'video',
    platform: 'tiktok',
    language: 'vi',
    version: 2,
    body: null,
    mime: 'video/mp4',
    width: 1080,
    height: 1920,
    durationMs: 30_000,
    ...more,
  });
const codes = (r: ReturnType<typeof qaReport>) => r.checks.map((c) => `${c.level}:${c.code}`);

describe('content quality checks', () => {
  it('passes a clean Vietnamese post', () => {
    expect(
      text(
        'Áo thun cotton MARIS thấm hút tốt, đủ size từ S đến XL. Nhắn tin cho shop để đặt hàng nhé! #aothun',
      ),
    ).toEqual({ status: 'pass', version: 1, checks: [] });
  });

  it('flags unproven claims, shouting, placeholders and a wrong language', () => {
    const r = text(
      'Áo thun TỐT NHẤT thị trường, cam kết hoàn tiền, giảm 5kg sau 1 tuần!!! Giá chỉ [giá]. Số 1 Việt Nam.',
    );
    expect(r.status).toBe('fail');
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        'error:QA_PLACEHOLDER',
        'warning:QA_RISKY_CLAIM',
        'warning:QA_PUNCTUATION',
      ]),
    );
    const claims = r.checks.filter((c) => c.code === 'QA_RISKY_CLAIM').map((c) => c.message);
    expect(claims.join(' ')).toContain('TỐT NHẤT');
    expect(claims.join(' ')).toContain('cam kết');
    expect(claims.join(' ')).toContain('giảm 5kg');
    expect(
      codes(
        text('THIS IS THE BEST SHIRT EVER MADE, GUARANTEED FOREVER AND EVER', { language: 'en' }),
      ),
    ).toEqual(['warning:QA_RISKY_CLAIM', 'warning:QA_SHOUTING']);
    expect(
      codes(text('Ao thun cotton thoang mat, du size tu S den XL, gia tot cho moi nguoi')),
    ).toEqual(['warning:QA_LANGUAGE']);
    expect(codes(text('   '))).toEqual(['error:QA_EMPTY']);
  });

  it('applies the platform text and hashtag limits', () => {
    expect(codes(text('a'.repeat(2201), { platform: 'instagram' }))).toContain(
      'error:QA_TEXT_TOO_LONG',
    );
    expect(codes(text('a'.repeat(2201), { platform: 'website' }))).not.toContain(
      'error:QA_TEXT_TOO_LONG',
    );
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    expect(codes(text(`Áo đẹp ${tags}`, { platform: 'instagram' }))).toContain(
      'error:QA_HASHTAGS_TOO_MANY',
    );
    expect(codes(text('Áo đẹp #a #b #c #d #e #f #g', { platform: 'tiktok' }))).toEqual([
      'warning:QA_HASHTAGS_MANY',
    ]);
  });

  it('checks a video against the platform: size, ratio and length', () => {
    expect(file({})).toEqual({ status: 'pass', version: 2, checks: [] });
    expect(codes(file({ width: 1920, height: 1080 }))).toEqual(['warning:QA_RATIO']);
    expect(codes(file({ width: 480, height: 854 }))).toEqual(['error:QA_TOO_SMALL']);
    expect(codes(file({ durationMs: 11 * 60_000 }))).toEqual(['error:QA_TOO_LONG']);
    expect(codes(file({ width: null, height: null, durationMs: null }))).toEqual([
      'info:QA_SIZE_UNKNOWN',
      'info:QA_LENGTH_UNKNOWN',
    ]);
    expect(file({ width: null, height: null, durationMs: null }).status).toBe('pass');
    expect(codes(file({ mime: 'image/jpeg', durationMs: null }))).toEqual(['error:QA_WRONG_FILE']);
  });

  it('checks an image size and ratio', () => {
    const img = (more: Partial<QaInput>) =>
      file({ kind: 'image', platform: 'instagram', mime: 'image/jpeg', durationMs: null, ...more });
    expect(img({ width: 1080, height: 1350 }).status).toBe('pass');
    expect(codes(img({ width: 200, height: 200 }))).toEqual(['error:QA_TOO_SMALL']);
    expect(codes(img({ width: 800, height: 800 }))).toEqual(['warning:QA_LOW_RESOLUTION']);
    expect(codes(img({ width: 3300, height: 1100 }))).toEqual(['warning:QA_RATIO']);
    expect(
      codes(
        qaReport({
          ...img({}),
          kind: 'image',
          platform: null,
          language: 'vi',
          version: 1,
          body: null,
          mime: null,
          width: null,
          height: null,
          durationMs: null,
        } as never),
      ),
    ).toEqual(['error:QA_NO_FILE']);
  });
});
