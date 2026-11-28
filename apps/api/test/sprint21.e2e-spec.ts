import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { MetaGraphService } from '../src/meta/meta-graph.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner21@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ shop',
  tenantName: 'Shop Áo Thun',
};
const APP_ID = '123456789012';
const APP_SECRET = 'app-secret-123';
const LONG = 'long-user-token-abc';
const PAGE_TOKEN = 'page-token-xyz';

/** A small stand-in for graph.facebook.com that checks what MARIS sends. */
class FakeGraph {
  server!: Server;
  url = '';
  hits: string[] = [];
  /** Problems to answer with, by path. */
  fail: Record<string, { status: number; body: unknown; headers?: Record<string, string> }> = {};
  tokenValid = true;
  badProof = 0;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, this.url);
    const path = u.pathname.replace(/^\/v23\.0/, '');
    this.hits.push(`${req.method} ${path}`);
    const q = u.searchParams;
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const f = this.fail[path];
    if (f) return send(f.status, f.body, f.headers);
    // Calls made with a user or page token carry its appsecret_proof.
    if (token && !token.includes('|')) {
      const proof = createHmac('sha256', APP_SECRET).update(token).digest('hex');
      if (q.get('appsecret_proof') !== proof) this.badProof++;
    }
    if (path === '/oauth/access_token') {
      if (q.get('client_id') !== APP_ID || q.get('client_secret') !== APP_SECRET)
        return send(400, { error: { code: 1, message: 'bad client' } });
      if (q.get('code') === 'good-code') {
        if (q.get('redirect_uri') !== 'http://localhost:3000/meta/callback')
          return send(400, { error: { code: 100, message: 'redirect mismatch' } });
        return send(200, { access_token: 'short-token', token_type: 'bearer', expires_in: 3600 });
      }
      if (
        q.get('grant_type') === 'fb_exchange_token' &&
        q.get('fb_exchange_token') === 'short-token'
      )
        return send(200, { access_token: LONG, token_type: 'bearer', expires_in: 5_184_000 });
      return send(400, { error: { code: 100, message: 'Invalid verification code' } });
    }
    if (path === '/debug_token') {
      if (token !== `${APP_ID}|${APP_SECRET}`)
        return send(400, { error: { code: 190, message: 'app token' } });
      return send(200, {
        data: this.tokenValid
          ? { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 50 * 86400, scopes: [] }
          : {
              is_valid: false,
              expires_at: 0,
              error: { message: 'The user has not authorized application' },
            },
      });
    }
    if (token !== LONG)
      return send(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (path === '/me' && req.method === 'GET')
      return send(200, { id: '1001', name: 'Tú Người Hoa' });
    if (path === '/me/permissions' && req.method === 'GET')
      return send(200, {
        data: [
          ...[
            'pages_show_list',
            'pages_read_engagement',
            'pages_manage_posts',
            'pages_manage_metadata',
            'instagram_basic',
            'instagram_content_publish',
            'ads_read',
          ].map((permission) => ({ permission, status: 'granted' })),
          { permission: 'ads_management', status: 'declined' },
        ],
      });
    if (path === '/me/permissions' && req.method === 'DELETE') return send(200, { success: true });
    if (path === '/me/accounts') {
      const usage = { 'x-app-usage': '{"call_count":28,"total_time":12,"total_cputime":9}' };
      if (!q.get('after'))
        return send(
          200,
          {
            data: [
              {
                id: '5551',
                name: 'Áo Thun Tú',
                category: 'Clothing',
                tasks: ['ADVERTISE', 'CREATE_CONTENT', 'MODERATE'],
                access_token: PAGE_TOKEN,
                instagram_business_account: {
                  id: '1784',
                  username: 'aothuntu',
                  name: 'Áo Thun Tú IG',
                },
              },
            ],
            paging: { cursors: { after: 'c1' }, next: `${this.url}/next` },
          },
          usage,
        );
      return send(
        200,
        {
          data: [
            {
              id: '5552',
              name: 'Tú Outlet',
              category: 'Shopping',
              tasks: ['CREATE_CONTENT'],
              access_token: 'page-2',
            },
          ],
          paging: { cursors: { after: 'c2' } },
        },
        usage,
      );
    }
    if (path === '/me/adaccounts')
      return send(200, {
        data: [
          {
            id: 'act_777',
            name: 'Quảng cáo Tú',
            account_status: 1,
            currency: 'VND',
            timezone_name: 'Asia/Ho_Chi_Minh',
          },
        ],
      });
    send(404, { error: { code: 803, message: `unknown ${path}` } });
  }
}

