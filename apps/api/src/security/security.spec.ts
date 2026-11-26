import { hashPassword, verifyPassword } from './password';
import { base32Encode, totpAt, verifyTotp } from './totp';
import { SecretBox } from './secret-box';
import { randomBytes } from 'node:crypto';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong password!!', stored)).resolves.toBe(false);
  });
});

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at t=%i gives %s', (t, code) => {
    expect(totpAt(secret, t * 1000)).toBe(code);
  });
  it('accepts one step of drift, not two', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
  });
});

describe('SecretBox', () => {
  it('round-trips and detects tampering', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
  });
});
