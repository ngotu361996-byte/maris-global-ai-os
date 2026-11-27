import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';
import { FakeAi, parseSse } from './fake-ai';

const OWNER = {
  email: 'owner6@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Hội đồng',
};

describe('Sprint 6 (e2e): Model Registry and AI Council', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let providerA: string;
  let providerB: string;
  const fake = new FakeAi();

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function send(conversationId: string, content: string) {
    const res = await http
      .post(`/api/v1/ai/conversations/${conversationId}/messages`)
      .set(as(token))
      .send({ content })
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => cb(null, text));
      });
    return parseSse(res.body as string);
  }

  async function waitCouncil(id: string, statuses: string[], ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      const c = (await http.get(`/api/v1/ai/councils/${id}`).set(as(token)).expect(200)).body;
      if (statuses.includes(c.status)) return c;
      if (Date.now() > until) throw new Error(`council ${id} stuck in ${c.status} (${c.stage})`);
      await sleep(100);
    }
  }

  const lastModel = (prefix: string) =>
    fake.requests.filter((r) => r.path.startsWith(prefix) && r.body?.messages).at(-1)!.body
      .model as string;
  const newCouncil = async (extra: Record<string, unknown> = {}, t = token) =>
    (
      await http
        .post('/api/v1/ai/councils')
        .set(as(t))
        .send({
          question: 'Nên bán cần câu qua TikTok Shop hay Shopee trước?',
          members: [{ providerId: providerA }, { providerId: providerB }],
          maxCostUsd: 1,
          ...extra,
        })
        .expect(201)
    ).body;

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const secretRef = (
      await http
        .post('/api/v1/secrets')
        .set(as(token))
        .send({ name: 'fake.api_key', value: 'sk-fake-key-6' })
        .expect(201)
    ).body.reference;
    const add = async (name: string, path: string) =>
      (
        await http
          .post('/api/v1/ai/providers')
          .set(as(token))
          .send({
            name,
            kind: 'openai',
            baseUrl: `${fake.baseUrl}/${path}`,
            secretRef,
            defaultModel: `${name}-model`,
            inputCostPerMtok: 10,
            outputCostPerMtok: 30,
          })
          .expect(201)
      ).body.id as string;
    providerA = await add('A', 'a');
    providerB = await add('B', 'b');

    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 's6.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
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

  beforeEach(async () => {
    fake.modes.a = 'ok';
    fake.modes.b = 'ok';
    // Failures in one test must not leave a circuit open for the next.
    const redis = new Redis(REDIS_URL);
    const keys = await redis.keys('ai:cb:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  describe('model registry', () => {
    let coder: string;

    it('lets only ai.manage register models, and rejects duplicates and keys', async () => {
      const body = {
        providerId: providerA,
        model: 'A-coder',
        capabilities: ['coding', 'coding', 'fast'],
        inputCostPerMtok: 1,
        outputCostPerMtok: 2,
      };
      await http.post('/api/v1/ai/models').set(as(memberToken)).send(body).expect(403);
      const created = await http.post('/api/v1/ai/models').set(as(token)).send(body).expect(201);
      expect(created.body).toMatchObject({
        model: 'A-coder',
        capabilities: ['coding', 'fast'],
        inputCostPerMtok: 1,
        enabled: true,
      });
      coder = created.body.id;
      await http.post('/api/v1/ai/models').set(as(token)).send(body).expect(409);
      await http
        .post('/api/v1/ai/models')
        .set(as(token))
        .send({ ...body, model: 'sk-proj-abcdefghijklmnop' })
        .expect(400);
      await http
        .post('/api/v1/ai/models')
        .set(as(token))
        .send({ ...body, model: 'A-x', capabilities: ['magic'] })
        .expect(400);
      const list = await http.get('/api/v1/ai/models').set(as(memberToken)).expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('picks the model the chat mode prefers and bills it at the model price', async () => {
      const coding = (
        await http
          .post('/api/v1/ai/conversations')
          .set(as(token))
          .send({ mode: 'coding' })
          .expect(201)
      ).body.id;
      const events = await send(coding, 'viết hàm cộng');
      expect(events.find((e) => e.type === 'provider')).toMatchObject({
        providerId: providerA,
        model: 'A-coder',
      });
      expect(lastModel('/a')).toBe('A-coder');
      // 1000 tokens in at $1 and 500 out at $2 per million.
      expect(events.at(-1).message.costUsd).toBeCloseTo(0.002, 6);

      const chat = (
        await http
          .post('/api/v1/ai/conversations')
          .set(as(token))
          .send({ mode: 'chat' })
          .expect(201)
      ).body.id;
      const plain = await send(chat, 'chào');
      expect(plain.find((e) => e.type === 'provider')).toMatchObject({ model: 'A-model' });
      expect(plain.at(-1).message.costUsd).toBeCloseTo(0.025, 6);

      // A model the user chose is never swapped.
      const pinned = (
        await http
          .post('/api/v1/ai/conversations')
          .set(as(token))
          .send({ mode: 'coding', providerId: providerA, model: 'A-model' })
          .expect(201)
      ).body.id;
      expect((await send(pinned, 'x')).find((e) => e.type === 'provider')).toMatchObject({
        model: 'A-model',
      });
    });

    it('never uses a disabled model', async () => {
      await http
        .patch(`/api/v1/ai/models/${coder}`)
        .set(as(token))
        .send({ enabled: false })
        .expect(200);
      const off = await http
        .post('/api/v1/ai/models')
        .set(as(token))
        .send({ providerId: providerA, model: 'A-model', capabilities: [], enabled: false })
        .expect(201);
      const chat = (
        await http
          .post('/api/v1/ai/conversations')
          .set(as(token))
          .send({ mode: 'coding' })
          .expect(201)
      ).body.id;
      const events = await send(chat, 'x');
      expect(events.find((e) => e.type === 'provider')).toMatchObject({
        providerId: providerB,
        model: 'B-model',
      });

      await http.delete(`/api/v1/ai/models/${off.body.id}`).set(as(token)).expect(204);
      await http.delete(`/api/v1/ai/models/${coder}`).set(as(token)).expect(204);
      const sql = admin();
      const audit =
        await sql`SELECT action FROM security.audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'ai.model.%' ORDER BY seq`;
      await sql.end();
      expect(audit.map((r) => r.action)).toEqual([
        'ai.model.created',
        'ai.model.updated',
        'ai.model.created',
        'ai.model.removed',
        'ai.model.removed',
      ]);
    });
  });

  describe('AI council', () => {
    it('answers independently, critiques, synthesises, and records every call', async () => {
      const before = fake.requests.length;
      const created = await newCouncil({}, memberToken);
      expect(created).toMatchObject({
        status: 'queued',
        critique: true,
        members: [{ model: 'A-model' }, { model: 'B-model' }],
      });
      const done = await waitCouncil(created.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');
      expect(done.synthesis).toBe('Xin chào');
      expect(done.turns.map((t: { stage: string }) => t.stage).sort()).toEqual([
        'answer',
        'answer',
        'critique',
        'critique',
        'synthesis',
      ]);
      expect(done.costUsd).toBeCloseTo(0.125, 6);

      const prompts = fake.requests
        .slice(before)
        .filter((r) => r.body?.messages)
        .map((r) => r.body.messages.at(-1).content as string);
      const answers = prompts.filter((p) =>
        p.startsWith('Hãy trả lời câu hỏi sau một cách độc lập'),
      );
      expect(answers).toHaveLength(2);
      expect(answers.every((p) => !p.includes('<answer>'))).toBe(true); // no member sees another's answer first
      const critiques = prompts.filter((p) => p.includes('Hãy phản biện'));
      expect(critiques).toHaveLength(2);
      expect(critiques[0]).toContain('<answer>');
      const synthesis = prompts.find((p) => p.startsWith('Bạn viết bản tổng hợp'))!;
      expect(synthesis).toContain('không phải bằng chứng');

      const sql = admin();
      const calls =
        await sql`SELECT count(*)::int AS n FROM ai.provider_calls WHERE council_id = ${created.id}`;
      const audit =
        await sql`SELECT action FROM security.audit_logs WHERE target_id = ${created.id} ORDER BY seq`;
      await sql.end();
      expect(calls[0]!.n).toBe(5);
      expect(audit.map((r) => r.action)).toEqual(['ai.council.created', 'ai.council.run_finished']);
    });

    it('validates members and the cost cap', async () => {
      const q = { question: 'x', maxCostUsd: 1 };
      await http
        .post('/api/v1/ai/councils')
        .set(as(token))
        .send({ ...q, members: [{ providerId: providerA }] })
        .expect(400);
      const five = Array.from({ length: 5 }, () => ({ providerId: providerA }));
      await http
        .post('/api/v1/ai/councils')
        .set(as(token))
        .send({ ...q, members: five })
        .expect(400);
      await http
        .post('/api/v1/ai/councils')
        .set(as(token))
        .send({
          ...q,
          maxCostUsd: 100,
          members: [{ providerId: providerA }, { providerId: providerB }],
        })
        .expect(400);
      const missing = '00000000-0000-7000-8000-000000000000';
      await http
        .post('/api/v1/ai/councils')
        .set(as(token))
        .send({ ...q, members: [{ providerId: providerA }, { providerId: missing }] })
        .expect(404);
    });

    it('stops at the cost cap between stages', async () => {
      const c = await newCouncil({ maxCostUsd: 0.03 });
      const done = await waitCouncil(c.id, ['completed', 'failed']);
      expect(done).toMatchObject({
        status: 'failed',
        errorCode: 'COUNCIL_BUDGET_EXCEEDED',
        synthesis: null,
      });
      expect(done.turns.map((t: { stage: string }) => t.stage)).toEqual(['answer', 'answer']);
    });

    it('goes on without a member that fails, and skips critique with one answer', async () => {
      fake.modes.a = '500';
      const c = await newCouncil();
      const done = await waitCouncil(c.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');
      const byStage = (s: string) => done.turns.filter((t: { stage: string }) => t.stage === s);
      expect(
        byStage('answer')
          .map((t: { status: string }) => t.status)
          .sort(),
      ).toEqual(['complete', 'error']);
      expect(byStage('critique')).toHaveLength(0);
      expect(byStage('synthesis')[0]).toMatchObject({
        memberIndex: 1,
        providerId: providerB,
        status: 'complete',
      });
    });

    it('can be cancelled by its creator or an approver, and stops for Emergency Stop', async () => {
      fake.modes.a = 'slow';
      fake.modes.b = 'slow';
      const c = await newCouncil();
      await waitCouncil(c.id, ['running']);
      await http
        .post(`/api/v1/ai/councils/${c.id}/cancel`)
        .set(as(memberToken))
        .send({})
        .expect(403);
      await http.post(`/api/v1/ai/councils/${c.id}/cancel`).set(as(token)).send({}).expect(200);
      await sleep(800); // the run notices and exits without overwriting "cancelled"
      const cancelled = (await http.get(`/api/v1/ai/councils/${c.id}`).set(as(token))).body;
      expect(cancelled.status).toBe('cancelled');
      await http.post(`/api/v1/ai/councils/${c.id}/cancel`).set(as(token)).send({}).expect(400);

      const d = await newCouncil({}, memberToken);
      await waitCouncil(d.id, ['running']);
      await http.post('/api/v1/ai/emergency-stop').set(as(memberToken)).send({}).expect(200);
      const stopped = await waitCouncil(d.id, ['cancelled', 'failed', 'completed']);
      expect(stopped).toMatchObject({ status: 'cancelled', errorCode: 'EMERGENCY_STOP' });
      await http
        .post('/api/v1/ai/councils')
        .set(as(token))
        .send({
          question: 'x',
          maxCostUsd: 1,
          members: [{ providerId: providerA }, { providerId: providerB }],
        })
        .expect(423);
      await http.delete('/api/v1/ai/emergency-stop').set(as(token)).expect(200);
    });
  });
});
