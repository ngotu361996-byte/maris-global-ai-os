import type { INestApplication } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner11@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Connector',
};
const SECRET = 'khoa-bi-mat-cua-api-11';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Stands in for an external API. */
class FakeApi {
  seen: Seen[] = [];
  private server?: Server;
  baseUrl = '';

  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        const url = req.url ?? '';
        if (url.startsWith('/api/v1/me'))
          return json(200, { user: { name: 'bot-maris' }, echo: req.headers['x-api-key'] });
        if (url.startsWith('/api/v1/items/'))
          return json(201, { id: 7, got: body ? JSON.parse(body) : null });
        if (url.startsWith('/api/v1/fail')) return json(500, { error: 'hỏng' });
        if (url.startsWith('/api/v1/move')) {
          res.writeHead(302, { Location: 'http://169.254.169.254/' });
          return res.end();
        }
        if (url.startsWith('/api/v1/slow')) return setTimeout(() => json(200, { ok: true }), 1500);
        json(404, { error: 'không có' });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api/v1`;
  }

  stop() {
    return new Promise<void>((r) => this.server?.close(() => r()));
  }
}

describe('Sprint 11 (e2e): Connector Hub', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const fake = new FakeApi();

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const api = '/api/v1/connectors';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const shopConnector = () => ({
    key: 'cua-hang',
    kind: 'http',
    name: 'API cửa hàng',
    baseUrl: fake.baseUrl,
    auth: { type: 'header', header: 'X-Api-Key', secret: 'shop.api_key' },
    headers: { 'X-Shop': 'maris' },
    timeoutSec: 1,
    capabilities: [
      {
        key: 'thong_tin',
        label: 'Thông tin',
        risk: 'read',
        method: 'GET',
        path: '/me',
        outputPath: 'user.name',
      },
      { key: 'toan_bo', label: 'Toàn bộ', risk: 'read', method: 'GET', path: '/me' },
      {
        key: 'tao',
        label: 'Tạo',
        risk: 'write',
        method: 'POST',
        path: '/items/{{input.ma}}',
        query: { nguon: '{{input.ma}}' },
        body: '{"ten": "{{input.ten}}", "so_luong": 1}',
        inputs: [
          { name: 'ma', label: 'Mã', type: 'text' },
          { name: 'ten', label: 'Tên', type: 'long_text' },
        ],
        outputPath: 'id',
      },
      { key: 'loi', label: 'Lỗi', risk: 'read', method: 'GET', path: '/fail' },
      { key: 'chuyen', label: 'Chuyển hướng', risk: 'read', method: 'GET', path: '/move' },
      { key: 'cham', label: 'Chậm', risk: 'read', method: 'GET', path: '/slow' },
    ],
  });

  async function waitRun(id: string, statuses: string[], ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      const r = (await http.get(`/api/v1/workflows/runs/${id}`).set(as(token)).expect(200)).body;
      if (statuses.includes(r.status)) return r;
      if (Date.now() > until) throw new Error(`run ${id} stuck in ${r.status}`);
      await sleep(100);
    }
  }

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    app = await startApp({ CONNECTOR_ALLOW_PRIVATE_URLS: 'true' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const memberRole = roles.find((r) => r.key === 'member')!.id;
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 's11.member@example.com', roleId: memberRole })
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

  let shopId: string;

  it('installs starter connectors as drafts that list the secrets they still need', async () => {
    await http.post(`${api}/templates`).set(as(memberToken)).expect(403);
    const created = (await http.post(`${api}/templates`).set(as(token)).expect(200)).body;
    expect(created.map((c: any) => c.key).sort()).toEqual([
      'github',
      'n8n',
      'nhan-danh-gia',
      'telegram-bot',
    ]);
    expect(created.every((c: any) => c.status === 'draft')).toBe(true);
    const telegram = created.find((c: any) => c.key === 'telegram-bot');
    expect(telegram.missingSecrets).toEqual(['telegram.bot_token']);
    const res = await http.post(`${api}/${telegram.id}/activate`).set(as(token)).expect(400);
    expect(res.body.error.code).toBe('CONNECTOR_SECRET_MISSING');
    expect((await http.post(`${api}/templates`).set(as(token)).expect(200)).body).toHaveLength(0);
    // Anyone who can chat sees the list (for workflow steps); only managers see more.
    await http.get(api).set(as(memberToken)).expect(200);
    await http.get(`${api}/${telegram.id}`).set(as(memberToken)).expect(403);
  });

  it('checks capabilities: placeholders, secret placement and JSON bodies', async () => {
    const bad = async (patch: (c: any) => void, text: string) => {
      const c = shopConnector();
      patch(c);
      const res = await http.post(api).set(as(token)).send(c).expect(400);
      expect(JSON.stringify(res.body)).toContain(text);
    };
    await bad(
      (c) => (c.capabilities[2].body = '{"ten": "{{secret}}"}'),
      'chỉ được đặt trong đường dẫn',
    );
    await bad((c) => (c.capabilities[2].body = '{"ten": "{{input.khong_co}}"}'), 'khong_co');
    await bad((c) => (c.capabilities[2].body = '{"ten": {{input.ten}}}'), 'JSON');
    await bad((c) => (c.capabilities[0].body = '{}'), 'GET');
    await bad((c) => (c.capabilities[0].path = '/../admin'), 'đường dẫn');
    await bad((c) => (c.capabilities[0].path = 'https://khac.example/x'), 'đường dẫn');
    await bad((c) => (c.headers = { Authorization: 'x' }), 'MARIS tự đặt');
    await bad(
      (c) => (c.auth = { type: 'path', secret: 'shop.api_key' }),
      '{{secret}} trong đường dẫn',
    );

    await http.post(api).set(as(memberToken)).send(shopConnector()).expect(403);
    const created = (await http.post(api).set(as(token)).send(shopConnector()).expect(201)).body;
    expect(created).toMatchObject({
      status: 'draft',
      source: 'created',
      missingSecrets: ['shop.api_key'],
    });
    shopId = created.id;
    await http.post(api).set(as(token)).send(shopConnector()).expect(409);
  });

  it('calls a capability with the secret from the vault, and keeps the secret out of the log', async () => {
    await http
      .post('/api/v1/secrets')
      .set(as(token))
      .send({ name: 'shop.api_key', value: SECRET })
      .expect(201);
    const read = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'thong_tin' })
        .expect(200)
    ).body;
    expect(read).toMatchObject({
      status: 'ok',
      httpStatus: 200,
      output: 'bot-maris',
      risk: 'read',
    });
    const hit = fake.seen.at(-1)!;
    expect(hit.headers['x-api-key']).toBe(SECRET);
    expect(hit.headers['x-shop']).toBe('maris');
    expect(hit.headers['user-agent']).toBe('MARIS-Connector/1.0');

    // A response that echoes the secret is stored with the secret masked.
    const whole = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'toan_bo' })
        .expect(200)
    ).body;
    expect(whole.output).toContain('"echo": "***"');
    expect(whole.output).not.toContain(SECRET);

    const write = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'tao', inputs: { ma: 'a/b c', ten: 'Áo "đẹp"\n<b>' } })
        .expect(200)
    ).body;
    expect(write).toMatchObject({ status: 'ok', httpStatus: 201, output: '7' });
    const posted = fake.seen.at(-1)!;
    expect(posted.url).toBe('/api/v1/items/a%2Fb%20c?nguon=a%2Fb+c');
    expect(JSON.parse(posted.body)).toEqual({ ten: 'Áo "đẹp"\n<b>', so_luong: 1 });
    expect(posted.headers['content-type']).toBe('application/json');

    const dots = await http
      .post(`${api}/${shopId}/call`)
      .set(as(token))
      .send({ capability: 'tao', inputs: { ma: '..', ten: 'x' } })
      .expect(400);
    expect(dots.body.error.code).toBe('CONNECTOR_REQUEST_INVALID');

    const failed = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'loi' })
        .expect(200)
    ).body;
    expect(failed).toMatchObject({
      status: 'failed',
      httpStatus: 500,
      errorCode: 'CONNECTOR_HTTP_ERROR',
    });
    const moved = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'chuyen' })
        .expect(200)
    ).body;
    expect(moved).toMatchObject({ status: 'failed', httpStatus: 302 });
    expect(moved.errorMessage).toContain('không đi theo');
    const slow = (
      await http
        .post(`${api}/${shopId}/call`)
        .set(as(token))
        .send({ capability: 'cham' })
        .expect(200)
    ).body;
    expect(slow).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_TIMEOUT' });

    const log = (await http.get(`${api}/${shopId}/calls`).set(as(token)).expect(200)).body;
    // The ".." call was refused before anything was sent, so it is not in the log.
    expect(log).toHaveLength(6);
    expect(JSON.stringify(log)).not.toContain(SECRET);

    const sql = admin();
    const audit =
      await sql`SELECT action, metadata FROM security.audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'connector.call%'`;
    await sql.end();
    expect(audit.length).toBe(6);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('needs ai.approve for write capabilities and for turning a connector on', async () => {
    const sql = admin();
    await sql`INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
              SELECT tenant_id, id, 'ai.manage' FROM identity.roles WHERE tenant_id = ${tenantId} AND key = 'member'`;
    await sql.end();
    await http
      .post(`${api}/${shopId}/call`)
      .set(as(memberToken))
      .send({ capability: 'thong_tin' })
      .expect(200);
    const denied = await http
      .post(`${api}/${shopId}/call`)
      .set(as(memberToken))
      .send({ capability: 'tao', inputs: { ma: 'x', ten: 'y' } })
      .expect(403);
    expect(denied.body.error.message).toContain('ai.approve');
    await http.post(`${api}/${shopId}/activate`).set(as(memberToken)).expect(403);

    const on = (await http.post(`${api}/${shopId}/activate`).set(as(token)).expect(200)).body;
    expect(on).toMatchObject({ status: 'active', missingSecrets: [] });
    // A new name keeps it on; a new address sends it back to draft.
    expect(
      (await http.patch(`${api}/${shopId}`).set(as(token)).send({ name: 'Cửa hàng' }).expect(200))
        .body.status,
    ).toBe('active');
    const moved = (
      await http
        .patch(`${api}/${shopId}`)
        .set(as(token))
        .send({ baseUrl: `${fake.baseUrl}/v2` })
        .expect(200)
    ).body;
    expect(moved).toMatchObject({ status: 'draft', activatedBy: null });
    await http.patch(`${api}/${shopId}`).set(as(token)).send({ baseUrl: fake.baseUrl }).expect(200);
    await http.post(`${api}/${shopId}/activate`).set(as(token)).expect(200);
  });

  it('exports without secrets and imports as a draft, refusing edited files', async () => {
    const file = (await http.get(`${api}/${shopId}/export`).set(as(token)).expect(200)).body;
    expect(file).toMatchObject({
      format: 'maris.connector/v1',
      key: 'cua-hang',
      auth: { secret: 'shop.api_key' },
    });
    expect(JSON.stringify(file)).not.toContain(SECRET);
    expect(
      (await http.post(`${api}/import`).set(as(token)).send({ manifest: file }).expect(409)).body
        .error.code,
    ).toBe('CONNECTOR_EXISTS');
    const tampered = { ...file, key: 'cua-hang-2', baseUrl: 'https://ke-xau.example' };
    expect(
      (await http.post(`${api}/import`).set(as(token)).send({ manifest: tampered }).expect(400))
        .body.error.code,
    ).toBe('CONNECTOR_CHECKSUM_MISMATCH');
    const copy = { ...file, key: 'cua-hang-2' };
    delete copy.checksum;
    const imported = (
      await http.post(`${api}/import`).set(as(token)).send({ manifest: copy }).expect(201)
    ).body;
    expect(imported).toMatchObject({ status: 'draft', source: 'imported' });
  });

  it('runs a connector step in a workflow, and fails it while the connector is off', async () => {
    const graph = (capability = 'tao') => ({
      maxSteps: 10,
      nodes: [
        {
          id: 'bat_dau',
          type: 'trigger',
          label: 'Bắt đầu',
          inputs: [{ name: 'san_pham', label: 'Sản phẩm', type: 'text' }],
        },
        {
          id: 'gui',
          type: 'connector',
          label: 'Gửi sang cửa hàng',
          connectorKey: 'cua-hang',
          capability,
          inputs: { ma: 'sp1', ten: '{{input.san_pham}}' },
        },
        { id: 'xong', type: 'end', label: 'Xong' },
      ],
    });
    const missing = await http
      .post('/api/v1/workflows')
      .set(as(token))
      .send({ key: 'gui-cua-hang', name: 'Gửi', graph: graph('khong_co') })
      .expect(400);
    expect(missing.body.error.code).toBe('WORKFLOW_REFERENCE_MISSING');
    const wf = (
      await http
        .post('/api/v1/workflows')
        .set(as(token))
        .send({ key: 'gui-cua-hang', name: 'Gửi', graph: graph() })
        .expect(201)
    ).body;
    const test = (
      await http
        .post(`/api/v1/workflows/${wf.id}/test`)
        .set(as(token))
        .send({ inputs: { san_pham: 'Mũ' } })
        .expect(200)
    ).body;
    expect(test.steps[1].output).toContain('không gọi Connector');

    const before = fake.seen.length;
    const run = (
      await http
        .post(`/api/v1/workflows/${wf.id}/runs`)
        .set(as(token))
        .send({ inputs: { san_pham: 'Mũ len' }, budgetUsd: 1 })
        .expect(201)
    ).body;
    const done = await waitRun(run.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    expect(done.steps.find((s: any) => s.nodeId === 'gui')).toMatchObject({
      status: 'completed',
      output: '7',
    });
    expect(done.steps.find((s: any) => s.nodeId === 'gui').input).toContain('POST');
    expect(fake.seen.length).toBe(before + 1);
    expect(JSON.parse(fake.seen.at(-1)!.body).ten).toBe('Mũ len');
    const calls = (await http.get(`${api}/${shopId}/calls`).set(as(token)).expect(200)).body;
    expect(calls[0]).toMatchObject({ workflowRunId: run.id, status: 'ok' });

    await http.post(`${api}/${shopId}/pause`).set(as(token)).expect(200);
    const off = (
      await http
        .post(`/api/v1/workflows/${wf.id}/runs`)
        .set(as(token))
        .send({ inputs: { san_pham: 'Mũ' }, budgetUsd: 1 })
        .expect(201)
    ).body;
    const failed = await waitRun(off.id, ['completed', 'failed']);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_NOT_ACTIVE' });
    expect(fake.seen.length).toBe(before + 1);
  });

  it('starts a workflow from a webhook only with the right token', async () => {
    const graph = {
      maxSteps: 5,
      nodes: [
        {
          id: 'bat_dau',
          type: 'trigger',
          label: 'Bắt đầu',
          inputs: [{ name: 'danh_gia', label: 'Đánh giá', type: 'long_text' }],
        },
        { id: 'xong', type: 'end', label: 'Xong' },
      ],
    };
    await http
      .post('/api/v1/workflows')
      .set(as(token))
      .send({ key: 'nhan-vao', name: 'Nhận vào', graph })
      .expect(201);
    const hook = (
      await http
        .post(api)
        .set(as(token))
        .send({
          key: 'web-gui-vao',
          kind: 'webhook',
          name: 'Website',
          webhook: { workflowKey: 'nhan-vao', runBudgetUsd: 0.2 },
        })
        .expect(201)
    ).body;
    expect(hook.webhook).toMatchObject({ hasToken: false, path: `/hooks/${tenantId}/${hook.id}` });
    expect(
      (await http.post(`${api}/${hook.id}/activate`).set(as(token)).expect(400)).body.error.code,
    ).toBe('CONNECTOR_TOKEN_MISSING');
    const { token: hookToken } = (
      await http.post(`${api}/${hook.id}/token`).set(as(token)).expect(200)
    ).body;
    expect(hookToken.length).toBeGreaterThan(30);
    const url = `/api/v1${hook.webhook.path}`;

    // Not on yet.
    await http.post(url).set('X-Maris-Token', hookToken).send({ danh_gia: 'Tốt' }).expect(409);
    await http.post(`${api}/${hook.id}/activate`).set(as(token)).expect(200);

    await http.post(url).send({ danh_gia: 'Tốt' }).expect(401);
    await http.post(url).set('X-Maris-Token', 'sai').send({ danh_gia: 'Tốt' }).expect(401);
    await http
      .post(`/api/v1/hooks/${tenantId}/${shopId}`)
      .set('X-Maris-Token', hookToken)
      .send({})
      .expect(404);

    const ok = (
      await http
        .post(url)
        .set('X-Maris-Token', hookToken)
        .send({ danh_gia: 'Giao nhanh', la: 'bỏ qua' })
        .expect(202)
    ).body;
    expect(ok.status).toBe('started');
    const run = await waitRun(ok.workflowRunId, ['completed', 'failed']);
    expect(run).toMatchObject({
      status: 'completed',
      input: { danh_gia: 'Giao nhanh' },
      budgetUsd: 0.2,
    });

    const events = (await http.get(`${api}/${hook.id}/events`).set(as(token)).expect(200)).body;
    expect(events.map((e: any) => e.status)).toEqual([
      'started',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(events[1].bodyExcerpt).toBe('');

    // A new token replaces the old one at once.
    await http.post(`${api}/${hook.id}/token`).set(as(token)).expect(200);
    await http.post(url).set('X-Maris-Token', hookToken).send({ danh_gia: 'Tốt' }).expect(401);
  });

  it('refuses connector calls during an emergency stop', async () => {
    await http.post('/api/v1/ai/emergency-stop').set(as(token)).send({ reason: 'Thử' }).expect(200);
    await http.post(`${api}/${shopId}/activate`).set(as(token)).expect(200);
    const res = await http
      .post(`${api}/${shopId}/call`)
      .set(as(token))
      .send({ capability: 'thong_tin' })
      .expect(423);
    expect(res.body.error.code).toBe('EMERGENCY_STOP');
    await http.delete('/api/v1/ai/emergency-stop').set(as(token)).expect(200);
  });
});
