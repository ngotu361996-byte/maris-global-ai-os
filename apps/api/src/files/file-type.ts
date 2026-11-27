import type { FileKind } from '@maris/contracts';

export interface DetectedType {
  mime: string;
  kind: FileKind;
}

const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

const OFFICE_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

/**
 * Detects the file type from its first bytes (and, for text and Office files, the extension).
 * The browser's Content-Type is never trusted. Anything not on this list is refused, which keeps
 * out HTML, SVG and executables.
 */
export function detectType(buf: Buffer, fileName: string): DetectedType | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'image' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (buf.length >= 6 && (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a')) return { mime: 'image/gif', kind: 'image' };
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio' };
  if (buf.length >= 5 && ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'document' };
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && OFFICE_TYPES[ext]) {
    return { mime: OFFICE_TYPES[ext]!, kind: 'document' };
  }
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (/^M4A/.test(brand)) return { mime: 'audio/mp4', kind: 'audio' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' };
    return { mime: 'video/mp4', kind: 'video' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm', kind: 'video' };
  if (buf.length >= 4 && ascii(buf, 0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio' };
  if (buf.length >= 3 && (ascii(buf, 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0))) return { mime: 'audio/mpeg', kind: 'audio' };
  if (TEXT_TYPES[ext] && isUtf8Text(buf)) return { mime: TEXT_TYPES[ext]!, kind: 'text' };
  return null;
}

/** Valid UTF-8 with no NUL bytes, so binary data cannot pass as text. */
export function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** A display name: no path, no control characters, at most 255 characters. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'tep').slice(0, 255);
}
