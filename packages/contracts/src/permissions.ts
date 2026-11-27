/**
 * Permission keys checked by the API guard. Adding a key here is the only way to
 * introduce a new permission; the migration seeds the same list.
 */
export const PERMISSIONS = [
  'tenant.read',
  'tenant.update',
  'members.read',
  'members.manage',
  'roles.read',
  'roles.manage',
  'audit.read',
  'secrets.read',
  'secrets.manage',
  'ai.chat',
  'ai.manage',
  'ai.memory',
  'ai.approve',
  'infra.read',
  'infra.manage',
  'infra.code',
  'content.read',
  'content.manage',
  'content.approve',
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

/** Built-in roles created for every new tenant. */
export const BUILTIN_ROLES: Record<string, readonly PermissionKey[]> = {
  owner: PERMISSIONS,
  administrator: PERMISSIONS,
  manager: [
    'tenant.read',
    'members.read',
    'roles.read',
    'ai.chat',
    'ai.memory',
    'content.read',
    'content.manage',
  ],
  member: ['tenant.read', 'ai.chat', 'content.read'],
};
