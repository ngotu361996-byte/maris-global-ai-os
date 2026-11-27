import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPrivate } from '../ai/url-guard';

/** Most bytes read from a response; the rest is cut off. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

export class ConnectorHttpError extends Error {
  constructor(
    readonly code:
      | 'CONNECTOR_BLOCKED_URL'
      | 'CONNECTOR_TIMEOUT'
      | 'CONNECTOR_NETWORK'
      | 'CONNECTOR_RESPONSE_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

/**
 * Checks the address a connector will call. Only https to public addresses, unless private
 * networks are allowed (self-hosted n8n, tests). The address actually connected to is checked
 * again at connect time (see guardedLookup), so a DNS answer that changes cannot slip past.
 */
export function assertConnectorUrl(url: URL, allowPrivate: boolean): void {
  if (url.username || url.password)
    throw new ConnectorHttpError('CONNECTOR_BLOCKED_URL', 'Địa chỉ không được chứa tài khoản');
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ConnectorHttpError('CONNECTOR_BLOCKED_URL', 'Chỉ hỗ trợ http(s)');
  if (url.protocol === 'http:' && !allowPrivate)
    throw new ConnectorHttpError('CONNECTOR_BLOCKED_URL', 'Phải dùng https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivate(host) && !allowPrivate)
    throw new ConnectorHttpError(
      'CONNECTOR_BLOCKED_URL',
      'Không cho phép gọi tới địa chỉ mạng nội bộ',
    );
}

/** DNS lookup that refuses private addresses, used for the connection itself. */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      if (!addresses.length) return callback(new Error('no address'), '', 0);
      if (!allowPrivate && addresses.some((a) => isPrivate(a.address))) {
        return callback(
          new ConnectorHttpError(
            'CONNECTOR_BLOCKED_URL',
            'Không cho phép gọi tới địa chỉ mạng nội bộ',
          ),
          '',
          0,
        );
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      }
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/**
 * One HTTP request for a connector. Redirects are not followed (a redirect could point anywhere),
 * the whole call has a deadline, and at most MAX_RESPONSE_BYTES of the response are read.
 */
export function connectorRequest(opts: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  allowPrivate: boolean;
}): Promise<HttpResult> {
  assertConnectorUrl(opts.url, opts.allowPrivate);
  const send = opts.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== null) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = send(
      opts.url,
      {
        method: opts.method,
        headers,
        lookup: guardedLookup(opts.allowPrivate),
        agent: false,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > MAX_RESPONSE_BYTES) {
            chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
            size = MAX_RESPONSE_BYTES;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        const finish = () =>
          done(() =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            }),
          );
        res.on('end', finish);
        res.on('error', (e) => done(() => reject(networkError(e))));
      },
    );
    const timer = setTimeout(() => {
      done(() =>
        reject(
          new ConnectorHttpError(
            'CONNECTOR_TIMEOUT',
            `Bên kia không trả lời trong ${Math.round(opts.timeoutMs / 1000)} giây`,
          ),
        ),
      );
      req.destroy();
    }, opts.timeoutMs);
    req.on('error', (e) => done(() => reject(networkError(e))));
    if (opts.body !== null) req.write(opts.body);
    req.end();
  });
}

function networkError(e: Error): ConnectorHttpError {
  if (e instanceof ConnectorHttpError) return e;
  const code = (e as { code?: string }).code;
  const why =
    code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      ? 'không tìm thấy tên miền'
      : code === 'ECONNREFUSED'
        ? 'bên kia từ chối kết nối'
        : (code ?? e.message);
  return new ConnectorHttpError('CONNECTOR_NETWORK', `Không kết nối được: ${why}`);
}
