import { z } from 'zod';
import { DEVICE_KINDS, type DeviceKind } from './devices';

/**
 * Work for workers (spec Part 26). Each kind is implemented inside the worker program; there is no
 * kind that runs a shell command. `code.run` runs Python or Node code only inside a locked-down
 * Docker container, only on a device of kind code_runner whose owner started the worker with
 * --allow-code, and only for people with the infra.code permission.
 */
export const WORKER_JOB_KINDS = [
  'diagnostics',
  'ollama.generate',
  'test.wait',
  'code.run',
  'media.image',
] as const;
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];
/**
 * Kinds that only MARIS itself queues, from a screen that checks what they work on (e.g. an image
 * job from the content library, which checks the image's rights). They cannot be queued or retried
 * from the jobs screen.
 */
export const INTERNAL_JOB_KINDS = ['media.image'] as const satisfies readonly WorkerJobKind[];
export const isInternalJobKind = (k: string) =>
  (INTERNAL_JOB_KINDS as readonly string[]).includes(k);
/** Kinds a person can queue on the jobs screen. */
export const MANUAL_JOB_KINDS = WORKER_JOB_KINDS.filter((k) => !isInternalJobKind(k));

export const WORKER_JOB_KIND_INFO: Record<
  WorkerJobKind,
  { label: string; description: string; timeoutSec: number }
> = {
  diagnostics: {
    label: 'Kiểm tra máy',
    description: 'Báo cáo chi tiết hệ điều hành, CPU, RAM, ổ đĩa, GPU, Node.js và độ trễ tới MARIS',
    timeoutSec: 60,
  },
  'ollama.generate': {
    label: 'AI cục bộ (Ollama)',
    description: 'Chạy một model trên Ollama của chính máy đó (127.0.0.1:11434), không tốn phí API',
    timeoutSec: 900,
  },
  'test.wait': {
    label: 'Việc thử',
    description: 'Đếm giây và báo tiến độ, để thử phân việc, hủy và chuyển máy',
    timeoutSec: 900,
  },
  'code.run': {
    label: 'Chạy mã trong sandbox',
    description:
      'Chạy mã Python hoặc Node.js trong container Docker cách ly: không mạng, không ghi đĩa, giới hạn RAM, CPU và thời gian',
    timeoutSec: 120,
  },
  'media.image': {
    label: 'Xử lý ảnh',
    description:
      'Chuẩn hóa kích thước, đổi tỉ lệ khung hình, tạo thumbnail và gắn logo cho ảnh trong kho nội dung',
    timeoutSec: 600,
  },
};

// ------------------------------------------------------------------------- media.image

/** Output sizes for the platforms (spec Part 13: chuẩn hóa kích thước, thumbnail, tỉ lệ khung hình). */
export const IMAGE_PRESETS = [
  'feed_square',
  'feed_portrait',
  'story',
  'landscape',
  'thumbnail',
  'original',
] as const;
export type ImagePreset = (typeof IMAGE_PRESETS)[number];
export const IMAGE_PRESET_INFO: Record<
  ImagePreset,
  { label: string; hint: string; width: number | null; height: number | null }
