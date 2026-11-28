import { execFile, spawn } from 'node:child_process';
import { IMAGE_PRESET_INFO, type VideoPreset, type WorkerJobInput } from '@maris/contracts';

export type VideoInput = WorkerJobInput<'media.video'>;

export interface Ffmpeg {
  ffmpeg: string;
  ffprobe: string;
  version: string;
}

/** The largest side an output keeps when the size is left as the original (4K). */
const ORIGINAL_MAX_SIDE = 3840;

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(String(out))),
    ),
  );
}

let found: Promise<Ffmpeg | null> | undefined;

/**
 * FFmpeg and ffprobe on this machine: FFMPEG_PATH and FFPROBE_PATH when set, else the ones on
 * PATH. Null when they do not run (then no video jobs are taken).
 */
export function findFfmpeg(): Promise<Ffmpeg | null> {
  found ??= (async () => {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobe =
      process.env.FFPROBE_PATH ||
      (process.env.FFMPEG_PATH
        ? process.env.FFMPEG_PATH.replace(
            /ffmpeg(\.exe)?$/i,
            (_m, exe: string) => `ffprobe${exe ?? ''}`,
          )
        : 'ffprobe');
    try {
      const out = await run(ffmpeg, ['-hide_banner', '-version'], 10_000);
      await run(ffprobe, ['-hide_banner', '-version'], 10_000);
      const encoders = await run(ffmpeg, ['-hide_banner', '-encoders'], 10_000);
      if (!/libx264/.test(encoders)) return null;
      return { ffmpeg, ffprobe, version: /ffmpeg version (\S+)/.exec(out)?.[1] ?? 'unknown' };
    } catch {
      return null;
    }
  })();
  return found;
}

export interface Probe {
  durationSec: number;
  /** Size as shown, after the phone's rotation is applied. */
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Reads a video's length, size, rotation and whether it has sound. */
export async function probeVideo(ffprobe: string, file: string): Promise<Probe> {
  const out = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    60_000,
  );
  return parseProbe(out);
}

interface ProbeJson {
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    tags?: { rotate?: string };
    side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string };
}

