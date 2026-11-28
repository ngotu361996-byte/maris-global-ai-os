import {
  TIKTOK_PRIVACY,
  TIKTOK_RULES,
  type TiktokCreatorResponse,
  type TiktokPrivacy,
} from '@maris/contracts';

/** TikTok's rules for the Content Posting API and its error answers, as pure functions. */

export type TiktokErrorKind =
  | 'token'
  | 'permission'
  | 'rate'
  | 'post_limit'
  | 'policy'
  | 'invalid'
  | 'transient'
  | 'other';

/**
 * TikTok answers {data, error: {code, message, log_id}} with code "ok" on success; its OAuth
 * endpoint answers {error, error_description} instead.
 */
export function tiktokErrorCode(body: unknown): string | null {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err.slice(0, 60);
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code.slice(0, 60) : null;
}

export function tiktokOk(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  const code = tiktokErrorCode(body);
  return code === null || code === 'ok';
}

export function tiktokErrorKind(status: number, body: unknown): TiktokErrorKind {
  const code = tiktokErrorCode(body) ?? '';
  if (['access_token_invalid', 'invalid_grant', 'token_expired'].includes(code) || status === 401)
    return 'token';
  if (['scope_not_authorized', 'scope_permission_missed'].includes(code)) return 'permission';
  if (code === 'rate_limit_exceeded' || status === 429) return 'rate';
  if (code.startsWith('spam_risk')) return 'post_limit';
  if (
    [
      'unaudited_client_can_only_post_to_private_accounts',
      'privacy_level_option_mismatch',
      'reached_active_user_cap',
      'url_ownership_unverified',
    ].includes(code)
  )
    return 'policy';
  if (status >= 500 || code === 'internal_error') return 'transient';
  if (code === 'invalid_params' || code === 'invalid_file_upload' || status === 400)
    return 'invalid';
  return 'other';
}

/** Explanations in Vietnamese for the answers a person can act on. */
const EXPLAIN: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts:
    'Ứng dụng TikTok chưa được TikTok xét duyệt nên chỉ đăng được khi tài khoản TikTok để chế độ riêng tư và video để Chỉ mình tôi',
  privacy_level_option_mismatch:
    'Chế độ xem đã chọn không còn nằm trong các lựa chọn TikTok cho tài khoản này; mở lại form để chọn lại',
  spam_risk_too_many_posts: 'Tài khoản đã đăng quá số bài TikTok cho phép trong ngày',
  spam_risk_user_banned_from_posting: 'TikTok đang chặn tài khoản này đăng bài',
  spam_risk_too_many_pending_share:
    'Hộp nháp TikTok đang có quá nhiều video chờ; mở app TikTok để đăng hoặc xóa bớt',
  reached_active_user_cap: 'Ứng dụng TikTok đã đạt số người dùng tối đa trong ngày',
  scope_not_authorized: 'Tài khoản chưa cho MARIS quyền này; bấm Kết nối lại và đánh dấu quyền',
  access_token_invalid: 'Quyền truy cập TikTok đã hết hiệu lực',
  invalid_grant: 'Quyền truy cập TikTok đã hết hiệu lực',
};

/** TikTok's message for an error, short, with an explanation when there is one. */
export function tiktokErrorMessage(status: number, body: unknown): string {
  const b = (body as Record<string, unknown> | null) ?? {};
  const err = b.error;
  const code = tiktokErrorCode(body);
  const raw =
    err && typeof err === 'object'
      ? String((err as { message?: unknown }).message ?? '')
      : String(b.error_description ?? err ?? '');
  const text = (raw.split('\n')[0] || code || `HTTP ${status}`).slice(0, 300);
  const why = code ? EXPLAIN[code] : undefined;
  return why ? `${why} (${text})` : text;
}