> = {
  feed_square: {
    label: 'Vuông 1:1',
    hint: 'Bài đăng Facebook, Instagram',
    width: 1080,
    height: 1080,
  },
  feed_portrait: {
    label: 'Dọc 4:5',
    hint: 'Bài đăng Instagram, Facebook',
    width: 1080,
    height: 1350,
  },
  story: { label: 'Dọc 9:16', hint: 'Story, Reels, TikTok', width: 1080, height: 1920 },
  landscape: { label: 'Ngang 16:9', hint: 'Banner, website, Facebook', width: 1920, height: 1080 },
  thumbnail: { label: 'Thumbnail', hint: 'Ảnh bìa YouTube 1280×720', width: 1280, height: 720 },
  original: { label: 'Giữ cỡ gốc', hint: 'Chỉ gắn logo hoặc chỉnh ảnh', width: null, height: null },
};
export const IMAGE_FITS = ['cover', 'contain'] as const;
export const IMAGE_FIT_LABEL: Record<(typeof IMAGE_FITS)[number], string> = {
  cover: 'Cắt cho vừa khung (giữ phần chính của ảnh)',
  contain: 'Giữ trọn ảnh, thêm nền vào chỗ trống',
};
export const LOGO_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
] as const;
export const LOGO_POSITION_LABEL: Record<(typeof LOGO_POSITIONS)[number], string> = {
  'top-left': 'Góc trên trái',
  'top-right': 'Góc trên phải',
  'bottom-left': 'Góc dưới trái',
  'bottom-right': 'Góc dưới phải',
  center: 'Giữa ảnh',
};
export const IMAGE_FORMATS = ['jpeg', 'webp', 'png'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export const MEDIA_LIMITS = {
  /** Largest source image or logo, in MB. */
  imageMaxMb: 50,
  /** Largest source image, in pixels (about 100 megapixels), so a crafted file cannot exhaust RAM. */
  maxInputPixels: 100_000_000,
} as const;

/** Device kinds that may run code.run; the server adds this target to every code job. */
export const CODE_RUNNER_KINDS = ['code_runner'] as const satisfies readonly DeviceKind[];
export const CODE_LANGUAGES = ['python', 'node'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export const CODE_LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  python: 'Python 3.12',
  node: 'Node.js 22',
};
/** Limits of one sandbox run. The worker enforces them; the server checks code size and time. */
export const SANDBOX_LIMITS = {
  codeMaxChars: 50_000,
  stdinMaxChars: 10_000,
  memoryMb: 256,
  cpus: 1,
  pids: 64,
  outputMaxBytes: 32 * 1024,
  maxTimeoutSec: 600,
} as const;

export const WORKER_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkerJobStatus = (typeof WORKER_JOB_STATUSES)[number];
export const WORKER_JOB_STATUS_LABEL: Record<WorkerJobStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

/** A worker holds a job this long after each report; then it goes back to the queue. */
export const JOB_LEASE_SEC = 60;
/** How often an idle worker asks for work. */
export const JOB_POLL_SEC = 5;
/** Largest result a worker may send back, in bytes of JSON. */
export const JOB_RESULT_MAX_BYTES = 64 * 1024;

export const workerJobInputSchemas = {
  diagnostics: z.object({}).strict(),
  'ollama.generate': z
    .object({
      model: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._:/-]{1,100}$/, 'Tên model chỉ gồm chữ, số và . _ : / -'),
      prompt: z.string().trim().min(1).max(20_000),
      maxTokens: z.number().int().min(1).max(8192).default(512),
    })
    .strict(),
  'test.wait': z
    .object({
      seconds: z.number().int().min(1).max(600).default(30),
      /** Fail at the end, to try error handling. */
      fail: z.boolean().default(false),
    })
    .strict(),
  'code.run': z
    .object({
      language: z.enum(CODE_LANGUAGES),
      code: z.string().min(1).max(SANDBOX_LIMITS.codeMaxChars),
      stdin: z.string().max(SANDBOX_LIMITS.stdinMaxChars).default(''),
    })
    .strict(),
  'media.image': z
    .object({
      assetId: z.uuid(),
      logoAssetId: z.uuid().nullable().default(null),
      /** Output folder for the new items. */
      folderId: z.uuid().nullable().default(null),
      presets: z
        .array(z.enum(IMAGE_PRESETS))
        .min(1, 'Chọn ít nhất một cỡ ảnh')
        .max(IMAGE_PRESETS.length)
        .transform((p) => [...new Set(p)]),
      fit: z.enum(IMAGE_FITS).default('cover'),
      background: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'Màu nền dạng #RRGGBB')
        .default('#ffffff'),
      logo: z
        .object({
          position: z.enum(LOGO_POSITIONS).default('bottom-right'),
          /** Logo width as a share of the image width. */
          sizePct: z.number().int().min(5).max(40).default(15),
          opacity: z.number().min(0.1).max(1).default(1),
          marginPct: z.number().int().min(0).max(10).default(3),
        })
        .strict()
        .default({ position: 'bottom-right', sizePct: 15, opacity: 1, marginPct: 3 }),
      /** Stretch the levels of a dull image (cân chỉnh ánh sáng). */
      autoLevel: z.boolean().default(false),
      sharpen: z.boolean().default(false),
      format: z.enum(IMAGE_FORMATS).default('jpeg'),
      quality: z.number().int().min(50).max(100).default(85),
    })
    .strict(),
} satisfies Record<WorkerJobKind, z.ZodType>;
export type WorkerJobInput<K extends WorkerJobKind> = z.infer<(typeof workerJobInputSchemas)[K]>;

