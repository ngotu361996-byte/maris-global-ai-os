'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AD_PERIODS,
  type AdAlert,
  type AdChangeResponse,
  type AdDay,
  type AdMetrics,
  type AdObjectResponse,
  type AdSyncResponse,
  type AdsSummaryResponse,
  type CampaignDetail,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const time = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const num = (n: number, digits = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: digits });
const money = (n: number | null, cur: string | null) =>
  n === null
    ? '—'
    : `${num(n, cur === 'VND' ? 0 : 2)}${cur === 'VND' ? ' ₫' : cur ? ` ${cur}` : ''}`;
const pct = (n: number | null) => (n === null ? '—' : `${num(n, 2)}%`);

const ALERT_CLS: Record<AdAlert['level'], string> = {
  critical: 'border-danger text-danger',
  warning: 'border-amber-500 text-amber-400',
  info: 'border-line text-muted',
};
const ALERT_LABEL: Record<AdAlert['level'], string> = {
  critical: 'Nghiêm trọng',
  warning: 'Cảnh báo',
  info: 'Gợi ý',
};
const CHANGE_LABEL: Record<AdChangeResponse['status'], string> = {
  pending: 'Chờ duyệt',
  applying: 'Đang gửi Meta',
  applied: 'Đã áp dụng',
  failed: 'Lỗi',
  rejected: 'Bị từ chối',
  cancelled: 'Đã rút',
};
const LEVEL_LABEL = { campaign: 'Chiến dịch', adset: 'Nhóm quảng cáo', ad: 'Quảng cáo' } as const;

