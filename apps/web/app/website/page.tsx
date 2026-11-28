'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  WEB_ISSUE_LABEL,
  WEB_LIMITS,
  type Ga4PropertyResponse,
  type GscSiteResponse,
  type WebCheckDetailResponse,
  type WebCheckResponse,
  type WebReportResponse,
  type WebSiteResponse,
  type WebStatusResponse,
  type WebSyncResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 60_000;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '–');
const n0 = (n: number) => Math.round(n).toLocaleString('vi-VN');
const pct = (n: number | null) => (n === null ? '–' : `${(n * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`);
const change = (cur: number, before: number) => {
  if (!before) return null;
  const c = (cur - before) / before;
  return { text: `${c >= 0 ? '+' : ''}${(c * 100).toFixed(0)}%`, up: c >= 0 };
};

/**
 * Website and SEO Center (spec Parts 16 and 18, M21): the tenant's websites, their Google
 * Analytics 4 and Search Console numbers (read through a Google account on the Google Center), the
 * sitemaps Google knows, and website checks for broken links, errors, slow pages and SEO tags.
 */
export default function WebsitePage() {
  const me = useMe();
  const [s, setS] = useState<WebStatusResponse | null>(null);
  const [siteId, setSiteId] = useState('');
  const [days, setDays] = useState(28);
  const [report, setReport] = useState<WebReportResponse | null>(null);
  const [checks, setChecks] = useState<WebCheckResponse[]>([]);
  const [detail, setDetail] = useState<WebCheckDetailResponse | null>(null);
  const [linking, setLinking] = useState<WebSiteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [picked, setPicked] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định'), []);
  const site = s?.sites.find((x) => x.id === siteId) ?? null;

  const load = useCallback(() => {
    api<WebStatusResponse>('/web')
      .then((r) => {
        setS(r);
        setSiteId((cur) => (r.sites.some((x) => x.id === cur) ? cur : (r.sites[0]?.id ?? '')));
      })
      .catch(fail);
  }, [fail]);

  const loadSite = useCallback(() => {
    if (!siteId) {
      setReport(null);
      setChecks([]);
      return;
    }
    api<WebReportResponse>(`/web/report?siteId=${siteId}&days=${days}`)
      .then(setReport)
      .catch(() => setReport(null));
    api<WebCheckResponse[]>(`/web/sites/${siteId}/checks`)
      .then(setChecks)
      .catch(() => setChecks([]));
  }, [siteId, days]);

  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [me, load]);

  useEffect(() => {
    if (me) loadSite();
  }, [me, loadSite]);

  useEffect(() => setPicked(null), [siteId]);

  // The check shown: the one picked, else the latest (read again when its state changes).
  const shownId = picked ?? checks[0]?.id ?? null;
  const shownState = checks.find((c) => c.id === shownId)?.status;
  useEffect(() => {
    if (!shownId) {
      setDetail(null);
      return;
    }
    api<WebCheckDetailResponse>(`/web/checks/${shownId}`)
      .then((d) => {
        setDetail(d);
        // The check finished between the two reads: refresh the list too.
        if (shownState && d.status !== shownState) loadSite();
      })
      .catch(() => setDetail(null));
  }, [shownId, shownState, loadSite]);

  // While a check runs, look again every few seconds.
  const running = checks[0]?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      loadSite();
      load();
    }, 3000);
    return () => clearInterval(t);
  }, [running, loadSite, load]);

  async function run<T>(fn: () => Promise<T>, msg: (r: T) => string) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await fn();
      setOk(msg(r));
      load();
      loadSite();
      return r;
    } catch (e) {
      fail(e);
      load();
      return null;
    } finally {
      setBusy(false);
    }
  }

  const synced = (r: WebSyncResponse) =>
    `Đã đọc ${r.sites} website, ${n0(r.days)} ngày số liệu.` + (r.errors.length ? ` Lưu ý: ${r.errors.join('; ')}` : '');

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const r = await run(
      () =>
        api<WebSiteResponse>('/web/sites', {
          method: 'POST',
          body: JSON.stringify({ name: String(f.get('name') ?? '').trim(), url: String(f.get('url') ?? '').trim() }),
        }),
      (x) => `Đã thêm ${x.name}. Bấm “Liên kết Google” để đọc số liệu GA4 và Search Console.`,
    );
    if (r) {
      form.reset();
      setSiteId(r.id);
    }
  }

  if (!me) return null;
  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Website và SEO</h1>
        <Link href="/google" className="text-sm text-accent underline">
          Trung tâm Google
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Số liệu Google Analytics 4 và Search Console của từng website, đọc bằng tài khoản Google đã kết
        nối ở Trung tâm Google (chỉ đọc){s?.syncEveryHours ? `, cập nhật mỗi ${s.syncEveryHours} giờ` : ''}.
        Kiểm tra website đọc tối đa {WEB_LIMITS.checkPages} trang và {WEB_LIMITS.checkLinks} liên kết công
        khai để tìm liên kết hỏng, trang lỗi, trang chậm và thẻ SEO còn thiếu.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Panel title="Website">
        {s?.sites.length === 0 && <p className="mb-2 text-sm text-muted">Chưa có website nào.</p>}
        <div className="space-y-2">
          {s?.sites.map((x) => (
            <SiteCard
              key={x.id}
              x={x}
              selected={x.id === siteId}
              busy={busy}
              onSelect={() => setSiteId(x.id)}
              onLink={() => setLinking(x)}
              onSync={() =>
                void run(() => api<WebSyncResponse>(`/web/sites/${x.id}/sync`, { method: 'POST' }), synced)
              }
              onCheck={() => {
                setSiteId(x.id);
                setPicked(null);
                void run(
                  () => api<WebCheckResponse>(`/web/sites/${x.id}/checks`, { method: 'POST' }),
                  () => `Đang kiểm tra ${x.name}. Kết quả hiện ở dưới khi xong.`,
                );
              }}
              onToggle={() =>
                void run(
                  () => api(`/web/sites/${x.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !x.enabled }) }),
                  () => (x.enabled ? `Đã tạm dừng đọc ${x.name}.` : `Đã bật lại ${x.name}.`),
                )
              }
              onRemove={() => {
                if (!window.confirm(`Gỡ ${x.name} khỏi MARIS? Google Analytics và Search Console không bị đổi.`)) return;
                void run(() => api(`/web/sites/${x.id}`, { method: 'DELETE' }), () => `Đã gỡ ${x.name}.`);
              }}
            />
          ))}
        </div>
        {linking && s && (
          <LinkForm
            site={linking}
            status={s}
            busy={busy}
            onCancel={() => setLinking(null)}
            onSave={async (body) => {
              const r = await run(
                () => api<WebSiteResponse>(`/web/sites/${linking.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
                (x) => `Đã lưu liên kết của ${x.name}. MARIS đang đọc số liệu…`,
              );
              if (r) {
                setLinking(null);
                if (r.ga4 || r.gsc)
                  await run(() => api<WebSyncResponse>(`/web/sites/${r.id}/sync`, { method: 'POST' }), synced);
              }
            }}
            onError={fail}
          />
        )}
        <details className="mt-3" open={s?.sites.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">Thêm website</summary>
          <form onSubmit={(e) => void add(e)} className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
            <label>
              <span className="text-muted">Tên</span>
              <input name="name" required maxLength={200} className={inputCls} placeholder="Maris Fishing" />
            </label>
            <label>
              <span className="text-muted">Địa chỉ trang chủ</span>
              <input name="url" required className={inputCls} placeholder="https://ten-mien.vn" />
            </label>
            <div className="self-end">
              <button className={btnCls} disabled={busy}>
                Thêm
              </button>
            </div>
          </form>
        </details>
        {s && s.sites.length > 1 && (
          <button
            className="mt-3 text-sm text-accent underline"
            disabled={busy}
            onClick={() => void run(() => api<WebSyncResponse>('/web/sync', { method: 'POST' }), synced)}
          >
            Đọc số liệu mọi website ngay
          </button>
        )}
      </Panel>

      {site && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{site.name}</span>
            <select className={`${inputCls} max-w-[12rem]`} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Khoảng ngày">
              <option value={7}>7 ngày qua</option>
              <option value={28}>28 ngày qua</option>
              <option value={90}>90 ngày qua</option>
            </select>
          </div>
          {report && (site.ga4 || site.gsc) && <ReportPanel r={report} site={site} />}
          {site.sitemaps.length > 0 && <SitemapPanel site={site} />}
          <CheckPanel checks={checks} detail={detail} onOpen={setPicked} />
        </>
      )}
    </Shell>
  );
}

