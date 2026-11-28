import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_PRESET_INFO,
  JOB_POLL_SEC,
  MEDIA_LIMITS,
  VIDEO_COVER,
  workerJobInputSchemas,
  type ImagePreset,
  type MediaOutput,
  type AgentJob,
  type WorkerJobKind,
} from '@maris/contracts';
import {
  claimJob,
  downloadJobFile,
  downloadJobFileTo,
  finishJob,
  jobProgress,
  ServerError,
  uploadJobOutput,
  uploadJobOutputFile,
} from './client';
import { loadSharp, renderImage } from './image';
import { AGENT_VERSION, parseNvidiaSmi } from './metrics';
import { dockerAvailable, runSandbox } from './sandbox';
import { coverArgs, cutRange, findFfmpeg, probeVideo, runFfmpeg, videoArgs } from './video';

/** Ollama on this machine only; the address is fixed so a job cannot point the worker elsewhere. */
export const OLLAMA_URL = 'http://127.0.0.1:11434';
/** How often a running job reports progress (and renews its lease). */
const REPORT_SEC = 10;
/** Most jobs this program runs at once, whatever the server allows. */
const LOCAL_MAX = 4;
const RESPONSE_MAX_CHARS = 48_000;

export interface JobContext {
  signal: AbortSignal;
  /** Records progress and a log line; sent with the next report. */
  report(progress?: number, note?: string, logLine?: string): void;
  server: string;
  /** The job's time limit; the job is stopped when it runs out. */
  timeoutSec: number;
  /** Fetches a library file of this job (only its own image and logo are allowed). */
  download(assetId: string, maxBytes: number): Promise<Buffer>;
  /** Sends one output image of this job. */
  upload(preset: ImagePreset, fileName: string, data: Buffer): Promise<{ itemId: string }>;
  /** Saves a library file, or the voice-over item, of this job to disk. */
  downloadTo(
    what: { assetId: string } | { itemId: string },
    dest: string,
    maxBytes: number,
  ): Promise<number>;
  /** Sends one output file of this job from disk. */
  uploadFile(
    preset: ImagePreset | typeof VIDEO_COVER,
    fileName: string,
    file: string,
  ): Promise<{ itemId: string }>;
}

export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Sent with the failure, e.g. the output of a program that ran out of time. */
    readonly result?: unknown,
  ) {
    super(message);
  }
}

type Handler = (input: Record<string, unknown>, ctx: JobContext) => Promise<unknown>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new JobError('CANCELLED', 'Đã dừng'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new JobError('CANCELLED', 'Đã dừng'));
      },
      { once: true },
    );
  });

function nvidiaDetails(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=driver_version,name,memory.total', '--format=csv,noheader'],
      { timeout: 5000, windowsHide: true },
      (err, out) => resolve(err ? null : String(out).trim()),
    );
  });
}

