import { z } from 'zod';

export interface TenantResponse {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MemberResponse {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  joinedAt: string;
}

export interface RoleResponse {
  id: string;
  key: string;
  name: string;
  builtin: boolean;
  permissions: string[];
}

export const updateRolePermissionsSchema = z.object({
  permissions: z.array(z.string().min(1)).max(200),
});
export type UpdateRolePermissions = z.infer<typeof updateRolePermissionsSchema>;

export interface AuditLogResponse {
  id: string;
  seq: number;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  hash: string;
}

export interface AuditVerifyResponse {
  valid: boolean;
  checked: number;
  brokenAtSeq: number | null;
}
