import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PLUGIN_SAMPLES, type PluginManifestInput } from '@maris/contracts';
import { definePlugin, generatePublisherKeys, signPlugin } from '@maris/sdk';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner12@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Owner',
  tenantName: 'Công ty Plugin',
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sample = (): PluginManifestInput => clone(PLUGIN_SAMPLES[0]!.manifest);

/** Version 1.1.0 of the sample: adds a read-only connector and its test. */
function withConnector(): PluginManifestInput {
  const m = sample();
  m.version = '1.1.0';
  m.permissions = ['ai.generate_text', 'connector.read', 'workflow.run'];
  m.contents.connectors = [
    {
      format: 'maris.connector/v1',
      key: 'kho-danh-gia',
      kind: 'http',
      name: 'Kho đánh giá',
      description: 'Đọc đánh giá mới',
      baseUrl: 'https://api.example.com/v1',
      auth: { type: 'none' },
      headers: {},
      timeoutSec: 15,
      capabilities: [
        {
          key: 'danh_gia_moi',
          label: 'Đánh giá mới',
          description: '',
          risk: 'read',
          method: 'GET',
          path: '/reviews/{{input.shop}}',
          query: {},
          body: null,
          inputs: [{ name: 'shop', label: 'Cửa hàng', type: 'text', required: true }],
          outputPath: null,
        },
      ],
      webhook: null,
    },
  ];
  m.tests = [
    ...m.tests,
    {
      kind: 'connector',
      name: 'Tạo được yêu cầu đọc',
      key: 'kho-danh-gia',
      capability: 'danh_gia_moi',
      inputs: { shop: 'shop-1' },
    },
  ];
  return m;
}

