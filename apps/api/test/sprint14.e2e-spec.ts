import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner14@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Worker',
};

const GPU = [
  { index: 0, name: 'RTX 4090', utilPct: 10, memUsedMb: 1000, memTotalMb: 24564, tempC: 50 },
];
const beat = (over: Record<string, unknown> = {}) => ({
  cpuPct: 10,
  ramUsedMb: 8000,
  ramTotalMb: 32000,
  diskUsedGb: 100,
  diskTotalGb: 1000,
  gpus: [],
  cpuTempC: null,
  capabilities: ['diagnostics', 'test.wait', 'nonsense.kind'],
  ...over,
});

describe('Sprint 14 (e2e): jobs for workers', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const as = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });
  const jobs = '/api/v1/worker-jobs';
  const A = { id: '', key: '' }; // GPU machine
  const B = { id: '', key: '' }; // admin PC, no GPU

  const agent = (key: string) => ({ 'X-Maris-Device': key });
  const claim = async (d: { key: string }) =>
    (await http.post('/api/v1/agent/jobs/claim').set(agent(d.key)).send({}).expect(200)).body;
  const progress = async (d: { key: string }, id: string, body: object = {}) =>
    (await http.post(`/api/v1/agent/jobs/${id}/progress`).set(agent(d.key)).send(body).expect(200))
      .body;
  const finish = async (d: { key: string }, id: string, body: object) =>
    (await http.post(`/api/v1/agent/jobs/${id}/finish`).set(agent(d.key)).send(body).expect(200))
      .body;
  const create = async (body: object) =>
    (await http.post(jobs).set(as()).send(body).expect(201)).body;
  const get = async (id: string) => (await http.get(`${jobs}/${id}`).set(as()).expect(200)).body;

  async function device(name: string, kind: string, gpus: object[]) {
    const c = (await http.post('/api/v1/devices').set(as()).send({ name, kind }).expect(201)).body;
    const p = (
      await http
        .post('/api/v1/agent/pair')
        .send({ pairing: c.pairing, info: { hostname: name } })
        .expect(200)
    ).body;
    await http.post('/api/v1/agent/heartbeat').set(agent(p.token)).send(beat({ gpus })).expect(200);
    return { id: c.device.id as string, key: p.token as string };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    Object.assign(A, await device('GPU-01', 'gpu_worker', GPU));
    Object.assign(B, await device('PC-01', 'admin_pc', []));
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps only known job kinds as capabilities and validates job input', async () => {
    const d = (await http.get(`/api/v1/devices/${A.id}`).set(as()).expect(200)).body;
    expect(d).toMatchObject({
      capabilities: ['diagnostics', 'test.wait'],
      maxJobs: 1,
      runningJobs: 0,
    });

    const bad = await http
      .post(jobs)
      .set(as())
      .send({ kind: 'test.wait', input: { seconds: 0 } })
      .expect(400);
    expect(bad.body.error.code).toBe('JOB_INPUT_INVALID');
    await http
      .post(jobs)
      .set(as())
      .send({ kind: 'test.wait', input: { command: 'rm -rf /' } })
      .expect(400);
    await http.post(jobs).set(as()).send({ kind: 'shell', input: {} }).expect(400);
  });

  it('gives GPU work only to a GPU machine, one job at a time per its limit', async () => {
    const j = await create({ kind: 'test.wait', input: { seconds: 5 }, needGpu: true });
    expect(j).toMatchObject({
      status: 'queued',
      title: 'Việc thử',
      input: { seconds: 5, fail: false },
    });

    expect((await claim(B)).job).toBeNull();
    const got = (await claim(A)).job;
    expect(got).toMatchObject({ id: j.id, kind: 'test.wait', input: { seconds: 5, fail: false } });

    // A is full (max 1), so a second job waits even though A could run it.
    const j2 = await create({ kind: 'diagnostics', targetDeviceId: A.id });
    expect((await claim(A)).job).toBeNull();

    expect(
      await progress(A, j.id, { progress: 40, note: '2/5 giây', logs: [{ message: 'đang đếm' }] }),
    ).toEqual({
      cancel: false,
      leaseSec: 60,
    });
    const d = (await http.get(`/api/v1/devices/${A.id}`).set(as()).expect(200)).body;
    expect(d.runningJobs).toBe(1);

    expect(await finish(A, j.id, { status: 'completed', result: { waited: 5 } })).toEqual({
      accepted: true,
    });
    // Repeated report is ignored.
    expect(await finish(A, j.id, { status: 'failed' })).toEqual({ accepted: false });
    const done = await get(j.id);
    expect(done).toMatchObject({
      status: 'completed',
      progress: 100,
      result: { waited: 5 },
      deviceName: 'GPU-01',
    });
    expect(done.logs.map((l: any) => l.message)).toEqual([
      'Đã giao việc, chờ Worker nhận',
      'GPU-01 nhận việc (lần 1/3)',
      'đang đếm',
      'GPU-01 làm xong',
    ]);

    // Raising the limit lets A take more; the targeted job is A's only.
    await http.patch(`/api/v1/devices/${A.id}`).set(as()).send({ maxJobs: 2 }).expect(200);
    expect((await claim(B)).job).toBeNull();
    expect((await claim(A)).job.id).toBe(j2.id);
    await finish(A, j2.id, { status: 'completed', result: { ok: true } });
  });

  it('moves a job to another worker when its worker goes quiet, and stops the old one', async () => {
    const j = await create({ kind: 'test.wait', input: { seconds: 60 } });
    expect((await claim(B)).job.id).toBe(j.id);

    const sql = admin();
    await sql`UPDATE infra.worker_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${j.id}`;
    await sql.end();

    // B lost it: it is told to stop, and cannot take it straight back.
    expect(await progress(B, j.id, { progress: 10 })).toMatchObject({ cancel: true });
    expect((await claim(B)).job).toBeNull();
    expect((await claim(A)).job.id).toBe(j.id);
    expect(await finish(B, j.id, { status: 'completed' })).toEqual({ accepted: false });

    // An admin can move it too.
    const moved = (await http.post(`${jobs}/${j.id}/reassign`).set(as()).expect(200)).body;
    expect(moved).toMatchObject({ status: 'queued', deviceId: null });
    expect(await progress(A, j.id)).toMatchObject({ cancel: true });
    // Both have lost it now; after a minute in the queue an earlier worker may take it back.
    expect((await claim(B)).job).toBeNull();
    const sql1 = admin();
    await sql1`UPDATE infra.worker_jobs SET updated_at = now() - interval '2 minutes' WHERE id = ${j.id}`;
    await sql1.end();
    expect((await claim(B)).job.id).toBe(j.id);
    const after = await get(j.id);
    expect(after.attempts).toBe(3);
    expect(
      after.logs.some((l: any) => l.message === 'PC-01 mất kết nối, chuyển việc sang Worker khác'),
    ).toBe(true);

    // Lost on its last attempt: it fails instead.
    const sql2 = admin();
    await sql2`UPDATE infra.worker_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${j.id}`;
    await sql2.end();
    const failed = (await http.get(`${jobs}/${j.id}`).set(as()).expect(200)).body;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'WORKER_LOST' });
  });

  it('cancels waiting and running jobs', async () => {
    const queued = await create({ kind: 'diagnostics', targetDeviceId: B.id, priority: -1 });
    const c1 = (await http.post(`${jobs}/${queued.id}/cancel`).set(as()).expect(200)).body;
    expect(c1.status).toBe('cancelled');
    await http.post(`${jobs}/${queued.id}/cancel`).set(as()).expect(400);

    const j = await create({ kind: 'test.wait', input: { seconds: 60 }, targetDeviceId: B.id });
    expect((await claim(B)).job.id).toBe(j.id);
    const c2 = (await http.post(`${jobs}/${j.id}/cancel`).set(as()).expect(200)).body;
    expect(c2).toMatchObject({ status: 'running', cancelRequested: true });
    expect(await progress(B, j.id)).toMatchObject({ cancel: true });
    await finish(B, j.id, { status: 'cancelled' });
    expect((await get(j.id)).status).toBe('cancelled');
  });

  it('records failures as device events, retries, and stops jobs past their time', async () => {
    const j = await create({
      kind: 'test.wait',
      input: { seconds: 1, fail: true },
      targetDeviceId: B.id,
    });
    expect((await claim(B)).job.id).toBe(j.id);
    const big = await http
      .post(`/api/v1/agent/jobs/${j.id}/finish`)
      .set(agent(B.key))
      .send({ status: 'completed', result: 'x'.repeat(70_000) })
      .expect(400);
    expect(big.body.error.code).toBe('JOB_RESULT_TOO_LARGE');
    await finish(B, j.id, { status: 'failed', errorCode: 'TEST_FAILURE', errorMessage: 'Lỗi thử' });
    expect(await get(j.id)).toMatchObject({
      status: 'failed',
      errorCode: 'TEST_FAILURE',
      errorMessage: 'Lỗi thử',
    });
    const events = (await http.get(`/api/v1/devices/${B.id}/events`).set(as()).expect(200)).body;
    expect(events[0]).toMatchObject({
      kind: 'job_failed',
      message: 'Việc “Việc thử” lỗi: Lỗi thử',
    });

    const again = (await http.post(`${jobs}/${j.id}/retry`).set(as()).expect(201)).body;
    expect(again).toMatchObject({ status: 'queued', input: { seconds: 1, fail: true } });
    expect((await claim(B)).job.id).toBe(again.id);

    const sql = admin();
    await sql`UPDATE infra.worker_jobs SET started_at = now() - interval '1 hour' WHERE id = ${again.id}`;
    await sql.end();
    expect(await progress(B, again.id)).toMatchObject({ cancel: true });
    expect(await get(again.id)).toMatchObject({ status: 'failed', errorCode: 'JOB_TIMEOUT' });
  });

  it('gives no work to paused, full, low-memory or incapable workers, and requeues on revoke', async () => {
    const j = await create({ kind: 'test.wait', input: { seconds: 5 }, targetDeviceId: B.id });
    await http.post(`/api/v1/devices/${B.id}/pause`).set(as()).expect(200);
    expect((await claim(B)).job).toBeNull();
    await http.post(`/api/v1/devices/${B.id}/resume`).set(as()).expect(200);

    await http.patch(`/api/v1/devices/${B.id}`).set(as()).send({ maxJobs: 0 }).expect(200);
    expect((await claim(B)).job).toBeNull();
    await http.patch(`/api/v1/devices/${B.id}`).set(as()).send({ maxJobs: 1 }).expect(200);

    await http
      .post('/api/v1/agent/heartbeat')
      .set(agent(B.key))
      .send(beat({ ramUsedMb: 31_500 }))
      .expect(200);
    expect((await claim(B)).job).toBeNull();
    await http.post('/api/v1/agent/heartbeat').set(agent(B.key)).send(beat()).expect(200);

    const ai = await create({
      kind: 'ollama.generate',
      input: { model: 'llama3.2', prompt: 'Chào' },
      priority: 5,
    });
    expect((await claim(B)).job.id).toBe(j.id); // B cannot run Ollama, so it skips the higher priority job
    expect((await get(ai.id)).status).toBe('queued');

    await http.post(`/api/v1/devices/${B.id}/revoke`).set(as()).expect(200);
    const back = await get(j.id);
    expect(back).toMatchObject({ status: 'queued', deviceId: null });
    expect(back.logs.at(-1).message).toBe(
      'Thiết bị bị thu hồi (PC-01), chuyển việc về hàng đợi cho Worker khác',
    );
    await http.post('/api/v1/agent/jobs/claim').set(agent(B.key)).send({}).expect(401);

    const list = (await http.get(`${jobs}?status=queued`).set(as()).expect(200)).body;
    expect(list.map((x: any) => x.id).sort()).toEqual([ai.id, j.id].sort());

    const sql = admin();
    const audit =
      await sql`SELECT action FROM security.audit_logs WHERE target_type = 'worker_job'`;
    const actions = new Set(audit.map((a) => a.action));
    await sql.end();
    for (const a of ['infra.job.created', 'infra.job.cancelled', 'infra.job.reassigned'])
      expect(actions.has(a)).toBe(true);
  });
});
