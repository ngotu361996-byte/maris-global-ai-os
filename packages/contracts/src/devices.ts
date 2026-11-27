import { z } from 'zod';

export const DEVICE_KINDS = [
  'server',
  'admin_pc',
  'staff_pc',
  'gpu_worker',
  'media_worker',
  'local_ai_worker',
  'code_runner',
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  server: 'VPS điều hành trung tâm',
  admin_pc: 'Máy tính quản trị',
  staff_pc: 'Máy tính nhân viên',
  gpu_worker: 'GPU Worker',
  media_worker: 'Media Worker',
  local_ai_worker: 'AI Local Worker',
  code_runner: 'Code Runner',
};

export const DEVICE_STATUSES = ['pending', 'active', 'paused', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  pending: 'Chờ ghép nối',
  active: 'Đang hoạt động',
  paused: 'Tạm dừng',
  revoked: 'Đã thu hồi',
};

/** The worker sends a heartbeat this often; a device is offline after three missed beats. */
export const HEARTBEAT_INTERVAL_SEC = 15;
export const OFFLINE_AFTER_SEC = 45;
/** A pairing string works once, for this long. */
export const PAIRING_TTL_MIN = 30;
/** Warnings raised from a heartbeat. */
export const DEVICE_LIMITS = { diskPct: 90, ramPct: 95, gpuTempC: 85, cpuTempC: 90 } as const;
/** Format tag at the start of a pairing string: maris1.<tenantId>.<deviceId>.<secret> */
export const PAIRING_PREFIX = 'maris1';

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(DEVICE_KINDS),
});
export type CreateDevice = z.input<typeof createDeviceSchema>;

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    /** Resource limit: jobs this device may run at once. 0 takes it out of the rotation. */
    maxJobs: z.number().int().min(0).max(16).optional(),
  })
  .refine((v) => v.name !== undefined || v.maxJobs !== undefined, {
    message: 'Không có gì để đổi',
  });
export type UpdateDevice = z.input<typeof updateDeviceSchema>;

const num = (max: number) => z.number().finite().min(0).max(max);
const text = (max: number) => z.string().trim().max(max);

export const deviceGpuSchema = z.object({
  index: z.number().int().min(0).max(63),
  name: text(120),
  utilPct: num(100).nullable(),
  memUsedMb: num(10_000_000).nullable(),
  memTotalMb: num(10_000_000).nullable(),
  tempC: z.number().finite().min(-50).max(200).nullable(),
});
export type DeviceGpu = z.infer<typeof deviceGpuSchema>;

export const deviceInfoSchema = z.object({
  hostname: text(120).optional(),
  os: text(120).optional(),
  arch: text(20).optional(),
  cpuModel: text(160).optional(),
  cpuCores: z.number().int().min(0).max(4096).optional(),
  ramTotalMb: num(100_000_000).optional(),
  gpus: z
    .array(z.object({ name: text(120), memTotalMb: num(10_000_000).nullable() }))
    .max(64)
    .optional(),
  agentVersion: text(40).optional(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** The worker trades its one-time pairing string for a device token. */
export const pairDeviceSchema = z.object({
  pairing: z.string().trim().max(300),
  info: deviceInfoSchema,
});
export type PairDevice = z.input<typeof pairDeviceSchema>;

export const heartbeatSchema = z.object({
  cpuPct: num(100).nullable(),
  ramUsedMb: num(100_000_000).nullable(),
  ramTotalMb: num(100_000_000).nullable(),
  diskUsedGb: num(10_000_000).nullable(),
  diskTotalGb: num(10_000_000).nullable(),
  gpus: z.array(deviceGpuSchema).max(64).default([]),
  cpuTempC: z.number().finite().min(-50).max(200).nullable().default(null),
  agentVersion: text(40).optional(),
  /** Job kinds this worker can run right now (see WORKER_JOB_KINDS). Unknown kinds are ignored. */
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]{1,39}$/))
    .max(32)
    .optional(),
});
export type Heartbeat = z.input<typeof heartbeatSchema>;

export interface PairDeviceResponse {
  deviceId: string;
  tenantId: string;
  /** Shown to the worker once; only its hash is kept. */
  token: string;
  name: string;
  heartbeatSec: number;
}

/** What the server tells the worker on every heartbeat. */
export interface HeartbeatResponse {
  status: DeviceStatus;
  heartbeatSec: number;
  serverTime: string;
}

export interface DeviceMetricResponse {
  cpuPct: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  gpus: DeviceGpu[];
  cpuTempC: number | null;
  recordedAt: string;
}

export interface DeviceEventResponse {
  id: string;
  level: 'info' | 'warning' | 'error';
  kind: string;
  message: string;
  createdAt: string;
}

export interface DeviceResponse {
  id: string;
  name: string;
  kind: DeviceKind;
  status: DeviceStatus;
  online: boolean;
  info: DeviceInfo;
  lastSeenAt: string | null;
  lastIp: string | null;
  pairedAt: string | null;
  /** Set while a pairing string is waiting to be used. */
  pairingExpiresAt: string | null;
  latest: DeviceMetricResponse | null;
  /** Jobs this device may run at once; 0 means it gets none. */
  maxJobs: number;
  /** Job kinds the worker said it can run. */
  capabilities: string[];
  runningJobs: number;
  /** Current warnings worked out from the latest sample and the last heartbeat. */
  warnings: string[];
  createdAt: string;
}

/** Returned once, when a device is created or a new pairing string is made. */
export interface DevicePairingResponse {
  device: DeviceResponse;
  pairing: string;
  expiresAt: string;
}

/** The server MARIS itself runs on, measured by the API process. */
export interface ServerStatusResponse {
  hostname: string;
  os: string;
  uptimeSec: number;
  cpuCores: number;
  cpuPct: number | null;
  ramUsedMb: number;
  ramTotalMb: number;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  loadAvg: number[];
}

export interface MetricAlert {
  /** Stable per kind of problem, so a changing value does not count as a new alert. */
  key: string;
  message: string;
}

type MetricSample = {
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  gpus: DeviceGpu[];
  cpuTempC: number | null;
};

/** Alerts for one sample. */
export function metricAlerts(m: MetricSample): MetricAlert[] {
  const out: MetricAlert[] = [];
  const pct = (a: number | null, b: number | null) => (a !== null && b ? (a / b) * 100 : null);
  const disk = pct(m.diskUsedGb, m.diskTotalGb);
  if (disk !== null && disk >= DEVICE_LIMITS.diskPct)
    out.push({ key: 'disk', message: `Ổ đĩa đã dùng ${Math.round(disk)}%` });
  const ram = pct(m.ramUsedMb, m.ramTotalMb);
  if (ram !== null && ram >= DEVICE_LIMITS.ramPct)
    out.push({ key: 'ram', message: `RAM đã dùng ${Math.round(ram)}%` });
  for (const g of m.gpus)
    if (g.tempC !== null && g.tempC >= DEVICE_LIMITS.gpuTempC)
      out.push({ key: `gpu:${g.index}`, message: `GPU ${g.index} nóng ${Math.round(g.tempC)}°C` });
  if (m.cpuTempC !== null && m.cpuTempC >= DEVICE_LIMITS.cpuTempC)
    out.push({ key: 'cpu', message: `CPU nóng ${Math.round(m.cpuTempC)}°C` });
  return out;
}

/** Warnings for one sample, in words. */
export function metricWarnings(m: MetricSample): string[] {
  return metricAlerts(m).map((a) => a.message);
}
