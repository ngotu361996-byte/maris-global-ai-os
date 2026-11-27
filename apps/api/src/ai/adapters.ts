import type { AiProviderKind } from '@maris/contracts';
import { AI_PROVIDER_PRESETS } from '@maris/contracts';
import { errorFromStatus, ProviderError } from './provider-error';

export interface ChatImage {
  mime: string;
  /** Base64 of the image bytes. */
  data: string;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Images sent with a user turn (vision input). */
  images?: ChatImage[];
}

export interface ProviderTarget {
  kind: AiProviderKind;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

export interface StreamUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderAdapter {
  /** Streams the reply, calling onText for each piece. Resolves with token usage when the provider reports it. */
  stream(target: ProviderTarget, messages: ChatTurn[], onText: (text: string) => void, signal: AbortSignal): Promise<StreamUsage>;
  listModels(target: Omit<ProviderTarget, 'model'>, signal: AbortSignal): Promise<string[]>;
}

export function baseUrlFor(kind: AiProviderKind, baseUrl: string | null): string {
  const url = baseUrl ?? AI_PROVIDER_PRESETS[kind].defaultBaseUrl;
  if (!url) throw new ProviderError('BAD_REQUEST', 'Provider chưa có địa chỉ (base URL)');
  return url.replace(/\/+$/, '');
}

const MAX_OUTPUT_TOKENS = 4096;

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
    // A redirect could point at an address the URL guard never checked.
    redirect: 'error',
  });
  if (!res.ok) throw errorFromStatus(res.status, await errorDetail(res));
  if (!res.body) throw new ProviderError('BAD_RESPONSE', 'Phản hồi rỗng');
  return res;
}

async function getJson<T>(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers, signal, redirect: 'error' });
  if (!res.ok) throw errorFromStatus(res.status, await errorDetail(res));
  return (await res.json()) as T;
}

/** Short, key-free description of an error body (shown to the user and logged). */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let m: string;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    m = String(typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? ''));
  } catch {
    m = text;
  }
  return redactKeys(m).slice(0, 300);
}

/** Providers sometimes echo part of the key in error messages; never pass that on. */
export function redactKeys(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_*\-]{6,}/g, '$1-***')
    .replace(/\bAIza[0-9A-Za-z_\-]{10,}/g, 'AIza***')
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '***');
}

/** Parses a server-sent-events body into { event, data } records. */
export async function* readSse(res: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        }
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

function parse<T>(data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new ProviderError('BAD_RESPONSE', 'Dữ liệu stream không hợp lệ');
  }
}

function streamError(err: unknown): ProviderError {
  const e = err as { message?: string; type?: string; code?: string | number } | string;
  const msg = redactKeys(String(typeof e === 'string' ? e : (e?.message ?? 'lỗi từ provider'))).slice(0, 300);
  const type = typeof e === 'string' ? '' : String(e?.type ?? e?.code ?? '');
  if (/rate|overloaded|429|529/i.test(type)) return new ProviderError('RATE_LIMIT', msg);
  if (/auth|permission|401|403/i.test(type)) return new ProviderError('AUTH', msg);
  if (/invalid_request|400|404/i.test(type)) return new ProviderError('BAD_REQUEST', msg);
  return new ProviderError('UPSTREAM', msg);
}

/** OpenAI Chat Completions, also used by Ollama, OpenRouter, DeepSeek, Qwen, Grok and other compatible APIs. */
const openAiCompatible: ProviderAdapter = {
  async stream(t, messages, onText, signal) {
    const headers: Record<string, string> = t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {};
    const res = await post(
      `${t.baseUrl}/chat/completions`,
      headers,
      { model: t.model, messages: messages.map(openAiMessage), stream: true, stream_options: { include_usage: true } },
      signal,
    );
    const usage: StreamUsage = { inputTokens: null, outputTokens: null };
    for await (const { data } of readSse(res)) {
      if (data === '[DONE]') break;
      const chunk = parse<{
        choices?: { delta?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: unknown;
      }>(data);
      if (chunk.error) throw streamError(chunk.error);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) onText(text);
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
      }
    }
    return usage;
  },
  async listModels(t, signal) {
    const headers: Record<string, string> = t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {};
    const body = await getJson<{ data?: { id: string }[] }>(`${t.baseUrl}/models`, headers, signal);
    return (body.data ?? []).map((m) => m.id);
  },
};

/** Anthropic Messages API. */
const anthropic: ProviderAdapter = {
  async stream(t, messages, onText, signal) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const res = await post(
      `${t.baseUrl}/v1/messages`,
      { 'x-api-key': t.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      {
        model: t.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(system ? { system } : {}),
        messages: alternate(messages).map((m) =>
          m.images.length
            ? {
                role: m.role,
                content: [
                  ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
                  { type: 'text', text: m.content },
                ],
              }
            : { role: m.role, content: m.content },
        ),
        stream: true,
      },
      signal,
    );
    const usage: StreamUsage = { inputTokens: null, outputTokens: null };
    for await (const { event, data } of readSse(res)) {
      const ev = parse<{
        type?: string;
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        delta?: { type?: string; text?: string };
        usage?: { output_tokens?: number };
        error?: unknown;
      }>(data);
      const type = ev.type ?? event;
      if (type === 'error') throw streamError(ev.error);
      if (type === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? null;
      if (type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) onText(ev.delta.text);
      if (type === 'message_delta' && ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens;
      if (type === 'message_stop') break;
    }
    return usage;
  },
  async listModels(t, signal) {
    const body = await getJson<{ data?: { id: string }[] }>(
      `${t.baseUrl}/v1/models?limit=100`,
      { 'x-api-key': t.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      signal,
    );
    return (body.data ?? []).map((m) => m.id);
  },
};

/** Google Gemini generateContent API. */
const gemini: ProviderAdapter = {
  async stream(t, messages, onText, signal) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const res = await post(
      `${t.baseUrl}/v1beta/models/${encodeURIComponent(t.model)}:streamGenerateContent?alt=sse`,
      { 'x-goog-api-key': t.apiKey ?? '' },
      {
        contents: alternate(messages).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [...m.images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: m.content }],
        })),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
      signal,
    );
    const usage: StreamUsage = { inputTokens: null, outputTokens: null };
    for await (const { data } of readSse(res)) {
      const chunk = parse<{
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        error?: unknown;
      }>(data);
      if (chunk.error) throw streamError(chunk.error);
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (part.text) onText(part.text);
      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
        usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens;
      }
    }
    return usage;
  },
  async listModels(t, signal) {
    const body = await getJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
      `${t.baseUrl}/v1beta/models?pageSize=200`,
      { 'x-goog-api-key': t.apiKey ?? '' },
      signal,
    );
    return (body.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  },
};

/** OpenAI-style message; a user turn with images becomes text plus image_url parts. */
export function openAiMessage(m: ChatTurn): { role: ChatTurn['role']; content: unknown } {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))],
  };
}

/** Anthropic and Gemini need user/assistant turns that alternate and start with the user. */
export function alternate(messages: ChatTurn[]): { role: 'user' | 'assistant'; content: string; images: ChatImage[] }[] {
  const out: { role: 'user' | 'assistant'; content: string; images: ChatImage[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system' || !m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
      last.images.push(...(m.images ?? []));
    } else out.push({ role: m.role, content: m.content, images: [...(m.images ?? [])] });
  }
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

export function adapterFor(kind: AiProviderKind): ProviderAdapter {
  switch (kind) {
    case 'anthropic':
      return anthropic;
    case 'gemini':
      return gemini;
    case 'openai':
    case 'ollama':
    case 'openai_compatible':
      return openAiCompatible;
  }
}