function SiteCard(p: {
  x: WebSiteResponse;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onLink: () => void;
  onSync: () => void;
  onCheck: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { x } = p;
  const c = x.lastCheck;
  return (
    <div className={`rounded-md border p-3 text-sm ${p.selected ? 'border-accent' : 'border-line'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button className="text-left" onClick={p.onSelect}>
          <div className="font-medium">
            {x.name} {!x.enabled && <span className="text-xs text-yellow-500">(tạm dừng)</span>}
          </div>
          <div className="text-xs text-muted">{x.url}</div>
        </button>
        <div className="flex flex-wrap gap-1.5">
          <button className={btnGhostCls} disabled={p.busy} onClick={p.onLink}>
            Liên kết Google
          </button>
          <button className={btnGhostCls} disabled={p.busy || (!x.ga4 && !x.gsc)} onClick={p.onSync}>
            Đọc ngay
          </button>
          <button className={btnGhostCls} disabled={p.busy || c?.status === 'running'} onClick={p.onCheck}>
            {c?.status === 'running' ? 'Đang kiểm tra…' : 'Kiểm tra website'}
          </button>
          <button className={btnGhostCls} disabled={p.busy} onClick={p.onToggle}>
            {x.enabled ? 'Tạm dừng' : 'Bật lại'}
          </button>
          <button className={`${btnGhostCls} text-danger`} disabled={p.busy} onClick={p.onRemove}>
            Gỡ
          </button>
        </div>
      </div>
      <div className="mt-2 grid gap-1 text-xs sm:grid-cols-3">
        <div>
          <span className="text-muted">GA4: </span>
          {x.ga4 ? `${x.ga4.name ?? x.ga4.property} (${x.ga4.connectionEmail})` : <span className="text-muted">chưa liên kết</span>}
        </div>
        <div>
          <span className="text-muted">Search Console: </span>
          {x.gsc ? `${x.gsc.site} (${x.gsc.connectionEmail})` : <span className="text-muted">chưa liên kết</span>}
        </div>
        <div>
          <span className="text-muted">Đọc lần cuối: </span>
          {when(x.syncedAt)}
        </div>
      </div>
      {x.syncError && <div className="mt-1 text-xs text-danger">{x.syncError}</div>}
      {c && c.status !== 'running' && (
        <div className="mt-1 text-xs text-muted">
          Kiểm tra {when(c.finishedAt ?? c.startedAt)}:{' '}
          {c.status === 'failed' ? (
            <span className="text-danger">{c.error}</span>
          ) : (
            <>
              <span className={c.errors ? 'text-danger' : ''}>{c.errors} lỗi</span>,{' '}
              <span className={c.warnings ? 'text-yellow-500' : ''}>{c.warnings} cảnh báo</span> trên {c.pages} trang
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LinkForm(p: {
  site: WebSiteResponse;
  status: WebStatusResponse;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const ga4Accounts = p.status.accounts.filter((a) => a.analytics);
  const gscAccounts = p.status.accounts.filter((a) => a.searchConsole);
  const [ga4Conn, setGa4Conn] = useState(p.site.ga4?.connectionId ?? ga4Accounts[0]?.id ?? '');
  const [gscConn, setGscConn] = useState(p.site.gsc?.connectionId ?? gscAccounts[0]?.id ?? '');
  const [props, setProps] = useState<Ga4PropertyResponse[] | null>(null);
  const [sites, setSites] = useState<GscSiteResponse[] | null>(null);
  const [property, setProperty] = useState(p.site.ga4?.property ?? '');
  const [gscSite, setGscSite] = useState(p.site.gsc?.site ?? '');
  const { onError } = p;

  useEffect(() => {
    setProps(null);
    if (ga4Conn)
      api<Ga4PropertyResponse[]>(`/web/google/ga4?connectionId=${ga4Conn}`)
        .then(setProps)
        .catch((e: unknown) => {
          setProps([]);
          onError(e);
        });
  }, [ga4Conn, onError]);
  useEffect(() => {
    setSites(null);
    if (gscConn)
      api<GscSiteResponse[]>(`/web/google/gsc?connectionId=${gscConn}`)
        .then(setSites)
        .catch((e: unknown) => {
          setSites([]);
          onError(e);
        });
  }, [gscConn, onError]);

  const host = new URL(p.site.url).hostname.replace(/^www\./, '');
  const suggested = sites?.find((x) => x.site.includes(host))?.site;
  useEffect(() => {
    if (!gscSite && suggested) setGscSite(suggested);
  }, [gscSite, suggested]);

  const save = () =>
    void p.onSave({
      ga4: property && ga4Conn ? { connectionId: ga4Conn, property } : null,
      gsc: gscSite && gscConn ? { connectionId: gscConn, site: gscSite } : null,
    });

  if (!ga4Accounts.length && !gscAccounts.length)
    return (
      <div className="mt-3 rounded-md border border-line p-3 text-sm">
        <p>
          Chưa có tài khoản Google nào cấp quyền Google Analytics hay Search Console. Vào{' '}
          <Link href="/google" className="text-accent underline">
            Trung tâm Google
          </Link>
          , bấm kết nối, đánh dấu <b>Google Analytics 4</b> và <b>Search Console</b>, rồi quay lại đây.
        </p>
        <button className={`${btnGhostCls} mt-2`} onClick={p.onCancel}>
          Đóng
        </button>
      </div>
    );

  return (
    <div className="mt-3 rounded-md border border-accent p-3 text-sm">
      <div className="mb-2 font-medium">Liên kết Google cho {p.site.name}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs text-muted">Google Analytics 4</div>
          <select className={inputCls} value={ga4Conn} onChange={(e) => setGa4Conn(e.target.value)} aria-label="Tài khoản GA4">
            {ga4Accounts.length === 0 && <option value="">Chưa có tài khoản cấp quyền</option>}
            {ga4Accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
          <select className={inputCls} value={property} onChange={(e) => setProperty(e.target.value)} aria-label="Thuộc tính GA4">
            <option value="">{props === null && ga4Conn ? 'Đang tải…' : 'Không liên kết'}</option>
            {props?.map((x) => (
              <option key={x.property} value={x.property}>
                {x.name} ({x.account}, {x.property.replace('properties/', '')})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted">Search Console</div>
          <select className={inputCls} value={gscConn} onChange={(e) => setGscConn(e.target.value)} aria-label="Tài khoản Search Console">
            {gscAccounts.length === 0 && <option value="">Chưa có tài khoản cấp quyền</option>}
            {gscAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
          <select className={inputCls} value={gscSite} onChange={(e) => setGscSite(e.target.value)} aria-label="Thuộc tính Search Console">
            <option value="">{sites === null && gscConn ? 'Đang tải…' : 'Không liên kết'}</option>
            {sites?.map((x) => (
              <option key={x.site} value={x.site}>
                {x.site}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button className={btnCls} disabled={p.busy} onClick={save}>
          Lưu và đọc số liệu
        </button>
        <button className={btnGhostCls} onClick={p.onCancel}>
          Hủy
        </button>
      </div>
    </div>
  );
}

function Tile({ label, value, delta }: { label: string; value: string; delta?: { text: string; up: boolean } | null }) {
  return (
    <div className="rounded-md border border-line p-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {delta && (
        <div className={`text-xs ${delta.up ? 'text-green-500' : 'text-danger'}`} title="So với cùng số ngày liền trước">
          {delta.text}
        </div>
      )}
    </div>
  );
}

function Bars({ label, days, value, fmt }: { label: string; days: WebReportResponse['daily']; value: (d: WebReportResponse['daily'][number]) => number | null; fmt: (n: number) => string }) {
  const vals = days.map(value);
  if (vals.every((v) => v === null)) return null;
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex h-20 items-end gap-0.5" role="img" aria-label={label}>
        {days.map((d, i) => (
          <div
            key={d.day}
            className={`flex-1 rounded-t ${vals[i] === null ? 'bg-line' : 'bg-accent'}`}
            style={{ height: `${Math.max(2, ((vals[i] ?? 0) / max) * 100)}%` }}
            title={`${d.day}: ${vals[i] === null ? 'chưa có số liệu' : fmt(vals[i]!)}`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-xs text-muted">
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function TopList({ title, rows, cols }: { title: string; rows: { key: string; a: number; b: number; c: number; d: number }[]; cols: [string, (r: { a: number; b: number; c: number; d: number }) => string][] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">Chưa có số liệu.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-0.5 font-normal" />
              {cols.map(([h]) => (
                <th key={h} className="text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="max-w-[16rem] truncate py-0.5 pr-2" title={r.key}>
                  {r.key}
                </td>
                {cols.map(([h, f]) => (
                  <td key={h} className="text-right tabular-nums">
                    {f(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReportPanel({ r, site }: { r: WebReportResponse; site: WebSiteResponse }) {
  const t = r.totals;
  return (
    <Panel title={`Số liệu ${r.days} ngày qua`}>
      {site.ga4 && (
        <div className="mb-3 grid gap-2 text-sm sm:grid-cols-5">
          <Tile label="Phiên truy cập" value={n0(t.sessions)} delta={change(t.sessions, r.before.sessions)} />
          <Tile label="Người dùng" value={n0(t.users)} />
          <Tile label="Người dùng mới" value={n0(t.newUsers)} />
          <Tile label="Lượt xem trang" value={n0(t.views)} />
          <Tile label="Sự kiện chính" value={t.keyEvents.toLocaleString('vi-VN')} delta={change(t.keyEvents, r.before.keyEvents)} />
        </div>
      )}
      {site.gsc && (
        <div className="mb-3 grid gap-2 text-sm sm:grid-cols-5">
          <Tile label="Lượt nhấp từ Google" value={n0(t.clicks)} delta={change(t.clicks, r.before.clicks)} />
          <Tile label="Lượt hiển thị" value={n0(t.impressions)} delta={change(t.impressions, r.before.impressions)} />
          <Tile label="CTR" value={pct(t.ctr)} />
          <Tile label="Vị trí trung bình" value={t.position === null ? '–' : t.position.toLocaleString('vi-VN')} />
          {site.ga4 && <Tile label="Tỷ lệ tương tác" value={pct(t.engagementRate)} />}
        </div>
      )}
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {site.ga4 && <Bars label="Phiên truy cập theo ngày (GA4)" days={r.daily} value={(d) => d.sessions} fmt={n0} />}
        {site.gsc && <Bars label="Lượt nhấp theo ngày (Search Console)" days={r.daily} value={(d) => d.clicks} fmt={n0} />}
      </div>
      <p className="mb-2 text-xs text-muted">
        Các danh sách dưới đây là của 28 ngày qua. Search Console thường có số liệu chậm 2 đến 3 ngày.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {site.ga4 && (
          <>
            <TopList title="Trang xem nhiều (GA4)" rows={r.tops.ga4_page} cols={[['Lượt xem', (x) => n0(x.a)], ['Người dùng', (x) => n0(x.b)]]} />
            <TopList title="Nguồn truy cập (GA4)" rows={r.tops.ga4_channel} cols={[['Phiên', (x) => n0(x.a)], ['Sự kiện chính', (x) => x.b.toLocaleString('vi-VN')]]} />
          </>
        )}
        {site.gsc && (
          <>
            <TopList
              title="Từ khóa tìm kiếm (Search Console)"
              rows={r.tops.gsc_query}
              cols={[['Nhấp', (x) => n0(x.a)], ['Hiển thị', (x) => n0(x.b)], ['CTR', (x) => pct(x.c)], ['Vị trí', (x) => x.d.toFixed(1)]]}
            />
            <TopList
              title="Trang trên Google (Search Console)"
              rows={r.tops.gsc_page}
              cols={[['Nhấp', (x) => n0(x.a)], ['Hiển thị', (x) => n0(x.b)], ['Vị trí', (x) => x.d.toFixed(1)]]}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function SitemapPanel({ site }: { site: WebSiteResponse }) {
  return (
    <Panel title="Sitemap trên Search Console">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1">Sitemap</th>
              <th>Google đọc lần cuối</th>
              <th className="text-right">Đã gửi</th>
              <th className="text-right">Đã lập chỉ mục</th>
              <th className="pl-3">Lỗi / cảnh báo</th>
            </tr>
          </thead>
          <tbody>
            {site.sitemaps.map((m) => (
              <tr key={m.path} className="border-t border-line">
                <td className="max-w-xs truncate py-1 pr-2 text-xs" title={m.path}>
                  {m.path} {m.isPending && <span className="text-yellow-500">(đang chờ Google)</span>}
                </td>
                <td className="text-xs">{when(m.lastDownloaded)}</td>
                <td className="text-right tabular-nums">{m.submitted === null ? '–' : n0(m.submitted)}</td>
                <td className="text-right tabular-nums">{m.indexed === null ? '–' : n0(m.indexed)}</td>
                <td className="pl-3 text-xs">
                  <span className={m.errors ? 'text-danger' : ''}>{m.errors}</span> /{' '}
                  <span className={m.warnings ? 'text-yellow-500' : ''}>{m.warnings}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CheckPanel({ checks, detail, onOpen }: { checks: WebCheckResponse[]; detail: WebCheckDetailResponse | null; onOpen: (id: string) => void }) {
  const groups = new Map<string, WebCheckDetailResponse['issues']>();
  for (const i of detail?.issues ?? []) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i]);
  const ordered = [...groups.entries()].sort(
    (a, b) => Number(b[1][0]!.severity === 'error') - Number(a[1][0]!.severity === 'error') || b[1].length - a[1].length,
  );
  return (
    <Panel title="Kiểm tra website">
      {checks.length === 0 ? (
        <p className="text-sm text-muted">Chưa kiểm tra lần nào. Bấm “Kiểm tra website” ở trên.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
            {checks.slice(0, 8).map((c) => (
              <button
                key={c.id}
                onClick={() => onOpen(c.id)}
                className={`rounded border px-2 py-1 ${detail?.id === c.id ? 'border-accent' : 'border-line'}`}
              >
                {when(c.startedAt)}{' '}
                {c.status === 'running' ? '(đang chạy)' : c.status === 'failed' ? '(lỗi)' : `(${c.errors} lỗi, ${c.warnings} cảnh báo)`}
              </button>
            ))}
          </div>
          {detail && detail.status === 'running' && <p className="text-sm text-muted">Đang đọc các trang…</p>}
          {detail && detail.status === 'failed' && <Notice kind="error">{detail.error ?? 'Lần kiểm tra không hoàn tất'}</Notice>}
          {detail && detail.status === 'done' && (
            <>
              <div className="mb-3 grid gap-2 text-sm sm:grid-cols-5">
                <Tile label="Trang đã đọc" value={n0(detail.pages)} />
                <Tile label="Liên kết đã thử" value={n0(detail.links)} />
                <Tile label="Lỗi" value={n0(detail.errors)} />
                <Tile label="Cảnh báo" value={n0(detail.warnings)} />
                <Tile
                  label="Thời gian tải (TB / chậm nhất)"
                  value={detail.avgMs === null ? '–' : `${(detail.avgMs / 1000).toFixed(1)} / ${((detail.maxMs ?? 0) / 1000).toFixed(1)} giây`}
                />
              </div>
              {ordered.length === 0 ? (
                <Notice kind="ok">Không thấy vấn đề nào.</Notice>
              ) : (
                <div className="space-y-2">
                  {ordered.map(([kind, list]) => (
                    <details key={kind} className="rounded-md border border-line p-2 text-sm" open={list[0]!.severity === 'error'}>
                      <summary className="cursor-pointer">
                        <span className={list[0]!.severity === 'error' ? 'text-danger' : 'text-yellow-500'}>
                          {list[0]!.severity === 'error' ? 'Lỗi' : 'Cảnh báo'}
                        </span>{' '}
                        {WEB_ISSUE_LABEL[kind] ?? kind} <span className="text-muted">({list.length})</span>
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {list.slice(0, 50).map((i, n) => (
                          <li key={`${i.url}:${n}`} className="break-all">
                            <a href={i.url} target="_blank" rel="noreferrer noopener" className="text-accent underline">
                              {i.url}
                            </a>
                            {i.detail && <span className="text-muted"> · {i.detail}</span>}
                          </li>
                        ))}
                        {list.length > 50 && <li className="text-muted">và {list.length - 50} chỗ khác</li>}
                      </ul>
                    </details>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}
