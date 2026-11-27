import { z } from 'zod';

export const AI_PROVIDER_KINDS = ['openai', 'anthropic', 'gemini', 'ollama', 'openai_compatible'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** Labels and defaults shown in the UI. Base URLs are used when a provider has none set. */
export const AI_PROVIDER_PRESETS: Record<AiProviderKind, { label: string; defaultBaseUrl?: string; needsKey: boolean }> = {
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', needsKey: true },
  anthropic: { label: 'Claude (Anthropic)', defaultBaseUrl: 'https://api.anthropic.com', needsKey: true },
  gemini: { label: 'Gemini (Google)', defaultBaseUrl: 'https://generativelanguage.googleapis.com', needsKey: true },
  ollama: { label: 'Ollama (máy cục bộ)', defaultBaseUrl: 'http://localhost:11434/v1', needsKey: false },
  openai_compatible: { label: 'Tương thích OpenAI (OpenRouter, DeepSeek, Qwen, Grok…)', needsKey: true },
};

/** A model name, never a key: catches a key pasted into the model box before it is stored in plain text. */
const modelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, 'tên model chỉ gồm chữ, số và . _ : / @ + -')
  .refine((v) => !/^(sk-|sk_|rk-|AIza|xai-|gsk_)/.test(v) && v.length < 120, 'đây giống API key, không phải tên model. Key chỉ dán vào Secret Vault');

const secretRef = z.string().regex(/^secret:\/\/[0-9a-f-]{36}$/, 'phải là mã secret://… từ Secret Vault');
const cost = z.number().min(0).max(100_000).nullable();

const providerFields = {
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url().max(500).nullable(),
  secretRef: secretRef.nullable(),
  defaultModel: modelName,
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(600_000),
  inputCostPerMtok: cost,
  outputCostPerMtok: cost,
};

export const createAiProviderSchema = z.object({
  kind: z.enum(AI_PROVIDER_KINDS),
  name: providerFields.name,
  baseUrl: providerFields.baseUrl.optional(),
  secretRef: providerFields.secretRef.optional(),
  defaultModel: providerFields.defaultModel,
  enabled: providerFields.enabled.optional(),
  timeoutMs: providerFields.timeoutMs.optional(),
  inputCostPerMtok: cost.optional(),
  outputCostPerMtok: cost.optional(),
});
export type CreateAiProvider = z.infer<typeof createAiProviderSchema>;

export const updateAiProviderSchema = z
  .object({
    name: providerFields.name,
    baseUrl: providerFields.baseUrl,
    secretRef: providerFields.secretRef,
    defaultModel: providerFields.defaultModel,
    enabled: providerFields.enabled,
    timeoutMs: providerFields.timeoutMs,
    inputCostPerMtok: cost,
    outputCostPerMtok: cost,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateAiProvider = z.infer<typeof updateAiProviderSchema>;

/** Full failover order: every live provider id, first = primary AI. */
export const reorderAiProvidersSchema = z.object({ order: z.array(z.string().uuid()).min(1).max(100) });
export type ReorderAiProviders = z.infer<typeof reorderAiProvidersSchema>;

export interface AiProviderResponse {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  /** Reference only; the key itself never leaves the server. */
  secretRef: string | null;
  defaultModel: string;
  priority: number;
  enabled: boolean;
  timeoutMs: number;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  /** Circuit breaker state from the health monitor. */
  health: 'ok' | 'open';
}

export interface AiProviderTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  errorCode?: string;
  message?: string;
}

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  providerId: z.string().uuid().nullable().optional(),
  model: modelName.nullable().optional(),
});
export type CreateConversation = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    providerId: z.string().uuid().nullable(),
    model: modelName.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateConversation = z.infer<typeof updateConversationSchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(32_000),
  /** Overrides the conversation's provider/model for this message and later ones. */
  providerId: z.string().uuid().nullable().optional(),
  model: modelName.nullable().optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export interface ConversationResponse {
  id: string;
  title: string;
  providerId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageResponse {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete' | 'error' | 'cancelled';
  providerId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface ConversationDetailResponse extends ConversationResponse {
  messages: ChatMessageResponse[];
}

/**
 * Server-sent events from POST /ai/conversations/:id/messages, one JSON object per `data:` line.
 * `provider` can appear more than once when the router fails over before any text arrived.
 */
export type ChatStreamEvent =
  | { type: 'start'; userMessageId: string; assistantMessageId: string }
  | { type: 'provider'; providerId: string; name: string; model: string }
  | { type: 'failover'; fromProviderId: string; errorCode: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      message: ChatMessageResponse;
    }
  | { type: 'error'; code: string; message: string };

export interface AiUsageRow {
  providerId: string;
  providerName: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AiUsageResponse {
  since: string;
  rows: AiUsageRow[];
  totalCostUsd: number;
}