describe('Sprint 21 (e2e): Meta connection and the API Governor', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const graph = new FakeGraph();
  let token: string;
  let tenantId: string;
  let managerToken: string;
  let memberToken: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const M = '/api/v1/meta';
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

  beforeAll(async () => {
    await resetDatabase();
    await graph.start();
    app = await startApp({ META_GRAPH_URL: graph.url, META_RETRY_BASE_MS: '1' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const join = async (key: string) => {
      const inv = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as())
        .send({ email: `s21.${key}@example.com`, roleId: roles.find((r) => r.key === key)!.id })
        .expect(201);
      return (
        await http
          .post('/api/v1/invitations/accept')
          .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: key })
          .expect(200)
      ).body.token as string;
    };
    managerToken = await join('manager');
    memberToken = await join('member');
  });

  afterAll(async () => {
    await app.close();
    await graph.stop();
  });

  it('needs meta.read to look and meta.manage to set up', async () => {
    await http.get(M).set(as(memberToken)).expect(403);
    const s = (await http.get(M).set(as(managerToken)).expect(200)).body;
    expect(s).toMatchObject({
      app: null,
      connection: null,
      redirectUri: 'http://localhost:3000/meta/callback',
    });
    expect(s.governor).toMatchObject({ used: 0, budget: 3000, level: 'Hoạt động bình thường' });
    expect(s.governor.platform.status).toBe('unknown');
    await http
      .put(`${M}/app`)
      .set(as(managerToken))
      .send({ appId: APP_ID, appSecretName: 'meta.app_secret' })
      .expect(403);
    const r = await http.post(`${M}/oauth/start`).set(as()).expect(409);
    expect(r.body.error.code).toBe('META_APP_MISSING');
  });

  it('keeps the App Secret in the vault and starts Meta’s own sign-in', async () => {
    let s = (
      await http
        .put(`${M}/app`)
        .set(as())
        .send({ appId: APP_ID, appSecretName: 'meta.app_secret' })
        .expect(200)
    ).body;
    expect(s.app).toMatchObject({ appId: APP_ID, secretFound: false, graphVersion: 'v23.0' });
    await http
      .post('/api/v1/secrets')
      .set(as())
      .send({ name: 'meta.app_secret', value: APP_SECRET })
      .expect(201);
    s = (await http.get(M).set(as()).expect(200)).body;
    expect(s.app.secretFound).toBe(true);
    expect(JSON.stringify(s)).not.toContain(APP_SECRET);

    const { url } = (await http.post(`${M}/oauth/start`).set(as()).expect(200)).body;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe(APP_ID);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/meta/callback');
    expect(u.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs in, stores sealed tokens and syncs Pages, Instagram and ad accounts', async () => {
    const { url } = (await http.post(`${M}/oauth/start`).set(as()).expect(200)).body;
    // A state from someone else, or made up, is refused.
    const other = (await http.post(`${M}/oauth/start`).set(as()).expect(200)).body.url;
    await http
      .post(`${M}/oauth/callback`)
      .set(as())
      .send({ code: 'good-code', state: 'x'.repeat(43) })
      .expect(400);

    const s = (
      await http
        .post(`${M}/oauth/callback`)
        .set(as())
        .send({ code: 'good-code', state: stateOf(url) })
        .expect(200)
    ).body;
    expect(graph.badProof).toBe(0);
    expect(s.connection).toMatchObject({
      fbUserId: '1001',
      fbName: 'Tú Người Hoa',
      status: 'active',
      declined: ['ads_management'],
      connectedByName: 'Chủ shop',
    });
    expect(Date.parse(s.connection.tokenExpiresAt) - Date.now()).toBeGreaterThan(59 * 86400_000);
    expect(
      // Name order depends on the database collation, so compare in a fixed order.
      s.assets
        .map((a: { kind: string; name: string; enabled: boolean }) => [a.kind, a.name, a.enabled])
        .sort((x: string[], y: string[]) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`, 'en')),
    ).toEqual([
      ['ad_account', 'Quảng cáo Tú', true],
      ['instagram', 'Áo Thun Tú IG', true],
      ['page', 'Áo Thun Tú', true],
      ['page', 'Tú Outlet', true],
    ]);
    const ig = s.assets.find((a: { kind: string }) => a.kind === 'instagram');
    expect(ig).toMatchObject({
      username: 'aothuntu',
      pageId: s.assets.find((a: { externalId: string }) => a.externalId === '5551').id,
    });
    const features = Object.fromEntries(
      s.features.map((f: { key: string; ready: boolean }) => [f.key, f.ready]),
    );
    expect(features).toMatchObject({
      pages: true,
      publish: true,
      instagram: true,
      ads_read: true,
      ads_manage: false,
      messages: false,
    });
    // Both pages of /me/accounts were read with the cursor.
    expect(graph.hits.filter((h) => h === 'GET /me/accounts')).toHaveLength(2);

    // Each sign-in state works once.
    await http
      .post(`${M}/oauth/callback`)
      .set(as())
      .send({ code: 'good-code', state: stateOf(url) })
      .expect(400);
    expect(stateOf(other)).not.toBe(stateOf(url));

    const sql = admin();
    const [conn] = await sql`SELECT token_sealed FROM meta.connections`;
    const pages = await sql`SELECT token_sealed FROM meta.assets WHERE kind = 'page'`;
    const calls =
      await sql`SELECT path, api_group, outcome FROM integration.api_calls ORDER BY created_at`;
    const audit =
      await sql`SELECT action FROM security.audit_logs WHERE action LIKE 'meta.%' ORDER BY created_at`;
    await sql.end();
    expect(conn.token_sealed).toMatch(/^v1\./);
    expect(conn.token_sealed).not.toContain(LONG);
    expect(pages.every((p) => p.token_sealed && !p.token_sealed.includes(PAGE_TOKEN))).toBe(true);
    // Calls are recorded by path only: no code, token or secret.
    expect(JSON.stringify(calls)).not.toMatch(/good-code|short-token|app-secret|long-user/);
    expect(calls.every((c) => c.api_group === 'sync' && c.outcome === 'ok')).toBe(true);
    expect(audit.map((a) => a.action)).toEqual(['meta.app_set', 'meta.connected', 'meta.synced']);

    expect(s.governor.groups.find((g: { group: string }) => g.group === 'sync').used).toBe(
      calls.length,
    );
    expect(s.governor.platform).toMatchObject({ status: 'known', pct: 28 });
  });

  it('keeps one Facebook account per business and the Page and ad account limits', async () => {
    const sql = admin();
    const [{ id: conn }] = await sql`SELECT id FROM meta.connections`;
    const s = (await http.get(M).set(as()).expect(200)).body;
    const outlet = s.assets.find((a: { name: string }) => a.name === 'Tú Outlet');
    await http
      .patch(`${M}/assets/${outlet.id}`)
      .set(as(managerToken))
      .send({ enabled: false })
      .expect(403);
    await http.patch(`${M}/assets/${outlet.id}`).set(as()).send({ enabled: false }).expect(200);
    for (let i = 0; i < 19; i++)
      await sql`INSERT INTO meta.assets (id, tenant_id, connection_id, kind, external_id, name, enabled)
        VALUES (gen_random_uuid(), ${tenantId}, ${conn}, 'page', ${String(9000 + i)}, ${`Page ${i}`}, true)`;
    await sql.end();
    const r = await http
      .patch(`${M}/assets/${outlet.id}`)
      .set(as())
      .send({ enabled: true })
      .expect(409);
    expect(r.body.error.code).toBe('META_ASSET_LIMIT');
  });

  it('answers repeated reads from the cache and merges reads in flight', async () => {
    const svc = app.get(MetaGraphService);
    const before = graph.hits.filter((h) => h === 'GET /me').length;
    const read = () =>
      svc.call(
        { tenantId, userId: null },
        {
          group: 'lookup',
          priority: 'normal',
          method: 'GET',
          path: '/me',
          params: { fields: 'id,name' },
          auth: { kind: 'user' },
          cacheSec: 60,
        },
      );
    const [a, b] = await Promise.all([read(), read()]);
    const c = await read();
    expect([a, b, c]).toEqual([
      { id: '1001', name: 'Tú Người Hoa' },
      { id: '1001', name: 'Tú Người Hoa' },
      { id: '1001', name: 'Tú Người Hoa' },
    ]);
    expect(graph.hits.filter((h) => h === 'GET /me').length - before).toBe(1);
    const s = (await http.get(M).set(as()).expect(200)).body;
    expect(s.governor.cacheHits).toBe(2);
  });

  it('stops for as long as Meta asks when Meta limits the app, and records what it refused', async () => {
    graph.fail['/me/accounts'] = {
      status: 400,
      body: {
        error: { code: 4, message: 'Application request limit reached', type: 'OAuthException' },
      },
      headers: {
        'x-business-use-case-usage':
          '{"5551":[{"type":"pages","call_count":100,"total_cputime":10,"total_time":20,"estimated_time_to_regain_access":17}]}',
      },
    };
    const r = await http.post(`${M}/sync`).set(as()).expect(429);
    expect(r.body.error.code).toBe('META_RATE_LIMITED');
    const hits = graph.hits.length;
    const again = await http.post(`${M}/sync`).set(as()).expect(429);
    expect(again.body.error.message).toContain('tạm dừng');
    expect(graph.hits.length).toBe(hits);

    const s = (await http.get(M).set(as()).expect(200)).body;
    const until = Date.parse(s.governor.blockedUntil) - Date.now();
    expect(until).toBeGreaterThan(16 * 60_000);
    expect(until).toBeLessThan(18 * 60_000);
    expect(s.governor.groups.every((g: { state: string }) => g.state === 'blocked')).toBe(true);
    expect(s.governor.platform.pct).toBe(100);
    const calls = (await http.get(`${M}/calls`).set(as()).expect(200)).body;
    expect(calls[0]).toMatchObject({
      outcome: 'refused',
      errorCode: 'META_RATE_LIMITED',
      path: '/me/accounts',
    });
    expect(calls[1]).toMatchObject({ outcome: 'failed', errorCode: 'GRAPH_4', httpStatus: 400 });
    delete graph.fail['/me/accounts'];
    const redis = new Redis(REDIS_URL);
    await redis.del(...(await redis.keys('meta:block:*')), ...(await redis.keys('meta:usage:*')));
    await redis.quit();
  });

  it('checks the token, marks it when Meta drops it, and disconnects without keeping tokens', async () => {
    let s = (await http.post(`${M}/check`).set(as(managerToken)).expect(200)).body;
    expect(s.connection.status).toBe('active');
    expect(s.connection.checkedAt).not.toBeNull();

    graph.fail['/me/adaccounts'] = {
      status: 400,
      body: { error: { code: 190, message: 'Error validating access token: session invalidated' } },
    };
    const r = await http.post(`${M}/sync`).set(as()).expect(409);
    expect(r.body.error.code).toBe('META_TOKEN_INVALID');
    s = (await http.get(M).set(as()).expect(200)).body;
    expect(s.connection).toMatchObject({ status: 'invalid' });
    expect(s.features.every((f: { ready: boolean }) => !f.ready)).toBe(true);
    delete graph.fail['/me/adaccounts'];

    graph.tokenValid = false;
    s = (await http.post(`${M}/check`).set(as()).expect(409)).body;
    expect(s.error.code).toBe('META_NOT_CONNECTED');

    s = (await http.delete(`${M}/connection`).set(as()).expect(200)).body;
    expect(s.connection).toBeNull();
    expect(s.assets).toEqual([]);
    // An invalid token is not sent to Meta to revoke.
    expect(graph.hits.filter((h) => h === 'DELETE /me/permissions')).toHaveLength(0);
    const sql = admin();
    const left =
      await sql`SELECT count(*)::int AS n FROM meta.assets WHERE token_sealed IS NOT NULL OR enabled`;
    const [conn] = await sql`SELECT status, token_sealed FROM meta.connections`;
    await sql.end();
    expect(left[0].n).toBe(0);
    expect(conn).toEqual({ status: 'removed', token_sealed: null });

    // Signing in again works, and disconnecting a working account revokes it at Meta.
    graph.tokenValid = true;
    const { url } = (await http.post(`${M}/oauth/start`).set(as()).expect(200)).body;
    s = (
      await http
        .post(`${M}/oauth/callback`)
        .set(as())
        .send({ code: 'good-code', state: stateOf(url) })
        .expect(200)
    ).body;
    expect(s.connection.status).toBe('active');
    await http.delete(`${M}/connection`).set(as()).expect(200);
    expect(graph.hits.filter((h) => h === 'DELETE /me/permissions')).toHaveLength(1);
  });
});