describe('Sprint 12 (e2e): Plugin Center and Extension SDK', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const api = '/api/v1/plugins';
  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const publisher = generatePublisherKeys();
  let pluginId: string;
  let publisherId: string;

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
      .send({ email: 's12.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
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

  it('installs the sample with every part off, and activates unsigned only when told to', async () => {
    await http.get(api).set(as(memberToken)).expect(403);
    await http.post(api).set(as(memberToken)).send({ manifest: sample() }).expect(403);

    const p = (await http.post(api).set(as(token)).send({ manifest: sample() }).expect(201)).body;
    pluginId = p.id;
    expect(p).toMatchObject({
      key: 'cham-soc-danh-gia',
      version: '1.0.0',
      status: 'installed',
      signatureStatus: 'unsigned',
      permissions: ['ai.generate_text', 'workflow.run'],
    });
    expect(p.checksum).toBe(definePlugin(sample()).checksum);
    expect(p.components.map((c: any) => [c.kind, c.key, c.status])).toEqual([
      ['skill', 'tra-loi-danh-gia', 'paused'],
      ['workflow', 'xu-ly-danh-gia', 'paused'],
    ]);
    expect(p.tests.every((t: any) => t.ok)).toBe(true);
    expect(p.checks.find((c: any) => c.key === 'signature').ok).toBe(false);

    const refused = await http
      .post(`${api}/${pluginId}/activate`)
      .set(as(token))
      .send({})
      .expect(400);
    expect(refused.body.error.code).toBe('PLUGIN_CHECK_FAILED');
    await http
      .post(`${api}/${pluginId}/activate`)
      .set(as(memberToken))
      .send({ allowUnsigned: true })
      .expect(403);
    const on = (
      await http
        .post(`${api}/${pluginId}/activate`)
        .set(as(token))
        .send({ allowUnsigned: true })
        .expect(200)
    ).body;
    expect(on.status).toBe('active');
    expect(on.components.every((c: any) => c.status === 'active')).toBe(true);

    // The installed skill and workflow work like any other.
    const skills = (await http.get('/api/v1/ai/skills').set(as(token)).expect(200)).body;
    expect(skills.find((s: any) => s.key === 'tra-loi-danh-gia').status).toBe('active');

    const sql = admin();
    const logs = await sql`SELECT action, metadata FROM security.audit_logs
      WHERE tenant_id = ${tenantId} AND target_type = 'plugin' ORDER BY created_at`;
    await sql.end();
    expect(logs.map((l) => l.action)).toEqual(['plugin.installed', 'plugin.activated']);
    expect(logs[1]!.metadata).toMatchObject({ allowUnsigned: true, signature: 'unsigned' });
  });

  it('refuses changed files, missing permissions, failing tests and taken keys', async () => {
    const packed = definePlugin({ ...sample(), key: 'ban-sao' });
    const changed = { ...packed, description: 'Đã sửa sau khi đóng gói' };
    const r1 = await http.post(api).set(as(token)).send({ manifest: changed }).expect(400);
    expect(r1.body.error.code).toBe('PLUGIN_CHECKSUM_MISMATCH');

    const noPerm = { ...sample(), key: 'thieu-quyen', permissions: ['workflow.run'] };
    const r2 = await http.post(api).set(as(token)).send({ manifest: noPerm }).expect(400);
    expect(r2.body.error.code).toBe('PLUGIN_INVALID');
    expect(r2.body.error.message).toContain('ai.generate_text');

    const failing = sample();
    failing.key = 'kiem-tra-truot';
    failing.contents.skills![0]!.key = 'skill-khac';
    failing.contents.workflows![0]!.key = 'workflow-khac';
    failing.contents.workflows![0]!.graph.nodes[1] = {
      ...(failing.contents.workflows![0]!.graph.nodes[1] as object),
      skillKey: 'skill-khac',
    } as never;
    failing.tests = [{ kind: 'workflow', name: 'Thiếu ô', key: 'workflow-khac', inputs: {} }];
    const r3 = await http.post(api).set(as(token)).send({ manifest: failing }).expect(400);
    expect(r3.body.error.code).toBe('PLUGIN_TEST_FAILED');

    const again = await http.post(api).set(as(token)).send({ manifest: sample() }).expect(409);
    expect(again.body.error.code).toBe('PLUGIN_EXISTS');

    const taken = { ...sample(), key: 'plugin-khac' };
    const r4 = await http.post(api).set(as(token)).send({ manifest: taken }).expect(409);
    expect(r4.body.error.code).toBe('PLUGIN_COMPONENT_CONFLICT');
  });

  it('checks signatures against trusted publisher keys', async () => {
    const signed = signPlugin(withConnector(), publisher.privateKey, 'maris.lab');

    // A key nobody trusts yet: installs as "untrusted" and cannot be activated without the override.
    const up = (
      await http.post(api).set(as(token)).send({ manifest: signed, replace: true }).expect(201)
    ).body;
    expect(up).toMatchObject({
      version: '1.1.0',
      status: 'installed',
      signatureStatus: 'untrusted',
    });
    expect(up.components.map((c: any) => [c.key, c.status])).toEqual([
      ['tra-loi-danh-gia', 'paused'],
      ['kho-danh-gia', 'draft'],
      ['xu-ly-danh-gia', 'paused'],
    ]);

    const pub = {
      keyId: 'maris.lab',
      name: 'MARIS Lab',
      publicKey: publisher.publicKey,
    };
    await http.post(`${api}/publishers`).set(as(memberToken)).send(pub).expect(403);
    await http
      .post(`${api}/publishers`)
      .set(as(token))
      .send({ ...pub, publicKey: 'không phải khóa' })
      .expect(400);
    const added = (await http.post(`${api}/publishers`).set(as(token)).send(pub).expect(201)).body;
    publisherId = added.id;
    expect(added.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // Now trusted: activation needs no override, and turns the connector on too.
    const on = (await http.post(`${api}/${pluginId}/activate`).set(as(token)).send({}).expect(200))
      .body;
    expect(on.checks.find((c: any) => c.key === 'signature').ok).toBe(true);
    expect(on.components.every((c: any) => c.status === 'active')).toBe(true);

    // The same key id signing other content with another key is refused outright.
    const impostor = generatePublisherKeys();
    const forged = signPlugin(
      { ...withConnector(), version: '1.2.0' },
      impostor.privateKey,
      'maris.lab',
    );
    const r = await http
      .post(api)
      .set(as(token))
      .send({ manifest: forged, replace: true })
      .expect(400);
    expect(r.body.error.code).toBe('PLUGIN_SIGNATURE_INVALID');

    // Distrusting the key pauses what it signed.
    await http.delete(`${api}/publishers/${publisherId}`).set(as(token)).expect(204);
    const after = (await http.get(`${api}/${pluginId}`).set(as(token)).expect(200)).body;
    expect(after).toMatchObject({ status: 'paused', signatureStatus: 'untrusted' });
    expect(after.components.every((c: any) => c.status === 'paused')).toBe(true);
  });

  it('keeps versions, rolls back, and checks dependencies before activation and removal', async () => {
    const versions = (await http.get(`${api}/${pluginId}/versions`).set(as(token)).expect(200))
      .body;
    expect(versions.map((v: any) => v.version)).toEqual(['1.1.0', '1.0.0']);
    const back = (
      await http
        .post(`${api}/${pluginId}/versions/${versions[1].id}/restore`)
        .set(as(token))
        .expect(200)
    ).body;
    expect(back.version).toBe('1.0.0');
    expect(back.components.map((c: any) => c.key)).toEqual(['tra-loi-danh-gia', 'xu-ly-danh-gia']);
    const connectors = (await http.get('/api/v1/connectors').set(as(token)).expect(200)).body;
    expect(connectors.some((c: any) => c.key === 'kho-danh-gia')).toBe(false);

    const dependent = sample();
    dependent.key = 'mo-rong-danh-gia';
    dependent.name = 'Mở rộng';
    dependent.dependencies = [{ key: 'cham-soc-danh-gia', version: '^2.0.0' }];
    dependent.contents.skills![0]!.key = 'tra-loi-danh-gia-2';
    dependent.contents.workflows = [];
    dependent.permissions = ['ai.generate_text'];
    dependent.tests = [dependent.tests[0]!];
    dependent.tests[0]!.key = 'tra-loi-danh-gia-2';
    const dep = (await http.post(api).set(as(token)).send({ manifest: dependent }).expect(201))
      .body;
    const depCheck = dep.checks.find((c: any) => c.key === 'dependencies');
    expect(depCheck).toMatchObject({ ok: false });
    expect(depCheck.detail).toContain('cần ^2.0.0');
    await http
      .post(`${api}/${dep.id}/activate`)
      .set(as(token))
      .send({ allowUnsigned: true })
      .expect(400);

    const blocked = await http.delete(`${api}/${pluginId}`).set(as(token)).expect(409);
    expect(blocked.body.error.code).toBe('PLUGIN_REQUIRED');
    await http.delete(`${api}/${dep.id}`).set(as(token)).expect(204);
  });

  it('revokes an unsafe plugin for good, then removes it and its parts', async () => {
    await http.post(`${api}/${pluginId}/revoke`).set(as(token)).send({ reason: '' }).expect(400);
    const revoked = (
      await http
        .post(`${api}/${pluginId}/revoke`)
        .set(as(token))
        .send({ reason: 'Nhà phát hành báo lỗi bảo mật' })
        .expect(200)
    ).body;
    expect(revoked.status).toBe('revoked');
    const r = await http
      .post(`${api}/${pluginId}/activate`)
      .set(as(token))
      .send({ allowUnsigned: true })
      .expect(400);
    expect(r.body.error.code).toBe('PLUGIN_REVOKED');

    const exported = (await http.get(`${api}/${pluginId}/export`).set(as(token)).expect(200)).body;
    expect(exported.format).toBe('maris.plugin/v1');

    await http.delete(`${api}/${pluginId}`).set(as(token)).expect(204);
    await http.get(`${api}/${pluginId}`).set(as(token)).expect(404);
    const skills = (await http.get('/api/v1/ai/skills').set(as(token)).expect(200)).body;
    expect(skills.some((s: any) => s.key === 'tra-loi-danh-gia')).toBe(false);

    // Removed, so the same file installs fresh.
    await http.post(api).set(as(token)).send({ manifest: sample() }).expect(201);
  });
});
