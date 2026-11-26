import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { AuditLogResponse, AuditVerifyResponse } from '@maris/contracts';
import type { Tx } from '../db/db.service';
import { auditHash, GENESIS_HASH } from './audit-hash';

export interface AuditEntry {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

const { auditLogs } = schema;

@Injectable()
export class AuditService {
  /**
   * Appends one entry to the tenant's hash chain inside the caller's transaction,
   * so the audit row commits or rolls back with the action it records.
   */
  async append(tx: Tx, entry: AuditEntry): Promise<void> {
    // Serialise appends per tenant so seq and prev_hash stay consistent.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${entry.tenantId}, 0))`);
    const [last] = await tx
      .select({ seq: auditLogs.seq, hash: auditLogs.hash })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, entry.tenantId))
      .orderBy(desc(auditLogs.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const createdAt = new Date();
    const row = {
      tenantId: entry.tenantId,
      seq,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      createdAt,
      prevHash,
    };
    await tx.insert(auditLogs).values({ id: uuidv7(), ip: entry.ip ?? null, ...row, hash: auditHash(row) });
  }

  async list(tx: Tx, tenantId: string, opts: { beforeSeq?: number; limit: number }): Promise<AuditLogResponse[]> {
    const where = opts.beforeSeq
      ? and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.seq, opts.beforeSeq))
      : eq(auditLogs.tenantId, tenantId);
    const rows = await tx.select().from(auditLogs).where(where).orderBy(desc(auditLogs.seq)).limit(opts.limit);
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      actorUserId: r.actorUserId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
      hash: r.hash,
    }));
  }

  /** Recomputes every hash in order; the first mismatch marks where the chain was altered. */
  async verify(tx: Tx, tenantId: string): Promise<AuditVerifyResponse> {
    const rows = await tx.select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId)).orderBy(asc(auditLogs.seq));
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const r of rows) {
      const recomputed = auditHash({
        tenantId: r.tenantId,
        seq: r.seq,
        actorUserId: r.actorUserId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        createdAt: r.createdAt,
        prevHash: r.prevHash,
      });
      if (r.seq !== expectedSeq || r.prevHash !== prev || recomputed !== r.hash) {
        return { valid: false, checked: rows.length, brokenAtSeq: r.seq };
      }
      prev = r.hash;
      expectedSeq++;
    }
    return { valid: true, checked: rows.length, brokenAtSeq: null };
  }
}
