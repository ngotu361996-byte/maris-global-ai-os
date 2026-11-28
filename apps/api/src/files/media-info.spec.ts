import { mediaInfo } from './media-info';

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const mvhd = (scale: number, duration: number) => {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(scale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
};
const tkhd = (w: number, h: number, turned = false) => {
  const b = Buffer.alloc(84);
  b.writeInt32BE(turned ? 0 : 0x10000, 40);
  b.writeInt32BE(turned ? 0x10000 : 0, 44);
  b.writeUInt32BE(w * 65536, 76);
  b.writeUInt32BE(h * 65536, 80);
  return box('tkhd', b);
};
const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isom', 'latin1'));

describe('media info', () => {
  it('reads image sizes from their headers', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000043800000780080600000000', 'hex');
    expect(mediaInfo(png, 'image/png')).toEqual({ width: 1080, height: 1920, durationMs: null });
    // SOI, an APP0 segment, then SOF0 with 720×1280.
    const jpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000ffc0001108050002d003012200021101031101',
      'hex',
    );
    expect(mediaInfo(jpeg, 'image/jpeg')).toEqual({ width: 720, height: 1280, durationMs: null });
    const gif = Buffer.from('474946383961e8030a00', 'hex');
    expect(mediaInfo(gif, 'image/gif')).toEqual({ width: 1000, height: 10, durationMs: null });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    expect(mediaInfo(webp, 'image/webp')).toEqual({ width: 1280, height: 720, durationMs: null });
    expect(mediaInfo(Buffer.from('nope'), 'image/png')).toBeNull();
  });

  it('reads a video size and length from an index at the start, turned when the phone was upright', () => {
    const audio = box('trak', tkhd(0, 0));
    const video = Buffer.concat([
      ftyp,
      box('moov', mvhd(1000, 12_500), audio, box('trak', tkhd(1920, 1080))),
    ]);
    expect(mediaInfo(video, 'video/mp4')).toEqual({
      width: 1920,
      height: 1080,
      durationMs: 12_500,
    });
    const upright = Buffer.concat([
      ftyp,
      box('moov', mvhd(600, 1800), box('trak', tkhd(1920, 1080, true))),
    ]);
    expect(mediaInfo(upright, 'video/quicktime')).toEqual({
      width: 1080,
      height: 1920,
      durationMs: 3000,
    });
    // The index after the media data is not in the first bytes: unknown.
    const late = Buffer.concat([ftyp, box('mdat', Buffer.alloc(100))]);
    expect(mediaInfo(late, 'video/mp4')).toBeNull();
    // A cut-off index is unknown too.
    expect(mediaInfo(video.subarray(0, video.length - 10), 'video/mp4')).toBeNull();
    expect(mediaInfo(video, 'application/pdf')).toBeNull();
  });
});
