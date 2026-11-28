import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { MetaAdsService } from '../src/meta/meta-ads.service';
import { dayIn } from '../src/meta/ads-analysis';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner25@example.com',
  password: 'mat-khau-rat-dai-125',
  displayName: 'Chủ shop',
  tenantName: 'Shop Quảng cáo',
};
const APP_ID = '523456789012';
const APP_SECRET = 'app-secret-555';
const LONG = 'long-user-token-25';
const TZ = 'Asia/Ho_Chi_Minh';
const ACT = 'act_5551';

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  token: string;
}

/** A stand-in for graph.facebook.com with one ad account, its campaigns and daily figures. */
class FakeGraph {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  failWrites = false;
  campaigns = [
    {
      id: '9100',
      name: 'Áo thun hè',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_SALES',
    },
    {
      id: '9200',
      name: 'Tin nhắn Messenger',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_ENGAGEMENT',
      daily_budget: '150000',
    },
    {
      id: '9300',
      name: 'Chiến dịch cũ',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: '100000',
    },
  ];
  adsets = [
    {
      id: '9110',
      name: 'Nữ 18-30',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      campaign_id: '9100',
      daily_budget: '200000',
    },
    {
      id: '9210',
      name: 'Người đã nhắn tin',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      campaign_id: '9200',
    },
  ];
  ads = [
    {
      id: '9111',
      name: 'Ảnh 1',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      campaign_id: '9100',
      adset_id: '9110',
    },
    {
      id: '9112',
      name: 'Ảnh 2',
      status: 'ACTIVE',
      effective_status: 'DISAPPROVED',
      campaign_id: '9100',
      adset_id: '9110',
    },
    {
      id: '9211',
      name: 'Video 1',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      campaign_id: '9200',
      adset_id: '9210',
    },
  ];
  /** Campaigns that have figures. */
  spending = ['9100', '9200'];

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  calls(method: string, re: RegExp) {
    return this.hits.filter((h) => h.method === method && re.test(h.path));
  }

  private insight(campaign: string, day: string) {
    if (campaign === '9100')
      return {
        campaign_id: '9100',
        date_start: day,
        date_stop: day,
        spend: '100000',
        impressions: '10000',
        reach: '7000',
        clicks: '200',
        inline_link_clicks: '150',
        actions: [
          { action_type: 'purchase', value: '2' },
          { action_type: 'omni_purchase', value: '2' },
        ],
        action_values: [{ action_type: 'omni_purchase', value: '500000' }],
      };
    return {
      campaign_id: campaign,
      date_start: day,
      date_stop: day,
      spend: '50000',
      impressions: '8000',
      reach: '6000',
      clicks: '100',
      inline_link_clicks: '90',
      actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }],
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url!, this.url);
    const path = u.pathname.replace(/^\/v23\.0/, '');
    const params: Record<string, string> = Object.fromEntries(u.searchParams);
    if ((req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
      Object.assign(
        params,
        Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())),
      );
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    this.hits.push({ method: req.method!, path, params, token });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path === '/oauth/access_token')
      return send(200, {
        access_token: params['code'] ? 'short' : LONG,
        token_type: 'bearer',
        expires_in: 5_184_000,
      });
    if (path === '/me') return send(200, { id: '4001', name: 'Tú' });
    if (path === '/me/permissions')
      return send(200, {
        data: ['pages_show_list', 'ads_read', 'ads_management'].map((permission) => ({
          permission,
          status: 'granted',
        })),
      });
    if (path === '/me/accounts') return send(200, { data: [] });
    if (path === '/me/adaccounts')
      return send(200, {
        data: [
          {
            id: ACT,
            name: 'TK quảng cáo chính',
            account_status: 1,
            currency: 'VND',
            timezone_name: TZ,
          },
        ],
      });
    if (token !== LONG) return send(400, { error: { code: 190, message: 'wrong token' } });

    const page = <T>(list: T[], size: number) => {
      const start = params['after'] ? Number(params['after']) : 0;
      const more = start + size < list.length;
      return send(200, {
        data: list.slice(start, start + size),
        paging: {
          cursors: { after: String(start + size) },
          ...(more ? { next: 'https://next' } : {}),
        },
      });
    };
    if (req.method === 'GET' && path === `/${ACT}/campaigns`) return page(this.campaigns, 2);
    if (req.method === 'GET' && path === `/${ACT}/adsets`) return page(this.adsets, 100);
    if (req.method === 'GET' && path === `/${ACT}/ads`) return page(this.ads, 100);
    if (req.method === 'GET' && path === `/${ACT}/insights`) {
      const { since, until } = JSON.parse(params['time_range']!) as {
        since: string;
        until: string;
      };
      const rows = [];
      for (
        let t = Date.parse(`${since}T00:00:00Z`);
        t <= Date.parse(`${until}T00:00:00Z`);
        t += 86_400_000
      )
        for (const c of this.spending)
          rows.push(this.insight(c, new Date(t).toISOString().slice(0, 10)));
      return page(rows, 40);
    }
    if (req.method === 'POST' && /^\/9\d{3}$/.test(path)) {
      if (this.failWrites)
        return send(400, {
          error: { code: 100, message: 'Invalid parameter', error_subcode: 1885650 },
        });
      return send(200, { success: true });
    }
    send(404, { error: { code: 803, message: `unknown ${req.method} ${path}` } });
  }
}

