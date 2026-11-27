import {
  CONNECTOR_OUTPUT_MAX_CHARS,
  type ConnectorAuth,
  type ConnectorCapability,
} from '@maris/contracts';

export class RequestBuildError extends Error {
  constructor(
    readonly code: 'CONNECTOR_REQUEST_INVALID' | 'CONNECTOR_OUTPUT_MISSING',
    message: string,
  ) {
    super(message);
  }
}

export interface BuiltRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** What the call log keeps: method and address with every secret masked. */
  summary: string;
}

const PLACEHOLDER = /\{\{\s*([a-z]+)(?:\.([a-z][a-z0-9_]*))?\s*\}\}/g;
const MASK = '***';
const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

type Mode = 'path' | 'query' | 'body';

function fill(
  text: string,
  mode: Mode,
  inputs: Record<string, string | number>,
  secret: string | null,
): string {
  return text.replace(PLACEHOLDER, (_, kind: string, name: string | undefined) => {
    const raw = kind === 'secret' ? (secret ?? '') : String(inputs[name ?? ''] ?? '');
    if (mode === 'path') return encodeURIComponent(raw);
    if (mode === 'body') return JSON.stringify(raw).slice(1, -1);
    return raw;
  });
}

/**
 * Turns a capability and its inputs into one request. Inputs only fill the places the capability
 * marks: in the path each value is encoded so it stays one segment, and in the JSON body each value
 * is escaped so it stays inside its string. The finished address must still be under the base URL.
 */
export function buildRequest(
  connector: { baseUrl: string; auth: ConnectorAuth; headers: Record<string, string> },
  cap: ConnectorCapability,
  inputs: Record<string, string | number>,
  secret: string | null,
): BuiltRequest {
  const base = new URL(connector.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const build = (s: string | null, forLog: boolean) => {
    const value = forLog && secret !== null ? MASK : s;
    const path = fill(cap.path, 'path', inputs, value);
    if (path.split('/').some((seg) => DOT_SEGMENT.test(seg)))
      throw new RequestBuildError('CONNECTOR_REQUEST_INVALID', 'Ô nhập không được là "." hay ".."');
    const url = new URL(base.origin);
    url.pathname = basePath + path;
    for (const [k, v] of Object.entries(cap.query))
      url.searchParams.set(k, fill(v, 'query', inputs, null));
    if (connector.auth.type === 'query')
      url.searchParams.set(connector.auth.param, forLog ? MASK : (secret ?? ''));
    return url;
  };
  const url = build(secret, false);
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath))
    throw new RequestBuildError(
      'CONNECTOR_REQUEST_INVALID',
      'Địa chỉ gọi ra ngoài phạm vi của Connector',
    );

  let body: string | null = null;
  if (cap.body !== null) {
    try {
      body = JSON.stringify(JSON.parse(fill(cap.body, 'body', inputs, null)));
    } catch {
      throw new RequestBuildError(
        'CONNECTOR_REQUEST_INVALID',
        'Nội dung gửi đi không phải JSON hợp lệ',
      );
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...connector.headers,
    'User-Agent': 'MARIS-Connector/1.0',
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (connector.auth.type === 'bearer') headers.Authorization = `Bearer ${secret ?? ''}`;
  if (connector.auth.type === 'header') headers[connector.auth.header] = secret ?? '';

  const logged = build(secret, true);
  return {
    url,
    method: cap.method,
    headers,
    body,
    summary: `${cap.method} ${readable(logged.toString())}`.slice(0, 2000),
  };
}

/** Removes the secret wherever it shows up in text that will be stored or shown. */
export function redact(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join(MASK);
}

/** The text a call returns: the outputPath value of a JSON response, or the whole response. */
export function extractOutput(body: string, outputPath: string | null): string {
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(body);
    isJson = true;
  } catch {
    /* not JSON */
  }
  if (outputPath) {
    if (!isJson)
      throw new RequestBuildError(
        'CONNECTOR_OUTPUT_MISSING',
        `Kết quả không phải JSON nên không lấy được ${outputPath}`,
      );
    let v: unknown = parsed;
    for (const part of outputPath.split('.')) {
      if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, part)) {
        throw new RequestBuildError(
          'CONNECTOR_OUTPUT_MISSING',
          `Không thấy ${outputPath} trong kết quả`,
        );
      }
      v = (v as Record<string, unknown>)[part];
    }
    return cut(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  return cut(isJson ? JSON.stringify(parsed, null, 2) : body);
}

function readable(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function cut(text: string): string {
  return text.length > CONNECTOR_OUTPUT_MAX_CHARS
    ? `${text.slice(0, CONNECTOR_OUTPUT_MAX_CHARS - 1)}…`
    : text;
}
