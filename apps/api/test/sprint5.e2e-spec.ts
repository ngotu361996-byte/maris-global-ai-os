import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';
import { FakeAi, parseSse } from './fake-ai';

const OWNER = { email: 'owner5@example.com', password: 'mat-khau-rat-dai-123', displayName: 'Owner', tenantName: 'Công ty Task' };
const TASK = {
  title: 'Kế hoạch nội dung tuần',
  goal: 'Lên lịch 5 bài đăng Facebook cho cửa hàng câu cá',
  scope: 'Chỉ soạn nội dung, không đăng',
  successCriteria: 'Có 5 bài, mỗi bài có tiêu đề và lời kêu gọi',
  budgetUsd: 1,
};

describe('Sprint 5 (e2e): Structured Task, Emergency Stop, Cost Governor', () => {
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

  async function waitFor(id: string, statuses: string[], ms = 8000) {
    const until = Date.now() + ms;
    for (;;) {
      const t = (await http.get(`/api/v1/ai/tasks/${id}`).set(as(token)).expect(200)).body;
      if (statuses.includes(t.status)) return t;
      if (Date.now() > until) throw new Error(`task ${id} stuck in ${t.status}`);
      await sleep(100);
    }
  }

  async function send(t: string, conversationId: string, content: string) {
    const res = await http
      .post(`/api/v1/ai/conversations/${conversationId}/messages`)
      .set(as(t))
      .send({ content })
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => cb(null, text));
      });
    return { status: res.status, events: res.status === 200 ? parseSse(res.body as string) : [], body: res.body };
  }

  const newConversation = async (t = token) => (await http.post('/api/v1/ai/conversations').set(as(t)).send({}).expect(201)).body.id as string;
  const newTask = async (t = token, extra = {}) => (await http.post('/api/v1/ai/tasks').set(as(t)).send({ ...TASK, ...extra }).expect(201)).body;

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.memberships[0].tenantId;
    const secretRef = (await http.post('/api/v1/secrets').set(as(token)).send({ name: 'fake.api_key', value: 'sk-fake-key-5' }).expect(201)).body
      .reference;
    const add = async (name: string, path: string, timeoutMs = 60_000) =>
      (
        await http
          .post('/api/v1/ai/providers')
          .set(as(token))
          .send({ name, kind: 'openai', baseUrl: `${fake.baseUrl}/${path}`, secretRef, defaultModel: `${name}-model`, inputCostPerMtok: 10, outputCostPerMtok: 30, timeoutMs })
          .expect(201)
      ).body.id as string;
    providerA = await add('A', 'a');
    providerB = await add('B', 'b');

    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as { id: string; key: string }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 's5.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
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

  beforeEach(() => {
    fake.modes.a = 'ok';
    fake.modes.b = 'ok';
  });

  describe('structured tasks', () => {
    it('runs nothing until approved, then completes and records cost', async () => {
      const task = await newTask(memberToken);
      expect(task).toMatchObject({ status: 'pending', permissions: ['ai.generate_text'], budgetUsd: 1 });
      await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(memberToken)).send({}).expect(403);
      const before = fake.count('/a');
      await sleep(300);
      expect(fake.count('/a')).toBe(before); // pending tasks never call an AI

      const approved = await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(token)).send({ note: 'OK' }).expect(200);
      expect(approved.body.status).toBe('queued');
      const done = await waitFor(task.id, ['completed', 'failed']);
      expect(done).toMatchObject({ status: 'completed', result: 'Xin chào', attempts: 1 });
      expect(done.costUsd).toBeCloseTo(0.025, 6);

      const prompt = fake.requests.filter((r) => r.body?.messages).at(-1)!.body.messages[1].content as string;
      expect(prompt).toContain('Mục tiêu: Lên lịch 5 bài đăng Facebook');
      expect(prompt).toContain('chỉ được soạn nội dung văn bản');

      const sql = admin();
      const calls = await sql`SELECT count(*)::int AS n FROM ai.provider_calls WHERE task_id = ${task.id}`;
      const audit = await sql`SELECT action FROM security.audit_logs WHERE target_id = ${task.id} ORDER BY seq`;
      await sql.end();
      expect(calls[0]!.n).toBe(1);
      expect(audit.map((r) => r.action)).toEqual(['ai.task.created', 'ai.task.approved', 'ai.task.run_finished']);

      await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(token)).send({}).expect(400);
    });

    it('rejects a task, and refuses an over-limit budget', async () => {
      const task = await newTask();
      const r = await http.post(`/api/v1/ai/tasks/${task.id}/reject`).set(as(token)).send({ note: 'Chưa cần' }).expect(200);
      expect(r.body).toMatchObject({ status: 'rejected', decisionNote: 'Chưa cần' });
      await http.post('/api/v1/ai/tasks').set(as(token)).send({ ...TASK, budgetUsd: 5000 }).expect(400);
      await http.post('/api/v1/ai/tasks').set(as(token)).send({ ...TASK, budgetUsd: 0 }).expect(400);
    });

    it('pauses a running task, resumes it, and lets only the creator or an approver cancel', async () => {
      fake.modes.a = 'slow';
      fake.modes.b = 'slow';
      const task = await newTask();
      await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(token)).send({}).expect(200);
      await waitFor(task.id, ['running']);
      await http.post(`/api/v1/ai/tasks/${task.id}/pause`).set(as(memberToken)).send({}).expect(403);
      await http.post(`/api/v1/ai/tasks/${task.id}/pause`).set(as(token)).send({}).expect(200);
      const paused = await waitFor(task.id, ['paused']);
      expect(paused.result).toBeNull();
      await sleep(800); // the run notices the flag and exits without overwriting "paused"
      expect((await http.get(`/api/v1/ai/tasks/${task.id}`).set(as(token))).body.status).toBe('paused');

      fake.modes.a = 'ok';
      fake.modes.b = 'ok';
      await http.post(`/api/v1/ai/tasks/${task.id}/resume`).set(as(memberToken)).send({}).expect(403);
      await http.post(`/api/v1/ai/tasks/${task.id}/resume`).set(as(token)).send({}).expect(200);
      const done = await waitFor(task.id, ['completed']);
      expect(done.attempts).toBe(2);

      const other = await newTask();
      await http.post(`/api/v1/ai/tasks/${other.id}/cancel`).set(as(memberToken)).send({}).expect(403);
      const mine = await newTask(memberToken);
      const c = await http.post(`/api/v1/ai/tasks/${mine.id}/cancel`).set(as(memberToken)).send({}).expect(200);
      expect(c.body.status).toBe('cancelled');
    });
  });

  describe('emergency stop', () => {
    it('stops chat and tasks for the whole tenant until an approver turns AI back on', async () => {
      fake.modes.a = 'slow';
      fake.modes.b = 'slow';
      const task = await newTask();
      await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(token)).send({}).expect(200);
      await waitFor(task.id, ['running']);
      const pendingTask = await newTask();

      // A reply already streaming is aborted too.
      const conv = await newConversation();
      const streaming = send(token, conv, 'viết dài');
      await sleep(300);
      const stop = await http.post('/api/v1/ai/emergency-stop').set(as(memberToken)).send({ reason: 'Thử nghiệm' }).expect(200);
      expect(stop.body).toMatchObject({ emergencyStop: true, reason: 'Thử nghiệm' });
      const aborted = await streaming;
      expect(aborted.events.at(-1)).toMatchObject({ type: 'error', code: 'EMERGENCY_STOP' });
      expect((await waitFor(task.id, ['paused'])).progress).toContain('Dừng khẩn cấp');

      const refused = await send(token, conv, 'còn đó không');
      expect(refused.status).toBe(423);
      await http.post(`/api/v1/ai/tasks/${pendingTask.id}/approve`).set(as(token)).send({}).expect(423);
      const activity = await http.get('/api/v1/ai/activity').set(as(memberToken)).expect(200);
      expect(activity.body.control.emergencyStop).toBe(true);

      await http.delete('/api/v1/ai/emergency-stop').set(as(memberToken)).expect(403);
      await http.delete('/api/v1/ai/emergency-stop').set(as(token)).expect(200);
      fake.modes.a = 'ok';
      fake.modes.b = 'ok';
      const ok = await send(token, conv, 'chào lại');
      expect(ok.events.at(-1).type).toBe('done');
      // Paused tasks stay paused until someone resumes them.
      expect((await http.get(`/api/v1/ai/tasks/${task.id}`).set(as(token))).body.status).toBe('paused');

      const sql = admin();
      const audit = await sql`SELECT action FROM security.audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'ai.emergency_stop.%' ORDER BY seq`;
      await sql.end();
      expect(audit.map((r) => r.action)).toEqual(['ai.emergency_stop.activated', 'ai.emergency_stop.released']);
    });
  });

  describe('cost governor', () => {
    beforeAll(async () => {
      // Start the budget tests from a clean month.
      const sql = admin();
      await sql`DELETE FROM ai.provider_calls WHERE tenant_id = ${tenantId}`;
      await sql.end();
    });

    it('lets only ai.manage set budgets', async () => {
      await http.put('/api/v1/ai/budgets').set(as(memberToken)).send({ providerId: null, monthlyUsd: 1 }).expect(403);
    });

    it('skips a provider over its budget and fails over to the next', async () => {
      const b = await http.put('/api/v1/ai/budgets').set(as(token)).send({ providerId: providerA, monthlyUsd: 0.01 }).expect(200);
      const conv = await newConversation();
      const first = await send(token, conv, 'một');
      expect(first.events.find((e) => e.type === 'provider')).toMatchObject({ providerId: providerA });
      const second = await send(token, conv, 'hai');
      expect(second.events.find((e) => e.type === 'provider')).toMatchObject({ providerId: providerB });
      await http.delete(`/api/v1/ai/budgets/${b.body.id}`).set(as(token)).expect(204);
    });

    it('warns once at 80% and stops all AI at 100% of the tenant budget', async () => {
      const sql = admin();
      await sql`DELETE FROM ai.provider_calls WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM work.outbox_events WHERE tenant_id = ${tenantId}`;
      await http.put('/api/v1/ai/budgets').set(as(token)).send({ providerId: null, monthlyUsd: 0.03 }).expect(200);
      const conv = await newConversation();

      await send(token, conv, 'một'); // 0.025 of 0.03 = 83%
      let budgets = (await http.get('/api/v1/ai/budgets').set(as(token)).expect(200)).body;
      expect(budgets[0]).toMatchObject({ providerId: null, state: 'warning', spentUsd: 0.025 });
      await send(token, conv, 'hai'); // 0.05: over
      budgets = (await http.get('/api/v1/ai/budgets').set(as(token)).expect(200)).body;
      expect(budgets[0].state).toBe('exceeded');

      const alerts = await sql`SELECT count(*)::int AS n FROM work.outbox_events WHERE tenant_id = ${tenantId} AND type = 'ai.budget.threshold_reached'`;
      await sql.end();
      expect(alerts[0]!.n).toBe(1);

      const refused = await send(token, conv, 'ba');
      expect(refused.status).toBe(402);
      expect(JSON.parse(refused.body as string).error.code).toBe('BUDGET_EXCEEDED');

      const task = await newTask();
      await http.post(`/api/v1/ai/tasks/${task.id}/approve`).set(as(token)).send({}).expect(200);
      const failed = await waitFor(task.id, ['failed']);
      expect(failed.errorCode).toBe('BUDGET_EXCEEDED');

      const activity = await http.get('/api/v1/ai/activity').set(as(token)).expect(200);
      expect(activity.body.budgetWarnings).toBe(1);
    });
  });
});
