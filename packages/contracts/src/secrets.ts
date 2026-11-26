import { z } from 'zod';

export const createSecretSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/, 'chữ thường, số, . _ -; tối đa 100 ký tự'),
  value: z.string().min(1).max(16_384),
});
export type CreateSecret = z.infer<typeof createSecretSchema>;

/** The value is write-only: no endpoint ever returns it. */
export interface SecretResponse {
  id: string;
  name: string;
  reference: string;
  createdAt: string;
}
