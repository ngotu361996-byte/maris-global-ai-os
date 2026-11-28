/** Size and length read from the first bytes of a stored file; each part null when unknown. */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

const ok = (n: number | null | undefined) => (n && n > 0 && n < 100_000 ? n : null);

/**
 * Reads an image's size (PNG, JPEG, GIF, WebP) or an MP4/MOV video's size and length from the
 * start of the file. A video whose index (moov) sits after the media data is not read here and
 * gives null; MARIS's own outputs put the index first.
 */
export function mediaInfo(head: Buffer, mime: string): MediaInfo | null {
  try {
    if (mime === 'image/png') return png(head);
    if (mime === 'image/jpeg') return jpeg(head);
    if (mime === 'image/gif') return gif(head);
    if (mime === 'image/webp') return webp(head);
    if (mime === 'video/mp4' || mime === 'video/quicktime' || mime === 'audio/mp4')
      return mp4(head);
  } catch {
    /* a truncated or odd header: unknown */
  }
  return null;
}

function png(b: Buffer): MediaInfo | null {
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: ok(b.readUInt32BE(16)), height: ok(b.readUInt32BE(20)), durationMs: null };
}

function gif(b: Buffer): MediaInfo | null {
  if (b.length < 10) return null;
  return { width: ok(b.readUInt16LE(6)), height: ok(b.readUInt16LE(8)), durationMs: null };
}

function jpeg(b: Buffer): MediaInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        width: ok(b.readUInt16BE(i + 7)),
        height: ok(b.readUInt16BE(i + 5)),
        durationMs: null,
      };
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): MediaInfo | null {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X')
    return {
      width: ok(1 + b.readUIntLE(24, 3)),
      height: ok(1 + b.readUIntLE(27, 3)),
      durationMs: null,
    };
  if (chunk === 'VP8 ')
    return {
      width: ok(b.readUInt16LE(26) & 0x3fff),
      height: ok(b.readUInt16LE(28) & 0x3fff),
      durationMs: null,
    };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return {
      width: ok((bits & 0x3fff) + 1),
      height: ok(((bits >> 14) & 0x3fff) + 1),
      durationMs: null,
    };
  }
  return null;
}

/** The boxes inside [start, end): type and the range of their contents. */
function* boxes(b: Buffer, start: number, end: number) {
  let i = start;
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = Number(b.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = end - i;
    if (size < header) return;
    yield { type, from: i + header, to: Math.min(i + size, end), complete: i + size <= end };
    i += size;
  }
}

function mp4(b: Buffer): MediaInfo | null {
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== 'moov') continue;
    if (!top.complete) return null;
    let durationMs: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    for (const box of boxes(b, top.from, top.to)) {
      if (box.type === 'mvhd') {
        const v = b[box.from]!;
        const [scale, dur] =
          v === 1
            ? [b.readUInt32BE(box.from + 20), Number(b.readBigUInt64BE(box.from + 24))]
            : [b.readUInt32BE(box.from + 12), b.readUInt32BE(box.from + 16)];
        if (scale > 0) durationMs = Math.round((dur / scale) * 1000);
      }
      if (box.type === 'trak' && width === null) {
        for (const t of boxes(b, box.from, box.to)) {
          if (t.type !== 'tkhd') continue;
          const v = b[t.from]!;
          const at = t.from + (v === 1 ? 88 : 76);
          if (at + 8 > t.to) continue;
          const w = Math.round(b.readUInt32BE(at) / 65536);
          const h = Math.round(b.readUInt32BE(at + 4) / 65536);
          // Audio tracks have no size. A rotated phone video keeps its stored size here.
          if (w > 0 && h > 0) {
            const m = (k: number) => b.readInt32BE(t.from + (v === 1 ? 52 : 40) + k * 4);
            const turned = m(0) === 0 && m(1) !== 0;
            [width, height] = turned ? [h, w] : [w, h];
          }
        }
      }
    }
    return { width: ok(width), height: ok(height), durationMs };
  }
  return null;
}
