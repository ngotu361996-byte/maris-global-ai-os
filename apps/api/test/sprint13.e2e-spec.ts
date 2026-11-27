import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner13@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Hạ tầng',
};

const INFO = {
  hostname: 'may-gpu-01',
  os: 'Windows 10',
  arch: 'x64',
  cpuModel: 'Ryzen 9',
  cpuCores: 16,
  ramTotalMb: 65536,
  gpus: [{ name: 'RTX 4090', memTotalMb: 24564 }],
  agentVersion: '0.13.0',
};

const beat = (over: Record<string, unknown> = {}) => ({
  cpuPct: 12.5,
  ramUsedMb: 16000,
  ramTotalMb: 65536,
  diskUsedGb: 400,
  diskTotalGb: 1000,
  gpus: [
    { index: 0, name: 'RTX 4090', utilPct: 30, memUsedMb: 2000, memTotalMb: 24564, tempC: 55 },
  ],
  cpuTempC: 60,
  ...over,
});

describe('Sprint 13 (e2e): devices and workers', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const api = '/api/v1/devices';
  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  let deviceId: string;
  let deviceKey: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as(token))
      .send({ email: 's13.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
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
  });

  it('creates a device with a one-time pairing string that the worker trades for a key', async () => {
    await http.get(api).set(as(memberToken)).expect(403);
    await http
      .post(api)
      .set(as(memberToken))
      .send({ name: 'Máy GPU', kind: 'gpu_worker' })
      .expect(403);

    const created = (
      await http.post(api).set(as(token)).send({ name: 'Máy GPU', kind: 'gpu_worker' }).expect(201)
    ).body;
    deviceId = created.device.id;
    expect(created.device).toMatchObject({ status: 'pending', online: false, kind: 'gpu_worker' });
    expect(created.device.pairingExpiresAt).toBeTruthy();
    expect(created.pairing).toMatch(
      new RegExp(`^maris1\\.${tenantId}\\.${deviceId}\\.[\\w-]{43}$`),
    );

    // Only hashes are stored.
    const sql = admin();
    const [row] =
      await sql`SELECT pairing_hash, token_hash FROM infra.devices WHERE id = ${deviceId}`;
    expect(row!.pairing_hash).not.toContain(created.pairing.split('.')[3]);
    expect(row!.token_hash).toBeNull();

    const wrong = created.pairing.slice(0, -2) + (created.pairing.endsWith('AA') ? 'BB' : 'AA');
    const bad = await http
      .post('/api/v1/agent/pair')
      .send({ pairing: wrong, info: INFO })
      .expect(401);
    expect(bad.body.error.code).toBe('DEVICE_PAIRING_INVALID');

    const paired = (
      await http
        .post('/api/v1/agent/pair')
        .send({ pairing: created.pairing, info: INFO })
        .expect(200)
    ).body;
    expect(paired).toMatchObject({ deviceId, tenantId, name: 'Máy GPU', heartbeatSec: 15 });
    deviceKey = paired.token;

    // Works once.
    await http
      .post('/api/v1/agent/pair')
      .send({ pairing: created.pairing, info: INFO })
      .expect(401);

    const d = (await http.get(`${api}/${deviceId}`).set(as(token)).expect(200)).body;
    expect(d).toMatchObject({ status: 'active', online: true, pairingExpiresAt: null });
    expect(d.info).toMatchObject({ hostname: 'may-gpu-01', cpuCores: 16 });

    const audit = await sql`SELECT action, actor_user_id FROM security.audit_logs
      WHERE target_id = ${deviceId} ORDER BY created_at`;
    expect(audit.map((a) => a.action)).toEqual(['infra.device.created', 'infra.device.paired']);
    expect(audit[1]!.actor_user_id).toBeNull();
    await sql.end();
  });

  it('records heartbeats, raises warnings once, and reports offline after missed beats', async () => {
    await http.post('/api/v1/agent/heartbeat').send(beat()).expect(401);
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', `${tenantId}.${deviceId}.${'x'.repeat(43)}`)
      .send(beat())
      .expect(401);

    const ok = (
      await http
        .post('/api/v1/agent/heartbeat')
        .set('X-Maris-Device', deviceKey)
        .send(beat())
        .expect(200)
    ).body;
    expect(ok).toMatchObject({ status: 'active', heartbeatSec: 15 });

    const hot = beat({
      diskUsedGb: 950,
      gpus: [
        { index: 0, name: 'RTX 4090', utilPct: 99, memUsedMb: 2000, memTotalMb: 24564, tempC: 88 },
      ],
    });
    for (let i = 0; i < 2; i++)
      await http
        .post('/api/v1/agent/heartbeat')
        .set('X-Maris-Device', deviceKey)
        .send(hot)
        .expect(200);

    // A hotter reading of the same problem is not a new alert.
    const hotter = beat({
      diskUsedGb: 950,
      gpus: [
        { index: 0, name: 'RTX 4090', utilPct: 99, memUsedMb: 2000, memTotalMb: 24564, tempC: 89 },
      ],
    });
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(hotter)
      .expect(200);
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(hot)
      .expect(200);

    const d = (await http.get(`${api}/${deviceId}`).set(as(token)).expect(200)).body;
    expect(d.latest).toMatchObject({ diskUsedGb: 950, cpuPct: 12.5 });
    expect(d.warnings).toEqual(['Ổ đĩa đã dùng 95%', 'GPU 0 nóng 88°C']);

    const metrics = (
      await http.get(`${api}/${deviceId}/metrics?minutes=10`).set(as(token)).expect(200)
    ).body;
    expect(metrics).toHaveLength(5);

    let events = (await http.get(`${api}/${deviceId}/events`).set(as(token)).expect(200)).body;
    const resource = events.filter((e: any) => e.kind === 'resource');
    expect(resource.map((e: any) => e.message).sort()).toEqual([
      'GPU 0 nóng 88°C',
      'Ổ đĩa đã dùng 95%',
    ]);

    // Missed beats: offline, then a reconnect event on the next beat.
    const sql = admin();
    await sql`UPDATE infra.devices SET last_seen_at = now() - interval '5 minutes' WHERE id = ${deviceId}`;
    const off = (await http.get(`${api}/${deviceId}`).set(as(token)).expect(200)).body;
    expect(off.online).toBe(false);
    expect(off.warnings).toEqual(['Mất kết nối']);
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(beat())
      .expect(200);
    events = (await http.get(`${api}/${deviceId}/events`).set(as(token)).expect(200)).body;
    expect(events[0]).toMatchObject({ kind: 'reconnected', level: 'warning' });

    // Old samples are pruned.
    await sql`UPDATE infra.device_metrics SET recorded_at = now() - interval '2 days'
      WHERE device_id = ${deviceId} AND disk_used_gb = 950`;
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(beat())
      .expect(200);
    const [{ n }] =
      await sql`SELECT count(*)::int AS n FROM infra.device_metrics WHERE device_id = ${deviceId}`;
    expect(n).toBe(3);
    await sql.end();
  });

  it('rejects bad samples and keys from another tenant', async () => {
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(beat({ cpuPct: 140 }))
      .expect(400);
    const [, dev, key] = deviceKey.split('.');
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', `00000000-0000-4000-8000-000000000000.${dev}.${key}`)
      .send(beat())
      .expect(401);
  });

  it('pauses, resumes, renames, repairs and revokes', async () => {
    const paused = (await http.post(`${api}/${deviceId}/pause`).set(as(token)).expect(200)).body;
    expect(paused.status).toBe('paused');
    await http.post(`${api}/${deviceId}/pause`).set(as(token)).expect(400);
    const hb = (
      await http
        .post('/api/v1/agent/heartbeat')
        .set('X-Maris-Device', deviceKey)
        .send(beat())
        .expect(200)
    ).body;
    expect(hb.status).toBe('paused');
    await http.post(`${api}/${deviceId}/resume`).set(as(token)).expect(200);

    const renamed = (
      await http
        .patch(`${api}/${deviceId}`)
        .set(as(token))
        .send({ name: 'GPU phòng máy' })
        .expect(200)
    ).body;
    expect(renamed.name).toBe('GPU phòng máy');

    // A new pairing string moves the worker; the old key keeps working until a new one is made.
    const again = (await http.post(`${api}/${deviceId}/pairing`).set(as(token)).expect(201)).body;
    const moved = (
      await http.post('/api/v1/agent/pair').send({ pairing: again.pairing, info: INFO }).expect(200)
    ).body;
    await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(beat())
      .expect(401);
    deviceKey = moved.token;

    const revoked = (await http.post(`${api}/${deviceId}/revoke`).set(as(token)).expect(200)).body;
    expect(revoked).toMatchObject({ status: 'revoked', online: false });
    const r = await http
      .post('/api/v1/agent/heartbeat')
      .set('X-Maris-Device', deviceKey)
      .send(beat())
      .expect(401);
    expect(r.body.error.code).toBe('DEVICE_AUTH_INVALID');
    const p = await http.post(`${api}/${deviceId}/pairing`).set(as(token)).expect(400);
    expect(p.body.error.code).toBe('DEVICE_REVOKED');

    await http.delete(`${api}/${deviceId}`).set(as(token)).expect(204);
    await http.get(`${api}/${deviceId}`).set(as(token)).expect(404);
    expect((await http.get(api).set(as(token)).expect(200)).body).toEqual([]);
  });

  it('reports the server MARIS runs on', async () => {
    const s = (await http.get(`${api}/server`).set(as(token)).expect(200)).body;
    expect(s.cpuCores).toBeGreaterThan(0);
    expect(s.ramTotalMb).toBeGreaterThan(0);
    expect(typeof s.hostname).toBe('string');
  });
});