export function parseProbe(json: string): Probe {
  const data = JSON.parse(json) as ProbeJson;
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
  if (!v) throw new Error('Tệp không có hình video');
  const rotation = Number(
    v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0,
  );
  const turned = Math.abs(rotation) % 180 === 90;
  const durationSec = Number(data.format?.duration ?? v.duration ?? NaN);
  if (!Number.isFinite(durationSec) || durationSec <= 0)
    throw new Error('Không đọc được độ dài video');
  return {
    durationSec,
    width: turned ? v.height! : v.width!,
    height: turned ? v.width! : v.height!,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/** The part of the video to keep, in seconds, or an error message. */
export function cutRange(
  input: Pick<VideoInput, 'startSec' | 'endSec'>,
  durationSec: number,
  maxSec: number,
): { start: number; length: number } | string {
  if (input.startSec >= durationSec)
    return `Thời điểm bắt đầu (${input.startSec} giây) ở sau khi video kết thúc (${Math.floor(durationSec)} giây)`;
  const end = Math.min(input.endSec ?? durationSec, durationSec);
  const length = Math.round((end - input.startSec) * 1000) / 1000;
  if (length <= 0) return 'Đoạn cắt không có thời lượng';
  if (length > maxSec) return `Đoạn video dài hơn ${Math.round(maxSec / 60)} phút`;
  return { start: input.startSec, length };
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** The output size of a preset for a video of this size. */
export function outputSize(preset: VideoPreset, probe: Pick<Probe, 'width' | 'height'>) {
  const info = IMAGE_PRESET_INFO[preset];
  if (info.width && info.height) return { width: info.width, height: info.height };
  const scale = Math.min(1, ORIGINAL_MAX_SIDE / Math.max(probe.width, probe.height));
  return { width: even(probe.width * scale), height: even(probe.height * scale) };
}

const LOGO_AT: Record<VideoInput['logo']['position'], [string, string]> = {
  'top-left': ['M', 'M'],
  'top-right': ['W-w-M', 'M'],
  'bottom-left': ['M', 'H-h-M'],
  'bottom-right': ['W-w-M', 'H-h-M'],
  center: ['(W-w)/2', '(H-h)/2'],
};

export interface VideoPlan {
  args: string[];
  width: number;
  height: number;
  durationSec: number;
}

/**
 * The FFmpeg arguments for one output: keep the cut, fit it to the preset's frame (crop to fill,
 * or fit whole on a background), optionally denoise and sharpen, place the logo, and lay the
 * voice-over over the original sound or instead of it. Metadata (such as GPS) is not copied.
 * Progress is written to stdout.
 */
export function videoArgs(o: {
  source: string;
  logo: string | null;
  voice: string | null;
  out: string;
  preset: VideoPreset;
  probe: Probe;
  cut: { start: number; length: number };
  input: VideoInput;
}): VideoPlan {
  const { input, probe } = o;
  const { width: W, height: H } = outputSize(o.preset, probe);
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  args.push('-ss', String(o.cut.start), '-t', String(o.cut.length), '-i', o.source);
  let next = 1;
  const logoIdx = o.logo ? next++ : -1;
  if (o.logo) args.push('-i', o.logo);
  const voiceIdx = o.voice ? next++ : -1;
  if (o.voice) args.push('-i', o.voice);

  const bg = `0x${input.background.slice(1)}`;
  const chain: string[] = [];
  if (o.preset === 'original') chain.push(`scale=${W}:${H}`);
  else if (input.fit === 'cover')
    chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
  else
    chain.push(
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg}`,
    );
  if (input.denoise) chain.push('hqdn3d=3:2:4:3');
  if (input.sharpen) chain.push('unsharp=5:5:0.8:5:5:0');
  chain.push('setsar=1');

  const graph: string[] = [];
  if (o.logo) {
    const margin = Math.round((Math.min(W, H) * input.logo.marginPct) / 100);
    const lw = Math.max(2, Math.round((W * input.logo.sizePct) / 100));
    const lh = Math.max(2, Math.round(H * 0.4));
    graph.push(`[0:v]${chain.join(',')}[base]`);
    const opacity = input.logo.opacity < 1 ? `,colorchannelmixer=aa=${input.logo.opacity}` : '';
    graph.push(
      `[${logoIdx}:v]scale=${lw}:${lh}:force_original_aspect_ratio=decrease,format=rgba${opacity}[logo]`,
    );
    const [x, y] = LOGO_AT[input.logo.position].map((e) => e.replace(/M/g, String(margin)));
    graph.push(`[base][logo]overlay=${x}:${y}:format=auto,format=yuv420p[v]`);
  } else graph.push(`[0:v]${chain.join(',')},format=yuv420p[v]`);

  let audio: string | null = null;
  if (o.voice) {
    if (input.voiceMix === 'mix' && probe.hasAudio) {
      graph.push(`[0:a]volume=${input.originalVolume}[orig]`);
      graph.push(`[${voiceIdx}:a]apad[voice]`);
      graph.push('[orig][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]');
    } else graph.push(`[${voiceIdx}:a]apad[a]`);
    audio = '[a]';
  } else if (probe.hasAudio) audio = '0:a:0';

  args.push('-filter_complex', graph.join(';'), '-map', '[v]');
  if (audio) args.push('-map', audio, '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  else args.push('-an');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    input.quality === 'high' ? 'slow' : 'veryfast',
    '-crf',
    input.quality === 'high' ? '18' : '23',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(o.cut.length),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    o.out,
  );
  return { args, width: W, height: H, durationSec: o.cut.length };
}

/** FFmpeg arguments to save one frame of a finished output as a JPEG cover picture. */
export function coverArgs(
  video: string,
  atSec: number,
  durationSec: number,
  out: string,
): string[] {
  const at = Math.max(0, Math.min(atSec, durationSec - 0.1));
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-ss',
    String(Math.round(at * 1000) / 1000),
    '-i',
    video,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-map_metadata',
    '-1',
    out,
  ];
}

/** Seconds of output written so far, from FFmpeg's -progress lines. */
export function progressSec(chunk: string): number | null {
  let sec: number | null = null;
  for (const m of chunk.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)) sec = Number(m[1]) / 1e6;
  return sec;
}

/** Runs FFmpeg; stops it when the job is cancelled. Rejects with the end of its error output. */
export function runFfmpeg(
  bin: string,
  args: string[],
  opts: { signal: AbortSignal; onProgress?: (sec: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new Error('Đã dừng'));
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      const sec = progressSec(c);
      if (sec !== null) opts.onProgress?.(sec);
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      err = (err + c).slice(-2000);
    });
    const stop = () => child.kill('SIGKILL');
    opts.signal.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => {
      opts.signal.removeEventListener('abort', stop);
      reject(e);
    });
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', stop);
      if (opts.signal.aborted) return reject(new Error('Đã dừng'));
      if (code === 0) return resolve();
      const last = err.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      reject(new Error(last || `FFmpeg thoát với mã ${code}`));
    });
  });
}
