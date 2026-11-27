import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WorkerConfig {
  server: string;
  tenantId: string;
  deviceId: string;
  name: string;
  /** The device key. Only this machine has it; MARIS keeps a hash. */
  token: string;
}

export function configDir(): string {
  return process.env.MARIS_WORKER_HOME ?? path.join(os.homedir(), '.maris-worker');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export async function loadConfig(): Promise<WorkerConfig | null> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as WorkerConfig;
  } catch {
    return null;
  }
}

/** Written so that only the current user can read it. */
export async function saveConfig(c: WorkerConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath(), 0o600).catch(() => {});
}

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/;

/**
 * The API base, e.g. https://maris.example.com/api/v1. Plain http is allowed only for this machine
 * and the local network, so the device key never crosses the internet unencrypted.
 */
export function normalizeServer(input: string, allowInsecure = false): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error(`Địa chỉ máy chủ không hợp lệ: ${input}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('Địa chỉ máy chủ phải bắt đầu bằng https://');
  if (u.protocol === 'http:' && !allowInsecure && !PRIVATE_HOST.test(u.hostname))
    throw new Error(
      'Máy chủ trên Internet phải dùng https:// để khóa thiết bị không bị lộ trên đường truyền',
    );
  if (u.username || u.password)
    throw new Error('Không ghi tên đăng nhập hay mật khẩu trong địa chỉ');
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith('/api/v1')) p = `${p}/api/v1`;
  return `${u.protocol}//${u.host}${p}`;
}
