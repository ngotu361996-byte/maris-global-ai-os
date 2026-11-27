-- Sprint 15: permission to run code in the worker sandbox (spec Part 26, Code Runner).
-- Only the built-in owner and administrator roles get it; other roles can be granted it later.

INSERT INTO identity.permissions (key, description) VALUES
  ('infra.code', 'Chạy mã Python/Node trong sandbox trên máy Code Runner');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'infra.code'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
