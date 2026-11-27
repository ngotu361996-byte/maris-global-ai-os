import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildChecks } from '../src/devices/system-monitor.service';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner15@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Sandbox',
};

const beat = (capabilities: string[]) => ({
  cpuPct: 10,
  ramUsedMb: 4000,
  ramTotalMb: 16000,
  diskUsedGb: 100,
  diskTotalGb: 500,
  gpus: [],
  cpuTempC: null,
  capabilities,
});
const CODE = 'print(input().upper())';

describe('Sprint 15 (e2e): code sandbox jobs and system monitoring', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const as = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });
  const jobs = '/api/v1/worker-jobs';
  const agent = (key: string) => ({ 'X-Maris-Device': key });
  const claim = async (key: string) =>
    (await http.post('/api/v1/agent/jobs/claim').set(agent(key)).send({}).expect(200)).body.job;
  const RUNNER = { id: '', key: '' };
  const PC = { id: '', key: '' };

  async function device(name: string, kind: string) {
    const c = (await http.post('/api/v1/devices').set(as()).send({ name, kind }).expect(201)).body;
    const p = (
      await http
        .post('/api/v1/agent/pair')
        .send({ pairing: c.pairing, info: { hostname: name } })
        .expect(200)
    ).body;
    // Both workers say they can run code; only the Code Runner is believed.
    await http
      .post('/api/v1/agent/heartbeat')
      .set(agent(p.token))
      .send(beat(['diagnostics', 'test.wait', 'code.run']))
      .expect(200);
    return { id: c.device.id as string, key: p.token as string };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    Object.assign(RUNNER, await device('CODE-01', 'code_runner'));
    Object.assign(PC, await device('PC-01', 'admin_pc'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts code.run only from a Code Runner device and validates code input', async () => {
    const pc = (await http.get(`/api/v1/devices/${PC.id}`).set(as()).expect(200)).body;
    expect(pc.capabilities).toEqual(['diagnostics', 'test.wait']);
    const runner = (await http.get(`/api/v1/devices/${RUNNER.id}`).set(as()).expect(200)).body;
    expect(runner.capabilities).toEqual(['diagnostics', 'test.wait', 'code.run']);

    for (const input of [
      { language: 'bash', code: 'ls' },
      { language: 'python', code: '' },
      { language: 'python', code: 'x'.repeat(50_001) },
      { language: 'python', code: 'print(1)', image: 'alpine' },
    ]) {
      const r = await http.post(jobs).set(as()).send({ kind: 'code.run', input }).expect(400);
      expect(r.body.error.code).toBe('JOB_INPUT_INVALID');
    }
    const long = await http
      .post(jobs)
      .set(as())
      .send({ kind: 'code.run', input: { language: 'python', code: CODE }, timeoutSec: 601 })
      .expect(400);
    expect(long.body.error.code).toBe('JOB_INPUT_INVALID');
    const wrongDevice = await http
      .post(jobs)
      .set(as())
      .send({ kind: 'code.run', input: { language: 'node', code: CODE }, targetDeviceId: PC.id })
      .expect(400);
    expect(wrongDevice.body.error.code).toBe('DEVICE_NOT_CODE_RUNNER');
  });

  it('sends code only to the Code Runner, whatever target was asked for, and audits a hash', async () => {
    const j = (
      await http
        .post(jobs)
        .set(as())
        .send({
          kind: 'code.run',
          input: { language: 'python', code: CODE, stdin: 'xin chào' },
          targetKinds: ['admin_pc'],
          maxAttempts: 1,
        })
        .expect(201)
    ).body;
    expect(j).toMatchObject({
      status: 'queued',
      title: 'Chạy mã trong sandbox',
      targetKinds: ['code_runner'],
      timeoutSec: 120,
    });

    expect(await claim(PC.key)).toBeNull();
    const got = await claim(RUNNER.key);
    expect(got).toMatchObject({
      id: j.id,
      kind: 'code.run',
      input: { language: 'python', code: CODE, stdin: 'xin chào' },
      timeoutSec: 120,
    });
    const result = {
      language: 'python',
      exitCode: 0,
      timedOut: false,
      durationMs: 812,
      stdout: 'XIN CHÀO\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    await http
      .post(`/api/v1/agent/jobs/${j.id}/finish`)
      .set(agent(RUNNER.key))
      .send({ status: 'completed', result })
      .expect(200);
    const done = (await http.get(`${jobs}/${j.id}`).set(as()).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', result, deviceName: 'CODE-01' });

    // A timed-out run is a failure that still carries what the program printed.
    const t = (
      await http
        .post(jobs)
        .set(as())
        .send({ kind: 'code.run', input: { language: 'node', code: 'for(;;){}' }, timeoutSec: 10 })
        .expect(201)
    ).body;
    expect((await claim(RUNNER.key)).id).toBe(t.id);
    await http
      .post(`/api/v1/agent/jobs/${t.id}/finish`)
      .set(agent(RUNNER.key))
      .send({
        status: 'failed',
        errorCode: 'CODE_TIMEOUT',
        errorMessage: 'Chương trình chạy quá 5 giây nên đã bị dừng',
        result: { ...result, language: 'node', exitCode: null, timedOut: true, stdout: '' },
      })
      .expect(200);
    expect((await http.get(`${jobs}/${t.id}`).set(as()).expect(200)).body).toMatchObject({
      status: 'failed',
      errorCode: 'CODE_TIMEOUT',
      result: { timedOut: true },
    });

    const sql = admin();
    const [entry] = await sql`SELECT metadata FROM security.audit_logs
      WHERE action = 'infra.job.created' AND target_id = ${j.id}`;
    await sql.end();
    expect(entry!.metadata).toMatchObject({
      kind: 'code.run',
      language: 'python',
      codeSha256: createHash('sha256').update(CODE).digest('hex'),
      codeChars: CODE.length,
    });
    expect(JSON.stringify(entry!.metadata)).not.toContain('upper');
  });

  it('needs the infra.code permission to queue or retry code', async () => {
    const [done] = (await http.get(`${jobs}?status=completed`).set(as()).expect(200)).body;
    const sql = admin();
    await sql`DELETE FROM identity.role_permissions WHERE permission_key = 'infra.code'`;
    try {
      const r = await http
        .post(jobs)
        .set(as())
        .send({ kind: 'code.run', input: { language: 'python', code: CODE } })
        .expect(403);
      expect(r.body.error).toEqual({
        code: 'PERMISSION_DENIED',
        message: 'Thiếu quyền infra.code',
      });
      await http.post(`${jobs}/${done.id}/retry`).set(as()).expect(403);
      // Other kinds still work.
      await http.post(jobs).set(as()).send({ kind: 'diagnostics' }).expect(201);
    } finally {
      await sql`INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
        SELECT tenant_id, id, 'infra.code' FROM identity.roles
        WHERE builtin AND key IN ('owner', 'administrator')`;
      await sql.end();
    }
    const again = (await http.post(`${jobs}/${done.id}/retry`).set(as()).expect(201)).body;
    expect(again).toMatchObject({ kind: 'code.run', targetKinds: ['code_runner'] });
  });

  it('reports the system: API, database, Redis, queues, activity, devices and recent errors', async () => {
    await http.get('/api/v1/system/monitor').expect(401);
    const m = (await http.get('/api/v1/system/monitor').set(as()).expect(200)).body;
    expect(m.api.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(m.database).toMatchObject({ up: true });
    expect(m.database.sizeMb).toBeGreaterThan(0);
    expect(m.database.connections).toBeGreaterThan(0);
    expect(m.redis).toMatchObject({ up: true });
    expect(m.queues.map((q: { name: string }) => q.name)).toEqual([
      'maris-tasks',
      'maris-plans',
      'maris-council',
      'maris-workflows',
      'maris-events',
    ]);
    expect(m.devices).toMatchObject({ total: 2, online: 2, offline: 0 });
    expect(m.activity).toMatchObject({ workerJobsFailed24h: 1, aiCalls24h: 0 });
    expect(m.activity.workerJobsQueued).toBeGreaterThanOrEqual(2);
    expect(m.recentErrors[0]).toMatchObject({ source: 'worker_job' });
    expect(m.recentErrors[0].message).toContain('CODE_TIMEOUT');
    const keys = m.checks.map((c: { key: string }) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'api',
        'database',
        'redis',
        'queues',
        'outbox',
        'ai',
        'failures',
        'devices',
      ]),
    );
    const byKey = Object.fromEntries(m.checks.map((c: { key: string }) => [c.key, c]));
    expect(byKey.database.status).toBe('ok');
    expect(byKey.failures.status).toBe('warning');
    expect(['ok', 'warning', 'error']).toContain(m.status);
  });

  it('turns numbers into checks: a dead database is an error, a high AI error rate a warning', () => {
    const base: Parameters<typeof buildChecks>[0] & {
      tenant: NonNullable<Parameters<typeof buildChecks>[0]['tenant']>;
    } = {
      api: {
        uptimeSec: 100,
        nodeVersion: 'v22',
        rssMb: 100,
        heapUsedMb: 50,
        heapLimitMb: 2000,
        pid: 1,
      },
      database: { up: true, latencyMs: 3, sizeMb: 20, connections: 5, version: '16' },
      redis: { up: true, latencyMs: 1, usedMemoryMb: 2, version: '7' },
      queues: [],
      tenant: {
        activity: {
          aiCalls24h: 0,
          aiErrors24h: 0,
          aiCalls1h: 10,
          aiErrors1h: 3,
          aiAvgLatencyMs24h: 900,
          tasksFailed24h: 0,
          workflowRunsFailed24h: 0,
          workflowRunsWaitingApproval: 0,
          connectorCallsFailed24h: 0,
          workerJobsQueued: 0,
          workerJobsRunning: 0,
          workerJobsFailed24h: 0,
        },
        outbox: { pending: 60, oldestPendingSec: 10 },
      },
      devices: { total: 1, online: 1, offline: 0, withWarnings: 0 },
      deviceList: [{}],
    };
    const status = (s: typeof base) =>
      Object.fromEntries(buildChecks(s).map((c) => [c.key, c.status]));
    expect(status(base)).toMatchObject({
      api: 'ok',
      database: 'ok',
      redis: 'ok',
      ai: 'warning',
      outbox: 'warning',
      failures: 'ok',
      devices: 'ok',
    });
    const down = status({
      ...base,
      database: { up: false, latencyMs: null, sizeMb: null, connections: null, version: null },
      redis: { up: false, latencyMs: null, usedMemoryMb: null, version: null },
      queues: null,
    });
    expect(down).toMatchObject({ database: 'error', redis: 'error', queues: 'error' });
    const aiDown = status({
      ...base,
      tenant: { ...base.tenant, activity: { ...base.tenant.activity, aiErrors1h: 6 } },
    });
    expect(aiDown.ai).toBe('error');
  });
});
