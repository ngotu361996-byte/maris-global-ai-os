'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  CHAT_MODE_INFO,
  CHAT_MODES,
  type AgentResponse,
  type AiProviderResponse,
  type ChatMessageResponse,
  type ChatMode,
  type ChatStreamEvent,
  type ConversationDetailResponse,
  type ConversationResponse,
  type ProjectResponse,
} from '@maris/contracts';
import { Markdown } from '@/components/Markdown';
import { btnCls, inputCls } from '@/components/ui';
import { api, apiStream } from '@/lib/api';

interface Props {
  conversationId: string | null;
  /** Called when the first message creates a conversation, or a reply changes its title. */
  onConversationChange?: (id: string) => void;
  compact?: boolean;
}

type LocalMessage = ChatMessageResponse & { providerName?: string; local?: boolean };

const ERROR_TEXT: Record<string, string> = {
  NO_PROVIDER: 'Chưa có AI nào được bật. Vào mục AI Provider để thêm.',
  ALL_PROVIDERS_FAILED: 'Tất cả AI đều lỗi. Kiểm tra key và trạng thái ở mục AI Provider.',
  CANCELLED: 'Đã dừng.',
  EMERGENCY_STOP: 'MARIS đang Dừng khẩn cấp.',
  BUDGET_EXCEEDED: 'Đã hết ngân sách AI.',
};

/** Hands a reply to the Giao việc page as a draft task (kept in this browser tab only). */
export const TASK_DRAFT_KEY = 'maris.taskDraft';

