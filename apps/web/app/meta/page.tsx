'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  META_DEFAULT_GRAPH_VERSION,
  META_LIMITS,
  type ApiCallResponse,
  type GovernorGroupState,
  type MetaAssetResponse,
  type MetaOauthStartResponse,
  type MetaStatusResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 30_000;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '–');

const STATE: Record<GovernorGroupState, [string, string]> = {
  ok: ['Bình thường', 'text-green-500'],
  no_background: ['Hoãn việc nền', 'text-yellow-500'],
  essential_only: ['Chỉ việc thiết yếu', 'text-yellow-500'],
  paused: ['Tạm dừng', 'text-danger'],
  blocked: ['Meta yêu cầu dừng', 'text-danger'],
};

const CONN_STATUS: Record<string, [string, string]> = {
  active: ['Đang hoạt động', 'border-green-600 text-green-500'],
  expired: ['Hết hạn', 'border-danger text-danger'],
  invalid: ['Mất hiệu lực', 'border-danger text-danger'],
};

function Bar({ pct }: { pct: number }) {
  const color = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-yellow-500' : 'bg-green-600';
  return (
    <span className="inline-block h-2 w-24 overflow-hidden rounded bg-line align-middle">
      <span className={`block h-2 ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

function AssetTable({
  title,
  rows,
  limit,
  onToggle,
  busy,
  pageName,
}: {
  title: string;
  rows: MetaAssetResponse[];
  limit: number | null;
  onToggle: (a: MetaAssetResponse) => void;
  busy: boolean;
  pageName: (id: string | null) => string | null;
}) {
  const on = rows.filter((r) => r.enabled).length;
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-xs text-muted">
          {on} đang bật{limit ? ` / tối đa ${limit}` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Không có.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <div className={a.removed ? 'text-muted line-through' : 'font-medium'}>
                      {a.name}
                      {a.username ? <span className="text-muted"> @{a.username}</span> : null}
                    </div>
                    <div className="text-xs text-muted">
                      ID {a.externalId}
                      {a.category ? ` · ${a.category}` : ''}
                      {a.currency ? ` · ${a.currency}` : ''}
                      {a.timezone ? ` · ${a.timezone}` : ''}
                      {pageName(a.pageId) ? ` · gắn với Page ${pageName(a.pageId)}` : ''}
                      {a.removed ? ' · tài khoản không còn quyền' : ''}
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {!a.removed && (
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={a.enabled}
                          disabled={busy}
                          onChange={() => onToggle(a)}
                        />
                        {a.enabled ? 'Đang bật' : 'Đang tắt'}
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Meta Control Center (spec Part 14, M17): the Meta App, signing in with Facebook through Meta's
 * own dialog, the Pages, Instagram and ad accounts in use, and the API Governor (Part 15).
 */
export default function MetaPage() {
  const me = useMe();
  const [s, setS] = useState<MetaStatusResponse | null>(null);
  const [calls, setCalls] = useState<ApiCallResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editApp, setEditApp] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<MetaStatusResponse>('/meta').then(setS).catch(fail);
    api<ApiCallResponse[]>('/meta/calls')
      .then(setCalls)
      .catch(() => setCalls([]));
  }, []);

  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [me, load]);

  async function run(fn: () => Promise<unknown>, msg: string) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'governor' in r) setS(r as MetaStatusResponse);
      else load();
      api<ApiCallResponse[]>('/meta/calls')
        .then(setCalls)
        .catch(() => undefined);
      setOk(msg);
    } catch (e) {
      fail(e);
      load();
    } finally {
      setBusy(false);
    }
  }

  function saveApp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(
      () =>
        api<MetaStatusResponse>('/meta/app', {
          method: 'PUT',
          body: JSON.stringify({
            appId: String(f.get('appId') ?? '').trim(),
            appSecretName: String(f.get('appSecretName') ?? '').trim(),
            graphVersion: String(f.get('graphVersion') ?? '').trim() || META_DEFAULT_GRAPH_VERSION,
          }),
        }).then((r) => {
          setEditApp(false);
          return r;
        }),
      'Đã lưu Meta App.',
    );
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<MetaOauthStartResponse>('/meta/oauth/start', { method: 'POST' });
      window.location.assign(url);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }

  const toggle = (a: MetaAssetResponse) =>
    run(
      () =>
        api(`/meta/assets/${a.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !a.enabled }),
        }),
      a.enabled ? `Đã tắt ${a.name}.` : `Đã bật ${a.name}.`,
    );

  const c = s?.connection;
  const live = s?.assets.filter((a) => !a.removed) ?? [];
  const removed = s?.assets.filter((a) => a.removed) ?? [];
  const pageName = (id: string | null) => s?.assets.find((a) => a.id === id)?.name ?? null;
  const g = s?.governor;

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;

  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trung tâm Meta</h1>
        <Link href="/meta/posts" className="text-sm text-accent underline">
          Lịch đăng bài
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Kết nối Facebook, Instagram và tài khoản quảng cáo bằng đăng nhập chính thức của Meta. MARIS
        không dùng cookie hay mật khẩu Facebook. Gói BUSINESS: 1 tài khoản Facebook, tối đa{' '}
        {META_LIMITS.pages} Page và {META_LIMITS.adAccounts} tài khoản quảng cáo,{' '}
        {META_LIMITS.apiCallsPerDay.toLocaleString('vi-VN')} lượt gọi API mỗi ngày (giới hạn nội bộ
        của MARIS, không phải của Meta).
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      {s && (!s.app || editApp) && (
        <Panel title="1. Meta App">
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              Vào developers.facebook.com, tạo ứng dụng loại Doanh nghiệp (Business), thêm sản phẩm
              Đăng nhập Facebook (Facebook Login for Business).
            </li>
            <li>
              Ở mục Trường hợp sử dụng (Use cases), thêm “Quản lý mọi thứ trên Trang của bạn” và
              “Quản lý tin nhắn và nội dung trên Instagram”; bấm Tùy chỉnh để thêm đủ quyền. Muốn
              nhận lead quảng cáo, thêm cả “Thu thập và quản lý khách hàng tiềm năng” (Capture &amp;
              manage ad leads). Thiếu bước này Facebook sẽ báo “Invalid Scopes”.
            </li>
            <li>
              Ở Cài đặt ứng dụng → Nâng cao → Bảo mật, đặt “Ứng dụng gốc hoặc ứng dụng máy tính?” là
              Không. Nếu để Có, Facebook báo “the app is configured as a desktop app”.
            </li>
            <li>
              Ở phần cài đặt đăng nhập, thêm “URI chuyển hướng OAuth hợp lệ”:{' '}
              <code className="rounded bg-bg px-1">{s.redirectUri}</code>
            </li>
            <li>
              Sao chép Khóa bí mật của ứng dụng (App Secret) vào{' '}
              <Link href="/secrets" className="text-accent underline">
                Secret Vault
              </Link>{' '}
              với tên bên dưới (đúng 32 ký tự, không có dấu cách). Không dán khóa này vào đây hay
              vào chat. Nếu Facebook báo “Error validating client secret”, khóa trong Vault không
              khớp App ID: sao chép lại và cập nhật.
            </li>
            <li>Nhập ID ứng dụng (App ID) rồi lưu.</li>
          </ol>
          <form onSubmit={saveApp} className="grid gap-3 text-sm sm:grid-cols-3" autoComplete="off">
            <label>
              App ID
              <input
                name="appId"
                required
                inputMode="numeric"
                pattern="[0-9]{5,20}"
                defaultValue={s.app?.appId ?? ''}
                className={inputCls}
              />
            </label>
            <label>
              Tên secret của App Secret
              <input
                name="appSecretName"
                required
                defaultValue={s.app?.appSecretName ?? 'meta.app_secret'}
                className={inputCls}
              />
            </label>
            <label>
              Phiên bản Graph API
              <input
                name="graphVersion"
                pattern="v[0-9]{2}\.0"
                defaultValue={s.app?.graphVersion ?? META_DEFAULT_GRAPH_VERSION}
                className={inputCls}
              />
            </label>
            <div className="flex gap-2 sm:col-span-3">
              <button className={btnCls} disabled={busy}>
                Lưu Meta App
              </button>
              {s.app && (
                <button type="button" className={btnGhostCls} onClick={() => setEditApp(false)}>
                  Hủy
                </button>
              )}
            </div>
          </form>
        </Panel>
      )}

      {s?.app && !editApp && (
        <Panel title="Tài khoản Facebook">
          <p className="mb-3 text-xs text-muted">
            Meta App {s.app.appId} · Graph API {s.app.graphVersion} ·{' '}
            {s.app.secretFound ? (
              'App Secret có trong Secret Vault'
            ) : (
              <span className="text-danger">
                chưa có secret “{s.app.appSecretName}” trong Secret Vault
              </span>
            )}{' '}
            ·{' '}
            <button className="text-accent underline" onClick={() => setEditApp(true)}>
              Sửa
            </button>
          </p>
          {!c ? (
            <div>
              <p className="mb-3 text-sm">
                Chưa kết nối. Bấm nút bên dưới, đăng nhập Facebook ở trang của Meta, chọn các Page
                và tài khoản quảng cáo muốn giao cho MARIS rồi cho phép.
              </p>
              <button
                className={btnCls}
                disabled={busy || !s.app.secretFound}
                onClick={() => void connect()}
              >
                Kết nối Facebook
              </button>
            </div>
          ) : (
            <div className="text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{c.fbName}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-xs ${CONN_STATUS[c.status]?.[1] ?? ''}`}
                >
                  {CONN_STATUS[c.status]?.[0] ?? c.status}
                </span>
              </div>
              <div className="mb-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
                <span>
                  Kết nối bởi {c.connectedByName}, {when(c.connectedAt)}
                </span>
                <span>Token hết hạn: {when(c.tokenExpiresAt)}</span>
                <span>Kiểm tra lần cuối: {when(c.checkedAt)}</span>
                <span>Đồng bộ lần cuối: {when(c.syncedAt)}</span>
              </div>
              {c.checkError && <Notice kind="error">{c.checkError}</Notice>}
              {c.status !== 'active' && (
                <Notice kind="info">
                  Kết nối không còn hiệu lực. Bấm “Kết nối lại” và đăng nhập cùng tài khoản
                  Facebook.
                </Notice>
              )}
              <div className="mb-3 flex flex-wrap gap-2">
                {c.status === 'active' ? (
                  <>
                    <button
                      className={btnGhostCls}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api('/meta/sync', { method: 'POST' }),
                          'Đã đồng bộ Page và tài khoản.',
                        )
                      }
                    >
                      Đồng bộ
                    </button>
                    <button
                      className={btnGhostCls}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api('/meta/check', { method: 'POST' }),
                          'Đã kiểm tra token và quyền.',
                        )
                      }
                    >
                      Kiểm tra token và quyền
                    </button>
                  </>
                ) : (
                  <button className={btnCls} disabled={busy} onClick={() => void connect()}>
                    Kết nối lại
                  </button>
                )}
                <button
                  className={`${btnGhostCls} border-danger text-danger`}
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      `Ngắt kết nối “${c.fbName}”? MARIS xóa mọi token và báo Meta thu hồi quyền.`,
                    ) &&
                    void run(
                      () => api('/meta/connection', { method: 'DELETE' }),
                      'Đã ngắt kết nối.',
                    )
                  }
                >
                  Ngắt kết nối
                </button>
              </div>
              <div className="mb-1 text-xs text-muted">Chức năng theo quyền Meta đã cấp</div>
              <ul className="grid gap-1 sm:grid-cols-2">
                {s.features.map((f) => (
                  <li key={f.key}>
                    <span className={f.ready ? 'text-green-500' : 'text-muted'}>
                      {f.ready ? '✓' : '○'}
                    </span>{' '}
                    {f.label}
                    {!f.ready && (
                      <span className="text-xs text-muted"> (thiếu {f.missing.join(', ')})</span>
                    )}
                  </li>
                ))}
              </ul>
              {c.declined.length > 0 && (
                <p className="mt-2 text-xs text-muted">Bạn đã từ chối: {c.declined.join(', ')}.</p>
              )}
              <p className="mt-2 text-xs text-muted">
                Ngoài chế độ phát triển, nhiều quyền cần Meta duyệt ứng dụng (App Review), xác minh
                doanh nghiệp và Advanced Access. Chức năng chỉ bật khi quyền thật sự được cấp.
              </p>
            </div>
          )}
        </Panel>
      )}

      {c && (
        <Panel title="Page, Instagram và tài khoản quảng cáo">
          <AssetTable
            title="Page"
            rows={live.filter((a) => a.kind === 'page')}
            limit={META_LIMITS.pages}
            onToggle={toggle}
            busy={busy}
            pageName={pageName}
          />
          <AssetTable
            title="Instagram"
            rows={live.filter((a) => a.kind === 'instagram')}
            limit={null}
            onToggle={toggle}
            busy={busy}
            pageName={pageName}
          />
          <AssetTable
            title="Tài khoản quảng cáo"
            rows={live.filter((a) => a.kind === 'ad_account')}
            limit={META_LIMITS.adAccounts}
            onToggle={toggle}
            busy={busy}
            pageName={pageName}
          />
          {removed.length > 0 && (
            <AssetTable
              title="Không còn quyền"
              rows={removed}
              limit={null}
              onToggle={toggle}
              busy={busy}
              pageName={pageName}
            />
          )}
        </Panel>
      )}

      {g && (
        <Panel title="Hạn mức API (API Governor)">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <span>
              24 giờ qua: <b className="tabular-nums">{g.used.toLocaleString('vi-VN')}</b> /{' '}
              {g.budget.toLocaleString('vi-VN')} lượt
            </span>
            <Bar pct={g.pct} />
            <span className="tabular-nums">{g.pct.toLocaleString('vi-VN')}%</span>
            <span className="text-muted">· {g.level}</span>
            <span className="text-muted">· tiết kiệm {g.cacheHits} lượt nhờ cache</span>
          </div>
          {g.blockedUntil && (
            <Notice kind="error">
              Meta đang giới hạn ứng dụng. MARIS dừng mọi lượt gọi tới {when(g.blockedUntil)}.
            </Notice>
          )}
          <p className="mb-3 text-xs text-muted">
            Hạn mức của Meta:{' '}
            {g.platform.status === 'unknown'
              ? 'UNKNOWN (chưa có lượt gọi nào trả về số liệu)'
              : g.platform.status === 'stale'
                ? `STALE (số liệu cũ, lúc ${when(g.platform.at)}: ${g.platform.pct ?? '–'}%)`
                : `${g.platform.pct}% (lúc ${when(g.platform.at)})`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Nhóm API</th>
                  <th>Đã dùng</th>
                  <th />
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {g.groups.map((x) => (
                  <tr key={x.group} className="border-t border-line">
                    <td className="py-1.5 pr-3">{x.label}</td>
                    <td className="whitespace-nowrap pr-3 tabular-nums">
                      {x.used} / {x.budget}
                    </td>
                    <td className="pr-3">
                      <Bar pct={x.pct} />
                    </td>
                    <td className={STATE[x.state][1]}>
                      {STATE[x.state][0]}
                      {x.blockedUntil && x.state === 'blocked' && !g.blockedUntil
                        ? ` tới ${when(x.blockedUntil)}`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Nhóm dùng hết phần của mình thì mượn phần Dự phòng. Từ 75% hạn mức MARIS hoãn việc nền,
            từ 85% chỉ chạy việc thiết yếu, từ 90% tạm dừng.
          </p>
        </Panel>
      )}

      {calls.length > 0 && (
        <Panel title="Lượt gọi Meta gần đây">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {calls.map((x) => (
                  <tr key={x.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-1 pr-3 text-muted">{when(x.createdAt)}</td>
                    <td className="pr-3 font-mono">
                      {x.method} {x.path}
                    </td>
                    <td
                      className={`pr-3 ${x.outcome === 'ok' ? 'text-green-500' : x.outcome === 'refused' ? 'text-yellow-500' : 'text-danger'}`}
                    >
                      {x.outcome === 'ok' ? 'OK' : x.outcome === 'refused' ? 'Không gọi' : 'Lỗi'}
                      {x.errorCode ? ` (${x.errorCode})` : ''}
                    </td>
                    <td className="pr-3 text-muted">{x.errorMessage ?? ''}</td>
                    <td className="whitespace-nowrap text-muted">
                      {x.durationMs !== null ? `${x.durationMs} ms` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Shell>
  );
}
