import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { DeviceGpu, DeviceInfo, Heartbeat } from '@maris/contracts';

export const AGENT_VERSION = '0.15.0';

const round = (n: number) => Math.round(n * 100) / 100;

export interface CpuTimes {
  idle: number;
  total: number;
}

export function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  return cpus.reduce(
    (acc, c) => {
      const t = c.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

/** Busy share of all CPUs between two readings, in percent. */
export function cpuPercent(a: CpuTimes, b: CpuTimes): number | null {
  const total = b.total - a.total;
  if (total <= 0) return null;
  return round(Math.min(100, Math.max(0, ((total - (b.idle - a.idle)) / total) * 100)));
}

const nullableNumber = (s: string | undefined): number | null => {
  const v = Number((s ?? '').trim());
  return (s ?? '').trim() === '' || !Number.isFinite(v) ? null : v;
};

/**
 * Parses `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu
 * --format=csv,noheader,nounits`. Values nvidia-smi cannot read come back as "[N/A]".
 */
export function parseNvidiaSmi(out: string): DeviceGpu[] {
  const gpus: DeviceGpu[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 6) continue;
    const index = Number(cols[0]);
    if (!Number.isInteger(index) || index < 0 || index > 63) continue;
    const pct = nullableNumber(cols[2]);
    gpus.push({
      index,
      name: cols[1]!.slice(0, 120),
      utilPct: pct === null ? null : Math.min(100, Math.max(0, pct)),
      memUsedMb: nullableNumber(cols[3]),
      memTotalMb: nullableNumber(cols[4]),
      tempC: nullableNumber(cols[5]),
    });
  }
  return gpus.slice(0, 64);
}

/** NVIDIA GPUs, when nvidia-smi is installed. Other machines report none. */
export function readGpus(): Promise<DeviceGpu[]> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(err ? [] : parseNvidiaSmi(String(stdout))),
    );
  });
}

function systemDisk(): string {
  return process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
}

async function readDisk(): Promise<{ usedGb: number | null; totalGb: number | null }> {
  try {
    const s = await statfs(systemDisk());
    const gb = (blocks: number) => round((blocks * s.bsize) / 1024 ** 3);
    return { usedGb: gb(s.blocks - s.bfree), totalGb: gb(s.blocks) };
  } catch {
    return { usedGb: null, totalGb: null };
  }
}

/** CPU temperature where the system shows it without extra tools (Linux). */
async function readCpuTemp(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const milli = Number((await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')).trim());
    return Number.isFinite(milli) ? round(milli / 1000) : null;
  } catch {
    return null;
  }
}

/** What the machine is, sent once when pairing. */
export async function collectInfo(): Promise<DeviceInfo> {
  const gpus = await readGpus();
  const cpus = os.cpus();
  return {
    hostname: os.hostname().slice(0, 120),
    os: `${os.type()} ${os.release()}`.slice(0, 120),
    arch: os.arch().slice(0, 20),
    cpuModel: (cpus[0]?.model ?? '').trim().slice(0, 160),
    cpuCores: cpus.length,
    ramTotalMb: Math.round(os.totalmem() / 1024 ** 2),
    gpus: gpus.map((g) => ({ name: g.name, memTotalMb: g.memTotalMb })),
    agentVersion: AGENT_VERSION,
  };
}

/** Takes one sample. CPU use is measured since the previous call. */
export class Sampler {
  private last = cpuTimes();

  async sample(): Promise<Heartbeat> {
    const now = cpuTimes();
    const cpuPct = cpuPercent(this.last, now);
    this.last = now;
    const [disk, gpus, cpuTempC] = await Promise.all([readDisk(), readGpus(), readCpuTemp()]);
    return {
      cpuPct,
      ramUsedMb: Math.round((os.totalmem() - os.freemem()) / 1024 ** 2),
      ramTotalMb: Math.round(os.totalmem() / 1024 ** 2),
      diskUsedGb: disk.usedGb,
      diskTotalGb: disk.totalGb,
      gpus,
      cpuTempC,
      agentVersion: AGENT_VERSION,
    };
  }
}