export function ChatPanel({ conversationId, onConversationChange, compact }: Props) {
  const [providers, setProviders] = useState<AiProviderResponse[]>([]);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [agentId, setAgentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [mode, setMode] = useState<ChatMode>('chat');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(conversationId);
  const endRef = useRef<HTMLDivElement>(null);

  const enabled = providers.filter((p) => p.enabled);
  const nameOf = useCallback((id: string | null) => providers.find((p) => p.id === id)?.name, [providers]);

  useEffect(() => {
    api<AiProviderResponse[]>('/ai/providers').then(setProviders).catch((e: Error) => setError(e.message));
    api<AgentResponse[]>('/ai/agents').then(setAgents).catch(() => undefined);
    api<ProjectResponse[]>('/ai/projects').then(setProjects).catch(() => undefined);
  }, []);

  useEffect(() => {
    convRef.current = conversationId;
    setError(null);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    // A conversation just created by this panel is already on screen.
    if (streaming) return;
    api<ConversationDetailResponse>(`/ai/conversations/${conversationId}`)
      .then((c) => {
        setMessages(c.messages);
        setProviderId(c.providerId ?? '');
        setModel(c.model ?? '');
        setAgentId(c.agentId ?? '');
        setProjectId(c.projectId ?? '');
        setMode(c.mode);
      })
      .catch((e: Error) => setError(e.message));
  }, [conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function send() {
    const content = text.trim();
    if (!content || streaming) return;
    setError(null);
    setStreaming(true);
    setStatus('Đang gửi…');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const now = new Date().toISOString();
    const tempId = `local-${Date.now()}`;
    const blank = { providerId: null, model: null, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: null, errorCode: null, createdAt: now };
    setMessages((m) => [
      ...m,
      { ...blank, id: `${tempId}-u`, role: 'user', content, status: 'complete', local: true },
      { ...blank, id: tempId, role: 'assistant', content: '', status: 'streaming', local: true },
    ]);
    setText('');
    const patch = (fn: (m: LocalMessage) => LocalMessage) => setMessages((list) => list.map((m) => (m.id === tempId ? fn(m) : m)));

    try {
      let id = convRef.current;
      if (!id) {
        const conv = await api<ConversationResponse>('/ai/conversations', {
          method: 'POST',
          body: JSON.stringify({
            providerId: providerId || null,
            model: providerId && model ? model : null,
            agentId: agentId || null,
            projectId: projectId || null,
            mode,
          }),
        });
        id = conv.id;
        convRef.current = id;
        onConversationChange?.(id);
      }
      await apiStream<ChatStreamEvent>(
        `/ai/conversations/${id}/messages`,
        { content, providerId: providerId || null, model: providerId && model ? model : null },
        (ev) => {
          if (ev.type === 'provider') {
            setStatus(`${ev.name} · ${ev.model}`);
            patch((m) => ({ ...m, providerId: ev.providerId, model: ev.model, providerName: ev.name }));
          } else if (ev.type === 'failover') {
            setStatus(`${nameOf(ev.fromProviderId) ?? 'AI'} lỗi (${ev.errorCode}), chuyển sang AI dự phòng…`);
          } else if (ev.type === 'delta') {
            patch((m) => ({ ...m, content: m.content + ev.text }));
          } else if (ev.type === 'done') {
            patch((m) => ({ ...ev.message, providerName: m.providerName }));
          } else if (ev.type === 'error') {
            patch((m) => ({ ...m, status: ev.code === 'CANCELLED' ? 'cancelled' : 'error', errorCode: ev.code }));
            if (ev.code !== 'CANCELLED') setError(ERROR_TEXT[ev.code] ? `${ERROR_TEXT[ev.code]} Chi tiết: ${ev.message}` : ev.message);
          }
        },
        ctrl.signal,
      );
      onConversationChange?.(id);
    } catch (e) {
      if (ctrl.signal.aborted) {
        patch((m) => ({ ...m, status: 'cancelled' }));
      } else {
        patch((m) => ({ ...m, status: 'error' }));
        setError(e instanceof Error ? e.message : 'Lỗi không xác định');
      }
    } finally {
      setStreaming(false);
      setStatus(null);
      abortRef.current = null;
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const chosen = providers.find((p) => p.id === providerId);
  const activeAgents = agents.filter((a) => a.status === 'active' || a.id === agentId);

  /** Agent, mode and project belong to the conversation: an open one is updated right away. */
  async function choose(field: 'agentId' | 'projectId' | 'mode', value: string) {
    if (field === 'agentId') setAgentId(value);
    else if (field === 'projectId') setProjectId(value);
    else setMode(value as ChatMode);
    if (!convRef.current) return;
    try {
      await api(`/ai/conversations/${convRef.current}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: field === 'mode' ? value : value || null }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex flex-wrap gap-2 ${compact ? 'mb-2' : 'mb-3'}`}>
        {activeAgents.length > 0 && (
          <select
            value={agentId}
            onChange={(e) => void choose('agentId', e.target.value)}
            className={`${inputCls} ${compact ? '' : 'max-w-xs'} py-1.5`}
            aria-label="Chọn AI Agent"
            disabled={streaming}
          >
            <option value="">MARIS (AI tổng điều hành)</option>
            {activeAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status === 'paused' ? ' (tạm dừng)' : ''}
              </option>
            ))}
          </select>
        )}
        {!compact && (
          <select
            value={mode}
            onChange={(e) => void choose('mode', e.target.value)}
            className={`${inputCls} max-w-[11rem] py-1.5`}
            aria-label="Chế độ chat"
            disabled={streaming}
          >
            {CHAT_MODES.map((m) => (
              <option key={m} value={m}>
                Chế độ: {CHAT_MODE_INFO[m].label}
              </option>
            ))}
          </select>
        )}
        {!compact && projects.length > 0 && (
          <select
            value={projectId}
            onChange={(e) => void choose('projectId', e.target.value)}
            className={`${inputCls} max-w-xs py-1.5`}
            aria-label="Dự án"
            disabled={streaming}
          >
            <option value="">Không gắn dự án</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Dự án: {p.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModel('');
          }}
          className={`${inputCls} ${compact ? '' : 'max-w-xs'} py-1.5`}
          aria-label="Chọn AI"
          disabled={streaming}
        >
          <option value="">Tự động (AI chính, lỗi thì dự phòng)</option>
          {enabled.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.health === 'open' ? ' (đang tạm ngắt)' : ''}
            </option>
          ))}
        </select>
        {providerId && !compact && (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={chosen?.defaultModel ?? 'Model'}
            className={`${inputCls} max-w-xs py-1.5`}
            aria-label="Model"
            disabled={streaming}
          />
        )}
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-bg ${compact ? 'p-2' : 'p-4'}`}>
        {messages.length === 0 && (
          <div className="text-sm text-muted">
            {providers.length === 0 ? (
              <>
                Chưa có AI nào. <Link href="/ai" className="underline">Thêm AI Provider</Link> rồi quay lại đây.
              </>
            ) : (
              'Giao việc hoặc hỏi MARIS bằng tiếng Việt. Enter để gửi, Shift+Enter để xuống dòng.'
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-accent text-black' : 'border border-line bg-panel'
              } ${m.status === 'error' ? 'border-danger' : ''}`}
            >
              {m.role === 'user' ? (
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              ) : m.content ? (
                <>
                  <Markdown text={m.content} />
                  {m.status === 'streaming' && <span className="ml-0.5 animate-pulse">▍</span>}
                </>
              ) : (
                m.status === 'streaming' && <span className="text-muted">…</span>
              )}
              {m.role === 'assistant' && m.status !== 'streaming' && (
                <div className="mt-1 text-[11px] text-muted">
                  {[
                    m.providerName ?? nameOf(m.providerId),
                    m.model,
                    m.inputTokens != null && m.outputTokens != null ? `${m.inputTokens}+${m.outputTokens} token` : null,
                    m.costUsd != null ? `$${m.costUsd.toFixed(4)}` : null,
                    m.status === 'cancelled' ? 'đã dừng' : null,
                    m.status === 'error' ? `lỗi ${m.errorCode ?? ''}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {m.status === 'complete' && !compact && (
                    <button
                      onClick={() => {
                        sessionStorage.setItem(
                          TASK_DRAFT_KEY,
                          JSON.stringify({ scope: m.content.slice(0, 4000), agentId: agentId || null, projectId: projectId || null, conversationId: convRef.current }),
                        );
                        window.location.href = '/tasks';
                      }}
                      className="ml-2 underline"
                      title="Biến đề xuất này thành công việc cần phê duyệt"
                    >
                      Giao việc
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {status && <p className="mt-2 text-xs text-muted">{status}</p>}

      <div className="mt-2 flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={compact ? 2 : 3}
          placeholder="Nhập yêu cầu…"
          className={`${inputCls} resize-none`}
          aria-label="Tin nhắn"
          maxLength={32000}
        />
        {streaming ? (
          <button onClick={() => abortRef.current?.abort()} className="rounded-md border border-danger px-3 text-sm text-danger">
            Dừng
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!text.trim()} className={btnCls}>
            Gửi
          </button>
        )}
      </div>
    </div>
  );
}