export const createWorkerJobSchema = z.object({
  kind: z.enum(WORKER_JOB_KINDS),
  title: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(-10).max(10).default(0),
  /** Only this device. */
  targetDeviceId: z.uuid().nullable().default(null),
  /** Only these kinds of device; empty means any. */
  targetKinds: z.array(z.enum(DEVICE_KINDS)).max(DEVICE_KINDS.length).default([]),
  needGpu: z.boolean().default(false),
  minFreeRamMb: z.number().int().min(0).max(10_000_000).default(0),
  timeoutSec: z.number().int().min(10).max(86_400).optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export type CreateWorkerJob = z.input<typeof createWorkerJobSchema>;

const logLine = z.object({
  level: z.enum(['info', 'warning', 'error']).default('info'),
  message: z.string().trim().min(1).max(1000),
});

export const claimJobSchema = z.object({});
export type ClaimJob = z.input<typeof claimJobSchema>;

export const jobProgressSchema = z.object({
  progress: z.number().int().min(0).max(100).optional(),
  note: z.string().trim().max(200).optional(),
  logs: z.array(logLine).max(20).default([]),
});
export type JobProgress = z.input<typeof jobProgressSchema>;

export const finishJobSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  result: z.unknown().optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,59}$/)
    .optional(),
  errorMessage: z.string().trim().max(1000).optional(),
  logs: z.array(logLine).max(20).default([]),
});
export type FinishJob = z.input<typeof finishJobSchema>;

/** What a worker gets when it claims a job. */
export interface AgentJob {
  id: string;
  kind: WorkerJobKind;
  input: Record<string, unknown>;
  timeoutSec: number;
  leaseSec: number;
}

export interface ClaimJobResponse {
  job: AgentJob | null;
  pollSec: number;
}

export interface JobProgressResponse {
  /** Stop now: the job was cancelled, moved to another worker, or ran past its time. */
  cancel: boolean;
  leaseSec: number;
}

export interface WorkerJobResponse {
  id: string;
  kind: WorkerJobKind;
  title: string;
  input: Record<string, unknown>;
  status: WorkerJobStatus;
  priority: number;
  targetDeviceId: string | null;
  targetKinds: DeviceKind[];
  needGpu: boolean;
  minFreeRamMb: number;
  timeoutSec: number;
  maxAttempts: number;
  attempts: number;
  deviceId: string | null;
  deviceName: string | null;
  progress: number;
  progressNote: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What a finished code.run job returns. */
export interface CodeRunResult {
  language: CodeLanguage;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** One finished image of a media.image job, as the worker reports it. */
export interface MediaOutput {
  preset: ImagePreset;
  itemId: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** The answer to a worker that sends one output image. */
export interface MediaOutputResponse {
  itemId: string;
  /** This preset was already saved for the job (a resend); nothing new was made. */
  duplicate: boolean;
}

export interface WorkerJobLogResponse {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  deviceId: string | null;
  createdAt: string;
}
