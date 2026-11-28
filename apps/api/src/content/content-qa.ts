import {
  PLATFORM_LABEL,
  PLATFORM_LIMITS,
  type ItemKind,
  type Platform,
  type QaCheck,
  type QaReport,
} from '@maris/contracts';

export interface QaInput {
  kind: ItemKind;
  platform: Platform | null;
  language: string;
  version: number;
  body: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * Words that Vietnamese advertising law (Luật Quảng cáo, Art. 8) and the ad platforms do not allow
 * without proof: superlatives, guarantees and health or results claims. Each match is a warning
 * for the reviewer, who knows whether there is proof.
 */
const RISKY: { re: RegExp; why: string }[] = [
  {
    re: /(tốt|rẻ|đẹp|chất lượng|uy tín)\s+nhất|duy nhất|số\s*(1|một)\b|hàng\s+đầu/giu,
    why: 'so sánh tuyệt đối (“nhất”, “số 1”) cần có căn cứ',
  },
  {
    re: /cam\s+kết|bảo\s+đảm\s+100|đảm\s+bảo\s+100|hoàn\s+tiền\s+100/giu,
    why: 'lời cam kết cần điều kiện rõ ràng',
  },
  {
    re: /chữa\s+(khỏi|bệnh|dứt)|trị\s+(dứt|khỏi)|khỏi\s+hẳn|đặc\s+trị|thần\s+dược/giu,
    why: 'tuyên bố chữa bệnh không được phép quảng cáo',
  },
  {
    re: /giảm\s+\d+\s*kg|giảm\s+cân\s+(cấp\s+tốc|nhanh)|trắng\s+(da\s+)?(cấp\s+tốc|sau\s+\d+)/giu,
    why: 'hứa hẹn kết quả cơ thể bị các nền tảng quảng cáo cấm',
  },
  {
    re: /an\s+toàn\s+tuyệt\s+đối|không\s+(có\s+)?tác\s+dụng\s+phụ|hiệu\s+quả\s+(ngay|tức\s+thì|100)/giu,
    why: 'tuyên bố an toàn hoặc hiệu quả tuyệt đối cần có căn cứ',
  },
  {
    re: /\b(the\s+best|#1|number\s+one|guarantee[ds]?|risk[-\s]free|miracle|cures?|100%\s+effective)\b/giu,
    why: 'absolute or guaranteed claims need proof',
  },
];

/** Text left from a template or a draft. */
const PLACEHOLDER =
  /\[(tên|ten|giá|gia|link|sản phẩm|product|name|price|url)[^\]]*\]|\{\{[^}]*\}\}|\bTODO\b|\bXXX\b|lorem ipsum/iu;
const VI_LETTERS = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/giu;

const err = (code: string, message: string): QaCheck => ({ code, level: 'error', message });
const warn = (code: string, message: string): QaCheck => ({ code, level: 'warning', message });
const info = (code: string, message: string): QaCheck => ({ code, level: 'info', message });

