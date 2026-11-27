import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import {
  JOB_POLL_SEC,
  workerJobInputSchemas,
  type AgentJob,
  type WorkerJobKind,
} from '@maris/contracts';
import { claimJob, finishJob, jobProgress, ServerError } from './client';
import { AGENT_VERSION, parseNvidiaSmi } from './metrics';

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
}

export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
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

/** Job kinds this machine can run now. */
export async function capabilities(): Promise<WorkerJobKind[]> {
  const kinds: WorkerJobKind[] = ['diagnostics', 'test.wait'];
  const models = await ollamaModels();
  if (models && models.length > 0) kinds.push('ollama.generate');
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
