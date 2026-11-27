import { z } from 'zod';
import { modelName } from './ai';
import type { ChatMode } from './chat-modes';

/** What a model is good at. The router uses these to pick a model for a chat mode. */
export const MODEL_CAPABILITIES = [
  'chat',
  'reasoning',
  'coding',
  'long_context',
  'vision',
  'fast',
  'low_cost',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_CAPABILITY_LABEL: Record<ModelCapability, string> = {
  chat: 'Trò chuyện',
  reasoning: 'Suy luận sâu',
  coding: 'Lập trình',
  long_context: 'Ngữ cảnh dài',
  vision: 'Đọc hình ảnh',
  fast: 'Nhanh',
  low_cost: 'Giá rẻ',
};

/**
 * The capability a chat mode prefers. When a provider has an enabled model with it in the
 * Model Registry, that model is used instead of the provider's default model, unless the
 * conversation or agent names a model itself.
 */
export const MODE_CAPABILITY: Partial<Record<ChatMode, ModelCapability>> = {
  research: 'reasoning',
  expert: 'reasoning',
  coding: 'coding',
  software: 'coding',
};

const capabilities = z
  .array(z.enum(MODEL_CAPABILITIES))
  .max(MODEL_CAPABILITIES.length)
  .transform((v) => [...new Set(v)]);
const price = z.number().min(0).max(100_000).nullable();

export const createModelSchema = z.object({
  providerId: z.string().uuid(),
  model: modelName,
  capabilities,
  contextWindow: z.number().int().positive().max(100_000_000).nullable().optional(),
  inputCostPerMtok: price.optional(),
  outputCostPerMtok: price.optional(),
  enabled: z.boolean().optional(),
});
export type CreateModel = z.infer<typeof createModelSchema>;

export const updateModelSchema = z
  .object({
    capabilities,
    contextWindow: z.number().int().positive().max(100_000_000).nullable(),
    inputCostPerMtok: price,
    outputCostPerMtok: price,
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateModel = z.infer<typeof updateModelSchema>;

export interface ModelResponse {
  id: string;
  providerId: string;
  model: string;
  capabilities: ModelCapability[];
  contextWindow: number | null;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
