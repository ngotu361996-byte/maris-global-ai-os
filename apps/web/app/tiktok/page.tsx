'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  TIKTOK_LIMITS,
  TIKTOK_MODE_LABEL,
  TIKTOK_POST_STATUS_LABEL,
  TIKTOK_POST_STATUSES,
  TIKTOK_PRIVACY_LABEL,
  TIKTOK_SERVICES,
  type ApiCallResponse,
  type TiktokAccountResponse,
  type TiktokOauthStartResponse,
  type TiktokPostResponse,
  type TiktokPostStatus,
  type TiktokReportResponse,
  type TiktokService,
  type TiktokStatusResponse,
  type TiktokVideoResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 15_000;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '–');
const num = (n: number | null) => (n === null ? '–' : n.toLocaleString('vi-VN'));

const STATUS_CLS: Record<TiktokPostStatus, string> = {
  scheduled: 'border-accent text-accent',
  uploading: 'border-accent text-accent',
  processing: 'border-yellow-600 text-yellow-500',
  published: 'border-green-600 text-green-500',
  in_inbox: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

/**
 * TikTok Center (spec Part 17, M19): the TikTok app, accounts signed in through TikTok's own
 * page with each service asked for separately, the posts MARIS sends, and the accounts' video
 * figures.
 */
export default function TiktokPage() {
  const me = useMe();
  const [s, setS] = useState<TiktokStatusResponse | null>(null);
  const [posts, setPosts] = useState<TiktokPostResponse[]>([]);
  const [videos, setVideos] = useState<TiktokVideoResponse[]>([]);
  const [report, setReport] = useState<TiktokReportResponse | null>(null);
  const [calls, setCalls] = useState<ApiCallResponse[]>([]);
  const [status, setStatus] = useState<TiktokPostStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editApp, setEditApp] = useState(false);
  const [services, setServices] = useState<TiktokService[]>(['publish', 'draft', 'insights']);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');
  const load = useCallback(() => {
    api<TiktokStatusResponse>('/tiktok').then(setS).catch(fail);
    api<TiktokPostResponse[]>(`/tiktok/posts${status ? `?status=${status}` : ''}`)
      .then(setPosts)
      .catch(() => setPosts([]));
    api<TiktokVideoResponse[]>('/tiktok/videos')
      .then(setVideos)
      .catch(() => setVideos([]));
    api<TiktokReportResponse>('/tiktok/report?days=30')
      .then(setReport)
      .catch(() => setReport(null));
    api<ApiCallResponse[]>('/tiktok/calls')
      .then(setCalls)
      .catch(() => setCalls([]));
  }, [status]);

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
      if (r && typeof r === 'object' && 'redirectUri' in r) setS(r as TiktokStatusResponse);
      load();
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
        api<TiktokStatusResponse>('/tiktok/app', {
          method: 'PUT',
          body: JSON.stringify({
            clientKey: String(f.get('clientKey') ?? '').trim(),
            clientSecretName: String(f.get('clientSecretName') ?? '').trim(),
            audited: f.get('audited') === 'on',
          }),
        }).then((r) => {
          setEditApp(false);
          return r;
        }),
      'Đã lưu ứng dụng TikTok.',
    );
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<TiktokOauthStartResponse>('/tiktok/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ services }),
      });
      window.location.assign(url);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }

  const toggle = (a: TiktokAccountResponse) =>
    run(
      () =>
        api(`/tiktok/accounts/${a.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !a.enabled }),
        }),
      a.enabled ? `Đã tắt ${a.displayName}.` : `Đã bật ${a.displayName}.`,
    );

  const act = (p: TiktokPostResponse, action: 'cancel' | 'retry') =>
    run(
      () => api(`/tiktok/posts/${p.id}/${action}`, { method: 'POST' }),
      action === 'cancel' ? 'Đã hủy bài đăng.' : 'Đã đưa bài vào hàng đợi lại.',
    );

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const failed = posts.filter((p) => p.status === 'failed');

  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trung tâm TikTok</h1>
        <Link href="/content/items?status=approved" className="text-sm text-accent underline">
          Chọn video để đăng
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted">
        Kết nối tài khoản TikTok bằng trang đăng nhập chính thức của TikTok, xin quyền riêng cho
        từng dịch vụ. MARIS không dùng mật khẩu TikTok. Gói BUSINESS: tối đa{' '}
        {TIKTOK_LIMITS.accounts} tài khoản; MARIS gửi tối đa {TIKTOK_LIMITS.postsPerDay} bài mỗi tài
        khoản trong 24 giờ để TikTok không chặn.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {failed.length > 0 && status === '' && (
        <Notice kind="error">{failed.length} bài TikTok lỗi đang chờ bạn xử lý.</Notice>
      )}

      {s && (!s.app || editApp) && (
        <Panel title="1. Ứng dụng TikTok for Developers">
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            <li>
              Vào developers.tiktok.com, đăng nhập, vào <b>Manage apps → Connect an app</b> và tạo
              ứng dụng cho doanh nghiệp. Ở mục <b>Platforms</b>, chọn <b>Desktop</b> (MARIS chạy
              trên máy của bạn).
            </li>
            <li>
              Thêm sản phẩm <b>Login Kit</b> và <b>Content Posting API</b> (bật <b>Direct Post</b>
              ), và nếu muốn xem số liệu thì thêm <b>Display API</b>. Ở Login Kit, thêm Redirect
              URI: <code className="rounded bg-bg px-1">{s.redirectUri}</code>
            </li>
            <li>
              Khi ứng dụng chưa được duyệt, dùng chế độ <b>Sandbox</b> và thêm tài khoản TikTok của
              bạn vào <b>Target users</b>.
            </li>
            <li>
              Sao chép <b>Client secret</b> vào{' '}
              <Link href="/secrets" className="text-accent underline">
                Secret Vault
              </Link>{' '}
              với tên bên dưới. Không dán khóa này vào đây hay vào chat.
            </li>
            <li>Nhập Client key rồi lưu.</li>
          </ol>
          <form onSubmit={saveApp} className="grid gap-3 text-sm sm:grid-cols-3" autoComplete="off">
            <label>
              Client key
              <input
                name="clientKey"
                required
                defaultValue={s.app?.clientKey ?? ''}
                placeholder="aw1234abcd5678ef"
                className={inputCls}
              />
            </label>
            <label>
              Tên secret của Client secret
              <input
                name="clientSecretName"
                required
                defaultValue={s.app?.clientSecretName ?? 'tiktok.client_secret'}
                className={inputCls}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2">
              <input type="checkbox" name="audited" defaultChecked={s.app?.audited ?? false} />
              TikTok đã duyệt (audit) Direct Post
            </label>
            <p className="text-xs text-muted sm:col-span-3">
              Khi TikTok chưa duyệt ứng dụng, video đăng thẳng chỉ được để <b>Chỉ mình tôi</b> và tài
              khoản TikTok cần để riêng tư. Muốn đăng công khai ngay thì chọn “Gửi vào hộp nháp”
              rồi bấm đăng trong app TikTok. Chỉ đánh dấu ô trên khi TikTok đã báo duyệt.
            </p>
            <div className="flex gap-2 sm:col-span-3">
              <button className={btnCls} disabled={busy}>
                Lưu ứng dụng TikTok
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
        <Panel title="Tài khoản TikTok">
          <p className="mb-3 text-xs text-muted">
            Client key {s.app.clientKey} ·{' '}
            {s.app.secretFound ? (
              'Client secret có trong Secret Vault'
            ) : (
              <span className="text-danger">
                chưa có secret “{s.app.clientSecretName}” trong Secret Vault
              </span>
            )}{' '}
            · {s.app.audited ? 'TikTok đã duyệt Direct Post' : 'TikTok chưa duyệt Direct Post'} ·{' '}
            <button className="text-accent underline" onClick={() => setEditApp(true)}>
              Sửa
            </button>
          </p>
          {s.accounts.length === 0 && (
            <p className="mb-3 text-sm">
              Chưa kết nối. Chọn quyền, bấm Kết nối TikTok, đăng nhập ở trang của TikTok rồi bấm
              Cho phép.
            </p>
          )}
          {s.accounts.map((a) => (
            <div key={a.id} className="mb-3 rounded-md border border-line p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{a.displayName}</span>
                {a.username && <span className="text-muted">@{a.username}</span>}
                <span
                  className={`rounded border px-1.5 py-0.5 text-xs ${a.status === 'active' ? 'border-green-600 text-green-500' : 'border-danger text-danger'}`}
                >
                  {a.status === 'active' ? 'Đang hoạt động' : 'Mất hiệu lực'}
                </span>
                <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    disabled={busy}
                    onChange={() => void toggle(a)}
                  />
                  {a.enabled ? 'Đang bật' : 'Đang tắt'}
                </label>
              </div>
              <div className="mb-2 text-xs text-muted">
                {num(a.followers)} người theo dõi · {num(a.likes)} lượt thích · {num(a.videoCount)}{' '}
                video · {a.postsToday}/{TIKTOK_LIMITS.postsPerDay} bài trong 24 giờ · kết nối bởi{' '}
                {a.connectedByName}, {when(a.connectedAt)} · đồng bộ {when(a.syncedAt)}
              </div>
              {a.checkError && <Notice kind="error">{a.checkError}</Notice>}
              <ul className="mb-2 grid gap-1 sm:grid-cols-2">
                {a.features.map((f) => (
                  <li key={f.key}>
                    <span className={f.ready ? 'text-green-500' : 'text-muted'}>
                      {f.ready ? '✓' : '○'}
                    </span>{' '}
                    {f.label}
                    {!f.ready && a.status === 'active' && (
                      <span className="text-xs text-muted"> (TikTok chưa cấp quyền)</span>
                    )}
                  </li>
                ))}
              </ul>
              {a.creator && (
                <p className="mb-2 text-xs text-muted">
                  TikTok cho đăng: {a.creator.privacyOptions.map((p) => TIKTOK_PRIVACY_LABEL[p]).join(', ') || '–'}
                  {a.creator.maxDurationSec ? ` · video tối đa ${a.creator.maxDurationSec} giây` : ''}
                  {a.creator.commentDisabled ? ' · đã tắt bình luận' : ''}
                  {a.creator.duetDisabled ? ' · đã tắt Duet' : ''}
                  {a.creator.stitchDisabled ? ' · đã tắt Stitch' : ''}
                </p>
              )}
              <button
                className={`${btnGhostCls} border-danger text-danger`}
                disabled={busy}
                onClick={() =>
                  confirm(
                    `Ngắt kết nối ${a.displayName}? MARIS xóa token và báo TikTok thu hồi quyền.`,
                  ) &&
                  void run(
                    () => api(`/tiktok/accounts/${a.id}`, { method: 'DELETE' }),
                    `Đã ngắt ${a.displayName}.`,
                  )
                }
              >
                Ngắt kết nối
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Xin quyền:</span>
            {(Object.keys(TIKTOK_SERVICES) as TiktokService[]).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={services.includes(k)}
                  onChange={(e) =>
                    setServices((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))
                  }
                />
                {TIKTOK_SERVICES[k].label}
              </label>
            ))}
            <button
              className={btnCls}
              disabled={busy || !s.app.secretFound || services.length === 0}
              onClick={() => void connect()}
            >
              {s.accounts.length ? 'Kết nối thêm hoặc kết nối lại' : 'Kết nối TikTok'}
            </button>
            {s.accounts.some((a) => a.status === 'active') && (
              <button
                className={btnGhostCls}
                disabled={busy}
                onClick={() =>
                  void run(() => api('/tiktok/sync', { method: 'POST' }), 'Đã đọc lại số liệu TikTok.')
                }
              >
                Đọc TikTok ngay
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">
            TikTok không có hẹn giờ đăng qua API: bài hẹn giờ chờ trong MARIS và được gửi đúng giờ,
            nên máy chạy MARIS cần bật lúc đó.
          </p>
        </Panel>
      )}

      <Panel title="Bài đăng TikTok">
        <label className="mb-3 flex max-w-sm items-center gap-2 text-sm">
          <span className="whitespace-nowrap text-muted">Trạng thái</span>
          <select
            className={`${inputCls} w-auto`}
            value={status}
            onChange={(e) => setStatus(e.target.value as TiktokPostStatus | '')}
          >
            <option value="">Tất cả</option>
            {TIKTOK_POST_STATUSES.map((x) => (
              <option key={x} value={x}>
                {TIKTOK_POST_STATUS_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
        {posts.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có bài nào. Mở một video đã duyệt trong Kho thành phẩm và chọn “Đăng lên TikTok”.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Video</th>
                  <th>Tài khoản</th>
                  <th>Cách đăng</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{p.title || p.itemTitle}</div>
                      <div className="text-xs text-muted">
                        <Link href={`/content/items?open=${p.itemId}`} className="underline">
                          {p.itemTitle}
                        </Link>{' '}
                        · bản {p.version} · hẹn {when(p.scheduledAt)} · {p.createdByName}
                        {p.brandOrganic ? ' · quảng bá thương hiệu riêng' : ''}
                        {p.brandedContent ? ' · hợp tác có trả phí' : ''}
                        {p.aigc ? ' · nội dung AI' : ''}
                      </div>
                      {p.warnings.map((w) => (
                        <div key={w} className="text-xs text-yellow-500">
                          {w}
                        </div>
                      ))}
                      {p.errorMessage && p.status !== 'published' && p.status !== 'in_inbox' && (
                        <div
                          className={`text-xs ${p.status === 'failed' ? 'text-danger' : 'text-muted'}`}
                        >
                          {p.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="pr-3">{p.accountName}</td>
                    <td className="pr-3 text-xs">
                      {TIKTOK_MODE_LABEL[p.mode]}
                      {p.privacy && <div className="text-muted">{TIKTOK_PRIVACY_LABEL[p.privacy]}</div>}
                    </td>
                    <td className="pr-3">
                      <span
                        className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATUS_CLS[p.status]}`}
                      >
                        {TIKTOK_POST_STATUS_LABEL[p.status]}
                        {p.uploadedPct !== null ? ` ${p.uploadedPct}%` : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mr-2 text-accent underline"
                        >
                          Xem trên TikTok
                        </a>
                      )}
                      {p.status === 'failed' && (
                        <button
                          className={`${btnGhostCls} mr-1`}
                          disabled={busy}
                          onClick={() => void act(p, 'retry')}
                        >
                          Thử lại
                        </button>
                      )}
                      {(p.status === 'scheduled' || p.status === 'failed') && (
                        <button
                          className={btnGhostCls}
                          disabled={busy}
                          onClick={() => void act(p, 'cancel')}
                        >
                          Hủy
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {report && (
        <Panel title={`Số liệu video ${report.days} ngày qua`}>
          <div className="mb-3 grid gap-3 text-sm sm:grid-cols-5">
            {(
              [
                ['Video', report.videos],
                ['Lượt xem', report.views],
                ['Lượt thích', report.likes],
                ['Bình luận', report.comments],
                ['Chia sẻ', report.shares],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md border border-line p-2">
                <div className="text-xs text-muted">{label}</div>
                <div className="text-lg font-semibold tabular-nums">{num(n)}</div>
              </div>
            ))}
          </div>
          <p className="mb-2 text-xs text-muted">
            Tỷ lệ tương tác (thích + bình luận + chia sẻ trên lượt xem):{' '}
            {report.engagementPct === null ? '–' : `${report.engagementPct.toLocaleString('vi-VN')}%`}
            . Số liệu do TikTok cung cấp, đọc lại khi bấm “Đọc TikTok ngay”.
          </p>
          {videos.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1">Video</th>
                    <th>Đăng lúc</th>
                    <th className="text-right">Xem</th>
                    <th className="text-right">Thích</th>
                    <th className="text-right">Bình luận</th>
                    <th className="text-right">Chia sẻ</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.slice(0, 30).map((v) => (
                    <tr key={v.id} className="border-t border-line align-top">
                      <td className="max-w-md py-1 pr-3">
                        {v.shareUrl ? (
                          <a href={v.shareUrl} target="_blank" rel="noreferrer" className="underline">
                            {v.title || v.videoId}
                          </a>
                        ) : (
                          v.title || v.videoId
                        )}
                        <div className="text-xs text-muted">{v.accountName}</div>
                      </td>
                      <td className="whitespace-nowrap pr-3 text-xs text-muted">{when(v.postedAt)}</td>
                      <td className="text-right tabular-nums">{num(v.views)}</td>
                      <td className="text-right tabular-nums">{num(v.likes)}</td>
                      <td className="text-right tabular-nums">{num(v.comments)}</td>
                      <td className="text-right tabular-nums">{num(v.shares)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {calls.length > 0 && (
        <Panel title="Lượt gọi TikTok gần đây">
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
