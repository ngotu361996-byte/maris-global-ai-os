import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import postgres from 'postgres';
import { totpAt } from '../src/security/totp';
import { admin, APP_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'Owner@Example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ hệ thống',
  tenantName: 'MARIS Việt Nam',
};

describe('Core Platform (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });

  it('reports health', async () => {
    const res = await http.get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up', redis: 'up' });
  });

  it('rejects a weak bootstrap password with a structured error', async () => {
    const res = await http.post('/api/v1/auth/bootstrap').send({ ...OWNER, password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('bootstraps the first owner and tenant exactly once', async () => {
    const res = await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201);
    token = res.body.token;
    expect(token).toBeTruthy();
    const again = await http.post('/api/v1/auth/bootstrap').send({ ...OWNER, email: 'x@example.com' }).expect(409);
    expect(again.body.error.code).toBe('ALREADY_BOOTSTRAPPED');
  });

  it('returns the user and memberships from /auth/me', async () => {
    const res = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.email).toBe('owner@example.com');
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0]).toMatchObject({ tenantName: OWNER.tenantName, role: 'owner' });
    tenantId = res.body.memberships[0].tenantId;
  });

  it('logs in with the right password and refuses a wrong one', async () => {
    await http.post('/api/v1/auth/login').send({ email: OWNER.email, password: 'sai-mat-khau-000' }).expect(401);
    const res = await http.post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(200);
    expect(res.body.token).toBeTruthy();
  });

  it('requires a session and a tenant header', async () => {
    await http.get('/api/v1/tenants/current').expect(401);
    const res = await http.get('/api/v1/tenants/current').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.error.code).toBe('TENANT_REQUIRED');
  });

  it('reads the current tenant, members and roles', async () => {
    const t = await http.get('/api/v1/tenants/current').set(auth()).expect(200);
    expect(t.body.name).toBe(OWNER.tenantName);
    const m = await http.get('/api/v1/tenants/current/members').set(auth()).expect(200);
    expect(m.body).toHaveLength(1);
    const r = await http.get('/api/v1/roles').set(auth()).expect(200);
    expect(r.body.map((x: { key: string }) => x.key).sort()).toEqual(['administrator', 'manager', 'member', 'owner']);
  });

  it('updates role permissions, blocks the owner role and unknown keys, and audits the change', async () => {
    const roles = (await http.get('/api/v1/roles').set(auth())).body as { id: string; key: string }[];
    const member = roles.find((r) => r.key === 'member')!;
    const owner = roles.find((r) => r.key === 'owner')!;
    const res = await http
      .put(`/api/v1/roles/${member.id}/permissions`)
      .set(auth())
      .send({ permissions: ['tenant.read', 'members.read'] })
      .expect(200);
    expect(res.body.permissions).toEqual(['members.read', 'tenant.read']);
    await http.put(`/api/v1/roles/${owner.id}/permissions`).set(auth()).send({ permissions: [] }).expect(403);
    await http.put(`/api/v1/roles/${member.id}/permissions`).set(auth()).send({ permissions: ['root'] }).expect(400);
    const logs = await http.get('/api/v1/audit-logs').set(auth()).expect(200);
    expect(logs.body.map((l: { action: string }) => l.action)).toEqual([
      'role.permissions.updated',
      'member.added',
      'tenant.created',
    ]);
  });

  it('isolates tenants: a foreign tenant id is refused and RLS hides its rows', async () => {
    // A second tenant + user created directly as the owner role, outside the API.
    const sql = admin();
    const otherTenant = '01900000-0000-7000-8000-0000000000b1';
    const otherUser = '01900000-0000-7000-8000-0000000000b2';
    const otherRole = '01900000-0000-7000-8000-0000000000b3';
    await sql`INSERT INTO identity.tenants (id, name, slug) VALUES (${otherTenant}, 'Other', 'other')`;
    await sql`INSERT INTO identity.users (id, email, display_name, password_hash) VALUES (${otherUser}, 'b@example.com', 'B', 'x')`;
    await sql`INSERT INTO identity.roles (id, tenant_id, key, name, builtin) VALUES (${otherRole}, ${otherTenant}, 'owner', 'Owner', true)`;
    await sql`INSERT INTO identity.tenant_members (tenant_id, user_id, role_id) VALUES (${otherTenant}, ${otherUser}, ${otherRole})`;
    await sql.end();

    const res = await http
      .get('/api/v1/tenants/current')
      .set({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': otherTenant })
      .expect(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');

    // Directly as the runtime role: with tenant A in context, tenant B's rows are invisible.
    const appSql = postgres(APP_URL, { max: 1, onnotice: () => {} });
    const rows = await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx`SELECT tenant_id FROM identity.tenant_members`;
    });
    const none = await appSql`SELECT count(*)::int AS n FROM identity.tenants`;
    await appSql.end();
    expect(rows.every((r) => r.tenant_id === tenantId)).toBe(true);
    expect(none[0]!.n).toBe(0); // no context => no tenant rows at all
  });

  it('keeps audit logs append-only and detects tampering', async () => {
    const ok = await http.get('/api/v1/audit-logs/verify').set(auth()).expect(200);
    expect(ok.body).toEqual({ valid: true, checked: 3, brokenAtSeq: null });

    const appSql = postgres(APP_URL, { max: 1, onnotice: () => {} });
    await expect(appSql`UPDATE security.audit_logs SET action = 'x'`).rejects.toThrow();
    await appSql.end();

    const sql = admin();
    await sql`ALTER TABLE security.audit_logs DISABLE TRIGGER audit_logs_no_update`;
    await sql`UPDATE security.audit_logs SET metadata = '{"role":"member"}' WHERE tenant_id = ${tenantId} AND seq = 2`;
    await sql`ALTER TABLE security.audit_logs ENABLE TRIGGER audit_logs_no_update`;
    await sql.end();
    const bad = await http.get('/api/v1/audit-logs/verify').set(auth()).expect(200);
    expect(bad.body).toEqual({ valid: false, checked: 3, brokenAtSeq: 2 });
  });

  it('enables TOTP MFA and then requires the code at login', async () => {
    const setup = await http.post('/api/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${token}`).expect(201);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    await http.post('/api/v1/auth/mfa/totp/verify').set('Authorization', `Bearer ${token}`).send({ code: '000000' }).expect(400);
    const code = totpAt(setup.body.secret, Date.now());
    await http.post('/api/v1/auth/mfa/totp/verify').set('Authorization', `Bearer ${token}`).send({ code }).expect(200);

    const noCode = await http.post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(401);
    expect(noCode.body.error.code).toBe('MFA_REQUIRED');
    await http
      .post('/api/v1/auth/login')
      .send({ email: OWNER.email, password: OWNER.password, totp: totpAt(setup.body.secret, Date.now()) })
      .expect(200);
  });

  it('revokes the session on logout', async () => {
    await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('locks the account after 5 wrong passwords', async () => {
    for (let i = 0; i < 5; i++) {
      await http.post('/api/v1/auth/login').send({ email: OWNER.email, password: 'sai-mat-khau-000' }).expect(401);
    }
    const res = await http.post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(401);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});
