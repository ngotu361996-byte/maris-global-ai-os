import {
  IMAGE_PRESET_INFO,
  MEDIA_LIMITS,
  type ImagePreset,
  type WorkerJobInput,
} from '@maris/contracts';

type Sharp = (typeof import('sharp'))['default'];
export type ImageInput = WorkerJobInput<'media.image'>;

/** Formats the worker reads. SVG and the rest are refused, whatever the server sent. */
const READABLE = new Set(['jpeg', 'png', 'webp', 'gif']);

let loaded: Promise<Sharp | null> | undefined;

/** sharp, or null when its native part is missing on this machine (then no image jobs are taken). */
export function loadSharp(): Promise<Sharp | null> {
  loaded ??= import('sharp')
    .then((m) => (m as unknown as { default?: Sharp }).default ?? (m as unknown as Sharp))
    .then(async (s) => {
      // A tiny render proves the native library works, not only that the package is there.
      await s({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
        .png()
        .toBuffer();
      return s;
    })
    .catch(() => null);
  return loaded;
}

export interface RenderedImage {
  data: Buffer;
  width: number;
  height: number;
  ext: 'jpg' | 'webp' | 'png';
}

/**
 * Makes one output image: turns it upright, resizes it to the preset (cropping around the most
 * interesting part, or fitting it whole on a background), optionally evens out levels and
 * sharpens, then places the logo. Metadata such as GPS position is not copied to the output.
 */
export async function renderImage(
  sharp: Sharp,
  source: Buffer,
  logo: Buffer | null,
  preset: ImagePreset,
  input: ImageInput,
): Promise<RenderedImage> {
  const opts = { limitInputPixels: MEDIA_LIMITS.maxInputPixels, failOn: 'error' as const };
  const meta = await sharp(source, opts).metadata();
  if (!meta.format || !READABLE.has(meta.format))
    throw new Error(`Định dạng ảnh không hỗ trợ: ${meta.format ?? 'không rõ'}`);
  const upright = meta.autoOrient ?? { width: meta.width, height: meta.height };
  const info = IMAGE_PRESET_INFO[preset];
  const width = info.width ?? upright.width;
  const height = info.height ?? upright.height;

  let img = sharp(source, opts).rotate();
  if (info.width && info.height)
    img = img.resize(info.width, info.height, {
      fit: input.fit,
      position: input.fit === 'cover' ? 'attention' : 'centre',
      background: input.background,
    });
  if (input.autoLevel) img = await autoLevel(sharp, img);
  if (input.sharpen) img = img.sharpen();

  if (logo) {
    const placed = await placeLogo(sharp, logo, width, height, input);
    img = sharp(await img.png().toBuffer()).composite([placed]);
  }

  if (input.format === 'png')
    return { data: await img.png().toBuffer(), width, height, ext: 'png' };
  if (input.format === 'webp')
    return {
      data: await img.webp({ quality: input.quality }).toBuffer(),
      width,
      height,
      ext: 'webp',
    };
  return {
    data: await img
      .flatten({ background: input.background })
      .jpeg({ quality: input.quality, mozjpeg: true })
      .toBuffer(),
    width,
    height,
    ext: 'jpg',
  };
}

/** Most an auto-level may stretch the tones, so a fairly good photo is only nudged. */
const LEVEL_MAX_GAIN = 1.3;

/**
 * Evens out a dull or washed-out image: stretches its darkest and brightest tones towards black and
 * white, by at most LEVEL_MAX_GAIN. An image that already spans the whole range is left alone
 * (unlike sharp's normalise, which ignores the extremes and can darken bright product photos).
 */
async function autoLevel(sharp: Sharp, img: import('sharp').Sharp): Promise<import('sharp').Sharp> {
  const buf = await img.png().toBuffer();
  const { channels } = await sharp(buf).stats();
  const colour = channels.slice(0, 3);
  const lo = Math.min(...colour.map((c) => c.min));
  const hi = Math.max(...colour.map((c) => c.max));
  if (hi - lo < 8 || (lo <= 2 && hi >= 253)) return sharp(buf);
  const gain = Math.min(LEVEL_MAX_GAIN, 255 / (hi - lo));
  // Stretch around the middle of the used range, so overall brightness stays, and keep in 0–255.
  let offset = ((lo + hi) / 2) * (1 - gain);
  offset -= Math.min(0, lo * gain + offset);
  offset -= Math.max(0, hi * gain + offset - 255);
  return sharp(buf).linear(gain, offset);
}

async function placeLogo(
  sharp: Sharp,
  logo: Buffer,
  width: number,
  height: number,
  input: ImageInput,
): Promise<{ input: Buffer; left: number; top: number }> {
  const opts = { limitInputPixels: MEDIA_LIMITS.maxInputPixels, failOn: 'error' as const };
  const meta = await sharp(logo, opts).metadata();
  if (!meta.format || !READABLE.has(meta.format))
    throw new Error(`Định dạng logo không hỗ trợ: ${meta.format ?? 'không rõ'}`);
  const { position, sizePct, opacity, marginPct } = input.logo;
  const margin = Math.round((Math.min(width, height) * marginPct) / 100);
  let mark = sharp(logo, opts)
    .rotate()
    .resize({
      width: Math.max(1, Math.round((width * sizePct) / 100)),
      height: Math.max(1, Math.round(height * 0.4)),
      fit: 'inside',
    })
    .ensureAlpha();
  if (opacity < 1)
    mark = sharp(await mark.png().toBuffer()).composite([
      {
        // Multiplies the logo's own transparency by the chosen opacity.
        input: Buffer.from([255, 255, 255, Math.round(255 * opacity)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in',
      },
    ]);
  const { data, info } = await mark.png().toBuffer({ resolveWithObject: true });
  const w = Math.min(info.width, width);
  const h = Math.min(info.height, height);
  const right = Math.max(0, width - w - margin);
  const bottom = Math.max(0, height - h - margin);
  const at: Record<ImageInput['logo']['position'], [number, number]> = {
    'top-left': [Math.min(margin, right), Math.min(margin, bottom)],
    'top-right': [right, Math.min(margin, bottom)],
    'bottom-left': [Math.min(margin, right), bottom],
    'bottom-right': [right, bottom],
    center: [Math.round((width - w) / 2), Math.round((height - h) / 2)],
  };
  const [left, top] = at[position];
  return { input: data, left, top };
}
