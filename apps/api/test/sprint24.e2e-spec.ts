import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MetaLeadsService } from '../src/meta/meta-leads.service';
import postgres from 'postgres';
import { admin, APP_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner24@example.com',
  password: 'mat-khau-rat-dai-124',
  displayName: 'Chủ shop',
  tenantName: 'Shop CRM',
};
const APP_ID = '423456789012';
const APP_SECRET = 'app-secret-444';
const LONG = 'long-user-token-24';
const PAGE_TOKEN = 'page-token-6661';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  token: string;
}

const lead = (id: string, min: number, fields: Record<string, string>, extra: object = {}) => ({
  id,
  created_time: ago(min),
  field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  ad_id: '9001',
  ad_name: 'Áo thun hè',
  campaign_id: '9100',
  campaign_name: 'Chiến dịch tháng 6',
  form_id: '7001',
  is_organic: false,
  platform: 'fb',
  ...extra,
});

/** A stand-in for graph.facebook.com with one Page, its Lead Ads forms and leads. */
class FakeGraph {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  scopes = [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'leads_retrieval',
    'pages_manage_ads',
  ];
  forms = [
    { id: '7001', name: 'Đăng ký nhận ưu đãi', status: 'ACTIVE' },
    { id: '7002', name: 'Tư vấn size', status: 'ACTIVE' },
  ];
  /** Leads of each form, newest first; served 2 per page to test paging. */
  leads: Record<string, ReturnType<typeof lead>[]> = {
    '7001': [
      lead('8003', 5, { full_name: 'Trần Thu', phone_number: '+84 912 345 678' }),
      lead('8002', 10, {
        full_name: 'Thu Trần',
        phone_number: '0912.345.678',
        email: 'thu@example.com',
      }),
      lead('8001', 20, { first_name: 'Bảo', last_name: 'Ngọc', email: 'NGOC@example.com' }),
    ],
    '7002': [
      lead(
        '8101',
        30,
        { full_name: 'Khang', 'bạn_mặc_size_gì?': 'L' },
        { form_id: '7002', is_organic: true },
      ),
    ],
  };
  single: Record<string, ReturnType<typeof lead>> = {};

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
        data: this.scopes.map((permission) => ({ permission, status: 'granted' })),
      });
    if (path === '/me/accounts')
      return send(200, {
        data: [
          {
            id: '6661',
            name: 'Áo Thun Tú',
            category: 'Clothing',
            tasks: ['MODERATE', 'MESSAGING', 'ADVERTISE'],
            access_token: PAGE_TOKEN,
          },
        ],
      });
    if (path === '/me/adaccounts') return send(200, { data: [] });
    if (/^\/(6661|7\d{3}|8\d{3})(\/|$)/.test(path) && token !== PAGE_TOKEN)
      return send(400, { error: { code: 190, message: 'wrong page token' } });

    if (req.method === 'GET' && path === '/6661/leadgen_forms')
      return send(200, { data: this.forms });
    const leadsOf = /^\/(\d+)\/leads$/.exec(path)?.[1];
    if (req.method === 'GET' && leadsOf) {
      let list = this.leads[leadsOf] ?? [];
      const filter = params['filtering'] ? JSON.parse(params['filtering']) : null;
      if (filter) list = list.filter((l) => Date.parse(l.created_time) / 1000 > filter[0].value);
      const start = params['after'] ? Number(params['after']) : 0;
      const page = list.slice(start, start + 2);
      const more = start + 2 < list.length;
      return send(200, {
        data: page,
        paging: {
          cursors: { after: String(start + 2) },
          ...(more ? { next: 'https://next' } : {}),
        },
      });
    }
    const one = /^\/(\d+)$/.exec(path)?.[1];
    if (req.method === 'GET' && one && this.single[one]) return send(200, this.single[one]);
    if (req.method === 'GET' && one === '7003')
      return send(200, { id: '7003', name: 'Đặt lịch thử đồ', status: 'ACTIVE' });
    if (req.method === 'POST' && /\/subscribed_apps$/.test(path))
      return send(200, { success: true });
    send(404, { error: { code: 803, message: `unknown ${req.method} ${path}` } });
  }
}

