import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../src/config';
import { WebCheckService } from '../src/web/web-check.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner29@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ website',
  tenantName: 'Maris Web',
};
const CLIENT_ID = '123456789012-abcdefghijklmnop0123456789.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-29';
const REFRESH = 'refresh-token-29';
const ACCESS = 'ya29.access-29';
const GA4 = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC = 'https://www.googleapis.com/auth/webmasters.readonly';
const PROPERTY = 'properties/111222';
const GSC_SITE = 'sc-domain:maris.vn';

const day = (back: number) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - back))
    .toISOString()
    .slice(0, 10);
};
const ga4Day = (back: number) => day(back).replace(/-/g, '');

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  body: Record<string, unknown> | null;
  headers: IncomingMessage['headers'];
}

/** oauth2.googleapis.com, www.googleapis.com, the GA4 Data and Admin APIs and Search Console. */
class FakeGoogle {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  challenge = '';
  scope = `openid email profile ${GA4} ${GSC}`;
  fail: Record<string, { status: number; body: unknown }> = {};

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  of(method: string, re: RegExp) {
    return this.hits.filter((h) => h.method === method && re.test(h.path));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, this.url);
    const path = u.pathname;
    const params: Record<string, string> = Object.fromEntries(u.searchParams);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: Record<string, unknown> | null = null;
    if ((req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
      Object.assign(params, Object.fromEntries(new URLSearchParams(raw)));
    else if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    this.hits.push({ method: req.method!, path, params, body, headers: req.headers });
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    const f = this.fail[`${req.method} ${path}`];
    if (f) return send(f.status, f.body);

    if (path === '/token') {
      if (params['client_secret'] !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
      if (params['grant_type'] === 'authorization_code')
        return send(200, {
          access_token: ACCESS,
          expires_in: 3599,
          refresh_token: REFRESH,
          scope: this.scope,
          token_type: 'Bearer',
        });
      if (params['grant_type'] === 'refresh_token' && params['refresh_token'] === REFRESH)
        return send(200, { access_token: ACCESS, expires_in: 3599, scope: this.scope });
      return send(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== `Bearer ${ACCESS}`)
      return send(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
    if (path === '/oauth2/v3/userinfo')
      return send(200, { sub: '220033004400', email: 'web@example.com', name: 'Web Tú' });

    // ---- GA4 Admin and Data
    if (path === '/v1beta/accountSummaries')
      return send(200, {
        accountSummaries: [
          {
            account: 'accounts/9',
            displayName: 'Maris',
            propertySummaries: [
              { property: PROPERTY, displayName: 'maris.vn - GA4' },
              { property: 'properties/333', displayName: 'Blog' },
            ],
          },
        ],
      });
    if (req.method === 'POST' && path === `/v1beta/${PROPERTY}:runReport`) {
      const dim = (body?.dimensions as { name: string }[])[0]!.name;
      if (dim === 'date')
        return send(200, {
          rows: [
            { dimensionValues: [{ value: ga4Day(1) }], metricValues: ['100', '80', '30', '250', '5', '0.6'].map((value) => ({ value })) },
            { dimensionValues: [{ value: ga4Day(2) }], metricValues: ['50', '40', '10', '120', '1.5', '0.4'].map((value) => ({ value })) },
            // In the 28 days before.
            { dimensionValues: [{ value: ga4Day(40) }], metricValues: ['70', '60', '20', '150', '2', '0.5'].map((value) => ({ value })) },
            { dimensionValues: [{ value: '(other)' }], metricValues: [{ value: '1' }] },
          ],
          metadata: { currencyCode: 'VND', timeZone: 'Asia/Ho_Chi_Minh' },
        });
      if (dim === 'pagePath')
        return send(200, {
          rows: [
            { dimensionValues: [{ value: '/' }], metricValues: [{ value: '300' }, { value: '90' }] },
            { dimensionValues: [{ value: '/can-cau' }], metricValues: [{ value: '70' }, { value: '30' }] },
          ],
        });
      return send(200, {
        rows: [
          { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '120' }, { value: '4' }] },
          { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '30' }, { value: '2.5' }] },
        ],
      });
    }
    if (path.startsWith('/v1beta/properties/'))
      return send(403, { error: { code: 403, message: 'User does not have sufficient permissions', status: 'PERMISSION_DENIED' } });

    // ---- Search Console
    if (path === '/webmasters/v3/sites')
      return send(200, {
        siteEntry: [
          { siteUrl: GSC_SITE, permissionLevel: 'siteOwner' },
          { siteUrl: 'https://khac.vn/', permissionLevel: 'siteUnverifiedUser' },
        ],
      });
    const enc = `/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}`;
    if (req.method === 'POST' && path === `${enc}/searchAnalytics/query`) {
      const dim = (body?.dimensions as string[])[0];
      if (dim === 'date')
        return send(200, {
          rows: [
            { keys: [day(2)], clicks: 10, impressions: 200, ctr: 0.05, position: 8 },
            { keys: [day(3)], clicks: 30, impressions: 600, ctr: 0.05, position: 4 },
            { keys: [day(35)], clicks: 20, impressions: 300, ctr: 0.066, position: 6 },
          ],
        });
      if (dim === 'query')
        return send(200, {
          rows: [
            { keys: ['cần câu'], clicks: 25, impressions: 400, ctr: 0.0625, position: 3.2 },
            { keys: ['máy câu'], clicks: 15, impressions: 400, ctr: 0.0375, position: 7.5 },
          ],
        });
      return send(200, { rows: [{ keys: ['https://maris.vn/'], clicks: 40, impressions: 800, ctr: 0.05, position: 5 }] });
    }
    if (path === `${enc}/sitemaps`)
      return send(200, {
        sitemap: [
          {
            path: 'https://maris.vn/sitemap.xml',
            lastSubmitted: '2026-11-01T00:00:00Z',
            lastDownloaded: '2026-11-27T00:00:00Z',
            isPending: false,
            warnings: '1',
            errors: '0',
            contents: [{ type: 'web', submitted: '120', indexed: '100' }],
          },
        ],
      });
    return send(404, { error: { code: 404, message: 'Not found' } });
  }
}

