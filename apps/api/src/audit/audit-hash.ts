import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditHashInput {
  tenantId: string;
  seq: number;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  prevHash: string;
}

/** JSON with object keys sorted at every level, so jsonb key reordering cannot change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function auditHash(e: AuditHashInput): string {
  const payload = canonicalJson({
    tenantId: e.tenantId,
    seq: e.seq,
    actorUserId: e.actorUserId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata,
    createdAt: e.createdAt.toISOString(),
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(payload).digest('hex');
}