function Status({ o }: { o: AdObjectResponse }) {
  const cls =
    o.effectiveStatus === 'ACTIVE'
      ? 'border-green-600 text-green-500'
      : o.effectiveStatus === 'DISAPPROVED' || o.effectiveStatus === 'WITH_ISSUES'
        ? 'border-danger text-danger'
        : 'border-line text-muted';
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${cls}`}>
      {o.present ? o.statusLabel : 'Không còn trên Meta'}
    </span>
  );
}

/** Daily spend, one bar a day, with the figures of the day on hover. */
function SpendChart({ series, currency }: { series: AdDay[]; currency: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...series.map((d) => d.spend), 0);
  if (!series.length) return null;
  const h = hover === null ? null : series[hover]!;
  return (
    <figure className="relative" aria-label="Chi tiêu theo ngày">
      <div className="mb-1 flex h-5 items-center justify-between text-xs text-muted">
        <span>Chi tiêu theo ngày</span>
        {h && (
          <span className="text-ink">
            {new Date(`${h.day}T00:00:00`).toLocaleDateString('vi-VN')}: {money(h.spend, currency)}{' '}
            · {num(h.results)} kết quả · {num(h.clicks)} nhấp
          </span>
        )}
      </div>
      <div
        className="flex h-32 items-end gap-0.5 border-b border-line"
        onMouseLeave={() => setHover(null)}
      >
        {series.map((d, i) => (
          <div
            key={d.day}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            tabIndex={0}
            aria-label={`${d.day}: ${money(d.spend, currency)}`}
          >
            <div
              className={`w-full rounded-t ${hover === i ? 'bg-accent' : 'bg-accent/70'}`}
              style={{
                height: max > 0 ? `${Math.max((d.spend / max) * 100, d.spend > 0 ? 2 : 0)}%` : 0,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{new Date(`${series[0]!.day}T00:00:00`).toLocaleDateString('vi-VN')}</span>
        <span>Cao nhất {money(max, currency)}</span>
        <span>{new Date(`${series.at(-1)!.day}T00:00:00`).toLocaleDateString('vi-VN')}</span>
      </div>
    </figure>
  );
}

function Tiles({ m, currency }: { m: AdMetrics; currency: string | null }) {
  const tiles: [string, string, string?][] = [
    ['Chi tiêu', money(m.spend, currency)],
    ['Hiển thị', num(m.impressions), `CPM ${money(m.cpm, currency)}`],
    ['Lượt nhấp', num(m.clicks), `CTR ${pct(m.ctr)} · CPC ${money(m.cpc, currency)}`],
    [
      'Kết quả',
      num(m.results),
      `${num(m.purchases)} mua · ${num(m.leads)} lead · ${num(m.messages)} tin nhắn`,
    ],
    ['Chi phí mỗi kết quả (CPA)', money(m.cpa, currency)],
    [
      'ROAS theo Meta',
      m.roas === null ? '—' : `${num(m.roas, 2)}×`,
      `Giá trị mua Meta báo ${money(m.purchaseValue, currency)}`,
    ],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map(([label, value, sub]) => (
        <div key={label} className="rounded-lg border border-line bg-panel p-2">
          <div className="text-xs text-muted">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
          {sub && <div className="text-xs text-muted">{sub}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Trung tâm quảng cáo (M23, spec Part 19): spend and results of every enabled Meta ad account,
 * campaign comparison, alerts and suggestions, and pausing, turning on and daily budgets with an
 * approval step above the approved limit.
 */
export default function AdsPage() {
  const me = useMe();
  const [days, setDays] = useState<number>(7);
  const [accountId, setAccountId] = useState('');
  const [summary, setSummary] = useState<AdsSummaryResponse | null>(null);
  const [allAccounts, setAllAccounts] = useState<AdsSummaryResponse['accounts']>([]);
  const [list, setList] = useState<AdObjectResponse[]>([]);
  const [changes, setChanges] = useState<AdChangeResponse[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [budget, setBudget] = useState<{ id: string; value: string } | null>(null);
  const [cap, setCap] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    const p = new URLSearchParams({ days: String(days) });
    if (accountId) p.set('accountId', accountId);
    api<AdsSummaryResponse>(`/ads/summary?${p}`)
      .then((r) => {
        setSummary(r);
        if (!accountId) setAllAccounts(r.accounts);
      })
      .catch(fail);
    // The account list keeps every account while one is chosen.
    if (accountId)
      api<AdsSummaryResponse>(`/ads/summary?days=${days}`)
        .then((r) => setAllAccounts(r.accounts))
        .catch(() => {});
    api<AdObjectResponse[]>(`/ads/campaigns?${p}`).then(setList).catch(fail);
    api<AdChangeResponse[]>('/ads/changes').then(setChanges).catch(fail);
  }, [days, accountId]);

  const loadDetail = useCallback(() => {
    if (!open) return setDetail(null);
    api<CampaignDetail>(`/ads/campaigns/${open}?days=${days}`).then(setDetail).catch(fail);
  }, [open, days]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);
  useEffect(() => {
    if (me) loadDetail();
  }, [me, loadDetail]);

  const account = summary?.accounts.find((a) => a.id === accountId) ?? null;
  useEffect(() => {
    setCap(account?.dailyCap == null ? '' : String(account.dailyCap));
  }, [account?.id, account?.dailyCap]);

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    setError(null);
    setOk(null);
    try {
      return await fn();
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy('');
    }
  }

  const after = (c: AdChangeResponse | null) => {
    if (!c) return;
    if (c.status === 'pending')
      setOk('Thay đổi vượt giới hạn ngân sách đã duyệt nên đang chờ người có quyền duyệt.');
    else if (c.status === 'applied') setOk('Đã gửi thay đổi lên Meta.');
    else if (c.status === 'failed') setError(`Meta không nhận thay đổi: ${c.error ?? ''}`);
    load();
    loadDetail();
  };

  const sync = async () => {
    const r = await run('sync', () => api<AdSyncResponse>('/ads/sync', { method: 'POST' }));
    if (r) {
      if (r.errors.length) setError(r.errors.join('; '));
      else setOk(`Đã đọc ${r.accounts} tài khoản, ${r.campaigns} chiến dịch.`);
      load();
      loadDetail();
    }
  };
  const setStatus = async (o: AdObjectResponse, status: 'ACTIVE' | 'PAUSED') =>
    after(
      await run(`s:${o.id}`, () =>
        api<AdChangeResponse>(`/ads/objects/${o.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      ),
    );
  const saveBudget = async () => {
    if (!budget) return;
    const value = Number(budget.value.replace(/[^\d.]/g, ''));
    if (!value) return setError('Nhập ngân sách hằng ngày lớn hơn 0');
    const c = await run(`b:${budget.id}`, () =>
      api<AdChangeResponse>(`/ads/objects/${budget.id}/budget`, {
        method: 'POST',
        body: JSON.stringify({ dailyBudget: value }),
      }),
    );
    if (c) setBudget(null);
    after(c);
  };
  const decide = async (c: AdChangeResponse, how: 'approve' | 'reject') =>
    after(
      await run(`c:${c.id}`, () =>
        api<AdChangeResponse>(`/ads/changes/${c.id}/${how}`, { method: 'POST', body: '{}' }),
      ),
    );
  const saveCap = async () => {
    if (!account) return;
    const v = cap.trim() === '' ? null : Number(cap.replace(/[^\d.]/g, ''));
    const r = await run('cap', () =>
      api(`/ads/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ dailyCap: v }),
      }),
    );
    if (r) {
      setOk('Đã lưu giới hạn ngân sách.');
      load();
    }
  };

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const currency = account?.currency ?? summary?.totals[0]?.currency ?? null;
  const totals = account ? account.metrics : (summary?.totals[0]?.metrics ?? null);
  const pending = changes.filter((c) => c.status === 'pending');

  const row = (o: AdObjectResponse, withMetrics: boolean) => (
    <tr key={o.id} className={`border-t border-line ${o.present ? '' : 'opacity-60'}`}>
      <td className="p-2">
        {o.level === 'campaign' ? (
          <button
            className="text-left font-medium underline-offset-2 hover:underline"
            onClick={() => setOpen(open === o.id ? null : o.id)}
          >
            {o.name}
          </button>
        ) : (
          <span>{o.name}</span>
        )}
        <div className="text-xs text-muted">{o.objective ?? LEVEL_LABEL[o.level]}</div>
      </td>
      <td className="p-2">
        <Status o={o} />
        {o.openChange && (
          <div className="mt-1 text-xs text-amber-400">
            {o.openChange.status === 'pending' ? 'Có thay đổi chờ duyệt' : 'Đang gửi Meta'}
          </div>
        )}
      </td>
      <td className="p-2 whitespace-nowrap">
        {budget?.id === o.id ? (
          <span className="flex gap-1">
            <input
              className={`${inputCls} w-28 py-1`}
              inputMode="decimal"
              value={budget.value}
              onChange={(e) => setBudget({ id: o.id, value: e.target.value })}
              aria-label="Ngân sách hằng ngày mới"
            />
            <button className={btnGhostCls} disabled={busy !== ''} onClick={saveBudget}>
              Lưu
            </button>
            <button className={btnGhostCls} onClick={() => setBudget(null)}>
              Hủy
            </button>
          </span>
        ) : o.dailyBudget !== null ? (
          <>
            {money(o.dailyBudget, o.currency)}/ngày
            {summary?.canManage && o.present && (
              <button
                className={`${btnGhostCls} ml-1`}
                onClick={() => setBudget({ id: o.id, value: String(o.dailyBudget) })}
              >
                Đổi
              </button>
            )}
          </>
        ) : o.lifetimeBudget !== null ? (
          `${money(o.lifetimeBudget, o.currency)} trọn đời`
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      {withMetrics && o.metrics && (
        <>
          <td className="p-2 text-right">{money(o.metrics.spend, o.currency)}</td>
          <td className="p-2 text-right">{num(o.metrics.results)}</td>
          <td className="p-2 text-right">{money(o.metrics.cpa, o.currency)}</td>
          <td className="p-2 text-right">{pct(o.metrics.ctr)}</td>
          <td className="p-2 text-right">{money(o.metrics.cpc, o.currency)}</td>
          <td className="p-2 text-right">
            {o.metrics.roas === null ? '—' : `${num(o.metrics.roas, 2)}×`}
          </td>
        </>
      )}
      <td className="p-2 text-right">
        {summary?.canManage &&
          o.present &&
          ['ACTIVE', 'PAUSED'].includes(o.status) &&
          !o.openChange && (
            <button
              className={btnGhostCls}
              disabled={
                busy !== '' || (o.status === 'PAUSED' && o.effectiveStatus === 'DISAPPROVED')
              }
              onClick={() => setStatus(o, o.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')}
            >
              {o.status === 'ACTIVE' ? 'Tạm dừng' : 'Bật lại'}
            </button>
          )}
      </td>
    </tr>
  );

  return (
    <Shell me={me}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trung tâm quảng cáo</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            className={`${inputCls} w-auto`}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label="Tài khoản quảng cáo"
          >
            <option value="">Mọi tài khoản quảng cáo</option>
            {allAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1" role="tablist" aria-label="Khoảng thời gian">
            {AD_PERIODS.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={days === d}
                className={days === d ? btnCls : `${btnGhostCls} px-3 py-2 text-sm`}
                onClick={() => setDays(d)}
              >
                {d} ngày
              </button>
            ))}
          </div>
          {summary?.canManage && (
            <button className={btnGhostCls} disabled={busy !== ''} onClick={sync}>
              {busy === 'sync' ? 'Đang đọc…' : 'Đọc Meta ngay'}
            </button>
          )}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {summary && !summary.ready && (
        <Notice kind="info">
          {summary.missingScopes.length
            ? 'MARIS chưa được cấp quyền ads_read. '
            : 'Chưa có tài khoản quảng cáo nào được bật. '}
          Vào{' '}
          <Link href="/meta" className="text-accent underline">
            Trung tâm Meta
          </Link>{' '}
          để kết nối lại Facebook hoặc bật tài khoản quảng cáo.
        </Notice>
      )}
      {summary && summary.ready && !summary.canManage && (
        <p className="mb-3 text-xs text-muted">
          Bạn chỉ xem được. Tạm dừng, bật lại và đổi ngân sách cần quyền “Quản lý quảng cáo” và
          quyền ads_management trên Meta.
        </p>
      )}

      {totals && (
        <section className="mb-4 grid gap-3">
          <Tiles m={totals} currency={currency} />
          {!account && (summary?.totals.length ?? 0) > 1 && (
            <p className="text-xs text-muted">
              Các tài khoản dùng nhiều loại tiền; số trên là của {currency}. Chọn từng tài khoản để
              xem riêng.
            </p>
          )}
          <div className="rounded-lg border border-line bg-panel p-3">
            <SpendChart series={summary?.series ?? []} currency={currency} />
          </div>
          <p className="text-xs text-muted">
            Số lượt mua, giá trị mua và ROAS là số Meta báo cáo (pixel, biểu mẫu, Messenger), không
            phải doanh thu thực nhận. Kết quả = mua + lead + cuộc trò chuyện Messenger.
            {summary &&
              ` MARIS tự đọc mỗi ${summary.pollMinutes || '—'} phút, từng tài khoản một lượt.`}
          </p>
        </section>
      )}

      {pending.length > 0 && (
        <section
          className="mb-4 rounded-lg border border-amber-500 bg-panel p-3"
          aria-label="Chờ duyệt"
        >
          <h2 className="mb-2 text-sm font-semibold">Thay đổi chờ duyệt ({pending.length})</h2>
          <ul className="divide-y divide-line text-sm">
            {pending.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <b>{c.objectName}</b> ({LEVEL_LABEL[c.level]}):{' '}
                  {c.kind === 'status'
                    ? 'bật lại'
                    : `ngân sách ${money(Number(c.fromValue), c.currency)} → ${money(Number(c.toValue), c.currency)}/ngày`}
                  <span className="text-muted">
                    {' '}
                    · {c.requestedByName ?? '—'} · {time(c.createdAt)}
                    {c.reason && ` · “${c.reason}”`}
                  </span>
                </span>
                <span className="flex gap-1">
                  {summary?.canApprove && (
                    <button
                      className={btnGhostCls}
                      disabled={busy !== ''}
                      onClick={() => decide(c, 'approve')}
                    >
                      Duyệt và gửi Meta
                    </button>
                  )}
                  {(summary?.canApprove || c.requestedByName === me.displayName) && (
                    <button
                      className={btnGhostCls}
                      disabled={busy !== ''}
                      onClick={() => decide(c, 'reject')}
                    >
                      {summary?.canApprove ? 'Từ chối' : 'Rút lại'}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(summary?.alerts.length ?? 0) > 0 && (
        <section
          className="mb-4 rounded-lg border border-line bg-panel p-3"
          aria-label="Cảnh báo và gợi ý"
        >
          <h2 className="mb-2 text-sm font-semibold">Cảnh báo và gợi ý</h2>
          <ul className="grid gap-1.5 text-sm">
            {summary!.alerts.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={`h-fit whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${ALERT_CLS[a.level]}`}
                >
                  {ALERT_LABEL[a.level]}
                </span>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            MARIS chỉ chỉ ra, không tự thay đổi quảng cáo hay ngân sách.
          </p>
        </section>
      )}

      <section
        className="mb-4 overflow-x-auto rounded-lg border border-line bg-panel"
        aria-label="Chiến dịch"
      >
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="p-2">Chiến dịch</th>
              <th className="p-2">Trạng thái</th>
              <th className="p-2">Ngân sách</th>
              <th className="p-2 text-right">Chi tiêu</th>
              <th className="p-2 text-right">Kết quả</th>
              <th className="p-2 text-right">CPA</th>
              <th className="p-2 text-right">CTR</th>
              <th className="p-2 text-right">CPC</th>
              <th className="p-2 text-right">ROAS (Meta)</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-3 text-muted">
                  Chưa có chiến dịch.{' '}
                  {summary?.canManage ? 'Bấm “Đọc Meta ngay” để lấy dữ liệu.' : ''}
                </td>
              </tr>
            ) : (
              list.map((o) => row(o, true))
            )}
          </tbody>
        </table>
      </section>

      {detail && (
        <section
          className="mb-4 rounded-lg border border-line bg-panel p-3"
          aria-label="Chi tiết chiến dịch"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{detail.name}</h2>
            <button className={btnGhostCls} onClick={() => setOpen(null)}>
              Đóng
            </button>
          </div>
          {detail.metrics && <Tiles m={detail.metrics} currency={detail.currency} />}
          <div className="my-3">
            <SpendChart series={detail.series} currency={detail.currency} />
          </div>
          {(['adsets', 'ads'] as const).map((k) => (
            <div key={k} className="mt-3 overflow-x-auto">
              <h3 className="mb-1 text-xs font-semibold text-muted">
                {k === 'adsets' ? 'Nhóm quảng cáo' : 'Quảng cáo'}
              </h3>
              <table className="w-full min-w-[36rem] text-sm">
                <tbody>
                  {detail[k].length ? (
                    detail[k].map((o) => row(o, false))
                  ) : (
                    <tr>
                      <td className="p-2 text-muted">Không có</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      <section className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-3 text-sm">
          <h2 className="mb-2 text-sm font-semibold">Tài khoản quảng cáo</h2>
          <ul className="divide-y divide-line">
            {allAccounts.map((a) => (
              <li key={a.id} className="py-2">
                <div className="flex justify-between gap-2">
                  <button
                    className={`text-left font-medium hover:underline ${a.id === accountId ? 'text-accent' : ''}`}
                    onClick={() => setAccountId(a.id === accountId ? '' : a.id)}
                    aria-pressed={a.id === accountId}
                  >
                    {a.name}
                  </button>
                  <span className="text-muted">{money(a.metrics.spend, a.currency)}</span>
                </div>
                <div className="text-xs text-muted">
                  {a.accountStatusLabel ?? '—'} · {a.activeCampaigns}/{a.campaigns} chiến dịch đang
                  chạy · Giới hạn{' '}
                  {a.dailyCap === null ? 'chưa đặt' : `${money(a.dailyCap, a.currency)}/ngày`} ·{' '}
                  {a.syncedAt ? `đọc lúc ${time(a.syncedAt)}` : 'chưa đọc'}
                </div>
                {a.error && <div className="text-xs text-danger">{a.error}</div>}
              </li>
            ))}
          </ul>
          {account && summary?.canApprove && (
            <div className="mt-3 rounded-md border border-line p-2">
              <label className="mb-1 block text-xs text-muted" htmlFor="cap">
                Ngân sách hằng ngày tối đa của một chiến dịch hoặc nhóm quảng cáo mà không cần duyệt
                ({account.currency}). Để trống: mọi lần tăng hay bật lại đều cần duyệt.
              </label>
              <div className="flex gap-2">
                <input
                  id="cap"
                  className={inputCls}
                  inputMode="decimal"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                />
                <button className={btnCls} disabled={busy !== ''} onClick={saveCap}>
                  Lưu
                </button>
              </div>
            </div>
          )}
          {!account && summary?.canApprove && (
            <p className="mt-2 text-xs text-muted">Chọn một tài khoản để đặt giới hạn ngân sách.</p>
          )}
        </div>
        <div className="rounded-lg border border-line bg-panel p-3 text-sm">
          <h2 className="mb-2 text-sm font-semibold">Lịch sử thay đổi</h2>
          {changes.length === 0 ? (
            <p className="text-muted">Chưa có thay đổi nào.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {changes.map((c) => (
                <li key={c.id} className="py-1.5">
                  <div className="flex justify-between gap-2">
                    <span>
                      {c.objectName}:{' '}
                      {c.kind === 'status'
                        ? c.toValue === 'PAUSED'
                          ? 'tạm dừng'
                          : 'bật lại'
                        : `ngân sách → ${money(Number(c.toValue), c.currency)}/ngày`}
                    </span>
                    <span className={c.status === 'failed' ? 'text-danger' : 'text-muted'}>
                      {CHANGE_LABEL[c.status]}
                    </span>
                  </div>
                  <div className="text-xs text-muted">
                    {c.requestedByName ?? '—'} · {time(c.createdAt)}
                    {c.decidedByName &&
                      ` · ${c.status === 'cancelled' ? 'rút bởi' : 'quyết định bởi'} ${c.decidedByName}`}
                    {c.error && ` · ${c.error}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Shell>
  );
}