/**
 * How a file is cut for TikTok's upload: files up to 64 MB go in one piece; larger ones in pieces
 * of 10 MB, the last piece holding the rest (TikTok: pieces of 5 to 64 MB, the last up to 128 MB).
 */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  const SINGLE_MAX = 64 * 1024 * 1024;
  const CHUNK = 10 * 1024 * 1024;
  if (size <= SINGLE_MAX) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK, count: Math.floor(size / CHUNK) };
}

/** Bytes [from, to) of piece `index` (from 0). */
export function chunkRange(
  size: number,
  plan: { chunkSize: number; count: number },
  index: number,
): { from: number; to: number } {
  const from = index * plan.chunkSize;
  const to = index === plan.count - 1 ? size : from + plan.chunkSize;
  return { from, to };
}

/** creator_info as TikTok sends it, made safe to keep. */
export function creatorFromBody(data: Record<string, unknown> | undefined): TiktokCreatorResponse {
  const d = data ?? {};
  const options = Array.isArray(d.privacy_level_options)
    ? (d.privacy_level_options as unknown[]).filter((p): p is TiktokPrivacy =>
        (TIKTOK_PRIVACY as readonly unknown[]).includes(p),
      )
    : [];
  const max = Number(d.max_video_post_duration_sec);
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  return {
    nickname: str(d.creator_nickname),
    username: str(d.creator_username),
    privacyOptions: options,
    commentDisabled: d.comment_disabled === true,
    duetDisabled: d.duet_disabled === true,
    stitchDisabled: d.stitch_disabled === true,
    maxDurationSec: Number.isFinite(max) && max > 0 ? Math.floor(max) : null,
    checkedAt: new Date().toISOString(),
  };
}

export interface PostCheck {
  mode: 'direct' | 'draft';
  privacy: TiktokPrivacy | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  brandedContent: boolean;
  durationMs: number | null;
  audited: boolean;
}

/** Why a post cannot go to this creator now (TikTok would refuse it), or [] when it can. */
export function postProblems(p: PostCheck, creator: TiktokCreatorResponse | null): string[] {
  const out: string[] = [];
  const sec = p.durationMs !== null ? p.durationMs / 1000 : null;
  if (sec !== null && sec < TIKTOK_RULES.minSec)
    out.push(`Video TikTok cần dài ít nhất ${TIKTOK_RULES.minSec} giây`);
  if (p.mode === 'draft') return out;
  if (!p.audited && p.privacy !== 'SELF_ONLY')
    out.push(
      'Ứng dụng TikTok chưa được xét duyệt: TikTok chỉ cho đăng ở chế độ Chỉ mình tôi. Chọn Chỉ mình tôi, hoặc Gửi vào hộp nháp để đăng công khai từ app TikTok',
    );
  if (!creator) return out;
  if (p.privacy && creator.privacyOptions.length && !creator.privacyOptions.includes(p.privacy))
    out.push('TikTok không cho tài khoản này chọn chế độ xem đó');
  if (sec !== null && creator.maxDurationSec !== null && sec > creator.maxDurationSec)
    out.push(
      `Tài khoản này chỉ được đăng video dài tối đa ${creator.maxDurationSec} giây qua API`,
    );
  return out;
}

/** Interactions the creator turned off in TikTok cannot be turned on by MARIS. */
export function interactionWarnings(
  p: Pick<PostCheck, 'allowComment' | 'allowDuet' | 'allowStitch'>,
  creator: TiktokCreatorResponse | null,
): string[] {
  if (!creator) return [];
  const out: string[] = [];
  if (p.allowComment && creator.commentDisabled)
    out.push('Tài khoản đã tắt bình luận trong TikTok nên video không cho bình luận');
  if (p.allowDuet && creator.duetDisabled)
    out.push('Tài khoản đã tắt Duet trong TikTok nên video không cho Duet');
  if (p.allowStitch && creator.stitchDisabled)
    out.push('Tài khoản đã tắt Stitch trong TikTok nên video không cho Stitch');
  return out;
}

/** The public address of a posted video. */
export function tiktokUrl(username: string | null, postId: string): string {
  return username
    ? `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${postId}`
    : `https://www.tiktok.com/video/${postId}`;
}
