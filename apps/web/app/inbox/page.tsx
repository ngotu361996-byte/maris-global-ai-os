'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  META_CHANNEL_LABEL,
  META_CHANNELS,
  META_REPLY_MAX_CHARS,
  type InboxSummaryResponse,
  type InboxThreadDetail,
  type InboxThreadResponse,
  type MetaChannel,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const time = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

const CHANNEL_CLS: Record<MetaChannel, string> = {
  messenger: 'border-blue-500 text-blue-400',
  ig_dm: 'border-pink-500 text-pink-400',
  fb_comment: 'border-blue-500 text-blue-400',
  ig_comment: 'border-pink-500 text-pink-400',
};

function Channel({ c }: { c: MetaChannel }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${CHANNEL_CLS[c]}`}>
      {META_CHANNEL_LABEL[c]}
    </span>
  );
}

/** Hours and minutes left to reply in a Messenger or Instagram chat. */
function windowLeft(until: string | null): { text: string; closed: boolean } | null {
  if (!until) return null;
  const ms = Date.parse(until) - Date.now();
  if (ms <= 0)
    return { text: 'Đã quá 24 giờ từ tin cuối của khách, không trả lời được nữa', closed: true };
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return { text: `Còn ${h} giờ ${m} phút để trả lời`, closed: false };
}

/**
 * Hộp thư khách hàng (M24, spec Part 20): Facebook and Instagram comments, Messenger and
 * Instagram messages in one list. MARIS's AI suggests; a person reads, edits and sends.
 */
export default function InboxPage() {
  const me = useMe();
  const [summary, setSummary] = useState<InboxSummaryResponse | null>(null);
  const [threads, setThreads] = useState<InboxThreadResponse[]>([]);
  const [status, setStatus] = useState<'open' | 'done' | ''>('open');
  const [channel, setChannel] = useState<MetaChannel | ''>('');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [text, setText] = useState('');
  const [fromAi, setFromAi] = useState(false);
  const [busy, setBusy] = useState<'' | 'send' | 'ai' | 'sync' | 'hook' | 'update'>('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const loadList = useCallback(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (channel) p.set('channel', channel);
    if (mine) p.set('assigned', 'me');
    if (q.trim()) p.set('q', q.trim());
    api<InboxThreadResponse[]>(`/meta/inbox/threads?${p}`).then(setThreads).catch(fail);
    api<InboxSummaryResponse>('/meta/inbox/summary')
      .then(setSummary)
      .catch(() => {});
  }, [status, channel, mine, q]);

  const loadDetail = useCallback((id: string) => {
    api<InboxThreadDetail>(`/meta/inbox/threads/${id}`).then(setDetail).catch(fail);
  }, []);

  useEffect(() => {
    if (!me) return;
    loadList();
    const t = setInterval(loadList, 15_000);
    return () => clearInterval(t);
  }, [me, loadList]);

  useEffect(() => {
    setText('');
    setFromAi(false);
    if (!selected) return setDetail(null);
    loadDetail(selected);
    const t = setInterval(() => loadDetail(selected), 10_000);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [detail?.messages.length]);

  async function run<T>(kind: typeof busy, fn: () => Promise<T>, msg?: string): Promise<T | null> {
    setBusy(kind);
    setError(null);
    setOk(null);
    try {
      const r = await fn();
      if (msg) setOk(msg);
      return r;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy('');
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!detail || !text.trim()) return;
    const d = await run('send', () =>
      api<InboxThreadDetail>(`/meta/inbox/threads/${detail.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          text: text.trim(),
          clientKey: crypto.randomUUID(),
          aiAssisted: fromAi,
        }),
      }),
    );
    if (d) {
      setDetail(d);
      setText('');
      setFromAi(false);
      loadList();
    }
  }

  async function suggest() {
    if (!detail) return;
    const d = await run('ai', () =>
      api<InboxThreadDetail>(`/meta/inbox/threads/${detail.id}/suggest`, { method: 'POST' }),
    );
    if (d) {
      setDetail(d);
      if (d.suggestion?.text) {
        setText(d.suggestion.text);
        setFromAi(true);
      }
    }
  }

  async function update(body: object, msg: string) {
    if (!detail) return;
    const d = await run(
      'update',
      () =>
        api<InboxThreadDetail>(`/meta/inbox/threads/${detail.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      msg,
    );
    if (d) {
      setDetail(d);
      loadList();
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const win = detail ? windowLeft(detail.replyUntil) : null;
  const webhookOn =
    summary?.webhook.lastEventAt &&
    Date.now() - Date.parse(summary.webhook.lastEventAt) < 86400_000;

  return (
    <Shell me={me}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Hộp thư khách hàng</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {summary && (
            <span className="text-muted">
              {summary.open} hội thoại đang mở · {summary.unread} tin chưa đọc · đã trả lời{' '}
              {summary.repliesToday}/{summary.replyLimit} lượt hôm nay
            </span>
          )}
          <button className={btnGhostCls} onClick={() => setShowSetup((v) => !v)}>
            {webhookOn ? 'Webhook đang nhận tin' : 'Cách nhận tin'}
          </button>
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      {showSetup && summary && (
        <section
          className="mb-4 rounded-md border border-line p-3 text-sm"
          aria-label="Cách nhận tin"
        >
          <p className="mb-2">
            Meta báo tin mới cho MARIS qua <b>webhook</b>. Webhook chỉ hoạt động khi MARIS có địa
            chỉ HTTPS công khai (khi chạy trên máy tính, Meta không gọi tới được). Khi webhook im
            lặng quá 1 giờ, MARIS tự đọc tin mới
            {summary.pollMinutes
              ? ` mỗi ${summary.pollMinutes} phút, vài Page mỗi lượt`
              : ' (đang tắt, bật bằng META_INBOX_POLL_MIN)'}
            . {summary.lastPolledAt && <>Lần đọc gần nhất: {time(summary.lastPolledAt)}. </>}
            {summary.webhook.lastEventAt && (
              <>Webhook gần nhất: {time(summary.webhook.lastEventAt)}.</>
            )}
          </p>
          <dl className="mb-2 grid gap-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">URL gọi lại</dt>
            <dd>
              <code className="break-all rounded bg-bg px-1">{summary.webhook.callbackUrl}</code>
            </dd>
            <dt className="text-muted">Mã xác minh</dt>
            <dd>
              <code className="break-all rounded bg-bg px-1">
                {summary.webhook.verifyToken ?? 'Cài Meta App trước'}
              </code>
            </dd>
          </dl>
          <p className="mb-2 text-xs text-muted">
            Trong Meta App: Webhook → Page, nhập URL và mã trên, chọn feed và messages; Webhook →
            Instagram, chọn comments và messages. Sau đó bấm “Bật webhook cho các Page”.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy !== ''}
              className={btnGhostCls}
              onClick={() =>
                void run(
                  'hook',
                  () =>
                    api<InboxSummaryResponse>('/meta/inbox/webhook/subscribe', {
                      method: 'POST',
                    }).then(setSummary),
                  'Đã bật webhook cho các Page đang bật.',
                )
              }
            >
              Bật webhook cho các Page
            </button>
            <button
              disabled={busy !== ''}
              className={btnGhostCls}
              onClick={() =>
                void run(
                  'sync',
                  async () => {
                    setSummary(
                      await api<InboxSummaryResponse>('/meta/inbox/sync', { method: 'POST' }),
                    );
                    loadList();
                  },
                  'Đã đọc tin mới từ Facebook và Instagram.',
                )
              }
            >
              {busy === 'sync' ? 'Đang đọc…' : 'Đọc tin mới ngay'}
            </button>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <section
          aria-label="Danh sách hội thoại"
          className="rounded-lg border border-line bg-panel p-3"
        >
          <div className="mb-2 grid grid-cols-2 gap-2 text-sm">
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as 'open' | 'done' | '')}
              aria-label="Trạng thái"
            >
              <option value="open">Đang mở</option>
              <option value="done">Đã xong</option>
              <option value="">Tất cả</option>
            </select>
            <select
              className={inputCls}
              value={channel}
              onChange={(e) => setChannel(e.target.value as MetaChannel | '')}
              aria-label="Kênh"
            >
              <option value="">Mọi kênh</option>
              {META_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {META_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
            <input
              className={inputCls}
              placeholder="Tìm tên, nội dung"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Giao cho tôi
            </label>
          </div>
          {threads.length === 0 ? (
            <p className="p-2 text-sm text-muted">
              Chưa có hội thoại nào. Tin nhắn và bình luận mới trên các Page đang bật trong{' '}
              <Link href="/meta" className="text-accent underline">
                Trung tâm Meta
              </Link>{' '}
              sẽ hiện ở đây.
            </p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    className={`w-full p-2 text-left text-sm ${selected === t.id ? 'bg-bg' : ''}`}
                    onClick={() => setSelected(t.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={t.unread ? 'font-semibold' : ''}>{t.customerName}</span>
                      <span className="text-xs text-muted">{time(t.lastMessageAt)}</span>
                    </div>
                    <div className="truncate text-muted">{t.snippet || '…'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <Channel c={t.channel} />
                      <span className="text-muted">{t.assetName}</span>
                      {t.unread > 0 && (
                        <span className="rounded-full bg-accent px-1.5 text-black">{t.unread}</span>
                      )}
                      {t.assignedToName && <span className="text-muted">· {t.assignedToName}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Hội thoại" className="rounded-lg border border-line bg-panel p-3">
          {!detail ? (
            <p className="p-2 text-sm text-muted">Chọn một hội thoại bên trái.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">{detail.customerName}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Channel c={detail.channel} /> {detail.assetName}
                    {detail.assignedToName && <> · giao cho {detail.assignedToName}</>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.assignedTo !== me.id ? (
                    <button
                      disabled={busy !== ''}
                      className={btnGhostCls}
                      onClick={() => void update({ assignedTo: me.id }, 'Đã nhận hội thoại.')}
                    >
                      Nhận xử lý
                    </button>
                  ) : (
                    <button
                      disabled={busy !== ''}
                      className={btnGhostCls}
                      onClick={() => void update({ assignedTo: null }, 'Đã bỏ nhận.')}
                    >
                      Bỏ nhận
                    </button>
                  )}
                  <button
                    disabled={busy !== ''}
                    className={btnGhostCls}
                    onClick={() =>
                      void update(
                        { status: detail.status === 'open' ? 'done' : 'open' },
                        detail.status === 'open' ? 'Đã đánh dấu xong.' : 'Đã mở lại.',
                      )
                    }
                  >
                    {detail.status === 'open' ? 'Đánh dấu xong' : 'Mở lại'}
                  </button>
                </div>
              </div>

              <div className="mb-3 max-h-[50vh] space-y-2 overflow-y-auto rounded-md bg-bg p-2">
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                        m.direction === 'out' ? 'bg-accent/15' : 'border border-line'
                      }`}
                    >
                      <div className="mb-0.5 text-xs text-muted">
                        {m.direction === 'out' ? (m.sentByName ?? m.authorName) : m.authorName} ·{' '}
                        {time(m.sentAt)}
                        {m.aiAssisted && ' · có AI gợi ý'}
                      </div>
                      {m.body && <div className="whitespace-pre-wrap">{m.body}</div>}
                      {m.attachments.map((a, i) =>
                        a.url ? (
                          <a
                            key={i}
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block text-accent underline"
                          >
                            Tệp đính kèm ({a.type})
                          </a>
                        ) : (
                          <div key={i} className="text-muted">
                            [{a.type}]
                          </div>
                        ),
                      )}
                      {m.status === 'sending' && (
                        <div className="text-xs text-muted">Đang gửi…</div>
                      )}
                      {(m.status === 'failed' || m.status === 'unknown') && (
                        <div className="text-xs text-danger">
                          {m.status === 'failed' ? 'Chưa gửi được: ' : ''}
                          {m.errorMessage}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>

              {detail.suggestion?.handoff && (
                <Notice kind="info">
                  AI đề nghị nhân viên tự xử lý hội thoại này
                  {detail.suggestion.reason ? `: ${detail.suggestion.reason}` : ''}.
                </Notice>
              )}
              {win && (
                <p className={`mb-2 text-xs ${win.closed ? 'text-danger' : 'text-muted'}`}>
                  {win.text}
                </p>
              )}
              <form onSubmit={send}>
                <textarea
                  className={inputCls}
                  rows={3}
                  maxLength={META_REPLY_MAX_CHARS}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    detail.channel.endsWith('comment')
                      ? 'Trả lời công khai dưới bình luận'
                      : 'Trả lời khách'
                  }
                  disabled={win?.closed}
                  aria-label="Nội dung trả lời"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    disabled={busy !== '' || !text.trim() || win?.closed}
                    className={btnCls}
                  >
                    {busy === 'send' ? 'Đang gửi…' : 'Gửi'}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== '' || win?.closed}
                    className={btnGhostCls}
                    onClick={() => void suggest()}
                  >
                    {busy === 'ai' ? 'AI đang viết…' : 'AI gợi ý trả lời'}
                  </button>
                  <span className="text-xs text-muted">
                    AI chỉ gợi ý; bạn đọc, sửa rồi bấm Gửi. Bài trả lời gửi dưới tên Page.
                  </span>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </Shell>
  );
}
