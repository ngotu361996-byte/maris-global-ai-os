import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Queue } from 'bullmq';
import { OutboxService, EVENTS_QUEUE } from '../src/outbox/outbox.service';
import { SecretVaultService } from '../src/secrets/secret-vault.service';
import { DbService } from '../src/db/db.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = { email: 'owner2@example.com', password: 'mat-khau-rat-dai-123', displayName: 'Owner', tenantName: 'Công ty A' };

describe('Sprint 2 (e2e): members, Secret Vault, outbox, rate limit, cookie sessions', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  let roleIds: Record<string, string>;

  const as = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });

  beforeAll(async () => {
    await resetDatabase();
    const q = new Queue(EVENTS_QUEUE, { connection: { url: REDIS_URL } });
    await q.obliterate({ force: true });
    await q.close();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as(token)).expect(200)).body as { id: string; key: string }[];
    roleIds = Object.fromEntries(roles.map((r) => [r.key, r.id]));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('invitations and members', () => {
    let memberToken: string;
    let memberId: string;

    it('refuses to invite as owner', async () => {
      const res = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as(token))
        .send({ email: 'x@example.com', roleId: roleIds.owner })
        .expect(403);
      expect(res.body.error.code).toBe('OWNER_NOT_ASSIGNABLE');
    });

    it('invites a new person, who accepts and becomes a member', async () => {
      const inv = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as(token))
        .send({ email: 'New.Member@Example.com', roleId: roleIds.member })
        .expect(201);
      expect(inv.body).toMatchObject({ email: 'new.member@example.com', role: 'member', status: 'pending' });
      expect(inv.body.token).toBeTruthy();

      await http.post('/api/v1/invitations/accept').send({ token: inv.body.token, password: 'short' }).expect(400);
      const acc = await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'Thành viên' })
        .expect(200);
      memberToken = acc.body.token;
      const me = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${memberToken}`).expect(200);
      memberId = me.body.id;
      expect(me.body.memberships).toEqual([expect.objectContaining({ tenantId, role: 'member' })]);

      const again = await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'X' })
        .expect(410);
      expect(again.body.error.code).toBe('INVITATION_USED');

      const list = await http.get('/api/v1/tenants/current/invitations').set(as(token)).expect(200);
      expect(list.body[0]).toMatchObject({ status: 'accepted' });
      expect(list.body[0].token).toBeUndefined();
    });

    it('rejects an unknown token', async () => {
      await http.post('/api/v1/invitations/accept').send({ token: 'x'.repeat(43), password: 'p' }).expect(404);
    });

    it('a member without members.manage cannot invite', async () => {
      const res = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as(memberToken))
        .send({ email: 'y@example.com', roleId: roleIds.member })
        .expect(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('changes a role and removes a member, never the owner', async () => {
      await http
        .patch(`/api/v1/tenants/current/members/${memberId}`)
        .set(as(token))
        .send({ roleId: roleIds.manager })
        .expect(204);
      const members = await http.get('/api/v1/tenants/current/members').set(as(token)).expect(200);
      expect(members.body.find((m: { userId: string }) => m.userId === memberId).role).toBe('manager');

      const ownerId = members.body.find((m: { role: string }) => m.role === 'owner').userId;
      await http.delete(`/api/v1/tenants/current/members/${ownerId}`).set(as(token)).expect(403);

      await http.delete(`/api/v1/tenants/current/members/${memberId}`).set(as(token)).expect(204);
      await http.get('/api/v1/tenants/current').set(as(memberToken)).expect(403);
    });

    it('an existing account must be signed in to accept', async () => {
      const inv = await http
        .post('/api/v1/tenants/current/invitations')
        .set(as(token))
        .send({ email: 'new.member@example.com', roleId: roleIds.member })
        .expect(201);
      const anon = await http.post('/api/v1/invitations/accept').send({ token: inv.body.token }).expect(403);
      expect(anon.body.error.code).toBe('SIGN_IN_REQUIRED');
      const ok = await http
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ token: inv.body.token })
        .expect(200);
      expect(ok.body).toEqual({ accepted: true });
    });
  });

  describe('Secret Vault', () => {
    it('stores a secret write-only and never returns the value', async () => {
      const created = await http
        .post('/api/v1/secrets')
        .set(as(token))
        .send({ name: 'openai.api_key', value: 'sk-test-VALUE-123' })
        .expect(201);
      expect(created.body.reference).toBe(`secret://${created.body.id}`);
      expect(JSON.stringify(created.body)).not.toContain('VALUE-123');

      await http.post('/api/v1/secrets').set(as(token)).send({ name: 'openai.api_key', value: 'x' }).expect(409);
      await http.post('/api/v1/secrets').set(as(token)).send({ name: 'Bad Name', value: 'x' }).expect(400);

      const list = await http.get('/api/v1/secrets').set(as(token)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain('VALUE-123');

      // Stored encrypted, not in the audit log either.
      const sql = admin();
      const [row] = await sql`SELECT ciphertext FROM security.secrets WHERE id = ${created.body.id}`;
      const audit = await sql`SELECT metadata::text AS m FROM security.audit_logs WHERE action = 'secret.created'`;
      await sql.end();
      expect(row!.ciphertext).not.toContain('VALUE-123');
      expect(audit[0]!.m).not.toContain('VALUE-123');

      // Server-side modules can resolve it within the tenant.
      const db = app.get(DbService);
      const vault = app.get(SecretVaultService);
      const value = await db.withContext({ tenantId }, (tx) => vault.resolve(tx, tenantId, created.body.reference));
      expect(value).toBe('sk-test-VALUE-123');

      await http.delete(`/api/v1/secrets/${created.body.id}`).set(as(token)).expect(204);
      expect((await http.get('/api/v1/secrets').set(as(token))).body).toHaveLength(0);
    });

    it('ciphertext moved to another row does not decrypt (bound to tenant and id)', async () => {
      const a = (await http.post('/api/v1/secrets').set(as(token)).send({ name: 'a', value: 'value-a' }).expect(201)).body;
      const b = (await http.post('/api/v1/secrets').set(as(token)).send({ name: 'b', value: 'value-b' }).expect(201)).body;
      const sql = admin();
      await sql`UPDATE security.secrets SET ciphertext = (SELECT ciphertext FROM security.secrets WHERE id = ${a.id}) WHERE id = ${b.id}`;
      await sql.end();
      const db = app.get(DbService);
      const vault = app.get(SecretVaultService);
      await expect(db.withContext({ tenantId }, (tx) => vault.resolve(tx, tenantId, b.reference))).rejects.toThrow();
    });
  });

  describe('outbox', () => {
    it('publishes events written with each change to BullMQ, once', async () => {
      const outbox = app.get(OutboxService);
      let published = 0;
      for (let n = await outbox.relayOnce(); n > 0; n = await outbox.relayOnce()) published += n;
      expect(published).toBeGreaterThan(0);
      expect(await outbox.relayOnce()).toBe(0);

      const q = new Queue(EVENTS_QUEUE, { connection: { url: REDIS_URL } });
      const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed']);
      await q.close();
      const types = jobs.map((j) => j.name);
      expect(types).toEqual(
        expect.arrayContaining(['identity.invitation.created', 'identity.member.added', 'security.secret.created']),
      );
      expect(jobs).toHaveLength(published);
      expect(JSON.stringify(jobs.map((j) => j.data))).not.toMatch(/value-a|VALUE-123/);
    });
  });

  describe('cookie sessions', () => {
    it('sets an httpOnly cookie without exposing the token, and requires the CSRF header on writes', async () => {
      const res = await http
        .post('/api/v1/auth/login')
        .set('X-MARIS-Session', 'cookie')
        .send({ email: OWNER.email, password: OWNER.password })
        .expect(200);
      expect(res.body.token).toBeUndefined();
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/maris_session=/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      const cookie = setCookie.split(';')[0]!;

      await http.get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      const noCsrf = await http
        .post('/api/v1/secrets')
        .set({ Cookie: cookie, 'X-Tenant-Id': tenantId })
        .send({ name: 'c', value: 'v' })
        .expect(403);
      expect(noCsrf.body.error.code).toBe('CSRF_HEADER_MISSING');
      await http
        .post('/api/v1/secrets')
        .set({ Cookie: cookie, 'X-Tenant-Id': tenantId, 'X-MARIS-CSRF': '1' })
        .send({ name: 'c', value: 'v' })
        .expect(201);

      await http.post('/api/v1/auth/logout').set({ Cookie: cookie, 'X-MARIS-CSRF': '1' }).expect(204);
      await http.get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('rate limit', () => {
    it('returns 429 with Retry-After once the login limit for one e-mail is exceeded', async () => {
      let last = 0;
      let retryAfter: string | undefined;
      for (let i = 0; i < 22; i++) {
        const res = await http.post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
        last = res.status;
        retryAfter = res.headers['retry-after'];
        if (last === 429) {
          expect(res.body.error.code).toBe('RATE_LIMITED');
          break;
        }
      }
      expect(last).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    }, 30_000); // each refused login spends a full scrypt hash (~250 ms) by design
  });
});
