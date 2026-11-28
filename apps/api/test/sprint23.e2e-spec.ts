import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MetaInboxService } from '../src/meta/meta-inbox.service';
import { FakeAi } from './fake-ai';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner23@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ shop',
  tenantName: 'Shop Hộp Thư',
};
const APP_ID = '323456789012';
const APP_SECRET = 'app-secret-333';
const LONG = 'long-user-token-23';
const PAGE_TOKEN = 'page-token-5551';
const PAGE2_TOKEN = 'page-token-5552';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  token: string;
}

/** A stand-in for graph.facebook.com with Pages, chats and comments. */
class FakeGraph {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  fail: Record<string, { status: number; body: unknown } | 'drop'> = {};
  sent = 0;

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
    const f = this.fail[`${req.method} ${path}`];
    if (f === 'drop') return req.socket.destroy();
    if (f) return send(f.status, f.body);

    if (path === '/oauth/access_token')
      return send(200, {
        access_token: params['code'] ? 'short' : LONG,
        token_type: 'bearer',
        expires_in: 5_184_000,
      });
    if (path === '/me') return send(200, { id: '3001', name: 'Tú' });
    if (path === '/me/permissions')
      return send(200, {
        data: [
          'pages_show_list',
          'pages_messaging',
          'pages_manage_engagement',
          'pages_read_user_content',
          'instagram_basic',
          'instagram_manage_comments',
          'instagram_manage_messages',
        ].map((permission) => ({ permission, status: 'granted' })),
      });
    if (path === '/me/accounts')
      return send(200, {
        data: [
          {
            id: '5551',
            name: 'Áo Thun Tú',
            category: 'Clothing',
            tasks: ['MODERATE', 'MESSAGING'],
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: '1784', username: 'aothuntu', name: 'IG' },
          },
          {
            id: '5552',
            name: 'Tú Outlet',
            category: 'Shopping',
            tasks: ['MODERATE'],
            access_token: PAGE2_TOKEN,
          },
        ],
      });
    if (path === '/me/adaccounts') return send(200, { data: [] });

    const pageTokens: Record<string, string> = {
      '5551': PAGE_TOKEN,
      '5552': PAGE2_TOKEN,
      '1784': PAGE_TOKEN,
    };
    const owner = /^\/(\d+)\//.exec(path)?.[1];
    if (owner && pageTokens[owner] && token !== pageTokens[owner])
      return send(400, { error: { code: 190, message: 'wrong page token' } });

    if (req.method === 'POST' && /\/subscribed_apps$/.test(path))
      return send(200, { success: true });
    if (req.method === 'GET' && path === '/5551/conversations') {
      if (params['platform'] === 'instagram')
        return send(200, {
          data: [
            {
              id: 'ig-conv-1',
              participants: {
                data: [
                  { id: '1784', username: 'aothuntu' },
                  { id: 'IGSID1', username: 'khach.ig' },
                ],
              },
              messages: {
                data: [
                  {
                    id: 'ig_m1',
                    from: { id: 'IGSID1', username: 'khach.ig' },
                    message: 'Ship Hà Nội bao lâu?',
                    created_time: ago(30),
                  },
                ],
              },
            },
          ],
        });
      return send(200, {
        data: [
          {
            id: 't_1',
            participants: {
              data: [
                { id: '5551', name: 'Áo Thun Tú' },
                { id: 'PSID1', name: 'Lan' },
              ],
            },
            messages: {
              data: [
                {
                  id: 'm_poll2',
                  from: { id: '5551', name: 'Áo Thun Tú' },
                  message: 'Dạ còn ạ',
                  created_time: ago(5),
                },
                {
                  id: 'm_poll1',
                  from: { id: 'PSID1', name: 'Lan' },
                  message: 'Còn size M không shop?',
                  created_time: ago(10),
                },
              ],
            },
          },
        ],
      });
    }
    if (req.method === 'GET' && path === '/5552/conversations') return send(200, { data: [] });
    if (req.method === 'GET' && path === '/5551/feed')
      return send(200, {
        data: [
          {
            id: '5551_77',
            comments: {
              data: [
                {
                  id: '5551_77_c9',
                  from: { id: 'U9', name: 'Minh' },
                  message: 'Giá bao nhiêu?',
                  created_time: ago(20),
                },
              ],
            },
          },
        ],
      });
    if (req.method === 'GET' && path === '/5552/feed') return send(200, { data: [] });
    if (req.method === 'GET' && path === '/1784/media')
      return send(200, {
        data: [
          {
            id: 'media1',
            comments: {
              data: [
                {
                  id: 'igc1',
                  text: 'Đẹp quá, có màu đen không?',
                  timestamp: ago(15),
                  from: { id: 'IGU2', username: 'mai.ng' },
                  replies: {
                    data: [
                      {
                        id: 'igr1',
                        text: 'Có ạ',
                        timestamp: ago(14),
                        from: { id: '1784', username: 'aothuntu' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      });
    if (req.method === 'GET' && path === '/PSID2') return send(200, { name: 'Nguyễn Lan Anh' });
    if (req.method === 'POST' && path === '/5551/messages')
      return send(200, {
        recipient_id: JSON.parse(params['recipient'] ?? '{}').id,
        message_id: `m_out_${++this.sent}`,
      });
    if (req.method === 'POST' && /^\/[\w]+\/comments$/.test(path))
      return send(200, { id: `reply_${++this.sent}` });
    if (req.method === 'POST' && /^\/[\w]+\/replies$/.test(path))
      return send(200, { id: `igreply_${++this.sent}` });
    send(404, { error: { code: 803, message: `unknown ${req.method} ${path}` } });
  }
}

describe('Sprint 23 (e2e): Facebook and Instagram inbox', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let inbox: MetaInboxService;
  const graph = new FakeGraph();
  const ai = new FakeAi();
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let memberId: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const I = '/api/v1/meta/inbox';
  const hook = () => `/api/v1/meta/webhook/${tenantId}`;
  const sign = (raw: string, secret = APP_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const deliver = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return http
      .post(hook())
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature ?? sign(raw))
      .send(raw);
  };
  const threads = async (q = '') =>
    (await http.get(`${I}/threads${q}`).set(as()).expect(200)).body as {
      id: string;
      channel: string;
      customerName: string;
      unread: number;
      status: string;
      snippet: string;
      replyUntil: string | null;
    }[];
  const reply = (id: string, text: string, extra: object = {}) =>
    http
      .post(`${I}/threads/${id}/reply`)
      .set(as())
      .send({ text, clientKey: randomUUID(), ...extra });

  const messengerEvent = (
    mid: string,
    text: string,
    opts: { echo?: boolean; psid?: string } = {},
  ) => ({
    object: 'page',
    entry: [
      {
        id: '5551',
        time: Date.now(),
        messaging: [
          {
            sender: { id: opts.echo ? '5551' : (opts.psid ?? 'PSID2') },
            recipient: { id: opts.echo ? (opts.psid ?? 'PSID2') : '5551' },
            timestamp: Date.now(),
            message: { mid, text, ...(opts.echo ? { is_echo: true } : {}) },
          },
        ],
      },
    ],
  });

  beforeAll(async () => {
    await resetDatabase();
    await graph.start();
    await ai.start();
    ai.reply = (body) => {
      const user = body?.messages?.at(-1)?.content;
      if (typeof user !== 'string' || !user.includes('<conversation>')) return null;
      return user.includes('hoàn tiền')
        ? '{"reply": "", "handoff": true, "reason": "Khách đòi hoàn tiền"}'
        : '```json\n{"reply": "Dạ shop còn size M ạ. Chị cần màu nào để shop giữ hàng?", "handoff": false}\n```';
    };
    app = await startApp({
      META_GRAPH_URL: graph.url,
      META_RETRY_BASE_MS: '1',
      META_PUBLISHER_ENABLED: 'false',
      META_INBOX_POLL_MIN: '0',
      PUBLIC_API_URL: 'https://maris.example.vn',
      AI_ALLOW_PRIVATE_URLS: 'true',
      AI_RETRY_BASE_MS: '5',
    });
    inbox = app.get(MetaInboxService);
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
      .send({ email: 's23.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({
          token: inv.body.token,
          password: 'mat-khau-thanh-vien-1',
          displayName: 'Thu (CSKH)',
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
    await http
      .post('/api/v1/meta/oauth/callback')
      .set(as())
      .send({ code: 'good-code', state: new URL(url).searchParams.get('state') })
      .expect(200);

    const secretRef = (
      await http
        .post('/api/v1/secrets')
        .set(as())
        .send({ name: 'fake.api_key', value: 'sk-fake-23' })
        .expect(201)
    ).body.reference;
    await http
      .post('/api/v1/ai/providers')
      .set(as())
      .send({
        name: 'A',
        kind: 'openai',
        baseUrl: `${ai.baseUrl}/a`,
        secretRef,
        defaultModel: 'A-model',
        inputCostPerMtok: 1,
        outputCostPerMtok: 2,
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await graph.stop();
    await ai.stop();
    await db.end();
  });

  it('gives the webhook address and answers Meta’s check only with the right token', async () => {
    const s = (await http.get(`${I}/summary`).set(as(memberToken)).expect(200)).body;
    expect(s).toMatchObject({
      open: 0,
      repliesToday: 0,
      replyLimit: 400,
      pollMinutes: 0,
      webhook: {
        callbackUrl: `https://maris.example.vn/api/v1/meta/webhook/${tenantId}`,
        lastEventAt: null,
      },
    });
    expect(s.webhook.verifyToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The token stays the same.
    expect((await http.get(`${I}/summary`).set(as()).expect(200)).body.webhook.verifyToken).toBe(
      s.webhook.verifyToken,
    );

    const q = (t: string) => `?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=12345`;
    await http.get(`${hook()}${q('sai')}`).expect(403);
    const ok = await http.get(`${hook()}${q(s.webhook.verifyToken)}`).expect(200);
    expect(ok.text).toBe('12345');
    await http.get(`/api/v1/meta/webhook/${randomUUID()}${q(s.webhook.verifyToken)}`).expect(403);
  });

  it('takes only deliveries signed with the App Secret, each change once', async () => {
    const body = messengerEvent('m_hook1', 'Chào shop, áo này còn không?');
    await deliver(body, 'sha256=00').expect(401);
    await deliver(body, sign(JSON.stringify(body), 'secret-khac')).expect(401);
    await http
      .post(hook())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
      .expect(401);
    expect(await db`SELECT 1 FROM meta.messages`).toHaveLength(0);

    expect((await deliver(body).expect(200)).body).toEqual({ received: 1, stored: 1 });
    // Meta sends it again: nothing doubles.
    expect((await deliver(body).expect(200)).body).toEqual({ received: 1, stored: 0 });

    const comment = {
      object: 'page',
      entry: [
        {
          id: '5551',
          time: Date.now(),
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '5551_88_c1',
                post_id: '5551_88',
                parent_id: '5551_88',
                from: { id: 'U7', name: 'Hùng' },
                message: 'Inbox giá giúp mình',
                created_time: Math.floor(Date.now() / 1000),
              },
            },
            { field: 'feed', value: { item: 'reaction', verb: 'add', post_id: '5551_88' } },
          ],
        },
      ],
    };
    expect((await deliver(comment).expect(200)).body).toEqual({ received: 2, stored: 1 });
    const ig = {
      object: 'instagram',
      entry: [
        {
          id: '1784',
          time: Date.now(),
          changes: [
            {
              field: 'comments',
              value: {
                id: 'igc5',
                text: 'Có size XL không?',
                from: { id: 'IGU5', username: 'tuan.ig' },
                media: { id: 'media9' },
              },
            },
          ],
        },
      ],
    };
    await deliver(ig).expect(200);

    const list = await threads();
    expect(list.map((t) => [t.channel, t.customerName, t.unread]).sort()).toEqual([
      ['fb_comment', 'Hùng', 1],
      ['ig_comment', 'tuan.ig', 1],
      // The Messenger customer's name is asked from Meta once.
      ['messenger', 'Nguyễn Lan Anh', 1],
    ]);
    expect(graph.calls('GET', /^\/PSID2$/)).toHaveLength(1);
    expect(graph.calls('GET', /^\/PSID2$/)[0]!.token).toBe(PAGE_TOKEN);
    const ev = await db`SELECT outcome, detail FROM meta.webhook_events ORDER BY received_at`;
    expect(ev.map((e) => e.outcome)).toEqual(['stored', 'stored', 'ignored', 'stored']);
    expect(JSON.stringify(ev)).not.toContain('Inbox giá');
    expect((await http.get(`${I}/summary`).set(as()).expect(200)).body).toMatchObject({
      open: 3,
      unread: 3,
    });
  });

  it('replies on Messenger as the Page, once per click, and ignores the echo', async () => {
    const t = (await threads('?channel=messenger'))[0]!;
    expect(Date.parse(t.replyUntil!) - Date.now()).toBeGreaterThan(23 * 3600_000);
    const d = (await http.get(`${I}/threads/${t.id}`).set(as(memberToken)).expect(200)).body;
    expect(d).toMatchObject({ unread: 0, customerName: 'Nguyễn Lan Anh' });
    expect(
      d.messages.map((m: { direction: string; body: string }) => [m.direction, m.body]),
    ).toEqual([['in', 'Chào shop, áo này còn không?']]);

    const clientKey = randomUUID();
    const send = () =>
      http
        .post(`${I}/threads/${t.id}/reply`)
        .set(as(memberToken))
        .send({ text: 'Dạ còn ạ, chị cần size nào?', clientKey });
    const r = (await send().expect(200)).body;
    await send().expect(200);
    const out = r.messages.filter((m: { direction: string }) => m.direction === 'out');
    expect(out).toEqual([
      expect.objectContaining({
        status: 'sent',
        body: 'Dạ còn ạ, chị cần size nào?',
        sentByName: 'Thu (CSKH)',
      }),
    ]);
    const sent = graph.calls('POST', /^\/5551\/messages$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe(PAGE_TOKEN);
    expect(JSON.parse(sent[0]!.params['recipient']!)).toEqual({ id: 'PSID2' });
    expect(sent[0]!.params['messaging_type']).toBe('RESPONSE');
    expect(JSON.parse(sent[0]!.params['message']!)).toEqual({
      text: 'Dạ còn ạ, chị cần size nào?',
    });

    // Meta's echo of the same message does not add a copy.
    await deliver(messengerEvent('m_out_1', 'Dạ còn ạ, chị cần size nào?', { echo: true })).expect(
      200,
    );
    const again = (await http.get(`${I}/threads/${t.id}`).set(as()).expect(200)).body;
    expect(again.messages).toHaveLength(2);
    // A reply sent from Facebook itself shows up as the shop's.
    await deliver(messengerEvent('m_fb_9', 'Shop gửi ảnh nhé', { echo: true })).expect(200);
    const after = (await http.get(`${I}/threads/${t.id}`).set(as()).expect(200)).body;
    expect(after.messages.at(-1)).toMatchObject({
      direction: 'out',
      body: 'Shop gửi ảnh nhé',
      sentByName: null,
    });
    expect((await http.get(`${I}/summary`).set(as()).expect(200)).body.repliesToday).toBe(1);
    expect(
      (await db`SELECT action FROM security.audit_logs WHERE action = 'inbox.replied'`).length,
    ).toBe(1);
  });

  it('keeps to the 24-hour window for chats but not for comments', async () => {
    const t = (await threads('?channel=messenger'))[0]!;
    await db`UPDATE meta.threads SET last_inbound_at = now() - interval '25 hours' WHERE id = ${t.id}`;
    expect((await reply(t.id, 'Shop chào chị').expect(409)).body.error.code).toBe(
      'META_REPLY_WINDOW',
    );
    // The customer writes again: the window opens.
    await deliver(messengerEvent('m_hook2', 'Mình lấy size M nhé')).expect(200);
    await reply(t.id, 'Dạ shop giữ size M cho chị ạ').expect(200);

    const fb = (await threads('?channel=fb_comment'))[0]!;
    expect(fb.replyUntil).toBeNull();
    await db`UPDATE meta.threads SET last_inbound_at = now() - interval '30 days' WHERE id = ${fb.id}`;
    const r = (await reply(fb.id, 'Shop đã inbox bạn nhé').expect(200)).body;
    expect(r.messages.at(-1)).toMatchObject({ status: 'sent', authorName: 'Áo Thun Tú' });
    expect(graph.calls('POST', /^\/5551_88_c1\/comments$/)[0]!.params['message']).toBe(
      'Shop đã inbox bạn nhé',
    );

    const ig = (await threads('?channel=ig_comment'))[0]!;
    const r2 = (await reply(ig.id, 'Có ạ').expect(200)).body;
    expect(r2.messages.at(-1)).toMatchObject({ status: 'sent', authorName: '@aothuntu' });
    expect(graph.calls('POST', /^\/igc5\/replies$/)).toHaveLength(1);
  });

  it('holds 400 replies a day, does not count refusals and leaves lost replies to a person', async () => {
    const t = (await threads('?channel=fb_comment'))[0]!;
    // Meta refuses: nothing went out, it does not count.
    graph.fail['POST /5551_88_c1/comments'] = {
      status: 400,
      body: { error: { code: 10, message: 'Permission denied' } },
    };
    expect((await reply(t.id, 'Thử').expect(409)).body.error.code).toBe('META_PERMISSION_MISSING');
    let d = (await http.get(`${I}/threads/${t.id}`).set(as()).expect(200)).body;
    expect(d.messages.at(-1)).toMatchObject({ status: 'failed' });
    const before = (await http.get(`${I}/summary`).set(as()).expect(200)).body.repliesToday;

    // The connection drops: it may have gone out, so it counts and is not sent again by itself.
    graph.fail['POST /5551_88_c1/comments'] = 'drop';
    d = (await reply(t.id, 'Thử lần nữa').expect(200)).body;
    expect(d.messages.at(-1)).toMatchObject({ status: 'unknown' });
    expect(d.messages.at(-1).errorMessage).toContain('Không rõ');
    expect((await http.get(`${I}/summary`).set(as()).expect(200)).body.repliesToday).toBe(
      before + 1,
    );
    delete graph.fail['POST /5551_88_c1/comments'];

    const [u] = await db`SELECT id FROM identity.users WHERE email = ${OWNER.email}`;
    await db`INSERT INTO meta.messages (id, tenant_id, thread_id, direction, body, status, sent_at, sent_by, local_day)
             SELECT gen_random_uuid(), ${tenantId}, ${t.id}, 'out', 'cũ', 'sent', now(), ${u!.id},
                    (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
             FROM generate_series(1, ${400 - before - 1})`;
    const r = await reply(t.id, 'Lượt 401').expect(409);
    expect(r.body.error).toMatchObject({ code: 'META_REPLY_LIMIT' });
    await db`DELETE FROM meta.messages WHERE body = 'cũ'`;
  });

  it('suggests a reply with the tenant’s AI and hands over when it should', async () => {
    const t = (await threads('?channel=messenger'))[0]!;
    const d = (await http.post(`${I}/threads/${t.id}/suggest`).set(as(memberToken)).expect(200))
      .body;
    expect(d.suggestion).toMatchObject({
      text: 'Dạ shop còn size M ạ. Chị cần màu nào để shop giữ hàng?',
      handoff: false,
    });
    const prompt = ai.requests.at(-1)!.body.messages.at(-1).content as string;
    expect(prompt).toContain('Khách: Mình lấy size M nhé');
    expect(prompt).toContain('Cửa hàng: Dạ shop giữ size M cho chị ạ');
    expect(ai.requests.at(-1)!.body.messages[0].content).toContain('Không bịa giá');
    const calls =
      await db`SELECT meta_thread_id FROM ai.provider_calls WHERE meta_thread_id IS NOT NULL`;
    expect(calls).toHaveLength(1);
    // Sending it marks the reply as AI-assisted and clears the suggestion.
    const sent = (await reply(t.id, d.suggestion.text, { aiAssisted: true }).expect(200)).body;
    expect(sent.messages.at(-1)).toMatchObject({ aiAssisted: true });
    expect(sent.suggestion).toBeNull();

    await deliver(messengerEvent('m_hook3', 'Hàng lỗi, mình muốn hoàn tiền')).expect(200);
    const h = (await http.post(`${I}/threads/${t.id}/suggest`).set(as()).expect(200)).body;
    expect(h.suggestion).toMatchObject({ handoff: true, reason: 'Khách đòi hoàn tiền' });
    // Nothing is ever sent by the AI itself.
    expect(graph.calls('POST', /^\/5551\/messages$/)).toHaveLength(3);
  });

  it('assigns, closes and reopens conversations', async () => {
    const t = (await threads('?channel=messenger'))[0]!;
    await http
      .patch(`${I}/threads/${t.id}`)
      .set(as())
      .send({ assignedTo: randomUUID() })
      .expect(400);
    let d = (
      await http
        .patch(`${I}/threads/${t.id}`)
        .set(as())
        .send({ assignedTo: memberId, status: 'done' })
        .expect(200)
    ).body;
    expect(d).toMatchObject({ status: 'done', assignedToName: 'Thu (CSKH)' });
    expect(
      (await http.get(`${I}/threads?assigned=me`).set(as(memberToken)).expect(200)).body,
    ).toHaveLength(1);
    expect((await threads('?status=open')).map((x) => x.id)).not.toContain(t.id);
    await deliver(messengerEvent('m_hook4', 'Shop ơi?')).expect(200);
    d = (await http.get(`${I}/threads/${t.id}`).set(as()).expect(200)).body;
    expect(d.status).toBe('open');
    expect((await threads('?q=Lan%20Anh')).map((x) => x.id)).toEqual([t.id]);
  });

  it('reads Meta when the webhook is quiet, and turns on the webhook for the Pages', async () => {
    await http.post(`${I}/sync`).set(as(memberToken)).expect(403);
    // The webhook delivered recently: the poller stays quiet.
    expect(await inbox.pollOnce()).toBe(0);
    expect(graph.calls('GET', /conversations$/)).toHaveLength(0);

    await db`UPDATE meta.apps SET webhook_last_at = now() - interval '2 hours'`;
    const n = await inbox.pollOnce();
    expect(n).toBeGreaterThan(0);
    const polled = graph.calls('GET', /\/(conversations|feed|media)$/);
    expect(polled.every((h) => h.params['limit'] === '10')).toBe(true);
    // Two accounts per round, in turn.
    await inbox.pollOnce();
    const list = await threads();
    const byChannel = (c: string) =>
      list
        .filter((t) => t.channel === c)
        .map((t) => t.customerName)
        .sort();
    expect(byChannel('messenger')).toEqual(['Lan', 'Nguyễn Lan Anh']);
    expect(byChannel('ig_dm')).toEqual(['khach.ig']);
    expect(byChannel('fb_comment')).toEqual(['Hùng', 'Minh']);
    expect(byChannel('ig_comment')).toEqual(['mai.ng', 'tuan.ig']);
    const lan = list.find((t) => t.customerName === 'Lan')!;
    const d = (await http.get(`${I}/threads/${lan.id}`).set(as()).expect(200)).body;
    expect(d.messages.map((m: { direction: string }) => m.direction)).toEqual(['in', 'out']);
    // Read again: nothing doubles.
    const count = (await db`SELECT count(*)::int AS n FROM meta.messages`)[0]!.n;
    await http.post(`${I}/sync`).set(as()).expect(200);
    expect((await db`SELECT count(*)::int AS n FROM meta.messages`)[0]!.n).toBe(count);

    await http.post(`${I}/webhook/subscribe`).set(as()).expect(200);
    const subs = graph.calls('POST', /subscribed_apps$/);
    expect(subs.map((h) => h.path).sort()).toEqual([
      '/5551/subscribed_apps',
      '/5552/subscribed_apps',
    ]);
    expect(subs[0]!.params['subscribed_fields']).toBe('feed,messages,message_echoes,leadgen');
  });
});
