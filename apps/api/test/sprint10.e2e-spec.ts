import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';
import { FakeAi } from './fake-ai';

const OWNER = {
  email: 'owner10@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Workflow',
};

describe('Sprint 10 (e2e): Workflow Studio', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const fake = new FakeAi();
  let sentiment = 'TIEU_CUC';

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const api = '/api/v1/workflows';

  async function waitRun(id: string, statuses: string[], ms = 15_000) {
    const until = Date.now() + ms;
    for (;;) {
      const r = (await http.get(`${api}/runs/${id}`).set(as(token)).expect(200)).body;
      if (statuses.includes(r.status)) return r;
      if (Date.now() > until) throw new Error(`run ${id} stuck in ${r.status} at ${r.currentNode}`);
      await sleep(100);
    }
  }

  const loopGraph = (maxSteps: number, budgetUsd: number) => ({
    maxSteps,
    nodes: [
      {
        id: 'bat_dau',
        type: 'trigger',
        label: 'Bắt đầu',
        inputs: [{ name: 'chu_de', label: 'Chủ đề', type: 'text' }],
      },
      { id: 'viet', type: 'ai', label: 'Viết', prompt: 'Viết về {{input.chu_de}}', budgetUsd },
      {
        id: 'xong_chua',
        type: 'condition',
        label: 'Xong chưa?',
        value: '{{steps.viet}}',
        operator: 'contains',
        compare: 'KHONG_BAO_GIO',
        then: null,
        else: 'viet',
      },
    ],
  });

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    fake.reply = (body) => {
      const text = JSON.stringify(body?.messages ?? '');
      if (text.includes('TICH_CUC hoặc TIEU_CUC')) return sentiment;
      return null;
    };
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const secretRef = (
      await http
        .post('/api/v1/secrets')
        .set(as(token))
        .send({ name: 'fake.api_key', value: 'sk-fake-key-10' })
        .expect(201)
    ).body.reference;
    await http
      .post('/api/v1/ai/providers')
      .set(as(token))
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
    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 's10.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
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

  let launchId: string;
  let reviewId: string;

  it('installs starter workflows only once their skills exist', async () => {
    await http.post(`${api}/templates`).set(as(memberToken)).expect(403);
    const before = (await http.post(`${api}/templates`).set(as(token)).expect(200)).body;
    expect(before.created).toHaveLength(0);
    expect(before.missingSkills.sort()).toEqual([
      'bai-quang-cao-facebook',
      'mo-ta-san-pham',
      'tra-loi-khach-hang',
    ]);
    await http.post('/api/v1/ai/skills/templates').set(as(token)).expect(200);
    const after = (await http.post(`${api}/templates`).set(as(token)).expect(200)).body;
    expect(after.created.map((w: any) => w.key).sort()).toEqual([
      'ra-mat-san-pham',
      'xu-ly-danh-gia',
    ]);
    expect(
      (await http.post(`${api}/templates`).set(as(token)).expect(200)).body.created,
    ).toHaveLength(0);
    const list = (await http.get(api).set(as(memberToken)).expect(200)).body;
    launchId = list.find((w: any) => w.key === 'ra-mat-san-pham').id;
    reviewId = list.find((w: any) => w.key === 'xu-ly-danh-gia').id;
  });

  it('checks the steps and their references, and lets only ai.manage create', async () => {
    const wf = (graph: unknown, key = 'thu') => ({ key, name: 'Thử', graph });
    await http
      .post(api)
      .set(as(memberToken))
      .send(wf(loopGraph(6, 0.01)))
      .expect(403);
    const noTrigger = {
      maxSteps: 5,
      nodes: [
        { id: 'a', type: 'end', label: 'A' },
        { id: 'b', type: 'end', label: 'B' },
      ],
    };
    expect(
      JSON.stringify((await http.post(api).set(as(token)).send(wf(noTrigger)).expect(400)).body),
    ).toContain('Bắt đầu');
    const bad = loopGraph(6, 0.01);
    (bad.nodes[1] as any).prompt = 'Viết về {{input.khong_co}} và {{steps.ma}}';
    const res = (await http.post(api).set(as(token)).send(wf(bad)).expect(400)).body;
    expect(JSON.stringify(res)).toContain('khong_co');
    const dangling = loopGraph(6, 0.01);
    (dangling.nodes[2] as any).else = 'khong_ton_tai';
    await http.post(api).set(as(token)).send(wf(dangling)).expect(400);
    const missing = {
      maxSteps: 5,
      nodes: [
        loopGraph(1, 1).nodes[0],
        { id: 's', type: 'skill', label: 'S', skillKey: 'khong-co', inputs: {} },
      ],
    };
    expect(
      (await http.post(api).set(as(token)).send(wf(missing)).expect(400)).body.error.code,
    ).toBe('WORKFLOW_REFERENCE_MISSING');
    const created = (
      await http
        .post(api)
        .set(as(token))
        .send(wf(loopGraph(6, 0.01)))
        .expect(201)
    ).body;
    expect(created).toMatchObject({ version: 1, source: 'created', status: 'active' });
    await http
      .post(api)
      .set(as(token))
      .send(wf(loopGraph(6, 0.01)))
      .expect(409);
  });

  it('saves a version per change of steps, and restores an old one as the newest', async () => {
    const wf = (await http.get(api).set(as(token))).body.find((w: any) => w.key === 'thu');
    const same = (
      await http
        .patch(`${api}/${wf.id}`)
        .set(as(token))
        .send({ graph: wf.graph, name: 'Thử lại' })
        .expect(200)
    ).body;
    expect(same).toMatchObject({ version: 1, name: 'Thử lại' });
    const v2 = (
      await http
        .patch(`${api}/${wf.id}`)
        .set(as(token))
        .send({ graph: loopGraph(8, 0.01), note: 'tăng giới hạn' })
        .expect(200)
    ).body;
    expect(v2.version).toBe(2);
    expect(v2.graph.maxSteps).toBe(8);
    const v3 = (await http.post(`${api}/${wf.id}/versions/1/restore`).set(as(token)).expect(200))
      .body;
    expect(v3).toMatchObject({ version: 3, checksum: wf.checksum });
    const versions = (await http.get(`${api}/${wf.id}/versions`).set(as(memberToken)).expect(200))
      .body;
    expect(versions.map((v: any) => [v.version, v.note])).toEqual([
      [3, 'Khôi phục từ phiên bản 1'],
      [2, 'tăng giới hạn'],
      [1, null],
    ]);
  });

  it('copies, exports and imports, refusing a tampered file', async () => {
    const copy = (
      await http
        .post(`${api}/${launchId}/copy`)
        .set(as(token))
        .send({ key: 'ra-mat-ban-sao', name: 'Bản sao' })
        .expect(201)
    ).body;
    expect(copy).toMatchObject({ source: 'copied', version: 1 });
    const file = (await http.get(`${api}/${launchId}/export`).set(as(memberToken)).expect(200))
      .body;
    expect(file).toMatchObject({ format: 'maris.workflow/v1', key: 'ra-mat-san-pham', version: 1 });
    const imp = (manifest: unknown, replace = false) =>
      http.post(`${api}/import`).set(as(token)).send({ manifest, replace });
    expect((await imp(file).expect(409)).body.error.code).toBe('WORKFLOW_EXISTS');
    const tampered = { ...file, key: 'gia-mao', graph: { ...file.graph, maxSteps: 200 } };
    expect((await imp(tampered).expect(400)).body.error.code).toBe('WORKFLOW_CHECKSUM_MISMATCH');
    const unknownSkill = JSON.parse(
      JSON.stringify({ ...file, key: 'thieu-skill', checksum: undefined }),
    );
    unknownSkill.graph.nodes[1].skillKey = 'skill-cua-noi-khac';
    expect((await imp(unknownSkill).expect(400)).body.error.code).toBe(
      'WORKFLOW_REFERENCE_MISSING',
    );
    const imported = (await imp({ ...file, key: 'ra-mat-nhap' }).expect(201)).body;
    expect(imported).toMatchObject({
      source: 'imported',
      status: 'paused',
      checksum: file.checksum,
    });
    const replaced = (await imp(file, true).expect(201)).body;
    expect(replaced).toMatchObject({ id: launchId, version: 2, status: 'paused' });
    await http.patch(`${api}/${launchId}`).set(as(token)).send({ status: 'active' }).expect(200);
  });

  it('test-runs without spending, following conditions', async () => {
    const calls = fake.count('/a');
    const t = (
      await http
        .post(`${api}/${reviewId}/test`)
        .set(as(memberToken))
        .send({ inputs: { danh_gia: 'Hàng tốt' } })
        .expect(200)
    ).body;
    expect(t.outcome).toBe('completed');
    expect(t.steps.map((s: any) => s.nodeId)).toEqual([
      'bat_dau',
      'phan_loai',
      'la_tieu_cuc',
      'cam_on',
    ]);
    expect(t.steps[1].input).toContain(
      '<workflow_data name="input.danh_gia">Hàng tốt</workflow_data>',
    );
    const l = (
      await http
        .post(`${api}/${launchId}/test`)
        .set(as(token))
        .send({ inputs: { san_pham: 'Cần câu', dac_diem: 'Nhẹ', khach_hang: 'Dân câu' } })
        .expect(200)
    ).body;
    expect(l.aiSteps).toBe(2);
    expect(l.maxBudgetUsd).toBe(1);
    expect(fake.count('/a')).toBe(calls);
    await http.post(`${api}/${launchId}/test`).set(as(token)).send({ inputs: {} }).expect(400);
  });

  describe('runs', () => {
    const launchInputs = {
      san_pham: 'Cần câu carbon',
      dac_diem: 'Nhẹ 150g',
      khach_hang: 'Người mới chơi',
    };

    it('lets only approvers start a run, and not a paused workflow', async () => {
      await http
        .post(`${api}/${launchId}/runs`)
        .set(as(memberToken))
        .send({ inputs: launchInputs, budgetUsd: 2 })
        .expect(403);
      const paused = (await http.get(api).set(as(token))).body.find(
        (w: any) => w.key === 'ra-mat-nhap',
      );
      expect(
        (
          await http
            .post(`${api}/${paused.id}/runs`)
            .set(as(token))
            .send({ inputs: launchInputs, budgetUsd: 2 })
            .expect(400)
        ).body.error.code,
      ).toBe('WORKFLOW_PAUSED');
      await http
        .post(`${api}/${launchId}/runs`)
        .set(as(token))
        .send({ inputs: { san_pham: 'x' }, budgetUsd: 2 })
        .expect(400);
    });

    it('runs skills as approved tasks, waits for the approval step, then completes', async () => {
      const started = (
        await http
          .post(`${api}/${launchId}/runs`)
          .set(as(token))
          .send({ inputs: launchInputs, budgetUsd: 2 })
          .expect(201)
      ).body;
      expect(started.version).toBe(2);
      const waiting = await waitRun(started.id, ['waiting_approval', 'failed']);
      expect(waiting).toMatchObject({
        status: 'waiting_approval',
        currentNode: 'duyet',
        waitingFor: 'approval',
        hasCheckpoint: true,
      });
      expect(waiting.steps.map((s: any) => [s.nodeId, s.status])).toEqual([
        ['bat_dau', 'completed'],
        ['mo_ta', 'completed'],
        ['luu_mo_ta', 'completed'],
        ['quang_cao', 'completed'],
        ['duyet', 'waiting'],
      ]);
      expect(waiting.steps[1].input).toContain('san_pham: Cần câu carbon');
      expect(waiting.steps[1].output).toBe('Xin chào');
      expect(waiting.steps[4].input).toBe(
        'Đọc mô tả và bài quảng cáo cho Cần câu carbon trước khi đăng.',
      );
      expect(waiting.costUsd).toBeCloseTo(0.004, 6);

      const tasks = (await http.get('/api/v1/ai/tasks').set(as(token)).expect(200)).body.filter(
        (t: any) => t.workflowRunId === started.id,
      );
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t: any) => t.status === 'completed' && t.skillId)).toBe(true);

      await http
        .post(`${api}/runs/${started.id}/approve`)
        .set(as(memberToken))
        .send({})
        .expect(403);
      const done = (
        await http
          .post(`${api}/runs/${started.id}/approve`)
          .set(as(token))
          .send({ note: 'Đăng được' })
          .expect(200)
      ).body;
      const final = done.status === 'completed' ? done : await waitRun(started.id, ['completed']);
      expect(final.steps.at(-2)).toMatchObject({
        nodeId: 'duyet',
        status: 'completed',
        output: 'Đã duyệt: Đăng được',
      });
      expect(final.steps.at(-1).nodeId).toBe('xong');

      const sql = admin();
      const audit =
        await sql`SELECT action FROM security.audit_logs WHERE target_id = ${started.id} ORDER BY seq`;
      await sql.end();
      expect(audit.map((a) => a.action)).toEqual([
        'workflow.run.started',
        'workflow.run.approved',
        'workflow.run.completed',
      ]);
    });

    it('follows a condition and ends cancelled when the approval is rejected', async () => {
      sentiment = 'TIEU_CUC';
      const run = (
        await http
          .post(`${api}/${reviewId}/runs`)
          .set(as(token))
          .send({ inputs: { danh_gia: 'Giao hàng chậm quá' }, budgetUsd: 1 })
          .expect(201)
      ).body;
      const waiting = await waitRun(run.id, ['waiting_approval', 'failed']);
      expect(waiting.steps.map((s: any) => s.nodeId)).toEqual([
        'bat_dau',
        'phan_loai',
        'la_tieu_cuc',
        'tra_loi',
        'duyet',
      ]);
      expect(waiting.steps[2]).toMatchObject({ output: 'Đúng' });
      const prompt = JSON.stringify(
        fake.requests
          .filter((r) => JSON.stringify(r.body?.messages ?? '').includes('TICH_CUC hoặc TIEU_CUC'))
          .at(-1)!.body.messages,
      );
      expect(prompt).toContain(
        '<workflow_data name=\\"input.danh_gia\\">Giao hàng chậm quá</workflow_data>',
      );
      expect(prompt).not.toContain('tự đánh giá');
      const rejected = (
        await http
          .post(`${api}/runs/${run.id}/reject`)
          .set(as(token))
          .send({ note: 'Viết lại' })
          .expect(200)
      ).body;
      expect(rejected).toMatchObject({
        status: 'cancelled',
        errorMessage: 'Bị từ chối ở bước "Duyệt câu trả lời"',
      });

      sentiment = 'TICH_CUC';
      const good = (
        await http
          .post(`${api}/${reviewId}/runs`)
          .set(as(token))
          .send({ inputs: { danh_gia: 'Hàng đẹp' }, budgetUsd: 1 })
          .expect(201)
      ).body;
      const finished = await waitRun(good.id, ['completed', 'failed']);
      expect(finished.status).toBe('completed');
      expect(finished.steps.map((s: any) => s.nodeId)).toEqual([
        'bat_dau',
        'phan_loai',
        'la_tieu_cuc',
        'cam_on',
      ]);
    });

    it('stops a loop at the step limit, and a run at its budget', async () => {
      const loop = (
        await http
          .post(api)
          .set(as(token))
          .send({ key: 'vong-lap', name: 'Vòng lặp', graph: loopGraph(6, 0.01) })
          .expect(201)
      ).body;
      const r1 = (
        await http
          .post(`${api}/${loop.id}/runs`)
          .set(as(token))
          .send({ inputs: { chu_de: 'cá' }, budgetUsd: 1 })
          .expect(201)
      ).body;
      const limited = await waitRun(r1.id, ['failed', 'completed']);
      expect(limited).toMatchObject({
        status: 'failed',
        errorCode: 'WORKFLOW_STEP_LIMIT',
        stepsTaken: 6,
      });
      expect(limited.steps.filter((s: any) => s.nodeId === 'viet')).toHaveLength(3);

      await http
        .patch(`${api}/${loop.id}`)
        .set(as(token))
        .send({ graph: loopGraph(50, 0.02) })
        .expect(200);
      const r2 = (
        await http
          .post(`${api}/${loop.id}/runs`)
          .set(as(token))
          .send({ inputs: { chu_de: 'cá' }, budgetUsd: 0.025 })
          .expect(201)
      ).body;
      const broke = await waitRun(r2.id, ['failed', 'completed']);
      expect(broke).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_BUDGET_EXCEEDED' });
      expect(
        broke.steps.filter((s: any) => s.nodeId === 'viet' && s.status === 'completed'),
      ).toHaveLength(8);
      // Steps 4 to 8 ran on less than their $0.02 budget: each gets what the run has left, and the
      // run stops once under $0.01 is left ($0.025 - 8 × $0.002 = $0.009).
      expect(broke.errorMessage).toContain('$0.0090');
      expect(broke.costUsd).toBeLessThanOrEqual(0.025);
    });

    it('restores a failed run from its checkpoint', async () => {
      const skills = (await http.get('/api/v1/ai/skills').set(as(token))).body;
      const ad = skills.find((s: any) => s.key === 'bai-quang-cao-facebook');
      await http
        .patch(`/api/v1/ai/skills/${ad.id}`)
        .set(as(token))
        .send({ status: 'paused' })
        .expect(200);
      const run = (
        await http
          .post(`${api}/${launchId}/runs`)
          .set(as(token))
          .send({ inputs: launchInputs, budgetUsd: 2 })
          .expect(201)
      ).body;
      const failed = await waitRun(run.id, ['failed', 'waiting_approval']);
      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: 'SKILL_PAUSED',
        hasCheckpoint: true,
      });
      const describeCalls = fake.count('/a');

      await http
        .patch(`/api/v1/ai/skills/${ad.id}`)
        .set(as(token))
        .send({ status: 'active' })
        .expect(200);
      await http.post(`${api}/runs/${run.id}/restore`).set(as(memberToken)).expect(403);
      await http.post(`${api}/runs/${run.id}/restore`).set(as(token)).expect(200);
      const resumed = await waitRun(run.id, ['waiting_approval', 'failed']);
      expect(resumed.status).toBe('waiting_approval');
      expect(fake.count('/a')).toBe(describeCalls + 1); // only the ad was written again, not the description
      expect(resumed.steps.filter((s: any) => s.nodeId === 'mo_ta')).toHaveLength(1);
    });

    it('pauses, resumes and cancels', async () => {
      const run = (
        await http
          .post(`${api}/${launchId}/runs`)
          .set(as(token))
          .send({ inputs: launchInputs, budgetUsd: 2 })
          .expect(201)
      ).body;
      await waitRun(run.id, ['waiting_approval']);
      await http.post(`${api}/runs/${run.id}/pause`).set(as(memberToken)).expect(403);
      expect(
        (await http.post(`${api}/runs/${run.id}/pause`).set(as(token)).expect(200)).body.status,
      ).toBe('paused');
      await http.post(`${api}/runs/${run.id}/approve`).set(as(token)).send({}).expect(400);
      expect(
        (await http.post(`${api}/runs/${run.id}/resume`).set(as(token)).expect(200)).body.status,
      ).toBe('waiting_approval');
      const cancelled = (await http.post(`${api}/runs/${run.id}/cancel`).set(as(token)).expect(200))
        .body;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.steps.at(-1)).toMatchObject({ nodeId: 'duyet', status: 'cancelled' });
      await http.post(`${api}/runs/${run.id}/resume`).set(as(token)).expect(400);
    });

    it('waits at a delay step', async () => {
      const graph = {
        maxSteps: 5,
        nodes: [
          loopGraph(1, 1).nodes[0],
          { id: 'cho', type: 'delay', label: 'Chờ', seconds: 1 },
          { id: 'het', type: 'end', label: 'Hết' },
        ],
      };
      const wf = (
        await http
          .post(api)
          .set(as(token))
          .send({ key: 'cho-mot-giay', name: 'Chờ', graph })
          .expect(201)
      ).body;
      const run = (
        await http
          .post(`${api}/${wf.id}/runs`)
          .set(as(token))
          .send({ inputs: { chu_de: 'x' }, budgetUsd: 1 })
          .expect(201)
      ).body;
      const mid = (await http.get(`${api}/runs/${run.id}`).set(as(token))).body;
      expect(mid.status === 'running' ? mid.waitingFor : 'done').not.toBe('task');
      const done = await waitRun(run.id, ['completed', 'failed'], 5000);
      expect(done.status).toBe('completed');
      expect(
        new Date(done.finishedAt).getTime() - new Date(done.createdAt).getTime(),
      ).toBeGreaterThanOrEqual(900);
    });

    it('deletes a workflow for managers only', async () => {
      await http.delete(`${api}/${reviewId}`).set(as(memberToken)).expect(403);
      await http.delete(`${api}/${reviewId}`).set(as(token)).expect(204);
      await http.get(`${api}/${reviewId}`).set(as(token)).expect(404);
    });
  });
});
