import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';
import { FakeAi, parseSse } from './fake-ai';

const OWNER = { email: 'owner3@example.com', password: 'mat-khau-rat-dai-123', displayName: 'Owner', tenantName: 'Công ty AI' };
const FAKE_KEY = 'sk-fake-test-key-123';

describe('Sprint 3 (e2e): AI Provider Gateway, router, failover, chat', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let secretRef: string;
  let memberToken: string;
  const fake = new FakeAi();
  const ids: Record<string, string> = {};

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });

  async function addProvider(name: string, kind: string, path: string, extra: Record<string, unknown> = {}) {
    const res = await http
      .post('/api/v1/ai/providers')
      .set(as(token))
      .send({ name, kind, baseUrl: `${fake.baseUrl}/${path}`, secretRef, defaultModel: `${name}-model`, ...extra })
      .expect(201);
    return res.body.id as string;
  }

  async function send(conversationId: string, content: string, extra: Record<string, unknown> = {}) {
    const res = await http
      .post(`/api/v1/ai/conversations/${conversationId}/messages`)
      .set(as(token))
      .send({ content, ...extra })
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => cb(null, text));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    return parseSse(res.body as string);
  }

  async function newConversation(body: Record<string, unknown> = {}) {
    return (await http.post('/api/v1/ai/conversations').set(as(token)).send(body).expect(201)).body.id as string;
  }

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    // The fake provider listens on 127.0.0.1, which the URL guard blocks unless private URLs are allowed.
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.memberships[0].tenantId;
    secretRef = (await http.post('/api/v1/secrets').set(as(token)).send({ name: 'fake.api_key', value: FAKE_KEY }).expect(201)).body
      .reference;

    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as { id: string; key: string }[];
    const memberRole = roles.find((r) => r.key === 'member')!.id;
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 'ai.member@example.com', roleId: memberRole })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'Member' })
        .expect(200)
    ).body.token;
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  describe('providers', () => {
    it('lets only ai.manage add providers', async () => {
      await http
        .post('/api/v1/ai/providers')
        .set(as(memberToken))
        .send({ name: 'x', kind: 'openai', secretRef, defaultModel: 'm' })
        .expect(403);
    });

    it('validates key, base URL and name', async () => {
      const noKey = await http.post('/api/v1/ai/providers').set(as(token)).send({ name: 'x', kind: 'openai', defaultModel: 'm' }).expect(400);
      expect(noKey.body.error.code).toBe('AI_SECRET_REQUIRED');
      const badRef = await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'x', kind: 'openai', defaultModel: 'm', secretRef: 'secret://00000000-0000-0000-0000-000000000000' })
        .expect(400);
      expect(badRef.body.error.code).toBe('SECRET_NOT_FOUND');
      const noUrl = await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'x', kind: 'openai_compatible', defaultModel: 'm', secretRef })
        .expect(400);
      expect(noUrl.body.error.code).toBe('AI_BASE_URL_REQUIRED');
      // A key pasted into the model box is refused, so it is never stored in plain text.
      const keyAsModel = await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'x', kind: 'openai', defaultModel: 'sk-proj-abcdefghijklmnop', secretRef })
        .expect(400);
      expect(keyAsModel.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(keyAsModel.body)).not.toContain('abcdefghijklmnop');
    });

    it('creates providers in failover order and never returns the key', async () => {
      ids.a = await addProvider('alpha', 'openai', 'a/v1', { inputCostPerMtok: 2, outputCostPerMtok: 8 });
      ids.b = await addProvider('beta', 'anthropic', 'b');
      ids.c = await addProvider('gamma', 'gemini', 'c');
      await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'ALPHA', kind: 'openai', baseUrl: `${fake.baseUrl}/a/v1`, secretRef, defaultModel: 'm' })
        .expect(409);

      const list = await http.get('/api/v1/ai/providers').set(as(memberToken)).expect(200);
      expect(list.body.map((p: { name: string }) => p.name)).toEqual(['alpha', 'beta', 'gamma']);
      expect(list.body[0]).toMatchObject({ kind: 'openai', secretRef, health: 'ok', inputCostPerMtok: 2 });
      expect(JSON.stringify(list.body)).not.toContain(FAKE_KEY);
    });

    it('lists models and tests a provider through its own API', async () => {
      const models = await http.get(`/api/v1/ai/providers/${ids.a}/models`).set(as(token)).expect(200);
      expect(models.body).toEqual(['fake-large', 'fake-mini']);
      const test = await http.post(`/api/v1/ai/providers/${ids.b}/test`).set(as(token)).expect(200);
      expect(test.body).toMatchObject({ ok: true, model: 'beta-model' });
    });

    it('requires the full provider list to reorder', async () => {
      const bad = await http.put('/api/v1/ai/providers/order').set(as(token)).send({ order: [ids.b] }).expect(400);
      expect(bad.body.error.code).toBe('AI_ORDER_MISMATCH');
    });
  });

  describe('chat', () => {
    let convId: string;

    it('streams a reply from the primary provider and stores it with tokens and cost', async () => {
      convId = await newConversation();
      const events = await send(convId, 'Chào MARIS, hôm nay làm gì?');
      expect(events[0]).toMatchObject({ type: 'start' });
      expect(events.filter((e) => e.type === 'provider')).toEqual([
        { type: 'provider', providerId: ids.a, name: 'alpha', model: 'alpha-model' },
      ]);
      expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Xin chào');
      const done = events.at(-1);
      expect(done.type).toBe('done');
      // 1000 in × $2 + 500 out × $8 per million tokens
      expect(done.message).toMatchObject({ content: 'Xin chào', status: 'complete', inputTokens: 1000, outputTokens: 500, costUsd: 0.006 });

      const req = fake.requests.filter((r) => r.path === '/a/v1/chat/completions').at(-1)!;
      expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(req.body.model).toBe('alpha-model');
      expect(req.body.messages[0].role).toBe('system');
      expect(req.body.messages.at(-1)).toEqual({ role: 'user', content: 'Chào MARIS, hôm nay làm gì?' });

      const conv = await http.get(`/api/v1/ai/conversations/${convId}`).set(as(token)).expect(200);
      expect(conv.body.title).toBe('Chào MARIS, hôm nay làm gì?');
      expect(conv.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    });

    it('sends earlier turns as context', async () => {
      await send(convId, 'Tiếp tục');
      const req = fake.requests.filter((r) => r.path === '/a/v1/chat/completions').at(-1)!;
      expect(req.body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    });

    it('uses a chosen provider and model, here Gemini', async () => {
      const events = await send(convId, 'Dùng Gemini', { providerId: ids.c, model: 'gemini-pro-x' });
      expect(events.find((e) => e.type === 'provider')).toMatchObject({ providerId: ids.c, model: 'gemini-pro-x' });
      expect(events.at(-1).message).toMatchObject({ content: 'Gemini xin chào', inputTokens: 30, outputTokens: 5 });
      const req = fake.requests.filter((r) => r.path.startsWith('/c/')).at(-1)!;
      expect(req.path).toBe('/c/v1beta/models/gemini-pro-x:streamGenerateContent?alt=sse');
      expect(req.headers['x-goog-api-key']).toBe(FAKE_KEY);
      expect(req.body.systemInstruction.parts[0].text).toContain('MARIS');
      // The choice sticks to the conversation.
      const conv = await http.get(`/api/v1/ai/conversations/${convId}`).set(as(token)).expect(200);
      expect(conv.body).toMatchObject({ providerId: ids.c, model: 'gemini-pro-x' });
    });

    it('fails over to the next provider when the primary errors, after retrying', async () => {
      fake.modes.a = '500';
      const before = fake.count('/a/');
      const conv = await newConversation();
      const events = await send(conv, 'Thử dự phòng');
      expect(fake.count('/a/') - before).toBe(2); // two attempts on alpha
      expect(events.filter((e) => e.type === 'provider').map((e) => e.providerId)).toEqual([ids.a, ids.b]);
      expect(events.find((e) => e.type === 'failover')).toMatchObject({ fromProviderId: ids.a, errorCode: 'UPSTREAM' });
      expect(events.at(-1).message).toMatchObject({ content: 'Claude trả lời', providerId: ids.b, inputTokens: 21, outputTokens: 4 });
      const req = fake.requests.filter((r) => r.path === '/b/v1/messages').at(-1)!;
      expect(req.headers['x-api-key']).toBe(FAKE_KEY);
      expect(req.body.messages[0].role).toBe('user');
    });

    it('opens the circuit after repeated failures and skips that provider', async () => {
      const conv = await newConversation();
      await send(conv, 'Lần lỗi thứ ba'); // third failure on alpha (two in the previous test)
      const list = await http.get('/api/v1/ai/providers').set(as(token)).expect(200);
      expect(list.body.find((p: { id: string }) => p.id === ids.a).health).toBe('open');

      const before = fake.count('/a/');
      const events = await send(conv, 'Bỏ qua alpha');
      expect(fake.count('/a/')).toBe(before);
      expect(events.filter((e) => e.type === 'provider').map((e) => e.providerId)).toEqual([ids.b]);
      expect(events.at(-1).type).toBe('done');
    });

    it('does not fail over on a bad request', async () => {
      fake.modes.b = '400';
      const conv = await newConversation({ providerId: ids.b });
      const events = await send(conv, 'Yêu cầu lỗi');
      expect(events.filter((e) => e.type === 'provider')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
      fake.modes.b = 'ok';
    });

    it('keeps partial text and does not fail over once text has streamed', async () => {
      fake.modes.c = 'ok';
      fake.modes.d = 'midfail';
      ids.d = await addProvider('delta', 'openai_compatible', 'd/v1');
      const conv = await newConversation({ providerId: ids.d });
      const events = await send(conv, 'Đứt giữa chừng');
      expect(events.filter((e) => e.type === 'provider')).toHaveLength(1);
      expect(events.at(-1).type).toBe('error');
      const detail = await http.get(`/api/v1/ai/conversations/${conv}`).set(as(token)).expect(200);
      expect(detail.body.messages[1]).toMatchObject({ role: 'assistant', status: 'error', content: 'Xin' });
    });

    it('times out a silent provider and moves on', async () => {
      fake.modes.e = 'slow';
      ids.e = await addProvider('epsilon', 'openai_compatible', 'e/v1', { timeoutMs: 1000 });
      const conv = await newConversation({ providerId: ids.e });
      const events = await send(conv, 'Chờ lâu');
      expect(events.find((e) => e.type === 'failover')).toMatchObject({ fromProviderId: ids.e, errorCode: 'TIMEOUT' });
      expect(events.at(-1).type).toBe('done');
    }, 15_000);

    it('reports an error when no provider is enabled', async () => {
      const list = (await http.get('/api/v1/ai/providers').set(as(token))).body as { id: string }[];
      for (const p of list) await http.patch(`/api/v1/ai/providers/${p.id}`).set(as(token)).send({ enabled: false }).expect(200);
      const conv = await newConversation();
      const events = await send(conv, 'Không có AI');
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'NO_PROVIDER' });
      for (const p of list) await http.patch(`/api/v1/ai/providers/${p.id}`).set(as(token)).send({ enabled: true }).expect(200);
    });

    it('reorders providers so a different AI becomes primary', async () => {
      fake.modes.a = 'ok';
      fake.modes.e = 'ok';
      const order = [ids.b, ids.a, ids.c, ids.d, ids.e];
      const res = await http.put('/api/v1/ai/providers/order').set(as(token)).send({ order }).expect(200);
      expect(res.body.map((p: { id: string }) => p.id)).toEqual(order);
      const conv = await newConversation();
      const events = await send(conv, 'Ai là AI chính?');
      expect(events.find((e) => e.type === 'provider').providerId).toBe(ids.b);
    });

    it('keeps conversations private to their author', async () => {
      await http.get(`/api/v1/ai/conversations/${convId}`).set(as(memberToken)).expect(404);
      const mine = await http.get('/api/v1/ai/conversations').set(as(memberToken)).expect(200);
      expect(mine.body).toEqual([]);
      await http.post(`/api/v1/ai/conversations/${convId}/messages`).set(as(memberToken)).send({ content: 'x' }).expect(404);
    });

    it('reports usage per provider to ai.manage only', async () => {
      await http.get('/api/v1/ai/usage').set(as(memberToken)).expect(403);
      const usage = await http.get('/api/v1/ai/usage?days=1').set(as(token)).expect(200);
      const alpha = usage.body.rows.find((r: { providerId: string }) => r.providerId === ids.a);
      expect(alpha.inputTokens).toBe(2000);
      expect(alpha.failures).toBeGreaterThanOrEqual(3);
      expect(usage.body.totalCostUsd).toBeCloseTo(0.012, 6);
    });

    it('keeps message text out of the audit log', async () => {
      const sql = admin();
      const rows = await sql`SELECT action, metadata::text AS m FROM security.audit_logs WHERE action LIKE 'ai.%'`;
      await sql.end();
      expect(rows.some((r) => r.action === 'ai.message.sent')).toBe(true);
      expect(rows.map((r) => r.m).join(' ')).not.toContain('Chào MARIS');
    });
  });
});
