'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  CRM_SOURCE_LABEL,
  CRM_SOURCES,
  CRM_STAGE_LABEL,
  CRM_STAGES,
  META_CHANNEL_LABEL,
  type ContactDetail,
  type ContactResponse,
  type CrmSource,
  type CrmStage,
  type CrmSummaryResponse,
  type LeadFormResponse,
  type LeadResponse,
  type MemberResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const time = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const vnd = (n: number) => `${n.toLocaleString('vi-VN')} ₫`;

const STAGE_CLS: Record<CrmStage, string> = {
  new: 'border-sky-500 text-sky-400',
  contacted: 'border-amber-500 text-amber-400',
  qualified: 'border-violet-500 text-violet-400',
  won: 'border-green-600 text-green-500',
  lost: 'border-line text-muted',
};

function Stage({ s }: { s: CrmStage }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STAGE_CLS[s]}`}>
      {CRM_STAGE_LABEL[s]}
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  created: 'Tạo khách hàng',
  note: 'Ghi chú',
  stage: 'Đổi giai đoạn',
  owner: 'Phụ trách',
  lead: 'Lead Ads',
  thread: 'Hội thoại',
  updated: 'Sửa thông tin',
  archived: 'Lưu trữ',
  order: 'Đơn hàng',
};
const FIELD_LABEL: Record<string, string> = {
  name: 'tên',
  phone: 'số điện thoại',
  email: 'email',
  tags: 'nhãn',
  note: 'ghi chú',
  valueVnd: 'giá trị',
  lostReason: 'lý do',
};

const emptyForm = { name: '', phone: '', email: '', tags: '', valueVnd: '' };

/**
 * CRM và bán hàng (M25, spec Part 20): every customer from Lead Ads, Messenger, Instagram and
 * comments in one list, with a sales pipeline, an owner, notes and a history; and the Lead Ads
 * forms and leads that feed it.
 */
export default function CrmPage() {
  const me = useMe();
  const [tab, setTab] = useState<'contacts' | 'leads'>('contacts');
  const [summary, setSummary] = useState<CrmSummaryResponse | null>(null);
  const [list, setList] = useState<ContactResponse[]>([]);
  const [stage, setStage] = useState<CrmStage | ''>('');
  const [source, setSource] = useState<CrmSource | ''>('');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [members, setMembers] = useState<MemberResponse[]>([]);
  const [forms, setForms] = useState<LeadFormResponse[]>([]);
  const [leads, setLeads] = useState<LeadResponse[]>([]);
  const [formId, setFormId] = useState('');
  const [leadQ, setLeadQ] = useState('');
  const [openLead, setOpenLead] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [edit, setEdit] = useState(emptyForm);
  const [note, setNote] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const loadSummary = useCallback(() => {
    api<CrmSummaryResponse>('/crm/summary')
      .then(setSummary)
      .catch(() => {});
  }, []);

  const loadList = useCallback(() => {
    const p = new URLSearchParams();
    if (stage) p.set('stage', stage);
    if (source) p.set('source', source);
    if (mine) p.set('owner', 'me');
    if (q.trim()) p.set('q', q.trim());
    api<ContactResponse[]>(`/crm/contacts?${p}`).then(setList).catch(fail);
    loadSummary();
  }, [stage, source, mine, q, loadSummary]);

  const loadLeads = useCallback(() => {
    const p = new URLSearchParams();
    if (formId) p.set('formId', formId);
    if (leadQ.trim()) p.set('q', leadQ.trim());
    api<LeadResponse[]>(`/crm/leads?${p}`).then(setLeads).catch(fail);
    api<LeadFormResponse[]>('/crm/lead-forms').then(setForms).catch(fail);
    loadSummary();
  }, [formId, leadQ, loadSummary]);

  const show = useCallback((d: ContactDetail) => {
    setDetail(d);
    setEdit({
      name: d.name,
      phone: d.phone ?? '',
      email: d.email ?? '',
      tags: d.tags.join(', '),
      valueVnd: d.valueVnd == null ? '' : String(d.valueVnd),
    });
    setLostReason(d.lostReason ?? '');
  }, []);

  useEffect(() => {
    if (!me) return;
    const id = new URLSearchParams(window.location.search).get('contact');
    if (id) setSelected(id);
    api<MemberResponse[]>('/tenants/current/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [me]);

  useEffect(() => {
    if (!me || tab !== 'contacts') return;
    loadList();
    const t = setInterval(loadList, 30_000);
    return () => clearInterval(t);
  }, [me, tab, loadList]);

  useEffect(() => {
    if (!me || tab !== 'leads') return;
    loadLeads();
  }, [me, tab, loadLeads]);

  useEffect(() => {
    setNote('');
    if (!selected) return setDetail(null);
    api<ContactDetail>(`/crm/contacts/${selected}`).then(show).catch(fail);
  }, [selected, show]);

  async function run<T>(kind: string, fn: () => Promise<T>, msg?: string): Promise<T | null> {
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

  async function patch(body: object, msg: string) {
    if (!detail) return;
    const d = await run(
      'patch',
      () =>
        api<ContactDetail>(`/crm/contacts/${detail.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      msg,
    );
    if (d) {
      show(d);
      loadList();
    }
  }

  const tagsOf = (s: string) =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  const valueOf = (s: string) => (s.trim() ? Number(s.replace(/\D/g, '')) : null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const d = await run(
      'create',
      () =>
        api<ContactDetail>('/crm/contacts', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            phone: form.phone.trim() || undefined,
            email: form.email.trim() || undefined,
            tags: tagsOf(form.tags),
            valueVnd: valueOf(form.valueVnd),
          }),
        }),
      'Đã thêm khách hàng.',
    );
    if (d) {
      setForm(emptyForm);
      setAdding(false);
      setSelected(d.id);
      show(d);
      loadList();
    }
  }

  async function saveInfo(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    await patch(
      {
        name: edit.name.trim(),
        phone: edit.phone.trim(),
        email: edit.email.trim(),
        tags: tagsOf(edit.tags),
        valueVnd: valueOf(edit.valueVnd),
      },
      'Đã lưu thông tin.',
    );
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!detail || !note.trim()) return;
    const d = await run('note', () =>
      api<ContactDetail>(`/crm/contacts/${detail.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: note.trim() }),
      }),
    );
    if (d) {
      show(d);
      setNote('');
      loadList();
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const lead = summary?.leadAds;

  return (
    <Shell me={me}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">CRM và bán hàng</h1>
        <div className="flex gap-2 text-sm" role="tablist">
          {(
            [
              ['contacts', 'Khách hàng'],
              ['leads', 'Lead Ads'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={tab === k ? btnCls : `${btnGhostCls} px-3 py-2 text-sm`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Giai đoạn">
          {CRM_STAGES.map((s) => (
            <button
              key={s}
              onClick={() => {
                setTab('contacts');
                setStage(stage === s ? '' : s);
              }}
              className={`rounded-lg border bg-panel p-2 text-left ${stage === s ? 'border-accent' : 'border-line'}`}
            >
              <div className="text-xs text-muted">{CRM_STAGE_LABEL[s]}</div>
              <div className="text-lg font-semibold">{summary.stages[s]}</div>
            </button>
          ))}
        </div>
      )}

      {tab === 'contacts' ? (
        <div className="grid gap-4 lg:grid-cols-[24rem_1fr]">
          <section
            aria-label="Danh sách khách hàng"
            className="rounded-lg border border-line bg-panel p-3"
          >
            <div className="mb-2 grid grid-cols-2 gap-2 text-sm">
              <input
                className={`${inputCls} col-span-2`}
                placeholder="Tìm tên, số điện thoại, email, nhãn"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <select
                className={inputCls}
                value={source}
                onChange={(e) => setSource(e.target.value as CrmSource | '')}
                aria-label="Nguồn"
              >
                <option value="">Mọi nguồn</option>
                {CRM_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {CRM_SOURCE_LABEL[s]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
                Tôi phụ trách
              </label>
            </div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted">
              <span>
                {summary
                  ? `${summary.total} khách hàng · ${summary.unassigned} chưa có người phụ trách`
                  : ''}
              </span>
              <button className={btnGhostCls} onClick={() => setAdding((v) => !v)}>
                {adding ? 'Đóng' : 'Thêm khách hàng'}
              </button>
            </div>
            {adding && (
              <form
                onSubmit={create}
                className="mb-3 grid gap-2 rounded-md border border-line p-2 text-sm"
              >
                <input
                  className={inputCls}
                  placeholder="Tên khách hàng"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
                <input
                  className={inputCls}
                  placeholder="Số điện thoại"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
                <input
                  className={inputCls}
                  placeholder="Email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                <input
                  className={inputCls}
                  placeholder="Nhãn, cách nhau bằng dấu phẩy"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                />
                <input
                  className={inputCls}
                  placeholder="Giá trị dự kiến (đồng)"
                  inputMode="numeric"
                  value={form.valueVnd}
                  onChange={(e) => setForm({ ...form, valueVnd: e.target.value })}
                />
                <button className={btnCls} disabled={busy !== '' || !form.name.trim()}>
                  {busy === 'create' ? 'Đang lưu…' : 'Lưu khách hàng'}
                </button>
              </form>
            )}
            {list.length === 0 ? (
              <p className="p-2 text-sm text-muted">
                Chưa có khách hàng nào. Lead từ quảng cáo Facebook tự vào đây; trong{' '}
                <Link href="/inbox" className="text-accent underline">
                  Hộp thư khách hàng
                </Link>{' '}
                bấm “Lưu vào CRM” để thêm người đã nhắn tin.
              </p>
            ) : (
              <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto">
                {list.map((c) => (
                  <li key={c.id}>
                    <button
                      className={`w-full p-2 text-left text-sm ${selected === c.id ? 'bg-bg' : ''}`}
                      onClick={() => setSelected(c.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{c.name}</span>
                        <Stage s={c.stage} />
                      </div>
                      <div className="truncate text-muted">
                        {[c.phone, c.email].filter(Boolean).join(' · ') ||
                          'Chưa có số điện thoại, email'}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted">
                        <span>{CRM_SOURCE_LABEL[c.source]}</span>
                        {c.ownerName && <span>· {c.ownerName}</span>}
                        <span>· {time(c.lastActivityAt)}</span>
                        {c.tags.map((t) => (
                          <span key={t} className="rounded bg-bg px-1">
                            {t}
                          </span>
                        ))}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Khách hàng" className="rounded-lg border border-line bg-panel p-3">
            {!detail ? (
              <p className="p-2 text-sm text-muted">Chọn một khách hàng bên trái.</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-lg font-semibold">{detail.name}</div>
                    <div className="text-xs text-muted">
                      {CRM_SOURCE_LABEL[detail.source]} · tạo lúc {time(detail.createdAt)}
                      {detail.valueVnd != null && <> · giá trị dự kiến {vnd(detail.valueVnd)}</>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <select
                      className={inputCls}
                      value={detail.ownerId ?? ''}
                      disabled={busy !== '' || detail.archived}
                      aria-label="Người phụ trách"
                      onChange={(e) =>
                        void patch({ ownerId: e.target.value || null }, 'Đã đổi người phụ trách.')
                      }
                    >
                      <option value="">Chưa có người phụ trách</option>
                      {members.length === 0 && <option value={me.id}>{me.displayName}</option>}
                      {detail.ownerId &&
                        detail.ownerId !== me.id &&
                        !members.some((m) => m.userId === detail.ownerId) && (
                          <option value={detail.ownerId}>{detail.ownerName}</option>
                        )}
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Đổi giai đoạn">
                  {CRM_STAGES.map((s) => (
                    <button
                      key={s}
                      disabled={busy !== '' || detail.archived || detail.stage === s}
                      className={`rounded border px-2 py-1 text-xs ${detail.stage === s ? `${STAGE_CLS[s]} font-semibold` : 'border-line'}`}
                      onClick={() =>
                        void patch(
                          s === 'lost' ? { stage: s, lostReason } : { stage: s },
                          `Đã chuyển sang “${CRM_STAGE_LABEL[s]}”.`,
                        )
                      }
                    >
                      {CRM_STAGE_LABEL[s]}
                    </button>
                  ))}
                  <input
                    className={`${inputCls} max-w-xs py-1 text-xs`}
                    placeholder="Lý do không mua (khi chọn Không mua)"
                    value={lostReason}
                    maxLength={300}
                    onChange={(e) => setLostReason(e.target.value)}
                  />
                </div>
                {detail.stage === 'lost' && detail.lostReason && (
                  <p className="mb-3 text-xs text-muted">Lý do: {detail.lostReason}</p>
                )}

                <div className="grid gap-4 xl:grid-cols-2">
                  <div>
                    <form
                      onSubmit={saveInfo}
                      className="mb-4 grid gap-2 text-sm"
                      aria-label="Thông tin"
                    >
                      <h2 className="text-sm font-semibold">Thông tin</h2>
                      {(
                        [
                          ['name', 'Tên'],
                          ['phone', 'Số điện thoại'],
                          ['email', 'Email'],
                          ['tags', 'Nhãn (dấu phẩy)'],
                          ['valueVnd', 'Giá trị dự kiến (đồng)'],
                        ] as const
                      ).map(([k, label]) => (
                        <label key={k} className="grid gap-0.5">
                          <span className="text-xs text-muted">{label}</span>
                          <input
                            className={inputCls}
                            value={edit[k]}
                            disabled={detail.archived}
                            onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                          />
                        </label>
                      ))}
                      <div className="flex flex-wrap gap-2">
                        <button className={btnCls} disabled={busy !== '' || detail.archived}>
                          Lưu thông tin
                        </button>
                        {!detail.archived && (
                          <button
                            type="button"
                            className={btnGhostCls}
                            disabled={busy !== ''}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Lưu trữ “${detail.name}”? Khách hàng sẽ ẩn khỏi danh sách.`,
                                )
                              )
                                void patch({ archived: true }, 'Đã lưu trữ khách hàng.').then(() =>
                                  setSelected(null),
                                );
                            }}
                          >
                            Lưu trữ
                          </button>
                        )}
                      </div>
                    </form>

                    {detail.threads.length > 0 && (
                      <div className="mb-4">
                        <h2 className="mb-1 text-sm font-semibold">Hội thoại</h2>
                        <ul className="space-y-1 text-sm">
                          {detail.threads.map((t) => (
                            <li key={t.id}>
                              <Link
                                href={`/inbox?thread=${t.id}`}
                                className="text-accent underline"
                              >
                                {META_CHANNEL_LABEL[t.channel]} · {t.assetName}
                              </Link>
                              <span className="text-muted">
                                {' '}
                                · {time(t.lastMessageAt)} · {t.snippet}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {detail.leads.length > 0 && (
                      <div className="mb-4">
                        <h2 className="mb-1 text-sm font-semibold">Lead từ quảng cáo</h2>
                        {detail.leads.map((l) => (
                          <LeadAnswers key={l.id} l={l} />
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h2 className="mb-1 text-sm font-semibold">Lịch sử chăm sóc</h2>
                    {!detail.archived && (
                      <form onSubmit={addNote} className="mb-2">
                        <textarea
                          className={inputCls}
                          rows={2}
                          maxLength={4000}
                          value={note}
                          placeholder="Ghi chú: đã gọi, khách hẹn, nhu cầu…"
                          onChange={(e) => setNote(e.target.value)}
                          aria-label="Ghi chú"
                        />
                        <button className={`${btnCls} mt-1`} disabled={busy !== '' || !note.trim()}>
                          Thêm ghi chú
                        </button>
                      </form>
                    )}
                    <ol className="max-h-[55vh] space-y-2 overflow-y-auto text-sm">
                      {detail.activities.map((a) => (
                        <li key={a.id} className="rounded-md border border-line p-2">
                          <div className="text-xs text-muted">
                            {KIND_LABEL[a.kind] ?? a.kind} · {time(a.createdAt)} ·{' '}
                            {a.actorName ?? 'MARIS'}
                          </div>
                          {a.kind === 'updated' ? (
                            <div>
                              Sửa{' '}
                              {((a.data.fields as string[] | undefined) ?? [])
                                .map((f) => FIELD_LABEL[f] ?? f)
                                .join(', ')}
                            </div>
                          ) : a.kind === 'created' ? (
                            <div>
                              Nguồn:{' '}
                              {CRM_SOURCE_LABEL[(a.data.source as CrmSource) ?? 'manual'] ?? ''}
                            </div>
                          ) : (
                            a.body && <div className="whitespace-pre-wrap">{a.body}</div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="grid gap-4">
          {lead && !lead.ready && (
            <Notice kind="info">
              Lead Ads chưa sẵn sàng: kết nối Facebook còn thiếu quyền{' '}
              {lead.missingScopes.join(', ') || '(chưa kết nối)'}. Trong Meta App, thêm trường hợp
              sử dụng <b>Thu thập và quản lý khách hàng tiềm năng</b> (Capture & manage ad leads),
              rồi vào{' '}
              <Link href="/meta" className="text-accent underline">
                Trung tâm Meta
              </Link>{' '}
              bấm <b>Kết nối lại</b> để Facebook cấp quyền.
            </Notice>
          )}
          <section aria-label="Biểu mẫu" className="rounded-lg border border-line bg-panel p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Biểu mẫu Lead Ads</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {lead && (
                  <span>
                    {summary?.leads7d ?? 0} lead trong 7 ngày ·{' '}
                    {lead.pollMinutes
                      ? `MARIS tự đọc lead mới mỗi ${lead.pollMinutes} phút`
                      : 'Tự đọc lead đang tắt (META_LEADS_POLL_MIN)'}
                    {lead.lastSyncedAt && ` · lần đọc gần nhất ${time(lead.lastSyncedAt)}`}
                  </span>
                )}
                <button
                  className={btnGhostCls}
                  disabled={busy !== ''}
                  onClick={() =>
                    void run('sync', async () => {
                      const r = await api<CrmSummaryResponse & { added: number }>(
                        '/crm/leads/sync',
                        {
                          method: 'POST',
                        },
                      );
                      setSummary(r);
                      loadLeads();
                      setOk(r.added ? `Đã nhận ${r.added} lead mới.` : 'Không có lead mới.');
                    })
                  }
                >
                  {busy === 'sync' ? 'Đang đọc…' : 'Đọc lead ngay'}
                </button>
              </div>
            </div>
            {forms.length === 0 ? (
              <p className="text-sm text-muted">
                Chưa có biểu mẫu nào. Bấm “Đọc lead ngay” để lấy các biểu mẫu Lead Ads của những
                Page đang bật.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1">Biểu mẫu</th>
                    <th>Page</th>
                    <th>Lead</th>
                    <th>Lead mới nhất</th>
                    <th>Nhận lead</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {forms.map((f) => (
                    <tr key={f.id}>
                      <td className="py-1">
                        <button
                          className="text-left text-accent underline"
                          onClick={() => setFormId(f.id)}
                        >
                          {f.name}
                        </button>
                        {f.status !== 'ACTIVE' && (
                          <span className="ml-1 text-xs text-muted">({f.status})</span>
                        )}
                      </td>
                      <td>{f.pageName}</td>
                      <td>{f.leads}</td>
                      <td>{f.lastLeadAt ? time(f.lastLeadAt) : '–'}</td>
                      <td>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={f.enabled}
                            disabled={busy !== ''}
                            onChange={(e) =>
                              void run('form', () =>
                                api<LeadFormResponse[]>(`/crm/lead-forms/${f.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ enabled: e.target.checked }),
                                }).then(setForms),
                              )
                            }
                          />
                          {f.enabled ? 'Đang nhận' : 'Đã tắt'}
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-label="Lead" className="rounded-lg border border-line bg-panel p-3">
            <div className="mb-2 grid gap-2 text-sm sm:grid-cols-[1fr_16rem]">
              <input
                className={inputCls}
                placeholder="Tìm trong câu trả lời, quảng cáo, chiến dịch"
                value={leadQ}
                onChange={(e) => setLeadQ(e.target.value)}
              />
              <select
                className={inputCls}
                value={formId}
                onChange={(e) => setFormId(e.target.value)}
                aria-label="Biểu mẫu"
              >
                <option value="">Mọi biểu mẫu</option>
                {forms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            {leads.length === 0 ? (
              <p className="text-sm text-muted">Chưa có lead nào.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1">Thời gian</th>
                    <th>Khách</th>
                    <th>Liên hệ</th>
                    <th>Biểu mẫu · quảng cáo</th>
                    <th>Khách hàng CRM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {leads.map((l) => (
                    <tr key={l.id} className="align-top">
                      <td className="py-1 whitespace-nowrap">{time(l.leadAt)}</td>
                      <td>
                        <button
                          className="text-left underline decoration-dotted"
                          onClick={() => setOpenLead(openLead === l.id ? null : l.id)}
                        >
                          {l.name ?? 'Không tên'}
                        </button>
                        {openLead === l.id && <LeadAnswers l={l} />}
                      </td>
                      <td>{[l.phone, l.email].filter(Boolean).join(' · ') || '–'}</td>
                      <td>
                        {l.formName}
                        <div className="text-xs text-muted">
                          {l.isOrganic
                            ? 'Không qua quảng cáo'
                            : [l.adName, l.campaignName].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td>
                        {l.contactId ? (
                          <button
                            className="text-accent underline"
                            onClick={() => {
                              setTab('contacts');
                              setSelected(l.contactId);
                            }}
                          >
                            {l.contactName}
                          </button>
                        ) : (
                          '–'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}

function LeadAnswers({ l }: { l: LeadResponse }) {
  return (
    <div className="mb-2 rounded-md border border-line p-2 text-xs">
      <div className="mb-1 text-muted">
        {l.formName} · {l.pageName} · {time(l.leadAt)}
        {l.adName && <> · {l.adName}</>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {l.fields.map((f) => (
          <div key={f.name} className="contents">
            <dt className="text-muted">{f.name.replace(/_/g, ' ')}</dt>
            <dd className="break-words">{f.values.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
