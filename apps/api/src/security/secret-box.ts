import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyB64: string) {
    this.key = Buffer.from(keyB64, 'base64');
    if (this.key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported sealed format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
