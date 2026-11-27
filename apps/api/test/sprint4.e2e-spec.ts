import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { AGENT_TEMPLATES } from '@maris/contracts';
import { admin, APP_URL, resetDatabase, startApp } from './helpers';
import { FakeAi, parseSse } from './fake-ai';

const OWNER = { email: 'owner4@example.com', password: 'mat-khau-rat-dai-123', displayName: 'Owner', tenantName: 'Công ty Agent' };

describe('Sprint 4 (e2e): AI Agents, chat modes, project memory', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let managerToken: string;
  let providerA: string;
  let providerB: string;
  const fake = new FakeAi();

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });

  async function invite(email: string, roleKey: string): Promise<string> {
    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as { id: string; key: string }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email, roleId: roles.find((r) => r.key === roleKey)!.id })
      .expect(201);
    return (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: roleKey })
        .expect(200)
    ).body.token;
  }

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
      })
      .expect(200);
    return parseSse(res.body as string);
  }

  const lastSystemPrompt = () => {
    const body = fake.requests.filter((r) => r.body?.messages).at(-1)!.body;
    return body.messages[0].content as string;
  };

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.memberships[0].tenantId;
    const secretRef = (await http.post('/api/v1/secrets').set(as(token)).send({ name: 'fake.api_key', value: 'sk-fake-key-4' }).expect(201))
      .body.reference;
    providerA = (
      await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'A', kind: 'openai', baseUrl: `${fake.baseUrl}/a`, secretRef, defaultModel: 'a-model' })
        .expect(201)
    ).body.id;
    providerB = (
      await http
        .post('/api/v1/ai/providers')
        .set(as(token))
        .send({ name: 'B', kind: 'openai', baseUrl: `${fake.baseUrl}/b`, secretRef, defaultModel: 'b-model' })
        .expect(201)
    ).body.id;
    memberToken = await invite('s4.member@example.com', 'member');
    managerToken = await invite('s4.manager@example.com', 'manager');
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  describe('agents', () => {
    it('installs the starter agents once, and only for ai.manage', async () => {
      await http.post('/api/v1/ai/agents/templates').set(as(memberToken)).send({}).expect(403);
      const first = await http.post('/api/v1/ai/agents/templates').set(as(token)).send({}).expect(201);
      expect(first.body).toHaveLength(AGENT_TEMPLATES.length);
      const again = await http.post('/api/v1/ai/agents/templates').set(as(token)).send({}).expect(201);
      expect(again.body).toHaveLength(0);
      await http.post('/api/v1/ai/agents/templates').set(as(token)).send({ keys: ['khong-co'] }).expect(400);
      const list = await http.get('/api/v1/ai/agents').set(as(memberToken)).expect(200);
      expect(list.body.map((a: { key: string }) => a.key)).toContain('marketing');
    });

    it('creates an agent, versions every change, and refuses duplicates and bad input', async () => {
      const body = { key: 'ban-hang-vip', name: 'AI Bán hàng VIP', role: 'Tư vấn khách VIP', systemPrompt: 'Luôn xưng hô "anh/chị".' };
      await http.post('/api/v1/ai/agents').set(as(memberToken)).send(body).expect(403);
      const created = await http.post('/api/v1/ai/agents').set(as(token)).send(body).expect(201);
      expect(created.body).toMatchObject({ key: 'ban-hang-vip', version: 1, status: 'active' });
      await http.post('/api/v1/ai/agents').set(as(token)).send(body).expect(409);
      await http.post('/api/v1/ai/agents').set(as(token)).send({ ...body, key: 'Có Dấu' }).expect(400);
      await http
        .post('/api/v1/ai/agents')
        .set(as(token))
        .send({ ...body, key: 'x2', model: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' })
        .expect(400);

      const updated = await http
        .patch(`/api/v1/ai/agents/${created.body.id}`)
        .set(as(token))
        .send({ providerId: providerB, model: 'b-special', evalCriteria: 'Ngắn gọn' })
        .expect(200);
      expect(updated.body.version).toBe(2);
      const versions = await http.get(`/api/v1/ai/agents/${created.body.id}/versions`).set(as(token)).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(versions.body[1].config.providerId).toBeNull();

      const sql = admin();
      const audit = await sql`SELECT action FROM security.audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'ai.agent.%'`;
      await sql.end();
      expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['ai.agent.created', 'ai.agent.updated', 'ai.agent.templates_installed']));
    });
  });

  describe('projects and memory', () => {
    it('lets ai.memory holders manage memory, and everyone in the tenant read it', async () => {
      await http.post('/api/v1/ai/projects').set(as(memberToken)).send({ name: 'Cửa hàng câu cá' }).expect(403);
      const project = await http.post('/api/v1/ai/projects').set(as(managerToken)).send({ name: 'Cửa hàng câu cá' }).expect(201);
      await http.post('/api/v1/ai/projects').set(as(token)).send({ name: 'cửa hàng câu cá' }).expect(409);
      const mem = await http
        .post(`/api/v1/ai/projects/${project.body.id}/memories`)
        .set(as(managerToken))
        .send({ title: 'Khách hàng chính', content: 'Người câu cá giải trí 25-45 tuổi ở TP.HCM', pinned: true })
        .expect(201);
      await http.post(`/api/v1/ai/projects/${project.body.id}/memories`).set(as(memberToken)).send({ title: 't', content: 'c' }).expect(403);
      const list = await http.get(`/api/v1/ai/projects/${project.body.id}/memories`).set(as(memberToken)).expect(200);
      expect(list.body).toHaveLength(1);
      await http.patch(`/api/v1/ai/memories/${mem.body.id}`).set(as(managerToken)).send({ content: 'Người câu cá giải trí 25-50 tuổi' }).expect(200);
      const projects = await http.get('/api/v1/ai/projects').set(as(memberToken)).expect(200);
      expect(projects.body[0]).toMatchObject({ name: 'Cửa hàng câu cá', memoryCount: 1 });
    });
  });

  describe('chat with an agent, a mode and project memory', () => {
    it('puts the agent, the mode and the memory into the system prompt, and uses the agent provider', async () => {
      const agents = (await http.get('/api/v1/ai/agents').set(as(token)).expect(200)).body as { id: string; key: string }[];
      const vip = agents.find((a) => a.key === 'ban-hang-vip')!;
      const project = (await http.get('/api/v1/ai/projects').set(as(token)).expect(200)).body[0];
      const conv = await http
        .post('/api/v1/ai/conversations')
        .set(as(token))
        .send({ agentId: vip.id, projectId: project.id, mode: 'command' })
        .expect(201);
      expect(conv.body).toMatchObject({ agentId: vip.id, projectId: project.id, mode: 'command' });

      const events = await send(conv.body.id, 'Lên kế hoạch tuần này');
      expect(events.at(-1).type).toBe('done');
      expect(events.find((e) => e.type === 'provider')).toMatchObject({ providerId: providerB, model: 'b-special' });
      const system = lastSystemPrompt();
      expect(system).toContain('AI Bán hàng VIP');
      expect(system).toContain('Luôn xưng hô');
      expect(system).toContain('Tiêu chí đánh giá câu trả lời: Ngắn gọn');
      expect(system).toContain('Chế độ Điều hành');
      expect(system).toContain('25-50 tuổi');
      // MARIS's own rules come first, before anything the tenant configured.
      expect(system.indexOf('Bạn là MARIS')).toBe(0);
    });

    it('lets the conversation provider win over the agent provider', async () => {
      const agents = (await http.get('/api/v1/ai/agents').set(as(token)).expect(200)).body as { id: string; key: string }[];
      const vip = agents.find((a) => a.key === 'ban-hang-vip')!;
      const conv = await http.post('/api/v1/ai/conversations').set(as(token)).send({ agentId: vip.id, providerId: providerA }).expect(201);
      const events = await send(conv.body.id, 'chào');
      expect(events.find((e) => e.type === 'provider')).toMatchObject({ providerId: providerA, model: 'a-model' });
    });

    it('refuses a paused agent and an unknown project', async () => {
      const agents = (await http.get('/api/v1/ai/agents').set(as(token)).expect(200)).body as { id: string; key: string }[];
      const seo = agents.find((a) => a.key === 'seo')!;
      const conv = await http.post('/api/v1/ai/conversations').set(as(token)).send({ agentId: seo.id }).expect(201);
      await http.patch(`/api/v1/ai/agents/${seo.id}`).set(as(token)).send({ status: 'paused' }).expect(200);
      const res = await http.post(`/api/v1/ai/conversations/${conv.body.id}/messages`).set(as(token)).send({ content: 'x' }).expect(400);
      expect(res.body.error.code).toBe('AI_AGENT_PAUSED');
      await http
        .post('/api/v1/ai/conversations')
        .set(as(token))
        .send({ projectId: '00000000-0000-7000-8000-000000000000' })
        .expect(404);
      await http.post('/api/v1/ai/conversations').set(as(token)).send({ mode: 'council' }).expect(400);
    });

    it('keeps agents, versions, projects and memory inside the tenant (RLS)', async () => {
      const appSql = postgres(APP_URL, { max: 1, onnotice: () => {} });
      const count = (tenant: string) =>
        appSql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
          const [r] = await tx`SELECT (SELECT count(*) FROM ai.agents)::int AS a, (SELECT count(*) FROM ai.agent_versions)::int AS v,
                                      (SELECT count(*) FROM ai.projects)::int AS p, (SELECT count(*) FROM ai.memories)::int AS m`;
          return r!;
        });
      const mine = await count(tenantId);
      const other = await count('01900000-0000-7000-8000-0000000000c1');
      await appSql.end();
      expect(mine.a).toBeGreaterThan(0);
      expect(mine.m).toBe(1);
      expect(other).toEqual({ a: 0, v: 0, p: 0, m: 0 });
    });
  });
});