describe('Sprint 25 (e2e): Meta Ads Command Center and spend analysis', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ads: MetaAdsService;
  const graph = new FakeGraph();
  const db: postgres.Sql = admin();
  let token: string;
  let ownerId: string;
  let tenantId: string;
  let managerToken: string;
  let memberToken: string;
  let accountId: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const A = '/api/v1/ads';
  const today = () => dayIn(TZ, new Date());
  const campaigns = async (t = token) =>
    (await http.get(`${A}/campaigns?days=7`).set(as(t)).expect(200)).body as {
      id: string;
      externalId: string;
      name: string;
      status: string;
      effectiveStatus: string;
      dailyBudget: number | null;
      present: boolean;
      metrics: { spend: number; results: number; roas: number | null };
    }[];
  const objectId = async (ext: string) =>
    (await db`SELECT id FROM meta.ad_objects WHERE external_id = ${ext}`)[0]!.id as string;

  beforeAll(async () => {
    await resetDatabase();
    await graph.start();
    app = await startApp({
      META_GRAPH_URL: graph.url,
      META_RETRY_BASE_MS: '1',
      META_PUBLISHER_ENABLED: 'false',
      META_INBOX_POLL_MIN: '0',
      META_LEADS_POLL_MIN: '0',
    });
    ads = app.get(MetaAdsService);
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    const me = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body;
    tenantId = me.memberships[0].tenantId;
    ownerId = me.id;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const invite = async (email: string, role: string, name: string) => {
      const inv = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as())
        .send({ email, roleId: roles.find((r) => r.key === role)!.id })
        .expect(201);
      return (
        await http
          .post('/api/v1/invitations/accept')
          .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-25', displayName: name })
          .expect(200)
      ).body.token as string;
    };
    managerToken = await invite('s25.manager@example.com', 'manager', 'Lan (Marketing)');
    memberToken = await invite('s25.member@example.com', 'member', 'Hà (Sale)');

    await http
      .put('/api/v1/meta/app')
      .set(as())
      .send({ appId: APP_ID, appSecretName: 'meta.app_secret' })
      .expect(200);
    await http
      .post('/api/v1/secrets')
      .set(as())
      .send({ name: 'meta.app_secret', value: APP_SECRET })
      .expect(201);
    const { url } = (await http.post('/api/v1/meta/oauth/start').set(as()).expect(200)).body;
    await http
      .post('/api/v1/meta/oauth/callback')
      .set(as())
      .send({ code: 'good-code', state: new URL(url).searchParams.get('state') })
      .expect(200);
    const assets = (await http.get('/api/v1/meta').set(as()).expect(200)).body.assets as {
      id: string;
      kind: string;
      enabled: boolean;
    }[];
    const acc = assets.find((a) => a.kind === 'ad_account')!;
    accountId = acc.id;
    if (!acc.enabled)
      await http
        .patch(`/api/v1/meta/assets/${acc.id}`)
        .set(as())
        .send({ enabled: true })
        .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await graph.stop();
    await db.end();
  });

  it('gives owners, administrators and managers ads access, approval only to the first two', async () => {
    const perms = await db`
      SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS p
      FROM identity.roles r JOIN identity.role_permissions rp ON rp.role_id = r.id
      WHERE r.tenant_id = ${tenantId} AND rp.permission_key LIKE 'ads.%'
      GROUP BY r.key ORDER BY r.key`;
    expect(perms.map((r) => [r.key, r.p])).toEqual([
      ['administrator', ['ads.approve', 'ads.manage', 'ads.read']],
      ['manager', ['ads.manage', 'ads.read']],
      ['owner', ['ads.approve', 'ads.manage', 'ads.read']],
    ]);
    await http.get(`${A}/summary`).set(as(memberToken)).expect(403);
    await http.get(`${A}/summary`).expect(401);
    const s = (await http.get(`${A}/summary`).set(as(managerToken)).expect(200)).body;
    expect(s).toMatchObject({
      ready: true,
      canManage: true,
      missingScopes: [],
      days: 7,
      pendingChanges: 0,
    });
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({
      externalId: ACT,
      currency: 'VND',
      accountStatusLabel: 'Đang hoạt động',
      dailyCap: null,
      syncedAt: null,
      campaigns: 0,
    });
    expect(s.series).toHaveLength(7);
    await http.get(`${A}/summary?days=9`).set(as()).expect(400);
  });

  it('reads campaigns, ad sets, ads and 30 days of figures, following paging', async () => {
    await http.post(`${A}/sync`).set(as(memberToken)).expect(403);
    const r = (await http.post(`${A}/sync`).set(as(managerToken)).expect(200)).body;
    expect(r).toEqual({ accounts: 1, campaigns: 3, days: 60, errors: [] });
    // 3 campaigns at 2 a page; 60 insight rows at 40 a page.
    expect(graph.calls('GET', /\/campaigns$/)).toHaveLength(2);
    expect(graph.calls('GET', /\/insights$/)).toHaveLength(2);
    const ins = graph.calls('GET', /\/insights$/)[0]!;
    expect(ins.params).toMatchObject({ level: 'campaign', time_increment: '1' });
    expect(JSON.parse(ins.params['time_range']!)).toEqual({
      since: dayIn(TZ, new Date(), 29),
      until: today(),
    });
    expect(ins.params['appsecret_proof']).toMatch(/^[0-9a-f]{64}$/);
    // Every read went through the Governor as "ads_insights".
    const groups =
      await db`SELECT DISTINCT api_group FROM integration.api_calls WHERE path LIKE ${`/${ACT}/%`}`;
    expect(groups.map((g) => g.api_group)).toEqual(['ads_insights']);

    const list = await campaigns();
    expect(list.map((c) => [c.name, c.metrics.spend, c.metrics.results, c.dailyBudget])).toEqual([
      ['Áo thun hè', 700000, 14, null],
      ['Tin nhắn Messenger', 350000, 35, 150000],
      ['Chiến dịch cũ', 0, 0, 100000],
    ]);
    expect(list[0]!.metrics.roas).toBe(5);

    const s = (await http.get(`${A}/summary?days=7`).set(as()).expect(200)).body;
    expect(s.totals).toEqual([
      {
        currency: 'VND',
        metrics: expect.objectContaining({
          spend: 1050000,
          impressions: 126000,
          clicks: 2100,
          purchases: 14,
          purchaseValue: 3500000,
          messages: 35,
          results: 49,
          ctr: 1.67,
          cpc: 500,
          cpm: 8333.33,
          cpa: 21428.57,
          roas: 3.33,
        }),
      },
    ]);
    expect(s.series).toHaveLength(7);
    expect(s.series.at(-1)).toEqual({
      day: today(),
      spend: 150000,
      results: 7,
      clicks: 300,
      impressions: 18000,
    });
    expect(s.accounts[0]).toMatchObject({ campaigns: 3, activeCampaigns: 2, error: null });
    // The refused ad is pointed out; nothing is sent again.
    expect(s.alerts).toEqual([
      expect.objectContaining({
        code: 'AD_DISAPPROVED',
        level: 'critical',
        campaignName: 'Áo thun hè',
      }),
    ]);
    const s30 = (await http.get(`${A}/summary?days=30`).set(as()).expect(200)).body;
    expect(s30.totals[0].metrics.spend).toBe(4500000);

    const detail = (await http.get(`${A}/campaigns/${list[0]!.id}?days=14`).set(as()).expect(200))
      .body;
    expect(detail.series).toHaveLength(14);
    expect(detail.metrics.spend).toBe(1400000);
    expect(
      detail.adsets.map((x: { name: string; dailyBudget: number }) => [x.name, x.dailyBudget]),
    ).toEqual([['Nữ 18-30', 200000]]);
    expect(
      detail.ads.map((x: { name: string; statusLabel: string }) => [x.name, x.statusLabel]),
    ).toEqual([
      ['Ảnh 1', 'Đang chạy'],
      ['Ảnh 2', 'Bị Meta từ chối'],
    ]);
    await http.get(`${A}/campaigns/${detail.adsets[0].id}`).set(as()).expect(404);
  });

  it('re-reads only the last 3 days in the background, and the structure when a new campaign shows', async () => {
    graph.hits = [];
    await ads.syncTenant({ tenantId, userId: ownerId }, false);
    expect(graph.calls('GET', /\/campaigns$/)).toHaveLength(0);
    const ins = graph.calls('GET', /\/insights$/);
    expect(ins).toHaveLength(1);
    expect(JSON.parse(ins[0]!.params['time_range']!)).toEqual({
      since: dayIn(TZ, new Date(), 2),
      until: today(),
    });
    expect((await db`SELECT count(*)::int AS n FROM meta.ad_insights`)[0]!.n).toBe(60);

    graph.campaigns.push({
      id: '9400',
      name: 'Khuyến mãi cuối tuần',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_SALES',
    });
    graph.spending.push('9400');
    graph.hits = [];
    await ads.syncTenant({ tenantId, userId: ownerId }, false);
    expect(graph.calls('GET', /\/campaigns$/).length).toBeGreaterThan(0);
    expect((await db`SELECT count(*)::int AS n FROM meta.ad_insights`)[0]!.n).toBe(63);

    // A campaign Meta no longer lists stays, marked absent.
    graph.campaigns = graph.campaigns.filter((c) => c.id !== '9400');
    graph.spending = ['9100', '9200'];
    await http.post(`${A}/sync`).set(as()).expect(200);
    const gone = (await campaigns()).find((c) => c.externalId === '9400')!;
    expect(gone.present).toBe(false);
  });

  it('pauses at once, and turns on only with approval when no budget limit is set', async () => {
    const id = await objectId('9100');
    graph.hits = [];
    const paused = (
      await http
        .post(`${A}/objects/${id}/status`)
        .set(as(managerToken))
        .send({ status: 'PAUSED', reason: 'Hết hàng' })
        .expect(200)
    ).body;
    expect(paused).toMatchObject({
      status: 'applied',
      needsApproval: false,
      kind: 'status',
      fromValue: 'ACTIVE',
      toValue: 'PAUSED',
      requestedByName: 'Lan (Marketing)',
    });
    const post = graph.calls('POST', /^\/9100$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.params).toMatchObject({ status: 'PAUSED' });
    expect(post[0]!.token).toBe(LONG);
    const call = (
      await db`SELECT api_group, method FROM integration.api_calls WHERE path = '/9100'`
    )[0]!;
    expect(call).toMatchObject({ api_group: 'ads_manage', method: 'POST' });
    expect((await campaigns()).find((c) => c.externalId === '9100')).toMatchObject({
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
    });
    await http.post(`${A}/objects/${id}/status`).set(as()).send({ status: 'PAUSED' }).expect(409);

    graph.hits = [];
    const asked = (
      await http
        .post(`${A}/objects/${id}/status`)
        .set(as(managerToken))
        .send({ status: 'ACTIVE' })
        .expect(200)
    ).body;
    expect(asked).toMatchObject({ status: 'pending', needsApproval: true });
    expect(graph.calls('POST', /^\/9100$/)).toHaveLength(0);
    expect((await http.get(`${A}/summary`).set(as()).expect(200)).body.pendingChanges).toBe(1);
    const again = await http
      .post(`${A}/objects/${id}/status`)
      .set(as(managerToken))
      .send({ status: 'ACTIVE' })
      .expect(409);
    expect(again.body.error.code).toBe('ADS_CHANGE_OPEN');
    await http.post(`${A}/changes/${asked.id}/approve`).set(as(managerToken)).send({}).expect(403);
    const ok = (
      await http
        .post(`${A}/changes/${asked.id}/approve`)
        .set(as())
        .send({ note: 'Đã nhập hàng' })
        .expect(200)
    ).body;
    expect(ok).toMatchObject({
      status: 'applied',
      decidedByName: 'Chủ shop',
      decisionNote: 'Đã nhập hàng',
    });
    expect(graph.calls('POST', /^\/9100$/)[0]!.params).toMatchObject({ status: 'ACTIVE' });
    await http.post(`${A}/changes/${asked.id}/approve`).set(as()).send({}).expect(409);

    const audit = await db`
      SELECT action FROM security.audit_logs WHERE action LIKE 'ads.%' ORDER BY created_at, id`;
    expect(audit.map((a) => a.action)).toEqual([
      'ads.change.requested',
      'ads.change.applied',
      'ads.change.requested',
      'ads.change.approved',
      'ads.change.applied',
    ]);
  });

  it('changes budgets within the approved limit and holds raises above it for approval', async () => {
    const adset = await objectId('9110');
    await http
      .patch(`${A}/accounts/${accountId}`)
      .set(as(managerToken))
      .send({ dailyCap: 300000 })
      .expect(403);
    const acc = (
      await http
        .patch(`${A}/accounts/${accountId}`)
        .set(as())
        .send({ dailyCap: 300000 })
        .expect(200)
    ).body;
    expect(acc.dailyCap).toBe(300000);

    graph.hits = [];
    const within = (
      await http
        .post(`${A}/objects/${adset}/budget`)
        .set(as(managerToken))
        .send({ dailyBudget: 250000 })
        .expect(200)
    ).body;
    expect(within).toMatchObject({
      status: 'applied',
      needsApproval: false,
      fromValue: '200000',
      toValue: '250000',
    });
    expect(graph.calls('POST', /^\/9110$/)[0]!.params).toMatchObject({ daily_budget: '250000' });

    const above = (
      await http
        .post(`${A}/objects/${adset}/budget`)
        .set(as(managerToken))
        .send({ dailyBudget: 400000, reason: 'Đang bán chạy' })
        .expect(200)
    ).body;
    expect(above).toMatchObject({
      status: 'pending',
      needsApproval: true,
      toValue: '400000',
      reason: 'Đang bán chạy',
    });
    // The person who asked can withdraw it.
    const withdrawn = (
      await http.post(`${A}/changes/${above.id}/reject`).set(as(managerToken)).send({}).expect(200)
    ).body;
    expect(withdrawn.status).toBe('cancelled');
    const again = (
      await http
        .post(`${A}/objects/${adset}/budget`)
        .set(as(managerToken))
        .send({ dailyBudget: 400000 })
        .expect(200)
    ).body;
    const refused = (
      await http
        .post(`${A}/changes/${again.id}/reject`)
        .set(as())
        .send({ note: 'Chờ cuối tháng' })
        .expect(200)
    ).body;
    expect(refused).toMatchObject({ status: 'rejected', decisionNote: 'Chờ cuối tháng' });
    expect(graph.calls('POST', /^\/9110$/)).toHaveLength(1);

    // Lowering never needs approval; turning on a campaign whose budget is above the limit does.
    const camp = await objectId('9200');
    expect(
      (
        await http
          .post(`${A}/objects/${camp}/budget`)
          .set(as(managerToken))
          .send({ dailyBudget: 120000 })
          .expect(200)
      ).body.status,
    ).toBe('applied');
    await http
      .post(`${A}/objects/${camp}/status`)
      .set(as(managerToken))
      .send({ status: 'PAUSED' })
      .expect(200);
    await http.patch(`${A}/accounts/${accountId}`).set(as()).send({ dailyCap: 100000 }).expect(200);
    expect(
      (
        await http
          .post(`${A}/objects/${camp}/status`)
          .set(as(managerToken))
          .send({ status: 'ACTIVE' })
          .expect(200)
      ).body.status,
    ).toBe('pending');

    const changes = (await http.get(`${A}/changes`).set(as(managerToken)).expect(200)).body as {
      status: string;
      objectName: string;
    }[];
    expect(changes[0]).toMatchObject({ status: 'pending', objectName: 'Tin nhắn Messenger' });
    expect(changes).toHaveLength(8);
  });

  it('refuses what Meta or the rules do not allow, and records a failed send', async () => {
    const ad = await objectId('9112');
    const r1 = await http
      .post(`${A}/objects/${ad}/budget`)
      .set(as())
      .send({ dailyBudget: 10000 })
      .expect(409);
    expect(r1.body.error.code).toBe('ADS_NO_DAILY_BUDGET');
    const camp9100 = await objectId('9100');
    const r2 = await http
      .post(`${A}/objects/${camp9100}/budget`)
      .set(as())
      .send({ dailyBudget: 10000 })
      .expect(409);
    expect(r2.body.error.code).toBe('ADS_NO_DAILY_BUDGET');
    await http.post(`${A}/objects/${ad}/status`).set(as()).send({ status: 'PAUSED' }).expect(200);
    const r3 = await http
      .post(`${A}/objects/${ad}/status`)
      .set(as())
      .send({ status: 'ACTIVE' })
      .expect(409);
    expect(r3.body.error.code).toBe('ADS_DISAPPROVED');
    await http.post(`${A}/objects/${ad}/budget`).set(as()).send({ dailyBudget: -5 }).expect(400);

    graph.failWrites = true;
    const adset = await objectId('9110');
    const failed = (
      await http
        .post(`${A}/objects/${adset}/budget`)
        .set(as())
        .send({ dailyBudget: 90000 })
        .expect(200)
    ).body;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Invalid parameter');
    graph.failWrites = false;
    const after = (await db`SELECT daily_budget FROM meta.ad_objects WHERE id = ${adset}`)[0]!;
    expect(Number(after.daily_budget)).toBe(250000);
    const audit =
      await db`SELECT metadata FROM security.audit_logs WHERE action = 'ads.change.failed'`;
    expect(audit).toHaveLength(1);
  });

  it('keeps ad data inside its tenant', async () => {
    const count = (tenant: string) =>
      db.begin(async (tx) => {
        await tx`SET LOCAL ROLE maris_app`;
        await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        const [i] = await tx`SELECT count(*)::int AS n FROM meta.ad_insights`;
        const [o] = await tx`SELECT count(*)::int AS n FROM meta.ad_objects`;
        const [c] = await tx`SELECT count(*)::int AS n FROM meta.ad_changes`;
        return [i!.n, o!.n, c!.n];
      });
    expect((await count(tenantId)).every((n) => n > 0)).toBe(true);
    expect(await count('00000000-0000-0000-0000-000000000000')).toEqual([0, 0, 0]);
  });
});
