import { auditHash, canonicalJson, GENESIS_HASH } from './audit-hash';

describe('audit hash chain', () => {
  const base = {
    tenantId: '018f0000-0000-7000-8000-000000000001',
    seq: 1,
    actorUserId: null,
    action: 'tenant.created',
    targetType: 'tenant',
    targetId: 'x',
    metadata: { b: 1, a: { d: 2, c: 3 } },
    createdAt: new Date('2026-11-26T00:00:00.000Z'),
    prevHash: GENESIS_HASH,
  };

  it('is independent of metadata key order', () => {
    expect(auditHash(base)).toBe(auditHash({ ...base, metadata: { a: { c: 3, d: 2 }, b: 1 } }));
  });

  it('changes when any field changes', () => {
    const h = auditHash(base);
    expect(auditHash({ ...base, action: 'tenant.deleted' })).not.toBe(h);
    expect(auditHash({ ...base, prevHash: 'f'.repeat(64) })).not.toBe(h);
  });

  it('canonicalJson sorts keys', () => {
    expect(canonicalJson({ z: 1, a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}],"z":1}');
  });
});
