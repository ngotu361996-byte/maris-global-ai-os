import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';
import { FakeAi } from './fake-ai';

const OWNER = {
  email: 'owner17@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ cửa hàng',
  tenantName: 'Công ty Viết bài',
};

describe('Sprint 17 (e2e): AI content writing', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let memberToken: string;
  let tenantId: string;
  const fake = new FakeAi();
  /** What the fake AI answers to a content prompt. */
  let reply = '';
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const C = '/api/v1/content';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ids = { product: '', reference: '', item: '' };
  const prompts: string[] = [];

  async function waitGeneration(itemId: string, ms = 15_000) {
    const until = Date.now() + ms;
    for (;;) {
      const d = (await http.get(`${C}/items/${itemId}`).set(as()).expect(200)).body;
      if (d.generations[0] && d.generations[0].status !== 'running') return d;
      if (Date.now() > until)
        throw new Error(`generation stuck: ${JSON.stringify(d.generations[0])}`);
      await sleep(100);
    }
  }

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    fake.reply = (body) => {
      const user = body?.messages?.at(-1)?.content;
      if (typeof user !== 'string' || !user.includes('DỮ LIỆU SẢN PHẨM ĐÃ XÁC MINH')) return null;
      prompts.push(user);
      return reply;
    };
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const secretRef = (
      await http
        .post('/api/v1/secrets')
        .set(as())
        .send({ name: 'fake.api_key', value: 'sk-fake-key-17' })
        .expect(201)
    ).body.reference;
    await http
      .post('/api/v1/ai/providers')
      .set(as())
      .send({
        name: 'A',
        kind: 'openai',
        baseUrl: `${fake.baseUrl}/a`,
        secretRef,
        defaultModel: 'A-model',
        inputCostPerMtok: 1,
        outputCostPerMtok: 2,
      })
      .expect(201);
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as())
      .send({ email: 's17.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'Member' })
        .expect(200)
    ).body.token;

    ids.product = (
      await http
        .post(`${C}/assets`)
        .set(as())
        .send({
          title: 'Áo thun cotton MARIS',
          kind: 'product',
          product: {
            name: 'Áo thun cotton MARIS',
            sku: 'AT-01',
            price: 199000,
            currency: 'VND',
            specs: [
              { key: 'Chất liệu', value: 'Cotton 100%' },
              { key: 'Size', value: 'S, M, L, XL' },
            ],
          },
          rightsStatus: 'owned',
        })
        .expect(201)
    ).body.id;
    ids.reference = (
      await http
        .post(`${C}/assets`)
        .set(as())
        .send({
          title: 'Bài mẫu của đối thủ',
          kind: 'reference',
          body: 'Áo mát lạnh, giặt 500 lần không phai, rẻ nhất thị trường!',
          rightsStatus: 'unknown',
        })
        .expect(201)
    ).body.id;
    ids.item = (
      await http
        .post(`${C}/items`)
        .set(as())
        .send({
          title: 'Khuyến mãi 01/12',
          kind: 'text',
          platform: 'facebook',
          language: 'vi',
          market: 'VN',
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await fake.stop();
    await app.close();
  });

  it('refuses unverified facts, files and people without content.generate', async () => {
    const r = await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as())
      .send({ productAssetIds: [ids.product] })
      .expect(400);
    expect(r.body.error.code).toBe('CONTENT_FACTS_UNVERIFIED');
    expect(r.body.error.message).toContain('Áo thun cotton MARIS');

    await http.post(`${C}/assets/${ids.product}/verify`).set(as()).expect(200);
    const wrong = await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as())
      .send({ productAssetIds: [ids.reference] })
      .expect(400);
    expect(wrong.body.error.code).toBe('CONTENT_NOT_PRODUCT');
    await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as(memberToken))
      .send({ productAssetIds: [ids.product] })
      .expect(403);
    await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as())
      .send({ budgetUsd: 50 })
      .expect(400);
    // Nothing started.
    const d = (await http.get(`${C}/items/${ids.item}`).set(as()).expect(200)).body;
    expect(d.generations).toEqual([]);
  });

  it('writes the next version from verified facts as an approved AI task, with cost and lineage', async () => {
    reply =
      '```\nÁo thun cotton MARIS chỉ 199.000 VND, chất liệu Cotton 100%, đủ size S đến XL.\nGiảm 20% dịp 01/12. Đặt ngay! #aothun\n```';
    const started = (
      await http
        .post(`${C}/items/${ids.item}/generate`)
        .set(as())
        .send({
          productAssetIds: [ids.product],
          sourceAssetIds: [ids.reference],
          brief: 'Giảm 20% dịp 01/12',
          tone: 'Thân thiện, gần gũi',
        })
        .expect(202)
    ).body;
    expect(started.generations[0]).toMatchObject({ status: 'running', mode: 'write' });
    const again = await http.post(`${C}/items/${ids.item}/generate`).set(as()).send({}).expect(409);
    expect(again.body.error.code).toBe('CONTENT_GENERATION_RUNNING');

    const d = await waitGeneration(ids.item);
    const g = d.generations[0];
    expect(g).toMatchObject({ status: 'done', version: 1, warnings: [] });
    expect(g.costUsd).toBeGreaterThan(0);
    expect(d.currentVersion).toBe(1);
    const v = d.versions[0];
    // The code fence is removed; the text is saved as it was written.
    expect(v.body).toBe(
      'Áo thun cotton MARIS chỉ 199.000 VND, chất liệu Cotton 100%, đủ size S đến XL.\nGiảm 20% dịp 01/12. Đặt ngay! #aothun',
    );
    expect(v).toMatchObject({ aiTaskId: g.taskId, aiWarnings: [], note: 'AI viết' });
    expect(v.sources.map((s: { id: string }) => s.id).sort()).toEqual(
      [ids.product, ids.reference].sort(),
    );

    // The prompt carries the facts, the rules and the brief, and asks for no self-review.
    const p = prompts.at(-1)!;
    expect(p).toContain('Giá: 199000 VND');
    expect(p).toContain('Chất liệu: Cotton 100%');
    expect(p).toContain('Bài đăng Facebook');
    expect(p).toContain('Giảm 20% dịp 01/12');
    expect(p).toContain('chỉ để lấy ý');
    expect(p).not.toContain('tự đánh giá ngắn');

    const task = (await http.get(`/api/v1/ai/tasks/${g.taskId}`).set(as()).expect(200)).body;
    expect(task).toMatchObject({ status: 'completed', budgetUsd: 0.2 });
    expect(task.approvedBy).toBeTruthy();
    // A content task cannot be run again on its own.
    const sql = admin();
    const calls =
      await sql`SELECT count(*)::int AS n FROM ai.provider_calls WHERE task_id = ${g.taskId}`;
    expect(calls[0]!.n).toBe(1);
    const audit =
      await sql`SELECT action FROM security.audit_logs WHERE target_id = ${ids.item} ORDER BY created_at`;
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'content.item.generation_started',
        'content.item.version_added',
        'content.item.generation_finished',
      ]),
    );
    await sql.end();

    // The reference has unknown rights: that blocks approval as before, not the AI.
    expect(d.approvalBlockers).toEqual([expect.stringContaining('Bài mẫu của đối thủ')]);
  });

  it('flags numbers and claims the facts do not support, and blocks approval until a person edits', async () => {
    reply =
      'Áo thun MARIS tốt nhất thị trường, bảo hành 24 tháng, giặt 500 lần không phai. Chỉ 199k!';
    await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as())
      .send({ productAssetIds: [ids.product] })
      .expect(202);
    const d = await waitGeneration(ids.item);
    const g = d.generations[0];
    expect(g.status).toBe('done');
    expect(g.version).toBe(2);
    expect(g.warnings).toEqual([
      'Số liệu không có trong thông tin sản phẩm hoặc yêu cầu: 24, 500, 199',
      'Tuyên bố cần có căn cứ: “tốt nhất”',
    ]);
    expect(d.versions[0].aiWarnings).toEqual(g.warnings);
    // The reference chosen for version 1 stays a source, so its unknown rights still count too.
    expect(d.approvalBlockers).toEqual([
      expect.stringContaining('phiên bản do AI viết'),
      expect.stringContaining('Bài mẫu của đối thủ'),
    ]);
    await http.post(`${C}/items/${ids.item}/submit`).set(as()).expect(200);
    const blocked = await http
      .post(`${C}/items/${ids.item}/approve`)
      .set(as())
      .send({})
      .expect(409);
    expect(blocked.body.error.message).toContain('tốt nhất');

    // A person rewrites it: the new version is theirs and can be approved.
    const fixed = (
      await http
        .post(`${C}/items/${ids.item}/versions`)
        .set(as())
        .send({ body: 'Áo thun cotton MARIS, giá 199.000 VND.', sourceAssetIds: [ids.product] })
        .expect(201)
    ).body;
    expect(fixed.approvalBlockers).toEqual([]);
    await http.post(`${C}/items/${ids.item}/submit`).set(as()).expect(200);
    await http.post(`${C}/items/${ids.item}/approve`).set(as()).send({}).expect(200);
  });

  it('makes an English version as a linked item from the current text and the same facts', async () => {
    reply = 'MARIS cotton T-shirt, only 199,000 VND. 100% cotton, sizes S to XL. Order now!';
    const v = (
      await http
        .post(`${C}/items/${ids.item}/variants`)
        .set(as())
        .send({ language: 'en', market: 'US' })
        .expect(202)
    ).body;
    expect(v).toMatchObject({
      variantOf: ids.item,
      language: 'en',
      market: 'US',
      platform: 'facebook',
      kind: 'text',
      currentVersion: 0,
    });
    expect(v.title).toContain('Tiếng Anh');
    const d = await waitGeneration(v.id);
    expect(d.generations[0]).toMatchObject({
      status: 'done',
      mode: 'variant',
      fromItemId: ids.item,
      fromVersion: 3,
      warnings: [],
    });
    expect(d.versions[0]).toMatchObject({ version: 1, note: 'AI chuyển thể từ bản 3' });
    expect(d.versions[0].sources.map((s: { id: string }) => s.id)).toEqual([ids.product]);
    const p = prompts.at(-1)!;
    expect(p).toContain('Bản địa hóa');
    expect(p).toContain('tiếng Anh');
    expect(p).toContain('Áo thun cotton MARIS, giá 199.000 VND.');

    const src = (await http.get(`${C}/items/${ids.item}`).set(as()).expect(200)).body;
    expect(src.variants).toEqual([expect.objectContaining({ id: v.id, language: 'en' })]);
    // The approved original is untouched.
    expect(src).toMatchObject({ status: 'approved', currentVersion: 3 });

    const same = await http
      .post(`${C}/items/${ids.item}/variants`)
      .set(as())
      .send({ language: 'vi' })
      .expect(400);
    expect(same.body.error.code).toBe('CONTENT_VARIANT_SAME');
  });

  it('can be cancelled while the AI writes, and is refused during Emergency Stop', async () => {
    fake.modes.a = 'slow';
    try {
      const d = (
        await http
          .post(`${C}/items/${ids.item}/generate`)
          .set(as())
          .send({ productAssetIds: [ids.product] })
          .expect(202)
      ).body;
      await sleep(300);
      const gid = d.generations[0].id;
      await http.post(`${C}/generations/${gid}/cancel`).set(as()).expect(200);
      const done = await waitGeneration(ids.item);
      expect(done.generations[0]).toMatchObject({ id: gid, status: 'cancelled', version: null });
      expect(done.currentVersion).toBe(3);
      await http.post(`${C}/generations/${gid}/cancel`).set(as()).expect(409);
    } finally {
      fake.modes.a = 'ok';
    }

    await http.post('/api/v1/ai/emergency-stop').set(as()).send({}).expect(200);
    const r = await http
      .post(`${C}/items/${ids.item}/generate`)
      .set(as())
      .send({ productAssetIds: [ids.product] })
      .expect(423);
    expect(r.body.error.code).toBe('EMERGENCY_STOP');
    await http.delete('/api/v1/ai/emergency-stop').set(as()).expect(200);
  });
});