/** A small website with a few problems on purpose. */
class FakeSite {
  server!: Server;
  url = '';
  hits: string[] = [];
  /** Another site the home page links to. */
  other = '';

  async start() {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url!, this.url).pathname;
    this.hits.push(`${req.method} ${path}`);
    const html = (body: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const page = (head: string, body: string, lang = ' lang="vi"') =>
      html(`<!doctype html><html${lang}><head><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`);
    switch (path) {
      case '/':
        return page(
          '<title>Maris – Đồ câu cá</title><meta name="description" content="Cửa hàng đồ câu">',
          `<h1>Maris</h1><img src="/a.png" alt="logo">
           <a href="/a">A</a> <a href="/b#phan-2">B</a> <a href="/mat">Mất</a> <a href="/vong">Vòng</a>
           <a href="mailto:a@b.vn">Thư</a> <a href="${this.other}head-khong">Ngoài</a>
           <a href="${this.other}mat-ngoai">Ngoài mất</a>
           <!-- <a href="/an">ẩn</a> -->`,
        );
      case '/a':
        return page('<title>Trùng tên</title>', '<h1>A</h1><h1>A2</h1><img src="/x.png"><a href="/">Về</a>');
      case '/b':
        return page(
          '<title>Trùng tên</title><meta name="description" content="b"><meta name="robots" content="noindex, follow">',
          '<h1>B</h1>',
          '',
        );
      case '/c':
        return html('lỗi', 500);
      case '/vong':
        res.writeHead(302, { location: '/vong' });
        return res.end();
      case '/head-khong':
        if (req.method === 'HEAD') {
          res.writeHead(405);
          return res.end();
        }
        return page('<title>Chỉ GET</title><meta name="description" content="g">', '<h1>G</h1>');
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`User-agent: *\nAllow: /\nSitemap: ${this.url}sitemap.xml\n`);
      case '/sitemap.xml':
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${this.url}</loc></url><url><loc>${this.url}a</loc></url><url><loc>${this.url}c</loc></url></urlset>`,
        );
      default:
        return html('không có', 404);
    }
  }
}

describe('Sprint 29 (e2e): Website, GA4 and Search Console', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const google = new FakeGoogle();
  const site = new FakeSite();
  const other = new FakeSite();
  const redis = new Redis(REDIS_URL);
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let connectionId = '';
  let siteId = '';
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const W = '/api/v1/web';
  const G = '/api/v1/google';

  beforeAll(async () => {
    await resetDatabase();
    await google.start();
    await site.start();
    await other.start();
    site.other = other.url;
    app = await startApp({
      GOOGLE_ACCOUNTS_URL: google.url,
      GOOGLE_OAUTH_URL: google.url,
      GOOGLE_API_URL: google.url,
      GOOGLE_ANALYTICS_DATA_URL: google.url,
      GOOGLE_ANALYTICS_ADMIN_URL: google.url,
      GOOGLE_SEARCH_CONSOLE_URL: google.url,
      GOOGLE_RETRY_BASE_MS: '1',
      YOUTUBE_UPLOADER_ENABLED: 'false',
      TIKTOK_PUBLISHER_ENABLED: 'false',
      COMMERCE_SYNC_MIN: '0',
      WEB_SYNC_HOURS: '0',
      // The fake website runs on this machine.
      WEBSITE_ALLOW_PRIVATE_URLS: 'true',
    });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as { id: string; key: string }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as())
      .send({ email: 's29.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'member' })
        .expect(200)
    ).body.token;
  });

  afterAll(async () => {
    await app.close();
    await google.stop();
    await site.stop();
    await other.stop();
    await redis.quit();
    await db.end();
  });

  it('keeps the center to web.read and adds websites with web.manage', async () => {
    await http.get(W).set(as(memberToken)).expect(403);
    await http.post(`${W}/sites`).set(as(memberToken)).send({ name: 'x', url: 'x.vn' }).expect(403);
    expect((await http.get(W).set(as()).expect(200)).body).toMatchObject({ sites: [], accounts: [], syncEveryHours: 0 });
    await http.post(`${W}/sites`).set(as()).send({ name: 'Sai', url: 'not a url' }).expect(400);
    await http.post(`${W}/sites`).set(as()).send({ name: 'Sai', url: 'ftp://maris.vn' }).expect(400);
    const s = (await http.post(`${W}/sites`).set(as()).send({ name: 'Maris', url: site.url }).expect(201)).body;
    expect(s).toMatchObject({ name: 'Maris', url: site.url, enabled: true, ga4: null, gsc: null, lastCheck: null });
    siteId = s.id;
    // The same home page written differently is the same site.
    const again = await http.post(`${W}/sites`).set(as()).send({ name: 'Lại', url: site.url.replace(/\/$/, '/trang?x=1') }).expect(409);
    expect(again.body.error.code).toBe('WEB_SITE_EXISTS');
  });

  it('lists GA4 and Search Console properties of a Google account with the read-only scopes', async () => {
    await http.post('/api/v1/secrets').set(as()).send({ name: 'google.client_secret', value: CLIENT_SECRET }).expect(201);
    await http.put(`${G}/app`).set(as()).send({ clientId: CLIENT_ID, clientSecretName: 'google.client_secret' }).expect(200);
    const { url } = (
      await http.post(`${G}/oauth/start`).set(as()).send({ services: ['analytics', 'search_console'] }).expect(200)
    ).body;
    const u = new URL(url);
    expect(u.searchParams.get('scope')).toBe(`openid email profile ${GA4} ${GSC}`);
    const conn = (
      await http.post(`${G}/oauth/callback`).set(as()).send({ code: 'good-code', state: u.searchParams.get('state') }).expect(200)
    ).body.connections[0];
    connectionId = conn.id;
    expect(conn.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'analytics_read', ready: true }),
        expect.objectContaining({ key: 'search_console_read', ready: true }),
      ]),
    );
    // No YouTube scope: no channel read.
    expect(google.of('GET', /youtube/)).toHaveLength(0);

    const st = (await http.get(W).set(as()).expect(200)).body;
    expect(st.accounts).toEqual([{ id: connectionId, email: 'web@example.com', analytics: true, searchConsole: true }]);
    const props = (await http.get(`${W}/google/ga4?connectionId=${connectionId}`).set(as()).expect(200)).body;
    expect(props).toEqual([
      { property: PROPERTY, name: 'maris.vn - GA4', account: 'Maris' },
      { property: 'properties/333', name: 'Blog', account: 'Maris' },
    ]);
    expect(google.of('GET', /accountSummaries/)[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    const sites = (await http.get(`${W}/google/gsc?connectionId=${connectionId}`).set(as()).expect(200)).body;
    expect(sites).toEqual([{ site: GSC_SITE, permission: 'siteOwner' }]);
    await http.get(`${W}/google/ga4?connectionId=${connectionId}`).set(as(memberToken)).expect(403);
  });

  it('refuses an account without the scope, and a property the account cannot see', async () => {
    await db`UPDATE google.connections SET scopes = array_remove(scopes, ${GSC}) WHERE id = ${connectionId}`;
    const r = await http.get(`${W}/google/gsc?connectionId=${connectionId}`).set(as()).expect(409);
    expect(r.body.error.code).toBe('GOOGLE_SCOPE_MISSING');
    await db`UPDATE google.connections SET scopes = array_append(scopes, ${GSC}) WHERE id = ${connectionId}`;

    const bad = await http
      .patch(`${W}/sites/${siteId}`)
      .set(as())
      .send({ ga4: { connectionId, property: 'properties/999' } })
      .expect(404);
    expect(bad.body.error.code).toBe('WEB_GA4_NOT_FOUND');
    await http
      .patch(`${W}/sites/${siteId}`)
      .set(as())
      .send({ gsc: { connectionId, site: 'https://khac.vn/' } })
      .expect(404);
    await http.patch(`${W}/sites/${siteId}`).set(as()).send({ gsc: { connectionId, site: 'not-a-site' } }).expect(400);
    await http.post(`${W}/sites/${siteId}/sync`).set(as()).expect(409);
  });

  it('links GA4 and Search Console and reads their numbers into MARIS', async () => {
    const linked = (
      await http
        .patch(`${W}/sites/${siteId}`)
        .set(as())
        .send({ ga4: { connectionId, property: PROPERTY }, gsc: { connectionId, site: GSC_SITE } })
        .expect(200)
    ).body;
    expect(linked.ga4).toEqual({ property: PROPERTY, name: 'maris.vn - GA4', connectionId, connectionEmail: 'web@example.com' });
    expect(linked.gsc).toEqual({ site: GSC_SITE, connectionId, connectionEmail: 'web@example.com' });

    const r = (await http.post(`${W}/sites/${siteId}/sync`).set(as()).expect(200)).body;
    expect(r).toEqual({ sites: 1, days: 6, errors: [] });
    const daily = google.of('POST', /runReport$/).find((h) => (h.body!.dimensions as { name: string }[])[0]!.name === 'date')!;
    expect(daily.body!.dateRanges).toEqual([{ startDate: day(180), endDate: day(1) }]);
    const q = google.of('POST', /searchAnalytics\/query$/).find((h) => (h.body!.dimensions as string[])[0] === 'query')!;
    expect(q.body).toMatchObject({ startDate: day(28), endDate: day(1), type: 'web', rowLimit: 20 });

    const rep = (await http.get(`${W}/report?siteId=${siteId}&days=28`).set(as()).expect(200)).body;
    expect(rep.totals).toEqual({
      sessions: 150,
      users: 120,
      newUsers: 40,
      views: 370,
      keyEvents: 6.5,
      engagementRate: 0.5333,
      clicks: 40,
      impressions: 800,
      ctr: 0.05,
      position: 5,
    });
    expect(rep.before).toEqual({ sessions: 70, clicks: 20, impressions: 300, keyEvents: 2 });
    expect(rep.daily).toHaveLength(28);
    expect(rep.daily.at(-1)).toMatchObject({ day: day(1), sessions: 100, clicks: null });
    expect(rep.daily.at(-2)).toMatchObject({ day: day(2), sessions: 50, clicks: 10, impressions: 200, position: 8 });
    expect(rep.tops.ga4_page).toEqual([
      { key: '/', a: 300, b: 90, c: 0, d: 0 },
      { key: '/can-cau', a: 70, b: 30, c: 0, d: 0 },
    ]);
    expect(rep.tops.ga4_channel[0]).toEqual({ key: 'Organic Search', a: 120, b: 4, c: 0, d: 0 });
    expect(rep.tops.gsc_query[0]).toEqual({ key: 'cần câu', a: 25, b: 400, c: 0.0625, d: 3.2 });
    expect(rep.tops.gsc_page).toHaveLength(1);

    const st = (await http.get(W).set(as()).expect(200)).body;
    expect(st.sites[0]).toMatchObject({ syncError: null, syncedAt: expect.any(String) });
    expect(st.sites[0].sitemaps).toEqual([
      {
        path: 'https://maris.vn/sitemap.xml',
        lastDownloaded: '2026-11-27T00:00:00Z',
        isPending: false,
        errors: 0,
        warnings: 1,
        submitted: 120,
        indexed: 100,
      },
    ]);
    const [cur] = await db`SELECT currency FROM web.sites WHERE id = ${siteId}`;
    expect(cur!.currency).toBe('VND');
    // Reading again replaces the top lists and keeps one row per day.
    await http.post(`${W}/sync`).set(as()).expect(200);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM web.ga4_daily WHERE site_id = ${siteId}`;
    expect(n).toBe(3);
    const calls = await db`SELECT DISTINCT api_group FROM integration.api_calls WHERE provider = 'google' ORDER BY 1`;
    expect(calls.map((c) => c.api_group)).toEqual(expect.arrayContaining(['analytics', 'search_console']));
  });

  it('keeps reading GA4 when Search Console refuses, and says why', async () => {
    const path = `/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;
    google.fail[`POST ${path}`] = {
      status: 403,
      body: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:maris.vn'.", status: 'PERMISSION_DENIED' } },
    };
    const before = google.of('POST', /runReport$/).length;
    const r = (await http.post(`${W}/sites/${siteId}/sync`).set(as()).expect(200)).body;
    delete google.fail[`POST ${path}`];
    expect(r.days).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Search Console: Thiếu quyền trên Google/);
    // A permission answer is not retried.
    expect(google.of('POST', /searchAnalytics/).filter((h) => h.path === path).length).toBeGreaterThan(0);
    expect(google.of('POST', /runReport$/).length).toBe(before + 3);
    const st = (await http.get(W).set(as()).expect(200)).body;
    expect(st.sites[0].syncError).toMatch(/Search Console/);
  });

  it('checks the website: broken links, errors, redirects and missing SEO tags', async () => {
    const started = (await http.post(`${W}/sites/${siteId}/checks`).set(as()).expect(201)).body;
    expect(started).toMatchObject({ siteId, status: 'running', requestedByName: 'Chủ website' });
    await http.post(`${W}/sites/${siteId}/checks`).set(as(memberToken)).expect(403);
    let done: { status: string } = started;
    for (let i = 0; i < 100 && done.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = (await http.get(`${W}/checks/${started.id}`).set(as()).expect(200)).body;
    }
    const d = done as unknown as {
      status: string;
      pages: number;
      links: number;
      errors: number;
      warnings: number;
      avgMs: number;
      issues: { severity: string; kind: string; url: string; detail: string }[];
    };
    expect(d.status).toBe('done');
    const has = (kind: string, path: string) =>
      d.issues.find((i) => i.kind === kind && i.url === `${site.url}${path}`);
    expect(has('no_https', '')).toMatchObject({ severity: 'warning' });
    expect(has('http_error', 'c')).toMatchObject({ severity: 'error', detail: 'HTTP 500' });
    expect(has('broken_link', 'mat')).toMatchObject({ severity: 'error' });
    expect(has('broken_link', 'mat')!.detail).toBe(`HTTP 404, trên trang ${site.url}`);
    expect(has('redirect_loop', 'vong')).toMatchObject({ severity: 'error' });
    expect(has('missing_description', 'a')).toBeTruthy();
    expect(has('many_h1', 'a')).toMatchObject({ detail: '2 thẻ H1' });
    expect(has('images_no_alt', 'a')).toMatchObject({ detail: '1 ảnh' });
    expect(has('duplicate_title', 'a')).toBeTruthy();
    expect(has('duplicate_title', 'b')).toBeTruthy();
    expect(has('noindex', 'b')).toBeTruthy();
    expect(has('missing_lang', 'b')).toBeTruthy();
    expect(d.issues.find((i) => i.url === `${other.url}mat-ngoai`)).toMatchObject({
      kind: 'broken_link',
      detail: `HTTP 404, trên trang ${site.url}`,
    });
    // The home page is clean; HEAD refused, then GET works; the commented link is not read.
    expect(d.issues.filter((i) => i.url === site.url && i.kind !== 'no_https')).toEqual([]);
    expect(d.issues.find((i) => i.url.endsWith('/head-khong'))).toBeUndefined();
    expect(other.hits.sort()).toEqual(['GET /head-khong', 'HEAD /head-khong', 'HEAD /mat-ngoai']);
    expect(site.hits.some((h) => h.endsWith('/an'))).toBe(false);
    expect(d.issues.some((i) => i.kind === 'no_sitemap' || i.kind === 'no_robots')).toBe(false);
    // /, then /a and /c from the sitemap, then /b, /mat and /vong from links.
    expect(d.pages).toBe(6);
    expect(d.links).toBe(2);
    expect(d.errors).toBe(d.issues.filter((i) => i.severity === 'error').length);
    expect(d.avgMs).toEqual(expect.any(Number));

    const list = (await http.get(`${W}/sites/${siteId}/checks`).set(as()).expect(200)).body;
    expect(list).toHaveLength(1);
    const st = (await http.get(W).set(as()).expect(200)).body;
    expect(st.sites[0].lastCheck).toMatchObject({ id: started.id, status: 'done' });
  });

  it('never reads private network addresses unless allowed', async () => {
    const config = app.get<AppConfig>(APP_CONFIG);
    const checker = app.get(WebCheckService);
    config.WEBSITE_ALLOW_PRIVATE_URLS = false;
    try {
      const r = await checker.crawl(site.url);
      expect(r.pages).toBe(0);
      expect(r.issues).toEqual([
        { severity: 'error', kind: 'unreachable', url: site.url, detail: 'Địa chỉ mạng nội bộ, MARIS không đọc' },
      ]);
      const meta = await checker.fetch('http://169.254.169.254/latest/meta-data/', 'GET', 1000);
      expect(meta.failure).toBe('blocked');
    } finally {
      config.WEBSITE_ALLOW_PRIVATE_URLS = true;
    }
  });

  it('records every change in the audit log and removes a site', async () => {
    await http.delete(`${W}/sites/${siteId}`).set(as(memberToken)).expect(403);
    await http.delete(`${W}/sites/${siteId}`).set(as()).expect(204);
    expect((await http.get(W).set(as()).expect(200)).body.sites).toEqual([]);
    await http.get(`${W}/report?siteId=${siteId}`).set(as()).expect(404);
    const acts = await db`SELECT action FROM security.audit_logs WHERE action LIKE 'web.%' ORDER BY created_at, seq`;
    expect(acts.map((a) => a.action)).toEqual([
      'web.site_created',
      'web.site_updated',
      'web.check_started',
      'web.site_removed',
    ]);
    // The same address can be added again after removal.
    await http.post(`${W}/sites`).set(as()).send({ name: 'Maris', url: site.url }).expect(201);
  });
});
