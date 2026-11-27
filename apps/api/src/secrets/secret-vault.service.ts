import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { schema, uuidv7 } from '@maris/db';
import type { SecretResponse } from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import type { Tx } from '../db/db.service';

const { secrets } = schema;
const REF_PREFIX = 'secret://';
const KEY_VERSION = 1;

/**
 * Secret Vault: values are encrypted with AES-256-GCM under VAULT_MASTER_KEY, with the
 * tenant id and secret id bound as additional authenticated data, so a ciphertext copied
 * to another row or tenant fails to decrypt. Values are write-only over the API;
 * only server-side modules resolve them, by reference.
 */
@Injectable()
export class SecretVaultService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.VAULT_MASTER_KEY, 'base64');
  }

  async create(tx: Tx, tenantId: string, userId: string, name: string, value: string): Promise<SecretResponse> {
    const [existing] = await tx
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name), isNull(secrets.deletedAt)));
    if (existing) throw new ConflictException({ code: 'SECRET_EXISTS', message: `Secret "${name}" đã tồn tại` });
    const id = uuidv7();
    const createdAt = new Date();
    await tx.insert(secrets).values({
      id,
      tenantId,
      name,
      ciphertext: this.seal(value, tenantId, id),
      keyVersion: KEY_VERSION,
      createdBy: userId,
      createdAt,
    });
    return { id, name, reference: REF_PREFIX + id, createdAt: createdAt.toISOString() };
  }

  async list(tx: Tx, tenantId: string): Promise<SecretResponse[]> {
    const rows = await tx
      .select({ id: secrets.id, name: secrets.name, createdAt: secrets.createdAt })
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)))
      .orderBy(asc(secrets.name));
    return rows.map((r) => ({ ...r, reference: REF_PREFIX + r.id, createdAt: r.createdAt.toISOString() }));
  }

  /** Soft delete; the ciphertext is overwritten so the value cannot be recovered from this row. */
  async remove(tx: Tx, tenantId: string, id: string): Promise<{ name: string }> {
    const [row] = await tx
      .update(secrets)
      .set({ deletedAt: new Date(), ciphertext: 'deleted' })
      .where(and(eq(secrets.id, id), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)))
      .returning({ name: secrets.name });
    if (!row) throw new NotFoundException({ code: 'SECRET_NOT_FOUND', message: 'Không tìm thấy secret' });
    return row;
  }

  /** For server-side modules only (AI Gateway, connectors). Never expose the result in a response. */
  async resolve(tx: Tx, tenantId: string, reference: string): Promise<string> {
    const id = reference.startsWith(REF_PREFIX) ? reference.slice(REF_PREFIX.length) : '';
    const [row] = await tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'SECRET_NOT_FOUND', message: 'Không tìm thấy secret' });
    return this.open(row.ciphertext, tenantId, row.id);
  }

  /** Resolves by name, for connectors, whose exported files carry secret names rather than ids. */
  async resolveByName(tx: Tx, tenantId: string, name: string): Promise<string> {
    const [row] = await tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name), isNull(secrets.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'SECRET_NOT_FOUND', message: `Chưa có secret "${name}" trong Secret Vault` });
    return this.open(row.ciphertext, tenantId, row.id);
  }

  private seal(value: string, tenantId: string, id: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${tenantId}:${id}`));
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  private open(sealed: string, tenantId: string, id: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported vault format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${tenantId}:${id}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