describe('Sprint 24 (e2e): CRM and Meta Lead Ads', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let leadsService: MetaLeadsService;
  const graph = new FakeGraph();
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let memberId: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const C = '/api/v1/crm';
  const hook = () => `/api/v1/meta/webhook/${tenantId}`;
  const deliver = (body: unknown) => {
    const raw = JSON.stringify(body);
    return http
      .post(hook())
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      )
      .send(raw);
  };
  const leadgenEvent = (leadgenId: string, formId: string) => ({
    object: 'page',
    entry: [
      {
        id: '6661',
        time: Date.now(),
        changes: [
          {
            field: 'leadgen',
            value: {
              ad_id: '9001',
              form_id: formId,
              leadgen_id: leadgenId,
              created_time: Math.floor(Date.now() / 1000),
              page_id: '6661',
            },
          },
        ],
      },
    ],
  });
  const contacts = async (q = '', t = token) =>
    (await http.get(`${C}/contacts${q}`).set(as(t)).expect(200)).body as {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      stage: string;
      source: string;
      ownerName: string | null;
    }[];

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
    leadsService = app.get(MetaLeadsService);
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as())
      .send({ email: 's24.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({
          token: inv.body.token,
          password: 'mat-khau-thanh-vien-2',
          displayName: 'Hà (Sale)',
        })
        .expect(200)
    ).body.token;
    memberId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${memberToken}`))
      .body.id;

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
    expect(new URL(url).searchParams.get('scope')).toContain('pages_manage_ads');
    await http
      .post('/api/v1/meta/oauth/callback')
      .set(as())
      .send({ code: 'good-code', state: new URL(url).searchParams.get('state') })
      .expect(200);
    const assets = (await http.get('/api/v1/meta').set(as()).expect(200)).body.assets as {
      id: string;
    }[];
    for (const a of assets)
      await http.patch(`/api/v1/meta/assets/${a.id}`).set(as()).send({ enabled: true }).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await graph.stop();
    await db.end();
  });

  it('gives every built-in role CRM access and says Lead Ads is ready', async () => {
    const perms = await db`
      SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS p
      FROM identity.roles r JOIN identity.role_permissions rp ON rp.role_id = r.id
      WHERE r.tenant_id = ${tenantId} AND rp.permission_key LIKE 'crm.%'
      GROUP BY r.key ORDER BY r.key`;
    expect(perms.map((r) => [r.key, r.p])).toEqual(
      ['administrator', 'manager', 'member', 'owner'].map((k) => [k, ['crm.manage', 'crm.read']]),
    );
    const s = (await http.get(`${C}/summary`).set(as(memberToken)).expect(200)).body;
    expect(s).toMatchObject({
      total: 0,
      leads7d: 0,
      stages: { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0 },
      leadAds: { ready: true, missingScopes: [], forms: 0, pollMinutes: 0 },
    });
    await http.get(`${C}/summary`).expect(401);
  });

  it('reads forms and leads, follows paging and makes one contact per phone or email', async () => {
    await http.post(`${C}/leads/sync`).set(as(memberToken)).expect(403);
    const r = (await http.post(`${C}/leads/sync`).set(as()).expect(200)).body;
    expect(r.added).toBe(4);
    expect(r.leadAds.forms).toBe(2);
    expect(r.leads7d).toBe(4);
    // Form 7001 has 3 leads, 2 per page: two reads.
    expect(graph.calls('GET', /^\/7001\/leads$/)).toHaveLength(2);
    expect(graph.calls('GET', /^\/7001\/leads$/)[1]!.params['after']).toBe('2');
    expect(graph.calls('GET', /\/leads$/).every((h) => h.token === PAGE_TOKEN)).toBe(true);

    const list = await contacts();
    expect(list.map((c) => [c.name, c.phone, c.email, c.source, c.stage]).sort()).toEqual([
      ['Bảo Ngọc', null, 'NGOC@example.com', 'lead_ads', 'new'],
      ['Khang', null, null, 'lead_ads', 'new'],
      // Two leads with the same number in different forms of writing: one contact, email filled in.
      ['Thu Trần', '0912.345.678', 'thu@example.com', 'lead_ads', 'new'],
    ]);
    const thu = list.find((c) => c.name === 'Thu Trần')!;
    const d = (await http.get(`${C}/contacts/${thu.id}`).set(as(memberToken)).expect(200)).body;
    expect(d.leads).toHaveLength(2);
    expect(d.leads[0]).toMatchObject({
      formName: 'Đăng ký nhận ưu đãi',
      pageName: 'Áo Thun Tú',
      name: 'Trần Thu',
      phone: '+84 912 345 678',
      adName: 'Áo thun hè',
      campaignName: 'Chiến dịch tháng 6',
      receivedVia: 'sync',
      contactName: 'Thu Trần',
    });
    expect(d.activities.map((a: { kind: string }) => a.kind)).toEqual(['lead', 'lead', 'created']);

    const leads = (await http.get(`${C}/leads`).set(as()).expect(200)).body;
    expect(leads).toHaveLength(4);
    const khang = leads.find((l: { name: string }) => l.name === 'Khang');
    expect(khang).toMatchObject({ isOrganic: true, formName: 'Tư vấn size' });
    expect(khang.fields).toContainEqual({ name: 'bạn_mặc_size_gì?', values: ['L'] });
    expect((await http.get(`${C}/leads?q=size`).set(as()).expect(200)).body).toHaveLength(1);

    // Customer data stays out of the audit log.
    const audit = await db`
      SELECT action, metadata::text AS m FROM security.audit_logs
      WHERE tenant_id = ${tenantId} AND action LIKE 'crm.%'`;
    expect(audit.filter((a) => a.action === 'crm.lead_received')).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toMatch(/example\.com|Thu|Khang|\+84/);

    // Reading again asks only for newer leads and doubles nothing.
    graph.leads['7001']!.unshift(
      lead('8004', 1, { full_name: 'Minh', phone_number: '0987654321' }),
    );
    const again = (await http.post(`${C}/leads/sync`).set(as()).expect(200)).body;
    expect(again.added).toBe(1);
    const last = graph.calls('GET', /^\/7001\/leads$/).at(-1)!;
    expect(JSON.parse(last.params['filtering']!)[0]).toMatchObject({
      field: 'time_created',
      operator: 'GREATER_THAN',
    });
    expect(await contacts()).toHaveLength(4);
    expect(await db`SELECT 1 FROM meta.leads`).toHaveLength(5);
  });

  it('takes a lead named by the webhook once, and learns a new form', async () => {
    graph.single['8201'] = lead(
      '8201',
      0,
      { full_name: 'Lan', phone_number: '0911222333' },
      { form_id: '7003' },
    );
    expect((await deliver(leadgenEvent('8201', '7003')).expect(200)).body).toEqual({
      received: 1,
      stored: 1,
    });
    expect((await deliver(leadgenEvent('8201', '7003')).expect(200)).body).toEqual({
      received: 1,
      stored: 0,
    });
    expect(graph.calls('GET', /^\/8201$/)).toHaveLength(1);
    const forms = (await http.get(`${C}/lead-forms`).set(as(memberToken)).expect(200)).body;
    const byName = Object.fromEntries(
      forms.map((f: { name: string; leads: number }) => [f.name, f.leads]),
    );
    expect(byName).toEqual({ 'Đăng ký nhận ưu đãi': 4, 'Đặt lịch thử đồ': 1, 'Tư vấn size': 1 });
    const lan = (await contacts('?q=0911222')).find((c) => c.name === 'Lan')!;
    expect(lan.source).toBe('lead_ads');
    const l = (await http.get(`${C}/leads?q=Lan`).set(as()).expect(200)).body[0];
    expect(l).toMatchObject({ receivedVia: 'webhook', formName: 'Đặt lịch thử đồ' });
    const ev = await db`SELECT field, outcome FROM meta.webhook_events WHERE field = 'leadgen'`;
    expect(ev.map((e) => e.outcome)).toEqual(['stored']);
  });

  it('skips leads of a form that is turned off', async () => {
    const forms = (await http.get(`${C}/lead-forms`).set(as()).expect(200)).body as {
      id: string;
      externalId: string;
    }[];
    const f = forms.find((x) => x.externalId === '7003')!;
    await http
      .patch(`${C}/lead-forms/${f.id}`)
      .set(as(memberToken))
      .send({ enabled: false })
      .expect(403);
    const after = (
      await http.patch(`${C}/lead-forms/${f.id}`).set(as()).send({ enabled: false }).expect(200)
    ).body;
    expect(after.find((x: { id: string }) => x.id === f.id).enabled).toBe(false);
    graph.single['8202'] = lead('8202', 0, { full_name: 'Bị bỏ qua' }, { form_id: '7003' });
    expect((await deliver(leadgenEvent('8202', '7003')).expect(200)).body.stored).toBe(0);
    expect(await db`SELECT 1 FROM meta.leads WHERE external_id = '8202'`).toHaveLength(0);
  });

  it('adds, finds and edits contacts, refusing a second contact with the same number', async () => {
    const created = (
      await http
        .post(`${C}/contacts`)
        .set(as(memberToken))
        .send({
          name: 'Chị Hoa',
          phone: '0903 111 222',
          tags: ['VIP', 'VIP', 'sỉ'],
          valueVnd: 2500000,
        })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      source: 'manual',
      stage: 'new',
      tags: ['VIP', 'sỉ'],
      valueVnd: 2500000,
    });
    const dup = await http
      .post(`${C}/contacts`)
      .set(as())
      .send({ name: 'Hoa', phone: '+84903111222' })
      .expect(409);
    expect(dup.body.error).toMatchObject({
      code: 'CRM_DUPLICATE',
      details: { contactId: created.id },
    });
    await http
      .post(`${C}/contacts`)
      .set(as())
      .send({ name: 'X', email: 'not-an-email' })
      .expect(400);
    await http
      .post(`${C}/contacts`)
      .set(as())
      .send({ name: 'Y', email: 'THU@example.com' })
      .expect(409);

    expect((await contacts('?q=111222')).map((c) => c.name)).toEqual(['Chị Hoa']);
    expect((await contacts('?q=vip')).map((c) => c.name)).toEqual(['Chị Hoa']);

    const ngoc = (await contacts()).find((c) => c.name === 'Bảo Ngọc')!;
    await http
      .patch(`${C}/contacts/${created.id}`)
      .set(as())
      .send({ email: 'ngoc@EXAMPLE.com' })
      .expect(409);
    await http
      .patch(`${C}/contacts/${created.id}`)
      .set(as())
      .send({ ownerId: randomUUID() })
      .expect(400);

    const moved = (
      await http
        .patch(`${C}/contacts/${created.id}`)
        .set(as(memberToken))
        .send({ stage: 'qualified', ownerId: memberId, note: 'Hỏi giá sỉ 50 áo' })
        .expect(200)
    ).body;
    expect(moved).toMatchObject({
      stage: 'qualified',
      ownerName: 'Hà (Sale)',
      note: 'Hỏi giá sỉ 50 áo',
    });
    expect(moved.activities.map((a: { kind: string; body: string }) => [a.kind, a.body])).toEqual([
      ['updated', ''],
      ['owner', 'Giao cho Hà (Sale)'],
      ['stage', 'Mới → Có nhu cầu'],
      ['created', ''],
    ]);
    const lost = (
      await http
        .patch(`${C}/contacts/${ngoc.id}`)
        .set(as())
        .send({ stage: 'lost', lostReason: 'Chê giá cao' })
        .expect(200)
    ).body;
    expect(lost).toMatchObject({ stage: 'lost', lostReason: 'Chê giá cao' });
    expect(lost.activities[0]).toMatchObject({
      kind: 'stage',
      body: 'Mới → Không mua: Chê giá cao',
    });

    const noted = (
      await http
        .post(`${C}/contacts/${created.id}/notes`)
        .set(as(memberToken))
        .send({ body: 'Đã gọi, hẹn thứ Hai' })
        .expect(201)
    ).body;
    expect(noted.activities[0]).toMatchObject({
      kind: 'note',
      body: 'Đã gọi, hẹn thứ Hai',
      actorName: 'Hà (Sale)',
    });

    expect((await contacts('?owner=me', memberToken)).map((c) => c.name)).toEqual(['Chị Hoa']);
    expect((await contacts('?stage=qualified')).map((c) => c.name)).toEqual(['Chị Hoa']);
    const s = (await http.get(`${C}/summary`).set(as(memberToken)).expect(200)).body;
    expect(s).toMatchObject({ total: 6, mine: 1, stages: { new: 4, qualified: 1, lost: 1 } });

    // Archived: gone from the list, frozen, and its number can be used again.
    await http.patch(`${C}/contacts/${created.id}`).set(as()).send({ archived: true }).expect(200);
    expect((await contacts()).map((c) => c.name)).not.toContain('Chị Hoa');
    await http.patch(`${C}/contacts/${created.id}`).set(as()).send({ name: 'Z' }).expect(409);
    await http
      .post(`${C}/contacts`)
      .set(as())
      .send({ name: 'Hoa mới', phone: '0903111222' })
      .expect(201);
    // History rows are never changed.
    const appDb = postgres(APP_URL, { max: 1, onnotice: () => {} });
    await expect(appDb`UPDATE crm.activities SET body = 'x'`).rejects.toThrow(/permission denied/);
    await appDb.end();
  });

  it('saves an inbox conversation to the CRM and shows the contact in the inbox', async () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: '6661',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID9' },
              recipient: { id: '6661' },
              timestamp: Date.now(),
              message: { mid: 'm_crm1', text: 'Mình muốn đặt 2 áo' },
            },
          ],
        },
      ],
    };
    await deliver(body).expect(200);
    const [t] = (await http.get('/api/v1/meta/inbox/threads').set(as()).expect(200)).body;
    expect(t).toMatchObject({ contactId: null, contactName: null });

    const c = (
      await http.post(`${C}/threads/${t.id}/contact`).set(as(memberToken)).send({}).expect(200)
    ).body;
    expect(c).toMatchObject({ source: 'messenger', stage: 'new' });
    expect(c.threads).toEqual([
      expect.objectContaining({ id: t.id, channel: 'messenger', assetName: 'Áo Thun Tú' }),
    ]);
    expect(c.activities.map((a: { kind: string }) => a.kind)).toEqual(['thread', 'created']);
    // Asking again keeps the same contact.
    const again = (await http.post(`${C}/threads/${t.id}/contact`).set(as()).send({}).expect(200))
      .body;
    expect(again.id).toBe(c.id);

    const lan = (await contacts('?q=Lan'))[0]!;
    const moved = (
      await http
        .post(`${C}/threads/${t.id}/contact`)
        .set(as())
        .send({ contactId: lan.id })
        .expect(200)
    ).body;
    expect(moved.id).toBe(lan.id);
    expect(moved.threads.map((x: { id: string }) => x.id)).toEqual([t.id]);
    const inbox = (await http.get(`/api/v1/meta/inbox/threads/${t.id}`).set(as()).expect(200)).body;
    expect(inbox).toMatchObject({ contactId: lan.id, contactName: 'Lan' });
    await http.post(`${C}/threads/${randomUUID()}/contact`).set(as()).send({}).expect(404);
  });

  it('says what is missing when the Facebook connection lacks the Lead Ads permissions', async () => {
    graph.scopes = ['pages_show_list', 'pages_messaging'];
    const { url } = (await http.post('/api/v1/meta/oauth/start').set(as()).expect(200)).body;
    await http
      .post('/api/v1/meta/oauth/callback')
      .set(as())
      .send({ code: 'good-code', state: new URL(url).searchParams.get('state') })
      .expect(200);
    const s = (await http.get(`${C}/summary`).set(as()).expect(200)).body;
    expect(s.leadAds).toMatchObject({
      ready: false,
      missingScopes: ['leads_retrieval', 'pages_manage_ads'],
    });
    // The poller keeps quiet when nothing is due.
    expect(await leadsService.pollOnce()).toBeGreaterThanOrEqual(0);
  });
});
