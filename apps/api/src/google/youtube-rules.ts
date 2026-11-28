import { YOUTUBE_RULES, type YoutubeFormat } from '@maris/contracts';

/**
 * YouTube's upload rules as pure functions (spec Part 17): what the title, description and tags
 * may hold, which videos can be Shorts, and what to warn about before an upload.
 */

/** YouTube counts a tag with a space as if it were quoted, and a comma between tags. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t, i) => n + [...t].length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);
}

export interface YoutubeText {
  title: string;
  description: string;
  tags: string[];
}

/** Problems that make YouTube refuse the metadata, in Vietnamese; empty when it is fine. */
export function metadataErrors(m: YoutubeText): string[] {
  const out: string[] = [];
  if ([...m.title].length > YOUTUBE_RULES.titleMaxChars)
    out.push(`Tiêu đề tối đa ${YOUTUBE_RULES.titleMaxChars} ký tự`);
  if (/[<>]/.test(m.title)) out.push('Tiêu đề không được có dấu < hoặc >');
  if (Buffer.byteLength(m.description, 'utf8') > YOUTUBE_RULES.descriptionMaxBytes)
    out.push(
      `Mô tả tối đa ${YOUTUBE_RULES.descriptionMaxBytes} byte (khoảng ${Math.floor(YOUTUBE_RULES.descriptionMaxBytes / 2)} chữ tiếng Việt có dấu)`,
    );
  if (/[<>]/.test(m.description)) out.push('Mô tả không được có dấu < hoặc >');
  if (m.tags.some((t) => /[<>,]/.test(t))) out.push('Thẻ không được có dấu phẩy, < hoặc >');
  if (tagsLength(m.tags) > YOUTUBE_RULES.tagsMaxChars)
    out.push(`Tổng độ dài các thẻ tối đa ${YOUTUBE_RULES.tagsMaxChars} ký tự`);
  return out;
}

/** YouTube shows a video as a Short when it is square or vertical and up to 3 minutes. */
export function shortProblem(
  width: number | null,
  height: number | null,
  durationMs: number | null,
): string | null {
  if (width !== null && height !== null && height < width)
    return 'Shorts cần video dọc hoặc vuông (chiều cao không nhỏ hơn chiều rộng)';
  if (durationMs !== null && durationMs > YOUTUBE_RULES.shortMaxSec * 1000)
    return `Shorts dài tối đa ${YOUTUBE_RULES.shortMaxSec / 60} phút; video này ${Math.round(durationMs / 1000)} giây`;
  return null;
}

/** Things worth knowing before an upload that do not stop it. */
export function uploadWarnings(input: {
  format: YoutubeFormat;
  durationMs: number | null;
  longUploads: string | null;
  audited: boolean;
  privacy: string;
}): string[] {
  const out: string[] = [];
  if (
    input.durationMs !== null &&
    input.durationMs > YOUTUBE_RULES.unverifiedMaxSec * 1000 &&
    input.longUploads !== 'allowed'
  )
    out.push(
      'Video dài hơn 15 phút: kênh cần xác minh số điện thoại trên YouTube, nếu chưa YouTube sẽ từ chối',
    );
  if (!input.audited && input.privacy !== 'private')
    out.push(
      'Dự án Google chưa được YouTube xét duyệt (audit): MARIS tải lên ở chế độ Riêng tư; mở công khai trong YouTube Studio',
    );
  return out;
}

/** The privacy MARIS asks YouTube for: an unaudited project's uploads stay private anyway. */
export function effectivePrivacy(
  wanted: 'public' | 'unlisted' | 'private',
  audited: boolean,
): 'public' | 'unlisted' | 'private' {
  return audited ? wanted : 'private';
}

/** "bytes=0-524287" from a 308 answer: how many bytes YouTube has. */
export function receivedBytes(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}
