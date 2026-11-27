import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProviderError } from './provider-error';

/**
 * SSRF guard for provider base URLs, checked on save and again before every call
 * (DNS answers can change). Only https to public addresses is allowed, except:
 * - an Ollama provider may use http on the loopback interface (it runs on the same machine);
 * - AI_ALLOW_PRIVATE_URLS=true allows private networks (self-hosted gateways, tests).
 */
export async function assertAllowedProviderUrl(raw: string, opts: { kind: string; allowPrivate: boolean }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('BLOCKED_URL', 'Địa chỉ không hợp lệ');
  }
  if (url.username || url.password) throw new ProviderError('BLOCKED_URL', 'Địa chỉ không được chứa tài khoản');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProviderError('BLOCKED_URL', 'Chỉ hỗ trợ http(s)');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  const loopbackOnly = addresses.every(isLoopback);
  const anyPrivate = addresses.some(isPrivate);
  const ollamaLocal = opts.kind === 'ollama' && loopbackOnly;

  if (anyPrivate && !opts.allowPrivate && !ollamaLocal) {
    throw new ProviderError('BLOCKED_URL', 'Không cho phép gọi tới địa chỉ mạng nội bộ');
  }
  if (url.protocol === 'http:' && !opts.allowPrivate && !ollamaLocal) {
    throw new ProviderError('BLOCKED_URL', 'Phải dùng https');
  }
  return url;
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const res = await lookup(host, { all: true, verbatim: true });
    if (!res.length) throw new Error('no address');
    return res.map((r) => r.address);
  } catch {
    throw new ProviderError('NETWORK', `Không phân giải được tên miền ${host}`);
  }
}

function v4(addr: string): number[] | null {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(addr);
  return m ? m.slice(1).map(Number) : null;
}

export function isLoopback(addr: string): boolean {
  const p = v4(addr);
  if (p) return p[0] === 127;
  return addr === '::1';
}

export function isPrivate(addr: string): boolean {
  const p = v4(addr);
  if (p) {
    const [a, b] = p as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const lower = addr.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower)
  );
}
