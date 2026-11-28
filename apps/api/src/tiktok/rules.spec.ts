import { bigIdsAsStrings } from './tiktok-api.service';
import {
  chunkPlan,
  chunkRange,
  creatorFromBody,
  interactionWarnings,
  postProblems,
  tiktokErrorKind,
  tiktokErrorMessage,
  tiktokOk,
  tiktokUrl,
} from './rules';

const MB = 1024 * 1024;

describe('TikTok rules', () => {
  it('cuts files the way TikTok takes them', () => {
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1 });
    expect(chunkPlan(64 * MB)).toEqual({ chunkSize: 64 * MB, count: 1 });
    const size = 95 * MB + 123;
    const plan = chunkPlan(size);
    expect(plan).toEqual({ chunkSize: 10 * MB, count: 9 });
    // Every byte goes once; the last piece holds the rest and stays under 128 MB.
    let total = 0;
    for (let i = 0; i < plan.count; i++) {
      const { from, to } = chunkRange(size, plan, i);
      expect(from).toBe(total);
      total = to;
    }
    expect(total).toBe(size);
    const last = chunkRange(size, plan, plan.count - 1);
    expect(last.to - last.from).toBe(15 * MB + 123);
    expect(chunkPlan(4096 * MB).count).toBe(409);
  });

  it('reads TikTok answers: ok, errors and their kinds', () => {
    expect(tiktokOk(200, { data: {}, error: { code: 'ok' } })).toBe(true);
    expect(tiktokOk(201, null)).toBe(true);
    expect(tiktokOk(200, { error: { code: 'invalid_params' } })).toBe(false);
    expect(tiktokErrorKind(401, { error: { code: 'access_token_invalid' } })).toBe('token');
    expect(tiktokErrorKind(400, { error: 'invalid_grant' })).toBe('token');
    expect(tiktokErrorKind(403, { error: { code: 'scope_not_authorized' } })).toBe('permission');
    expect(tiktokErrorKind(429, { error: { code: 'rate_limit_exceeded' } })).toBe('rate');
    expect(tiktokErrorKind(403, { error: { code: 'spam_risk_too_many_posts' } })).toBe(
      'post_limit',
    );
    expect(
      tiktokErrorKind(403, {
        error: { code: 'unaudited_client_can_only_post_to_private_accounts' },
      }),
    ).toBe('policy');
    expect(tiktokErrorKind(500, { error: { code: 'internal_error' } })).toBe('transient');
    expect(tiktokErrorKind(400, { error: { code: 'invalid_params' } })).toBe('invalid');
    expect(
      tiktokErrorMessage(403, {
        error: { code: 'spam_risk_too_many_posts', message: 'Too many posts' },
      }),
    ).toMatch(/quá số bài.*\(Too many posts\)/);
    expect(tiktokErrorMessage(400, { error: 'invalid_client', error_description: 'Bad key' })).toBe(
      'Bad key',
    );
  });

  it('keeps 64-bit post ids exact', () => {
    const text = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[ 7300000000000000001 ,7300000000000000002]}}';
    expect(JSON.parse(bigIdsAsStrings(text)).data.publicaly_available_post_id).toEqual([
      '7300000000000000001',
      '7300000000000000002',
    ]);
    expect(bigIdsAsStrings('{"publicaly_available_post_id":[]}')).toBe(
      '{"publicaly_available_post_id":[]}',
    );
  });

  it('checks a post against the app and the creator', () => {
    const creator = creatorFromBody({
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY', 'SOMETHING_NEW'],
      comment_disabled: true,
      duet_disabled: false,
      stitch_disabled: false,
      max_video_post_duration_sec: 60,
      creator_nickname: 'Shop',
    });
    expect(creator.privacyOptions).toEqual(['PUBLIC_TO_EVERYONE', 'SELF_ONLY']);
    const base = {
      mode: 'direct' as const,
      privacy: 'PUBLIC_TO_EVERYONE' as const,
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      brandedContent: false,
      durationMs: 30_000,
      audited: true,
    };
    expect(postProblems(base, creator)).toEqual([]);
    expect(postProblems({ ...base, audited: false }, creator)[0]).toMatch(/Chỉ mình tôi/);
    expect(postProblems({ ...base, privacy: 'FOLLOWER_OF_CREATOR' }, creator)[0]).toMatch(
      /không cho/,
    );
    expect(postProblems({ ...base, durationMs: 90_000 }, creator)[0]).toMatch(/60 giây/);
    expect(postProblems({ ...base, durationMs: 2000 }, creator)[0]).toMatch(/ít nhất 3 giây/);
    // Drafts are finished in the TikTok app: only the length matters.
    expect(postProblems({ ...base, mode: 'draft', audited: false, privacy: null }, creator)).toEqual(
      [],
    );
    expect(interactionWarnings(base, creator)[0]).toMatch(/bình luận/);
  });

  it('builds the public address of a post', () => {
    expect(tiktokUrl('shop.tu', '123')).toBe('https://www.tiktok.com/@shop.tu/video/123');
    expect(tiktokUrl(null, '123')).toBe('https://www.tiktok.com/video/123');
  });
});