export const HANDLERS: Record<WorkerJobKind, Handler> = {
  async diagnostics(_input, ctx) {
    ctx.report(10, 'Đọc thông tin máy');
    const disk = await statfs(
      process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/',
    )
      .then((s) => ({
        totalGb: Math.round(((s.blocks * s.bsize) / 1024 ** 3) * 10) / 10,
        freeGb: Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10,
      }))
      .catch(() => null);
    ctx.report(40, 'Đọc GPU');
    const gpuCsv = await new Promise<string>((resolve) =>
      execFile(
        'nvidia-smi',
        [
          '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
          '--format=csv,noheader,nounits',
        ],
        { timeout: 5000, windowsHide: true },
        (err, out) => resolve(err ? '' : String(out)),
      ),
    );
    ctx.report(70, 'Đo độ trễ tới MARIS');
    const t0 = Date.now();
    let latencyMs: number | null = null;
    try {
      const r = await fetch(`${ctx.server}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) latencyMs = Date.now() - t0;
    } catch {
      /* unreachable */
    }
    return {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeHours: Math.round(os.uptime() / 360) / 10,
      cpu: {
        model: os.cpus()[0]?.model.trim() ?? null,
        cores: os.cpus().length,
        loadAvg: os.loadavg(),
      },
      ram: {
        totalMb: Math.round(os.totalmem() / 1024 ** 2),
        freeMb: Math.round(os.freemem() / 1024 ** 2),
      },
      disk,
      gpus: parseNvidiaSmi(gpuCsv),
      nvidia: await nvidiaDetails(),
      ollama: await ollamaModels(),
      node: process.version,
      agentVersion: AGENT_VERSION,
      latencyMs,
    };
  },

  async 'test.wait'(raw, ctx) {
    const input = workerJobInputSchemas['test.wait'].parse(raw);
    for (let i = 1; i <= input.seconds; i++) {
      await sleep(1000, ctx.signal);
      ctx.report(
        Math.round((i / input.seconds) * 100),
        `${i}/${input.seconds} giây`,
        i % 10 === 0 ? `Đã đếm ${i} giây` : undefined,
      );
    }
    if (input.fail) throw new JobError('TEST_FAILURE', 'Việc thử được yêu cầu báo lỗi');
    return { waitedSec: input.seconds };
  },

  async 'ollama.generate'(raw, ctx) {
    const input = workerJobInputSchemas['ollama.generate'].parse(raw);
    ctx.report(5, `Gọi model ${input.model}`);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          stream: false,
          options: { num_predict: input.maxTokens },
        }),
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Đã dừng');
      throw new JobError(
        'OLLAMA_UNREACHABLE',
        `Không gọi được Ollama trên máy này: ${(e as Error).message}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      response?: string;
      error?: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };
    if (!res.ok)
      throw new JobError('OLLAMA_ERROR', body.error ?? `Ollama trả về HTTP ${res.status}`);
    const text = body.response ?? '';
    return {
      model: input.model,
      response: text.length > RESPONSE_MAX_CHARS ? `${text.slice(0, RESPONSE_MAX_CHARS)}…` : text,
      promptTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
      durationMs: Date.now() - t0,
    };
  },

  async 'code.run'(raw, ctx) {
    const input = workerJobInputSchemas['code.run'].parse(raw);
    ctx.report(5, 'Khởi động sandbox');
    // Leave a few seconds before the job's limit to stop the container and send the output.
    const timeoutMs = Math.max(5, ctx.timeoutSec - 5) * 1000;
    const out = await runSandbox(input, { signal: ctx.signal, timeoutMs });
    if (out.cancelled) throw new JobError('CANCELLED', 'Đã dừng');
    const { cancelled: _cancelled, ...result } = out;
    if (out.timedOut)
      throw new JobError(
        'CODE_TIMEOUT',
        `Chương trình chạy quá ${Math.round(timeoutMs / 1000)} giây nên đã bị dừng`,
        result,
      );
    // 125 is Docker's own failure (e.g. the image could not be pulled), not the program's.
    if (out.exitCode === 125)
      throw new JobError(
        'SANDBOX_ERROR',
        `Docker không chạy được sandbox: ${out.stderr.trim().slice(0, 500)}`,
      );
    ctx.report(100, `Mã thoát ${out.exitCode}`);
    return result;
  },

  async 'media.image'(raw, ctx) {
    const input = workerJobInputSchemas['media.image'].parse(raw);
    const sharp = await loadSharp();
    if (!sharp)
      throw new JobError('MEDIA_UNAVAILABLE', 'Máy này chưa có thư viện xử lý ảnh (sharp)');
    const maxBytes = MEDIA_LIMITS.imageMaxMb * 1024 * 1024;
    const fetchFile = async (id: string, what: string) => {
      try {
        return await ctx.download(id, maxBytes);
      } catch (e) {
        if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Đã dừng');
        throw new JobError(
          'MEDIA_DOWNLOAD_FAILED',
          `Không tải được ${what}: ${(e as Error).message}`,
        );
      }
    };
    ctx.report(5, 'Tải ảnh gốc');
    const source = await fetchFile(input.assetId, 'ảnh gốc');
    const logo = input.logoAssetId ? await fetchFile(input.logoAssetId, 'logo') : null;
    const outputs: MediaOutput[] = [];
    for (const [i, preset] of input.presets.entries()) {
      if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Đã dừng');
      const label = IMAGE_PRESET_INFO[preset].label;
      ctx.report(10 + Math.round((i / input.presets.length) * 85), `Đang làm ảnh ${label}`);
      let img;
      try {
        img = await renderImage(sharp, source, logo, preset, input);
      } catch (e) {
        throw new JobError('MEDIA_IMAGE_INVALID', `Không xử lý được ảnh: ${(e as Error).message}`);
      }
      let saved: { itemId: string };
      try {
        saved = await ctx.upload(
          preset,
          `${preset}-${img.width}x${img.height}.${img.ext}`,
          img.data,
        );
      } catch (e) {
        if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Đã dừng');
        throw new JobError(
          'MEDIA_UPLOAD_FAILED',
          `Không gửi được ảnh ${label}: ${(e as Error).message}`,
        );
      }
      outputs.push({
        preset,
        itemId: saved.itemId,
        width: img.width,
        height: img.height,
        sizeBytes: img.data.length,
      });
      ctx.report(
        10 + Math.round(((i + 1) / input.presets.length) * 85),
        `Xong ${i + 1}/${input.presets.length}`,
        `Đã gửi ảnh ${label} ${img.width}×${img.height} (${Math.round(img.data.length / 1024)} KB)`,
      );
    }
    return { outputs };
  },

  async 'media.video'(raw, ctx) {
    const input = workerJobInputSchemas['media.video'].parse(raw);
    const ff = await findFfmpeg();
    if (!ff)
      throw new JobError(
        'MEDIA_UNAVAILABLE',
        'Máy này chưa cài FFmpeg (cài bằng: winget install --id Gyan.FFmpeg -e, rồi mở lại cửa sổ)',
      );
    const cancelled = () => new JobError('CANCELLED', 'Đã dừng');
    const dir = await mkdtemp(join(os.tmpdir(), 'maris-video-'));
    try {
      const maxBytes = MEDIA_LIMITS.videoMaxMb * 1024 * 1024;
      const fetchTo = async (
        what: { assetId: string } | { itemId: string },
        name: string,
        label: string,
        max: number,
      ) => {
        const dest = join(dir, name);
        try {
          await ctx.downloadTo(what, dest, max);
          return dest;
        } catch (e) {
          if (ctx.signal.aborted) throw cancelled();
          throw new JobError(
            'MEDIA_DOWNLOAD_FAILED',
            `Không tải được ${label}: ${(e as Error).message}`,
          );
        }
      };
      ctx.report(2, 'Tải video gốc');
      const source = await fetchTo({ assetId: input.assetId }, 'source', 'video gốc', maxBytes);
      const logo = input.logoAssetId
        ? await fetchTo(
            { assetId: input.logoAssetId },
            'logo',
            'logo',
            MEDIA_LIMITS.imageMaxMb * 1024 * 1024,
          )
        : null;
      const voice = input.voiceItemId
        ? await fetchTo({ itemId: input.voiceItemId }, 'voice', 'giọng đọc', maxBytes)
        : null;

      let probe;
      try {
        probe = await probeVideo(ff.ffprobe, source);
      } catch (e) {
        throw new JobError('MEDIA_VIDEO_INVALID', `Không đọc được video: ${(e as Error).message}`);
      }
      const cut = cutRange(input, probe.durationSec, MEDIA_LIMITS.videoMaxSec);
      if (typeof cut === 'string') throw new JobError('MEDIA_VIDEO_CUT_INVALID', cut);
      ctx.report(
        5,
        'Bắt đầu xử lý',
        `Video ${probe.width}×${probe.height}, ${Math.round(probe.durationSec)} giây${probe.hasAudio ? '' : ', không có tiếng'}; giữ ${cut.length} giây từ giây ${cut.start}`,
      );

      const outputs: MediaOutput[] = [];
      const steps = input.presets.length + (input.coverAtSec !== null ? 0.2 : 0);
      let firstOut: { file: string; durationSec: number } | null = null;
      for (const [i, preset] of input.presets.entries()) {
        if (ctx.signal.aborted) throw cancelled();
        const label = IMAGE_PRESET_INFO[preset].label;
        const out = join(dir, `${preset}.mp4`);
        const plan = videoArgs({ source, logo, voice, out, preset, probe, cut, input });
        const base = 5 + (i / steps) * 90;
        ctx.report(Math.round(base), `Đang làm video ${label}`);
        try {
          await runFfmpeg(ff.ffmpeg, plan.args, {
            signal: ctx.signal,
            onProgress: (sec) =>
              ctx.report(
                Math.min(99, Math.round(base + (Math.min(1, sec / cut.length) * 90) / steps)),
                `Video ${label}: ${Math.min(100, Math.round((sec / cut.length) * 100))}%`,
              ),
          });
        } catch (e) {
          if (ctx.signal.aborted) throw cancelled();
          throw new JobError(
            'MEDIA_VIDEO_FAILED',
            `FFmpeg không làm được video ${label}: ${(e as Error).message}`,
          );
        }
        const { size } = await stat(out);
        let saved: { itemId: string };
        try {
          saved = await ctx.uploadFile(preset, `${preset}-${plan.width}x${plan.height}.mp4`, out);
        } catch (e) {
          if (ctx.signal.aborted) throw cancelled();
          throw new JobError(
            'MEDIA_UPLOAD_FAILED',
            `Không gửi được video ${label}: ${(e as Error).message}`,
          );
        }
        outputs.push({
          preset,
          itemId: saved.itemId,
          width: plan.width,
          height: plan.height,
          sizeBytes: size,
          durationSec: plan.durationSec,
        });
        ctx.report(
          Math.round(5 + ((i + 1) / steps) * 90),
          `Xong ${i + 1}/${input.presets.length}`,
          `Đã gửi video ${label} ${plan.width}×${plan.height} (${Math.round(size / 1024 / 1024)} MB)`,
        );
        if (!firstOut) firstOut = { file: out, durationSec: plan.durationSec };
        else await rm(out, { force: true });
      }

      if (input.coverAtSec !== null && firstOut) {
        ctx.report(96, 'Làm ảnh bìa');
        const cover = join(dir, 'cover.jpg');
        try {
          await runFfmpeg(
            ff.ffmpeg,
            coverArgs(firstOut.file, input.coverAtSec, firstOut.durationSec, cover),
            { signal: ctx.signal },
          );
          const saved = await ctx.uploadFile(VIDEO_COVER, `${input.presets[0]}-cover.jpg`, cover);
          const first = outputs[0]!;
          outputs.push({
            preset: VIDEO_COVER,
            itemId: saved.itemId,
            width: first.width,
            height: first.height,
            sizeBytes: (await stat(cover)).size,
          });
          ctx.report(99, 'Xong ảnh bìa', 'Đã gửi ảnh bìa');
        } catch (e) {
          if (ctx.signal.aborted) throw cancelled();
          throw new JobError(
            'MEDIA_UPLOAD_FAILED',
            `Không làm được ảnh bìa: ${(e as Error).message}`,
          );
        }
      }
      return { outputs, ffmpeg: ff.version };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

/** Models installed in Ollama on this machine, or null when Ollama is not running. */
export async function ollamaModels(): Promise<string[] | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name).slice(0, 50);
  } catch {
    return null;
  }
}

/**
 * Job kinds this machine can run now. Code runs only when the owner of the machine started the
 * worker with --allow-code and Docker is running.
 */
export async function capabilities(opts: { allowCode: boolean }): Promise<WorkerJobKind[]> {
  const kinds: WorkerJobKind[] = ['diagnostics', 'test.wait'];
  const models = await ollamaModels();
  if (models && models.length > 0) kinds.push('ollama.generate');
  if (opts.allowCode && (await dockerAvailable())) kinds.push('code.run');
  if (await loadSharp()) kinds.push('media.image');
  if (await findFfmpeg()) kinds.push('media.video');
  return kinds;
}

/** Asks for work, runs it with the handlers above, reports progress, and finishes it. */
export class JobRunner {
  private running = new Map<string, AbortController>();
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly server: string,
    private readonly token: string,
    private readonly say: (msg: string) => void,
  ) {}

  start(): void {
    void this.poll();
  }

  /** Stops asking for work and stops the jobs that are running (they go back to the queue). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const c of this.running.values()) c.abort();
  }

  get busy(): number {
    return this.running.size;
  }

  private async poll(): Promise<void> {
    let wait = JOB_POLL_SEC;
    if (!this.stopped && this.running.size < LOCAL_MAX) {
      try {
        const r = await claimJob(this.server, this.token);
        wait = r.pollSec;
        if (r.job) {
          void this.run(r.job);
          wait = 0.2; // there may be more
        }
      } catch (e) {
        if (e instanceof ServerError && e.status === 401) return; // the heartbeat loop reports this
        wait = JOB_POLL_SEC * 2;
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), wait * 1000);
  }

  private async run(job: AgentJob): Promise<void> {
    const handler = HANDLERS[job.kind];
    const controller = new AbortController();
    this.running.set(job.id, controller);
    this.say(`Nhận việc ${job.kind} (${job.id.slice(-6)})`);
    let progress: number | undefined;
    let note: string | undefined;
    let logs: { level: 'info' | 'warning' | 'error'; message: string }[] = [];
    let cancelledByServer = false;

    const send = async () => {
      const batch = logs;
      logs = [];
      try {
        const r = await jobProgress(this.server, this.token, job.id, {
          progress,
          note,
          logs: batch,
        });
        if (r.cancel) {
          cancelledByServer = true;
          controller.abort();
        }
      } catch {
        /* the lease covers a missed report */
      }
    };
    const reporter = setInterval(() => void send(), REPORT_SEC * 1000);
    const limit = setTimeout(() => controller.abort(), job.timeoutSec * 1000);

    let outcome: Parameters<typeof finishJob>[3];
    try {
      if (!handler)
        throw new JobError('KIND_UNSUPPORTED', `Worker này không chạy được việc ${job.kind}`);
      const result = await handler(job.input, {
        signal: controller.signal,
        server: this.server,
        timeoutSec: job.timeoutSec,
        download: (assetId, maxBytes) =>
          downloadJobFile(this.server, this.token, job.id, assetId, maxBytes, controller.signal),
        downloadTo: (what, dest, maxBytes) =>
          downloadJobFileTo(
            this.server,
            this.token,
            job.id,
            what,
            dest,
            maxBytes,
            controller.signal,
          ),
        uploadFile: (preset, fileName, file) =>
          uploadJobOutputFile(
            this.server,
            this.token,
            job.id,
            preset,
            fileName,
            file,
            controller.signal,
          ),
        upload: (preset, fileName, data) =>
          uploadJobOutput(
            this.server,
            this.token,
            job.id,
            preset,
            fileName,
            data,
            controller.signal,
          ),
        report: (p, n, line) => {
          if (p !== undefined) progress = p;
          if (n !== undefined) note = n;
          if (line && logs.length < 20) logs.push({ level: 'info', message: line });
        },
      });
      outcome = { status: 'completed', result, logs };
    } catch (e) {
      const stopped = controller.signal.aborted;
      outcome = stopped
        ? { status: 'cancelled', errorCode: cancelledByServer ? 'CANCELLED' : 'JOB_TIMEOUT', logs }
        : {
            status: 'failed',
            errorCode: e instanceof JobError ? e.code : 'JOB_FAILED',
            errorMessage: (e as Error).message.slice(0, 1000),
            ...(e instanceof JobError && e.result !== undefined ? { result: e.result } : {}),
            logs,
          };
    } finally {
      clearInterval(reporter);
      clearTimeout(limit);
      this.running.delete(job.id);
    }
    // When this program is closing, leave the job to its lease so it goes to another worker.
    if (this.stopped && outcome.status === 'cancelled') return;
    try {
      await finishJob(this.server, this.token, job.id, outcome);
    } catch (e) {
      this.say(`Không gửi được kết quả việc ${job.id.slice(-6)}: ${(e as Error).message}`);
    }
    const label =
      outcome.status === 'completed' ? 'xong' : outcome.status === 'cancelled' ? 'đã dừng' : 'lỗi';
    this.say(`Việc ${job.kind} (${job.id.slice(-6)}) ${label}`);
  }
}