const ratioLabel = (w: number, h: number) => {
  const r = w / h;
  const known: [number, string][] = [
    [1, '1:1'],
    [4 / 5, '4:5'],
    [9 / 16, '9:16'],
    [16 / 9, '16:9'],
    [1.91, '1,91:1'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
  ];
  return known.find(([k]) => Math.abs(k - r) / k < 0.02)?.[1] ?? `${w}×${h}`;
};

/** The automatic quality checks of one version. Pure: the same version always gives the same result. */
export function qaReport(input: QaInput): QaReport {
  const checks = input.body !== null && input.mime === null ? textChecks(input) : fileChecks(input);
  const status = checks.some((c) => c.level === 'error')
    ? 'fail'
    : checks.some((c) => c.level === 'warning')
      ? 'warning'
      : 'pass';
  return { status, version: input.version, checks };
}

function textChecks(input: QaInput): QaCheck[] {
  const out: QaCheck[] = [];
  const body = input.body ?? '';
  const text = body.trim();
  if (!text) return [err('QA_EMPTY', 'Nội dung trống')];
  const limits = input.platform ? PLATFORM_LIMITS[input.platform] : null;
  const where = input.platform ? PLATFORM_LABEL[input.platform] : '';
  const chars = [...text].length;
  if (limits?.textMaxChars && chars > limits.textMaxChars)
    out.push(
      err('QA_TEXT_TOO_LONG', `Dài ${chars} ký tự, ${where} nhận tối đa ${limits.textMaxChars}`),
    );

  const tags = text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  if (limits?.hashtagsMax && tags.length > limits.hashtagsMax)
    out.push(
      err(
        'QA_HASHTAGS_TOO_MANY',
        `${tags.length} hashtag, ${where} cho tối đa ${limits.hashtagsMax}`,
      ),
    );
  else if (limits?.hashtagsAdvised && tags.length > limits.hashtagsAdvised)
    out.push(
      warn(
        'QA_HASHTAGS_MANY',
        `${tags.length} hashtag; trên ${where} nên dùng khoảng ${limits.hashtagsAdvised} trở xuống`,
      ),
    );

  const placeholder = PLACEHOLDER.exec(text);
  if (placeholder) out.push(err('QA_PLACEHOLDER', `Còn chỗ chưa điền: “${placeholder[0]}”`));

  const found = new Map<string, Set<string>>();
  for (const { re, why } of RISKY)
    for (const m of text.matchAll(re)) {
      if (!found.has(why)) found.set(why, new Set());
      found.get(why)!.add(m[0].trim());
    }
  for (const [why, words] of found)
    out.push(warn('QA_RISKY_CLAIM', `“${[...words].slice(0, 3).join('”, “')}”: ${why}`));

  const letters = text.match(/\p{L}/gu) ?? [];
  const upper = text.match(/\p{Lu}/gu) ?? [];
  if (letters.length >= 40 && upper.length / letters.length > 0.4)
    out.push(warn('QA_SHOUTING', 'Viết hoa quá nhiều; nền tảng quảng cáo có thể hạn chế'));
  if (/[!?]{3,}/.test(text)) out.push(warn('QA_PUNCTUATION', 'Có chuỗi dấu “!!!” hoặc “???”'));

  const vi = (text.match(VI_LETTERS) ?? []).length;
  if (letters.length >= 40) {
    if (input.language === 'vi' && vi / letters.length < 0.02)
      out.push(
        warn('QA_LANGUAGE', 'Mục ghi là tiếng Việt nhưng nội dung gần như không có dấu tiếng Việt'),
      );
    if (input.language === 'en' && vi / letters.length > 0.05)
      out.push(warn('QA_LANGUAGE', 'Mục ghi là tiếng Anh nhưng nội dung có nhiều chữ tiếng Việt'));
  }
  return out;
}

function fileChecks(input: QaInput): QaCheck[] {
  const out: QaCheck[] = [];
  const media = input.mime?.split('/')[0] ?? null;
  if (!media) return [err('QA_NO_FILE', 'Phiên bản chưa có tệp')];
  const expect: Partial<Record<ItemKind, string>> = {
    video: 'video',
    image: 'image',
    audio: 'audio',
  };
  if (expect[input.kind] && expect[input.kind] !== media)
    out.push(err('QA_WRONG_FILE', `Mục loại ${input.kind} nhưng tệp là ${input.mime}`));
  const limits = input.platform ? PLATFORM_LIMITS[input.platform] : null;
  const where = input.platform ? PLATFORM_LABEL[input.platform] : '';

  if (media === 'image' || media === 'video') {
    const { width: w, height: h } = input;
    if (!w || !h)
      out.push(
        info('QA_SIZE_UNKNOWN', 'Không đọc được kích thước tệp, chưa kiểm tra được cỡ và tỉ lệ'),
      );
    else {
      const short = Math.min(w, h);
      if (media === 'image' && short < 320)
        out.push(err('QA_TOO_SMALL', `Ảnh ${w}×${h} quá nhỏ (cạnh ngắn dưới 320 px)`));
      else if (media === 'image' && short < 1080)
        out.push(
          warn('QA_LOW_RESOLUTION', `Ảnh ${w}×${h}; nên có cạnh ngắn từ 1080 px để hiển thị nét`),
        );
      if (media === 'video' && short < 540)
        out.push(err('QA_TOO_SMALL', `Video ${w}×${h} dưới 540p, các nền tảng sẽ hiển thị mờ`));
      else if (media === 'video' && short < 720)
        out.push(warn('QA_LOW_RESOLUTION', `Video ${w}×${h}; nên từ 720p trở lên`));
      if (limits?.ratio) {
        const r = w / h;
        const { min, max, label } = limits.ratio;
        if (r < min * 0.98 || r > max * 1.02)
          out.push(
            warn(
              'QA_RATIO',
              `Tỉ lệ ${ratioLabel(w, h)} không hợp ${where} (nên ${label}); nền tảng sẽ cắt hoặc thêm viền`,
            ),
          );
      }
    }
  }
  if (media === 'video' || media === 'audio') {
    if (input.durationMs === null)
      out.push(info('QA_LENGTH_UNKNOWN', 'Không đọc được thời lượng, chưa kiểm tra được độ dài'));
    else {
      const sec = input.durationMs / 1000;
      if (sec < 1) out.push(err('QA_TOO_SHORT', 'Dài dưới 1 giây'));
      if (media === 'video' && limits?.videoMaxSec && sec > limits.videoMaxSec)
        out.push(
          err(
            'QA_TOO_LONG',
            `Video dài ${Math.round(sec)} giây, ${where} nhận tối đa ${limits.videoMaxSec} giây`,
          ),
        );
    }
  }
  return out;
}
