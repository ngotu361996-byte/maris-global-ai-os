import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  passwordSchema,
  type AcceptInvitation,
  type InvitationResponse,
  type PermissionKey,
  type SessionResponse,
} from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser, TenantContext } from '../common/request-context';
import { DbService, type Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { hashPassword } from '../security/password';
import { hashToken, newSessionToken } from '../security/tokens';

const { invitations, roles, rolePermissions, tenantMembers, users } = schema;

interface Actor {
  user: AuthUser;
  tenant: TenantContext;
  ip: string | null;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async invite(actor: Actor, email: string, roleId: string): Promise<InvitationResponse> {
    return this.db.withContext({ userId: actor.user.id, tenantId: actor.tenant.id }, async (tx) => {
      const role = await this.assignableRole(tx, actor.tenant, roleId);
      const [member] = await tx
        .select({ userId: tenantMembers.userId })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(and(eq(tenantMembers.tenantId, actor.tenant.id), eq(users.email, email)));
      if (member) throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'Email này đã là thành viên' });

      // A new invitation replaces any open one for the same e-mail.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, actor.tenant.id),
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      const { token, hash } = newSessionToken();
      const id = uuidv7();
      const expiresAt = new Date(Date.now() + this.config.INVITATION_TTL_DAYS * 86_400_000);
      await tx.insert(invitations).values({
        id,
        tenantId: actor.tenant.id,
        email,
        roleId: role.id,
        tokenHash: hash,
        invitedBy: actor.user.id,
        expiresAt,
      });
      await this.audit.append(tx, {
        tenantId: actor.tenant.id,
        actorUserId: actor.user.id,
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: id,
        metadata: { email, role: role.key },
        ip: actor.ip,
      });
      await this.outbox.enqueue(tx, {
        tenantId: actor.tenant.id,
        type: 'identity.invitation.created',
        payload: { invitationId: id, email, role: role.key },
      });
      return { id, email, role: role.key, expiresAt: expiresAt.toISOString(), status: 'pending', token };
    });
  }

  async listInvitations(actor: Actor): Promise<InvitationResponse[]> {
    return this.db.withContext({ userId: actor.user.id, tenantId: actor.tenant.id }, async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          email: invitations.email,
          role: roles.key,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
        })
        .from(invitations)
        .innerJoin(roles, eq(roles.id, invitations.roleId))
        .where(eq(invitations.tenantId, actor.tenant.id))
        .orderBy(desc(invitations.createdAt))
        .limit(200);
      const now = new Date();
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        status: r.acceptedAt ? 'accepted' : r.revokedAt ? 'revoked' : r.expiresAt < now ? 'expired' : 'pending',
      }));
    });
  }

  async revokeInvitation(actor: Actor, id: string): Promise<void> {
    await this.db.withContext({ userId: actor.user.id, tenantId: actor.tenant.id }, async (tx) => {
      const [row] = await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, id),
            eq(invitations.tenantId, actor.tenant.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ email: invitations.email });
      if (!row) throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Không có lời mời đang mở' });
      await this.audit.append(tx, {
        tenantId: actor.tenant.id,
        actorUserId: actor.user.id,
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: id,
        metadata: { email: row.email },
        ip: actor.ip,
      });
    });
  }

  /**
   * Accepting an invitation. If the e-mail already has an account, the invitee must be
   * signed in as that account (sessionUser); otherwise a new account is created with the
   * given password and display name.
   */
  async accept(
    input: AcceptInvitation,
    sessionUser: AuthUser | null,
    client: { ip: string | null; userAgent: string | null },
  ): Promise<SessionResponse | { accepted: true }> {
    const tokenHash = hashToken(input.token);
    const result = await this.db.withContext({}, async (lookupTx) => {
      const rows = await lookupTx.execute<{
        id: string;
        tenant_id: string;
        email: string;
        role_id: string;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>(sql`SELECT * FROM identity.invitation_by_token(${tokenHash})`);
      return rows[0] ?? null;
    });
    if (!result || result.revoked_at) {
      throw new NotFoundException({ code: 'INVITATION_INVALID', message: 'Lời mời không hợp lệ' });
    }
    if (result.accepted_at) throw new GoneException({ code: 'INVITATION_USED', message: 'Lời mời đã được dùng' });
    if (new Date(result.expires_at) < new Date()) {
      throw new GoneException({ code: 'INVITATION_EXPIRED', message: 'Lời mời đã hết hạn' });
    }

    const [existing] = await this.db.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, result.email), isNull(users.deletedAt)));

    let userId: string;
    let passwordHash: string | null = null;
    if (existing) {
      if (!sessionUser || sessionUser.id !== existing.id) {
        throw new ForbiddenException({
          code: 'SIGN_IN_REQUIRED',
          message: 'Email này đã có tài khoản. Hãy đăng nhập bằng tài khoản đó rồi chấp nhận lời mời.',
        });
      }
      userId = existing.id;
    } else {
      if (!input.password || !passwordSchema.safeParse(input.password).success || !input.displayName) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Tài khoản mới cần tên hiển thị và mật khẩu từ 12 ký tự',
        });
      }
      userId = uuidv7();
      passwordHash = await hashPassword(input.password);
    }

    await this.db.withContext({ userId, tenantId: result.tenant_id }, async (tx) => {
      if (passwordHash) {
        await tx.insert(users).values({ id: userId, email: result.email, displayName: input.displayName!, passwordHash });
      }
      // Mark used first, guarded on still-open, so two concurrent accepts cannot both win.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(and(eq(invitations.id, result.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!claimed.length) throw new GoneException({ code: 'INVITATION_USED', message: 'Lời mời đã được dùng' });
      await tx
        .insert(tenantMembers)
        .values({ tenantId: result.tenant_id, userId, roleId: result.role_id, createdBy: userId })
        .onConflictDoNothing();
      const [role] = await tx.select({ key: roles.key }).from(roles).where(eq(roles.id, result.role_id));
      await this.audit.append(tx, {
        tenantId: result.tenant_id,
        actorUserId: userId,
        action: 'member.added',
        targetType: 'user',
        targetId: userId,
        metadata: { role: role?.key, via: 'invitation', invitationId: result.id },
        ip: client.ip,
      });
      await this.outbox.enqueue(tx, {
        tenantId: result.tenant_id,
        type: 'identity.member.added',
        payload: { userId, role: role?.key },
      });
    });

    return existing ? { accepted: true } : this.auth.createSession(userId, client);
  }

  async changeRole(actor: Actor, userId: string, roleId: string): Promise<void> {
    await this.db.withContext({ userId: actor.user.id, tenantId: actor.tenant.id }, async (tx) => {
      const current = await this.memberRole(tx, actor.tenant.id, userId);
      if (current.key === 'owner') {
        throw new ForbiddenException({ code: 'OWNER_LOCKED', message: 'Không đổi được vai trò của Owner' });
      }
      await this.assertCanManage(tx, actor.tenant, current.id);
      const role = await this.assignableRole(tx, actor.tenant, roleId);
      await tx
        .update(tenantMembers)
        .set({ roleId: role.id })
        .where(and(eq(tenantMembers.tenantId, actor.tenant.id), eq(tenantMembers.userId, userId)));
      await this.audit.append(tx, {
        tenantId: actor.tenant.id,
        actorUserId: actor.user.id,
        action: 'member.role.changed',
        targetType: 'user',
        targetId: userId,
        metadata: { from: current.key, to: role.key },
        ip: actor.ip,
      });
      await this.outbox.enqueue(tx, {
        tenantId: actor.tenant.id,
        type: 'identity.member.role_changed',
        payload: { userId, from: current.key, to: role.key },
      });
    });
  }

  async remove(actor: Actor, userId: string): Promise<void> {
    if (userId === actor.user.id) {
      throw new ForbiddenException({ code: 'CANNOT_REMOVE_SELF', message: 'Không tự gỡ chính mình' });
    }
    await this.db.withContext({ userId: actor.user.id, tenantId: actor.tenant.id }, async (tx) => {
      const current = await this.memberRole(tx, actor.tenant.id, userId);
      if (current.key === 'owner') throw new ForbiddenException({ code: 'OWNER_LOCKED', message: 'Không gỡ được Owner' });
      await this.assertCanManage(tx, actor.tenant, current.id);
      await tx
        .delete(tenantMembers)
        .where(and(eq(tenantMembers.tenantId, actor.tenant.id), eq(tenantMembers.userId, userId)));
      await this.audit.append(tx, {
        tenantId: actor.tenant.id,
        actorUserId: actor.user.id,
        action: 'member.removed',
        targetType: 'user',
        targetId: userId,
        metadata: { role: current.key },
        ip: actor.ip,
      });
      await this.outbox.enqueue(tx, { tenantId: actor.tenant.id, type: 'identity.member.removed', payload: { userId } });
    });
  }

  private async memberRole(tx: Tx, tenantId: string, userId: string) {
    const [row] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(tenantMembers)
      .innerJoin(roles, eq(roles.id, tenantMembers.roleId))
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
    if (!row) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Không tìm thấy thành viên' });
    return row;
  }

  /** The owner role is never assignable, and nobody can hand out permissions they lack. */
  private async assignableRole(tx: Tx, tenant: TenantContext, roleId: string) {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenant.id)));
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Không tìm thấy vai trò' });
    if (role.key === 'owner') {
      throw new ForbiddenException({ code: 'OWNER_NOT_ASSIGNABLE', message: 'Không gán được vai trò Owner' });
    }
    await this.assertCanManage(tx, tenant, role.id);
    return role;
  }

  private async assertCanManage(tx: Tx, tenant: TenantContext, roleId: string): Promise<void> {
    const perms = await tx
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    const missing = perms.map((p) => p.key as PermissionKey).filter((p) => !tenant.permissions.has(p));
    if (missing.length) {
      throw new ForbiddenException({
        code: 'PERMISSION_ESCALATION',
        message: 'Vai trò này có quyền bạn không có',
        details: missing,
      });
    }
  }
}
