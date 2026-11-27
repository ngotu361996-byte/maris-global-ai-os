/**
 * Checks AI-written text against the text it was allowed to rely on (product facts, the brief and the
 * item's own words). It is deliberately simple and errs towards warning: a person reviews every
 * warning and edits the text, so a false alarm costs a minute while a made-up spec reaches customers.
 */

/** Advertising claims that need evidence (spec Part 13: no unfounded claims). */
const CLAIMS = [
  'tốt nhất',
  'rẻ nhất',
  'số 1',
  'số một',
  'duy nhất',
  'hàng đầu',
  'cam kết',
  'bảo hành trọn đời',
  'chính hãng',
  'an toàn tuyệt đối',
  'chữa khỏi',
  'đảm bảo',
  'bảo đảm',
  'best',
  'cheapest',
  'number one',
  '#1',
  'guaranteed',
  'guarantee',
  'lifetime warranty',
  'genuine',
  'authentic',
  'clinically proven',
  'cures',
];

const NUMBER = /\d(?:[\d.,]*\d)?/g;

/** "199.000", "199,000" and "199000" are the same number; so are "4,5" and "4.5". */
const digits = (n: string) => n.replace(/[.,]/g, '');

const fold = (s: string) => s.normalize('NFC').toLowerCase();

export function factWarnings(output: string, allowed: string): string[] {
  const allowedText = fold(allowed);
  const allowedNumbers = new Set((allowedText.match(NUMBER) ?? []).map(digits));
  const warnings: string[] = [];

  const unsupported: string[] = [];
  for (const raw of output.match(NUMBER) ?? []) {
    // Single digits are list markers, counts and dates far more often than product specs.
    const n = digits(raw);
    if (n.length < 2) continue;
    if (allowedNumbers.has(n) || unsupported.includes(raw)) continue;
    unsupported.push(raw);
  }
  if (unsupported.length) {
    warnings.push(
      `Số liệu không có trong thông tin sản phẩm hoặc yêu cầu: ${unsupported.slice(0, 15).join(', ')}`,
    );
  }

  const text = fold(output);
  const claims = CLAIMS.filter((c) => hasWord(text, c) && !hasWord(allowedText, c));
  if (claims.length)
    warnings.push(`Tuyên bố cần có căn cứ: ${claims.map((c) => `“${c}”`).join(', ')}`);
  return warnings;
}

/** A whole-word match, so "best" does not match "bestseller" and "cures" not "secures". */
function hasWord(text: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(phrase, from);
    if (i < 0) return false;
    const before = text[i - 1];
    const after = text[i + phrase.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = i + 1;
  }
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
