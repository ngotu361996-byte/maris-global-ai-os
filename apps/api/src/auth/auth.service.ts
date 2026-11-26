import {
  ConflictException,
  Inject,
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  BUILTIN_ROLES,
  type BootstrapRequest,
  type LoginRequest,
  type MeResponse,
  type SessionResponse,
} from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/request-context';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../security/password';
import { hashToken, newSessionToken } from '../security/tokens';
import { newTotpSecret, totpUri, verifyTotp } from '../security/totp';
import { SecretBox } from '../security/secret-box';

const { users, sessions, tenants, roles, rolePermissions, tenantMembers } = schema;

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY);
  }

  /**
   * Creates the first owner and first tenant. Allowed only while the system has no users;
   * after that, people join a tenant by invitation (Sprint 2).
   */
  async bootstrap(input: BootstrapRequest, client: ClientInfo): Promise<SessionResponse> {
    const userId = uuidv7();
    const tenantId = uuidv7();
    const passwordHash = await hashPassword(input.password);

    await this.db.withContext({ userId, tenantId }, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('maris.bootstrap', 0))`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) {
        throw new ConflictException({ code: 'ALREADY_BOOTSTRAPPED', message: 'Hệ thống đã có chủ sở hữu' });
      }
      await tx.insert(users).values({ id: userId, email: input.email, displayName: input.displayName, passwordHash });
      await tx.insert(tenants).values({ id: tenantId, name: input.tenantName, slug: slugify(input.tenantName), createdBy: userId });
      const ownerRoleId = await this.createBuiltinRoles(tx, tenantId);
      await tx.insert(tenantMembers).values({ tenantId, userId, roleId: ownerRoleId, createdBy: userId });
      await this.audit.append(tx, {
        tenantId,
        actorUserId: userId,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { name: input.tenantName, via: 'bootstrap' },
        ip: client.ip,
      });
      await this.audit.append(tx, {
        tenantId,
        actorUserId: userId,
        action: 'member.added',
        targetType: 'user',
        targetId: userId,
        metadata: { role: 'owner' },
        ip: client.ip,
      });
    });
    return this.createSession(userId, client);
  }

  async login(input: LoginRequest, client: ClientInfo): Promise<SessionResponse> {
    const invalid = () => new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Sai email hoặc mật khẩu' });
    const [user] = await this.db.db
      .select()
      .from(users)
      .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
      .limit(1);
    if (!user) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH); // equalise timing
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ code: 'ACCOUNT_LOCKED', message: 'Tài khoản tạm khóa, thử lại sau' });
    }
    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      await this.recordFailedLogin(user.id, user.failedLoginCount);
      throw invalid();
    }
    if (user.mfaEnabled) {
      if (!input.totp) throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Cần mã xác thực 2 lớp' });
      const secret = this.box.open(user.mfaTotpSecretEnc ?? '');
      if (!verifyTotp(secret, input.totp)) {
        await this.recordFailedLogin(user.id, user.failedLoginCount);
        throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Mã xác thực không đúng' });
      }
    }
    await this.db.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    return this.createSession(user.id, client);
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async resolveSession(token: string): Promise<AuthUser | null> {
    const [row] = await this.db.db
      .select({ sessionId: sessions.id, id: users.id, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async me(userId: string): Promise<MeResponse> {
    return this.db.withContext({ userId }, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên không hợp lệ' });
      const memberships = await tx
        .select({ tenantId: tenants.id, tenantName: tenants.name, role: roles.key })
        .from(tenantMembers)
        .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
        .innerJoin(roles, eq(roles.id, tenantMembers.roleId))
        .where(and(eq(tenantMembers.userId, userId), isNull(tenants.deletedAt)));
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        mfaEnabled: user.mfaEnabled,
        memberships,
      };
    });
  }

  /** Step 1: store a new (not yet active) secret and return the otpauth URI for the QR code. */
  async startTotpSetup(user: AuthUser): Promise<{ otpauthUri: string; secret: string }> {
    const [row] = await this.db.db.select({ mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, user.id));
    if (row?.mfaEnabled) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA đã bật' });
    const secret = newTotpSecret();
    await this.db.db
      .update(users)
      .set({ mfaTotpSecretEnc: this.box.seal(secret), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return { otpauthUri: totpUri(secret, user.email), secret };
  }

  /** Step 2: a correct code proves the authenticator app has the secret; MFA turns on. */
  async confirmTotp(user: AuthUser, code: string): Promise<{ mfaEnabled: true }> {
    const [row] = await this.db.db.select().from(users).where(eq(users.id, user.id));
    if (!row?.mfaTotpSecretEnc) throw new BadRequestException({ code: 'MFA_NOT_STARTED', message: 'Chưa tạo mã MFA' });
    if (row.mfaEnabled) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA đã bật' });
    if (!verifyTotp(this.box.open(row.mfaTotpSecretEnc), code)) {
      throw new BadRequestException({ code: 'MFA_INVALID', message: 'Mã xác thực không đúng' });
    }
    await this.db.db.update(users).set({ mfaEnabled: true, updatedAt: new Date() }).where(eq(users.id, user.id));
    return { mfaEnabled: true };
  }

  private async createBuiltinRoles(tx: Tx, tenantId: string): Promise<string> {
    let ownerRoleId = '';
    for (const [key, perms] of Object.entries(BUILTIN_ROLES)) {
      const id = uuidv7();
      if (key === 'owner') ownerRoleId = id;
      await tx.insert(roles).values({ id, tenantId, key, name: key[0]!.toUpperCase() + key.slice(1), builtin: true });
      if (perms.length) {
        await tx.insert(rolePermissions).values(perms.map((p) => ({ tenantId, roleId: id, permissionKey: p })));
      }
    }
    return ownerRoleId;
  }

  private async createSession(userId: string, client: ClientInfo): Promise<SessionResponse> {
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3600_000);
    await this.db.db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash: hash,
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 500) ?? null,
      expiresAt,
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  private async recordFailedLogin(userId: string, previous: number): Promise<void> {
    const count = previous + 1;
    await this.db.db
      .update(users)
      .set({
        failedLoginCount: count,
        lockedUntil: count >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, userId));
  }
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'tenant'}-${uuidv7().slice(-6)}`;
}
