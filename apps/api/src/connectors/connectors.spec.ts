import { connectorCapabilitySchema, type ConnectorAuth } from '@maris/contracts';
import { assertConnectorUrl, connectorRequest, ConnectorHttpError } from './connector-http';
import { buildRequest, extractOutput, redact, RequestBuildError } from './connector-request';

const cap = (c: Record<string, unknown>) =>
  connectorCapabilitySchema.parse({ key: 'x', label: 'X', risk: 'read', method: 'GET', ...c });
const conn = (auth: ConnectorAuth = { type: 'none' }, baseUrl = 'https://api.example.com/v1/') => ({
  baseUrl,
  auth,
  headers: {},
});

describe('connector requests', () => {
  it('keeps each path input inside its segment and under the base path', () => {
    const c = cap({
      path: '/repos/{{input.owner}}/issues',
      inputs: [{ name: 'owner', label: 'O', type: 'text' }],
    });
    const r = buildRequest(conn(), c, { owner: 'a/../../admin?x=1#y' }, null);
    expect(r.url.toString()).toBe(
      'https://api.example.com/v1/repos/a%2F..%2F..%2Fadmin%3Fx%3D1%23y/issues',
    );
    // An encoded dot stays encoded (%25), so it is not a dot segment either.
    expect(buildRequest(conn(), c, { owner: '%2e%2e' }, null).url.pathname).toBe(
      '/v1/repos/%252e%252e/issues',
    );
    for (const bad of ['..', '.'])
      expect(() => buildRequest(conn(), c, { owner: bad }, null)).toThrow(RequestBuildError);
  });

  it('escapes body inputs so they stay inside their JSON string', () => {
    const c = cap({
      method: 'POST',
      path: '/m',
      body: '{"text": "{{input.t}}", "n": 1}',
      inputs: [{ name: 't', label: 'T', type: 'long_text' }],
    });
    const evil = '", "admin": true, "x": "';
    const r = buildRequest(conn(), c, { t: evil }, null);
    expect(JSON.parse(r.body!)).toEqual({ text: evil, n: 1 });
  });

  it('puts the secret where the auth says, and masks it in the summary', () => {
    const c = cap({ path: '/bot{{secret}}/getMe', query: { a: 'b' } });
    const path = buildRequest(conn({ type: 'path', secret: 's' }), c, {}, '123:ABC/def');
    expect(path.url.pathname).toBe('/v1/bot123%3AABC%2Fdef/getMe');
    expect(path.summary).toBe('GET https://api.example.com/v1/bot***/getMe?a=b');

    const plain = cap({ path: '/me' });
    const q = buildRequest(conn({ type: 'query', param: 'key', secret: 's' }), plain, {}, 'sk-1');
    expect(q.url.searchParams.get('key')).toBe('sk-1');
    expect(q.summary).toContain('key=***');
    expect(q.summary).not.toContain('sk-1');
    const b = buildRequest(conn({ type: 'bearer', secret: 's' }), plain, {}, 'tok');
    expect(b.headers.Authorization).toBe('Bearer tok');
    expect(b.headers['User-Agent']).toBe('MARIS-Connector/1.0');
  });

  it('picks the output path from JSON, and says when it is missing', () => {
    expect(extractOutput('{"result":{"id":5}}', 'result.id')).toBe('5');
    expect(extractOutput('{"a":{"b":"c"}}', 'a')).toBe('{\n  "b": "c"\n}');
    expect(extractOutput('plain text', null)).toBe('plain text');
    expect(() => extractOutput('{"a":1}', 'b')).toThrow(RequestBuildError);
    expect(() => extractOutput('not json', 'a')).toThrow(RequestBuildError);
    expect(redact('token=sk-secret-1 again sk-secret-1', 'sk-secret-1')).toBe(
      'token=*** again ***',
    );
  });

  it('refuses private and plain-http addresses unless they are allowed', async () => {
    const blocked = (u: string) => () => assertConnectorUrl(new URL(u), false);
    expect(blocked('https://10.0.0.5/x')).toThrow(ConnectorHttpError);
    expect(blocked('https://[::1]/x')).toThrow(ConnectorHttpError);
    expect(blocked('http://example.com/x')).toThrow(ConnectorHttpError);
    expect(() => assertConnectorUrl(new URL('http://127.0.0.1:5678/x'), true)).not.toThrow();
    // A name that resolves to a private address is refused when connecting.
    await expect(
      connectorRequest({
        url: new URL('https://localhost:1/x'),
        method: 'GET',
        headers: {},
        body: null,
        timeoutMs: 2000,
        allowPrivate: false,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_BLOCKED_URL' });
  });
});
