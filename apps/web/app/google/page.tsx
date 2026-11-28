'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  GOOGLE_LIMITS,
  GOOGLE_SERVICE_HINT,
  GOOGLE_SERVICES,
  YOUTUBE_COSTS,
  YOUTUBE_DEFAULT_QUOTA,
  type ApiCallResponse,
  type GoogleOauthStartResponse,
  type GoogleService,
  type GoogleStatusResponse,
  type QuotaResponse,
  type YoutubeChannelResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 30_000;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '–');
const num = (n: number | null) => (n === null ? '–' : n.toLocaleString('vi-VN'));

const QUOTA_STATE: Record<QuotaResponse['state'], [string, string]> = {
  ok: ['Bình thường', 'text-green-500'],
  no_background: ['Hoãn việc nền', 'text-yellow-500'],
  essential_only: ['Chỉ việc thiết yếu', 'text-yellow-500'],
  paused: ['Tạm dừng', 'text-danger'],
  blocked: ['Google yêu cầu dừng', 'text-danger'],
};

function Bar({ pct }: { pct: number }) {
  const color = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-yellow-500' : 'bg-green-600';
  return (
    <span className="inline-block h-2 w-32 overflow-hidden rounded bg-line align-middle">
      <span className={`block h-2 ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

/**
 * Google Center (spec Part 16, M18): the Google Cloud OAuth client, Google accounts signed in
 * through Google's own consent screen with each service asked for separately, the YouTube
 * channels in use (Part 17) and the YouTube quota of the day.
 */
export default function GooglePage() {
  const me = useMe();
  const [s, setS] = useState<GoogleStatusResponse | null>(null);
  const [calls, setCalls] = useState<ApiCallResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editApp, setEditApp] = useState(false);
  const [services, setServices] = useState<GoogleService[]>(['youtube']);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');
  const loadCalls = () =>
    api<ApiCallResponse[]>('/google/calls')
      .then(setCalls)
      .catch(() => setCalls([]));
  const load = useCallback(() => {
    api<GoogleStatusResponse>('/google').then(setS).catch(fail);
    loadCalls();
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
      if (r && typeof r === 'object' && 'quota' in r) setS(r as GoogleStatusResponse);
      else load();
      loadCalls();
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
        api<GoogleStatusResponse>('/google/app', {
          method: 'PUT',
          body: JSON.stringify({
            clientId: String(f.get('clientId') ?? '').trim(),
            clientSecretName: String(f.get('clientSecretName') ?? '').trim(),
            youtubeQuota: Number(f.get('youtubeQuota') ?? YOUTUBE_DEFAULT_QUOTA),
            youtubeAudited: f.get('youtubeAudited') === 'on',
          }),
        }).then((r) => {
          setEditApp(false);
          return r;
        }),
      'Đã lưu OAuth client Google.',
    );
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<GoogleOauthStartResponse>('/google/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ services }),
      });
      window.location.assign(url);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }

  const toggle = (c: YoutubeChannelResponse) =>
    run(
      () =>
        api(`/google/channels/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !c.enabled }),
        }),
      c.enabled ? `Đã tắt kênh ${c.title}.` : `Đã bật kênh ${c.title}.`,
    );

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const q = s?.quota;
  const uploadsLeft = q ? Math.max(0, Math.floor((q.quota - q.used) / YOUTUBE_COSTS.upload)) : 0;
  const live = s?.channels.filter((c) => !c.removed) ?? [];

  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trung tâm Google</h1>
        <Link href="/youtube" className="text-sm text-accent underline">
          Video đã tải lên YouTube
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Kết nối tài khoản Google bằng màn hình đồng ý chính thức của Google, xin quyền riêng cho
        từng dịch vụ. MARIS không dùng mật khẩu Google. Gói BUSINESS: tối đa{' '}
        {GOOGLE_LIMITS.connections} tài khoản Google và {GOOGLE_LIMITS.channels} kênh YouTube.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      {s && (!s.app || editApp) && (
        <Panel title="1. OAuth client của Google Cloud">
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              Vào console.cloud.google.com, tạo dự án (Project) cho doanh nghiệp. Ở “APIs &amp;
              Services → Library”, bật <b>YouTube Data API v3</b>; muốn xem số liệu website ở trang Website và SEO thì bật thêm <b>Google Analytics Data API</b>, <b>Google Analytics Admin API</b> và <b>Google Search Console API</b>.
            </li>
            <li>
              Ở “OAuth consent screen” (Google Auth Platform), chọn đối tượng <b>External</b>, điền
              tên ứng dụng và email. Khi còn ở chế độ Testing, thêm email Google của bạn vào “Test
              users”.
            </li>
            <li>
              Ở “Credentials → Create credentials → OAuth client ID”, chọn loại{' '}
              <b>Web application</b>, thêm vào “Authorized redirect URIs”:{' '}
              <code className="rounded bg-bg px-1">{s.redirectUri}</code>
            </li>
            <li>
              Sao chép <b>Client secret</b> vào{' '}
              <Link href="/secrets" className="text-accent underline">
                Secret Vault
              </Link>{' '}
              với tên bên dưới. Không dán khóa này vào đây hay vào chat.
            </li>
            <li>Nhập Client ID (dạng …apps.googleusercontent.com) rồi lưu.</li>
          </ol>
          <form onSubmit={saveApp} className="grid gap-3 text-sm sm:grid-cols-3" autoComplete="off">
            <label className="sm:col-span-3">
              Client ID
              <input
                name="clientId"
                required
                defaultValue={s.app?.clientId ?? ''}
                placeholder="1234567890-abc123.apps.googleusercontent.com"
                className={inputCls}
              />
            </label>
            <label>
              Tên secret của Client secret
              <input
                name="clientSecretName"
                required
                defaultValue={s.app?.clientSecretName ?? 'google.client_secret'}
                className={inputCls}
              />
            </label>
            <label>
              Hạn mức YouTube mỗi ngày (đơn vị)
              <input
                name="youtubeQuota"
                type="number"
                min={100}
                defaultValue={s.app?.youtubeQuota ?? YOUTUBE_DEFAULT_QUOTA}
                className={inputCls}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2">
              <input
                type="checkbox"
                name="youtubeAudited"
                defaultChecked={s.app?.youtubeAudited ?? false}
              />
              YouTube đã xét duyệt (audit) dự án
            </label>
            <p className="text-xs text-muted sm:col-span-3">
              Dự án Google mới có {YOUTUBE_DEFAULT_QUOTA.toLocaleString('vi-VN')} đơn vị mỗi ngày;
              mỗi video tải lên tốn {YOUTUBE_COSTS.upload.toLocaleString('vi-VN')} đơn vị. Khi
              YouTube chưa xét duyệt dự án, video tải qua API luôn ở chế độ Riêng tư: MARIS tải lên
              ở chế độ Riêng tư và bạn mở công khai trong YouTube Studio. Chỉ đánh dấu ô trên khi
              Google đã gửi thư chấp thuận.
            </p>
            <div className="flex gap-2 sm:col-span-3">
              <button className={btnCls} disabled={busy}>
                Lưu OAuth client
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
        <Panel title="Tài khoản Google">
          <p className="mb-3 text-xs text-muted">
            Client ID {s.app.clientId} ·{' '}
            {s.app.secretFound ? (
              'Client secret có trong Secret Vault'
            ) : (
              <span className="text-danger">
                chưa có secret “{s.app.clientSecretName}” trong Secret Vault
              </span>
            )}{' '}
            · YouTube {s.app.youtubeAudited ? 'đã xét duyệt dự án' : 'chưa xét duyệt dự án'} ·{' '}
            <button className="text-accent underline" onClick={() => setEditApp(true)}>
              Sửa
            </button>
          </p>
          {s.connections.length === 0 && (
            <p className="mb-3 text-sm">
              Chưa kết nối. Chọn dịch vụ, bấm Kết nối Google, chọn tài khoản (hoặc kênh thương hiệu)
              ở trang của Google rồi đánh dấu đủ các quyền.
            </p>
          )}
          {s.connections.map((c) => (
            <div key={c.id} className="mb-3 rounded-md border border-line p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{c.name}</span>
                <span className="text-muted">{c.email}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-xs ${c.status === 'active' ? 'border-green-600 text-green-500' : 'border-danger text-danger'}`}
                >
                  {c.status === 'active' ? 'Đang hoạt động' : 'Mất hiệu lực'}
                </span>
              </div>
              <div className="mb-2 text-xs text-muted">
                Kết nối bởi {c.connectedByName}, {when(c.connectedAt)} · Đồng bộ lần cuối{' '}
                {when(c.syncedAt)}
              </div>
              {c.checkError && <Notice kind="error">{c.checkError}</Notice>}
              <ul className="mb-2 grid gap-1 sm:grid-cols-2">
                {c.features.map((f) => (
                  <li key={f.key}>
                    <span className={f.ready ? 'text-green-500' : 'text-muted'}>
                      {f.ready ? '✓' : '○'}
                    </span>{' '}
                    {f.label}
                    {!f.ready && c.status === 'active' && (
                      <span className="text-xs text-muted"> (Google chưa cấp quyền)</span>
                    )}
                  </li>
                ))}
              </ul>
              <button
                className={`${btnGhostCls} border-danger text-danger`}
                disabled={busy}
                onClick={() =>
                  confirm(
                    `Ngắt kết nối ${c.email}? MARIS xóa token và báo Google thu hồi quyền; các kênh của tài khoản này sẽ tắt.`,
                  ) &&
                  void run(
                    () => api(`/google/connections/${c.id}`, { method: 'DELETE' }),
                    `Đã ngắt ${c.email}.`,
                  )
                }
              >
                Ngắt kết nối
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Xin quyền:</span>
            {(Object.keys(GOOGLE_SERVICES) as GoogleService[]).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={services.includes(k)}
                  onChange={(e) =>
                    setServices((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))
                  }
                />
                {GOOGLE_SERVICES[k].label} ({GOOGLE_SERVICE_HINT[k]})
              </label>
            ))}
            <button
              className={btnCls}
              disabled={busy || !s.app.secretFound || services.length === 0}
              onClick={() => void connect()}
            >
              {s.connections.length ? 'Kết nối thêm hoặc kết nối lại' : 'Kết nối Google'}
            </button>
            {s.connections.some((c) => c.status === 'active') && (
              <button
                className={btnGhostCls}
                disabled={busy}
                onClick={() =>
                  void run(() => api('/google/sync', { method: 'POST' }), 'Đã đồng bộ kênh.')
                }
              >
                Đồng bộ kênh
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            Mỗi kênh thương hiệu (Brand Account) là một lần đăng nhập riêng: chọn đúng kênh ở trang
            của Google. Chức năng chỉ bật khi Google thật sự cấp quyền.
          </p>
        </Panel>
      )}

      {s && s.channels.length > 0 && (
        <Panel title="Kênh YouTube">
          <div className="mb-1 text-xs text-muted">
            {live.filter((c) => c.enabled).length} đang bật / tối đa {GOOGLE_LIMITS.channels}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {s.channels.map((c) => (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className={c.removed ? 'text-muted line-through' : 'font-medium'}>
                        {c.title}
                        {c.customUrl ? <span className="text-muted"> {c.customUrl}</span> : null}
                      </div>
                      <div className="text-xs text-muted">
                        {c.channelId} · {num(c.subscribers)} người đăng ký · {num(c.videos)} video ·{' '}
                        {c.connectionEmail}
                        {c.longUploads === 'allowed'
                          ? ' · đã xác minh (video dài, ảnh bìa)'
                          : ' · chưa xác minh: video tối đa 15 phút, chưa dùng ảnh bìa riêng'}
                        {c.removed ? ' · tài khoản không còn quyền' : ''}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      {!c.removed && (
                        <label className="inline-flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={c.enabled}
                            disabled={busy}
                            onChange={() => void toggle(c)}
                          />
                          {c.enabled ? 'Đang bật' : 'Đang tắt'}
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {q && (
        <Panel title="Hạn mức YouTube hôm nay">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span>
              <b className="tabular-nums">{q.used.toLocaleString('vi-VN')}</b> /{' '}
              {q.quota.toLocaleString('vi-VN')} đơn vị
            </span>
            <Bar pct={q.pct} />
            <span className="tabular-nums">{q.pct.toLocaleString('vi-VN')}%</span>
            <span className={QUOTA_STATE[q.state][1]}>{QUOTA_STATE[q.state][0]}</span>
            <span className="text-muted">· còn đủ khoảng {uploadsLeft} video</span>
          </div>
          {q.blockedUntil && (
            <Notice kind="error">Google yêu cầu tạm dừng tới {when(q.blockedUntil)}.</Notice>
          )}
          <p className="text-xs text-muted">
            Google tính lại lúc {when(q.resetsAt)} (nửa đêm giờ Thái Bình Dương). Từ 75% MARIS hoãn
            việc nền, từ 85% chỉ chạy việc thiết yếu, từ 90% tạm dừng, và không gửi lượt nào vượt
            hạn mức.
          </p>
        </Panel>
      )}

      {calls.length > 0 && (
        <Panel title="Lượt gọi Google gần đây">
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
                    <td className="whitespace-nowrap pr-3 text-muted">
                      {x.units ? `${x.units} đơn vị` : ''}
                    </td>
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
