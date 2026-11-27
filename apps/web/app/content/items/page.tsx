'use client';

import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ASSET_KIND_LABEL,
  ITEM_KIND_LABEL,
  ITEM_KINDS,
  ITEM_STATUS_LABEL,
  ITEM_STATUSES,
  LANGUAGES,
  PLATFORM_LABEL,
  PLATFORMS,
  RIGHTS_LABEL,
  type AssetResponse,
  type ItemDetailResponse,
  type ItemResponse,
  type ItemStatus,
  type Platform,
  type VersionResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api, fileUrl, uploadTo } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const STATUS_CLS: Record<ItemStatus, string> = {
  draft: 'border-line text-muted',
  in_review: 'border-accent text-accent',
  approved: 'border-green-600 text-green-500',
  rejected: 'border-danger text-danger',
  published: 'border-green-600 text-green-500',
  archived: 'border-line text-muted',
};

function Status({ s }: { s: ItemStatus }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATUS_CLS[s]}`}>
      {ITEM_STATUS_LABEL[s]}
    </span>
  );
}

function Version({ itemId, v, current }: { itemId: string; v: VersionResponse; current: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const media = v.file && /^(image|video|audio)\//.test(v.file.mime);
  async function show() {
    try {
      setUrl(await fileUrl(`/content/items/${itemId}/versions/${v.version}/file?inline=1`));
    } catch {
      setUrl(null);
    }
  }
  async function download() {
    const u = await fileUrl(`/content/items/${itemId}/versions/${v.version}/file`);
    const a = document.createElement('a');
    a.href = u;
    a.download = v.file?.name ?? `phien-ban-${v.version}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  }
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return (
    <li className={`rounded-md border p-3 ${current ? 'border-accent' : 'border-line'}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-semibold text-ink">Phiên bản {v.version}</span>
        {current && <span className="text-accent">hiện tại</span>}
        <span>
          {v.createdByName}, {new Date(v.createdAt).toLocaleString('vi-VN')}
        </span>
        {v.skillName && <span>· Skill: {v.skillName}</span>}
        {v.workflowRunId && <span>· từ Workflow</span>}
        {v.aiTaskId && <span>· từ việc AI</span>}
      </div>
      {v.note && <p className="mb-2 text-xs italic text-muted">{v.note}</p>}
      {v.body && (
        <pre className="mb-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg p-2 text-sm">
          {v.body}
        </pre>
      )}
      {v.file && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span>
            {v.file.name} ({Math.round(v.file.sizeBytes / 1024)} KB)
          </span>
          {media && !url && (
            <button className={btnGhostCls} onClick={show}>
              Xem
            </button>
          )}
          <button className={btnGhostCls} onClick={download}>
            Tải về
          </button>
        </div>
      )}
      {url && v.file?.mime.startsWith('image/') && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="mb-2 max-h-80 rounded border border-line" />
      )}
      {url && v.file?.mime.startsWith('video/') && (
        <video src={url} controls className="mb-2 max-h-80 rounded border border-line" />
      )}
      {url && v.file?.mime.startsWith('audio/') && (
        <audio src={url} controls className="mb-2 w-full" />
      )}
      {v.sources.length > 0 && (
        <div className="text-xs">
          <span className="text-muted">Nguồn gốc: </span>
          {v.sources.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              {s.title} <span className="text-muted">({ASSET_KIND_LABEL[s.kind]}, </span>
              <span className={s.usable ? 'text-green-500' : 'text-yellow-500'}>
                {s.usable ? RIGHTS_LABEL[s.rightsStatus] : 'chưa dùng được'}
              </span>
              <span className="text-muted">)</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function ItemsPage() {
  const me = useMe();
  const params = useSearchParams();
  const from = params.get('from');
  const [items, setItems] = useState<ItemResponse[]>([]);
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [status, setStatus] = useState<ItemStatus | ''>('');
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [q, setQ] = useState('');
  const [sources, setSources] = useState<string[]>(from ? [from] : []);
  // Sources chosen for an item created without text; they go on its first uploaded version.
  const [pendingSources, setPendingSources] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (platform) p.set('platform', platform);
    if (q.trim()) p.set('q', q.trim());
    api<ItemResponse[]>(`/content/items?${p}`).then(setItems).catch(fail);
  }, [status, platform, q]);
  useEffect(() => {
    if (!me) return;
    load();
    api<AssetResponse[]>('/content/assets?limit=200')
      .then(setAssets)
      .catch(() => {});
  }, [me, load]);
  useEffect(() => {
    if (!selected) return setDetail(null);
    api<ItemDetailResponse>(`/content/items/${selected}`).then(setDetail).catch(fail);
  }, [selected]);

  const done = (d: ItemDetailResponse, msg: string) => {
    setDetail(d);
    setSelected(d.id);
    setOk(msg);
    setError(null);
    load();
  };

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setOk(null);
    try {
      const d = await api<ItemDetailResponse>('/content/items', {
        method: 'POST',
        body: JSON.stringify({
          title: String(f.get('title')).trim(),
          kind: String(f.get('kind')),
          platform: String(f.get('platform')) || null,
          language: String(f.get('language')),
          market: String(f.get('market') ?? '').trim() || null,
          body: String(f.get('body') ?? '').trim() || null,
          sourceAssetIds: sources,
          note: String(f.get('note') ?? '').trim() || null,
        }),
      });
      form.reset();
      if (d.currentVersion === 0 && sources.length)
        setPendingSources((p) => ({ ...p, [d.id]: sources }));
      setSources([]);
      done(
        d,
        d.currentVersion === 0
          ? `Đã tạo “${d.title}”. Tải tệp lên ở phần Phiên bản mới.`
          : `Đã tạo “${d.title}”.`,
      );
    } catch (err) {
      fail(err);
    }
  }

  async function act(path: string, body: object | undefined, msg: string) {
    if (!detail) return;
    setBusy(true);
    try {
      done(
        await api<ItemDetailResponse>(`/content/items/${detail.id}/${path}`, {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        }),
        msg,
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function newVersion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = (form.elements.namedItem('file') as HTMLInputElement).files?.[0];
    const body = String(f.get('body') ?? '').trim();
    const note = String(f.get('note') ?? '').trim();
    const keep = detail.versions[0]?.sources.map((s) => s.id) ?? pendingSources[detail.id] ?? [];
    setBusy(true);
    try {
      let d: ItemDetailResponse;
      if (file) {
        const p = new URLSearchParams();
        if (keep.length) p.set('sourceAssetIds', keep.join(','));
        if (note) p.set('note', note);
        d = await uploadTo<ItemDetailResponse>(
          `/content/items/${detail.id}/versions/upload?${p}`,
          file,
        );
      } else if (body) {
        d = await api<ItemDetailResponse>(`/content/items/${detail.id}/versions`, {
          method: 'POST',
          body: JSON.stringify({ body, sourceAssetIds: keep, note: note || null }),
        });
      } else {
        setBusy(false);
        return setError('Nhập nội dung mới hoặc chọn tệp.');
      }
      form.reset();
      done(d, `Đã lưu phiên bản ${d.currentVersion}. Nội dung trở về bản nháp để duyệt lại.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const usableAssets = assets.filter((a) => !a.archivedAt);

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Kho thành phẩm</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Nội dung đã làm xong theo ngôn ngữ, thị trường và nền tảng. Mỗi lần sửa là một phiên bản
        mới, phiên bản cũ giữ nguyên. Mỗi phiên bản ghi rõ nội dung gốc đã dùng, Skill hoặc Workflow
        đã làm ra nó. Quy trình: Bản nháp → Chờ duyệt → Đã duyệt → Đã xuất bản.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Panel title="Thêm thành phẩm">
        <form onSubmit={create} className="grid max-w-4xl gap-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-sm sm:col-span-2">
              Tiêu đề
              <input name="title" required maxLength={200} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-sm">
              Loại
              <select name="kind" defaultValue="text" className={`${inputCls} mt-1`}>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ITEM_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Nền tảng
              <select name="platform" defaultValue="" className={`${inputCls} mt-1`}>
                <option value="">Chưa chọn</option>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-sm">
              Ngôn ngữ
              <select name="language" defaultValue="vi" className={`${inputCls} mt-1`}>
                {Object.entries(LANGUAGES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Thị trường
              <input
                name="market"
                maxLength={50}
                placeholder="VN, US…"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm sm:col-span-2">
              Ghi chú phiên bản
              <input name="note" maxLength={1000} className={`${inputCls} mt-1`} />
            </label>
          </div>
          <label className="text-sm">
            Nội dung (bài viết; video và ảnh tải lên sau khi tạo)
            <textarea name="body" rows={5} maxLength={200000} className={`${inputCls} mt-1`} />
          </label>
          <div className="text-sm">
            Nội dung gốc đã dùng ({sources.length})
            <div className="mt-1 max-h-40 overflow-auto rounded-md border border-line bg-bg p-2">
              {usableAssets.length === 0 ? (
                <p className="text-xs text-muted">Kho nội dung gốc đang trống.</p>
              ) : (
                usableAssets.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox"
                      checked={sources.includes(a.id)}
                      onChange={(e) =>
                        setSources((s) =>
                          e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id),
                        )
                      }
                    />
                    <span>{a.title}</span>
                    <span className="text-xs text-muted">{ASSET_KIND_LABEL[a.kind]}</span>
                    {!a.usable && (
                      <span className="text-xs text-yellow-500">
                        ({RIGHTS_LABEL[a.rightsStatus]})
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
          <div>
            <button className={btnCls}>Tạo thành phẩm</button>
          </div>
        </form>
      </Panel>

      <Panel title={`Thành phẩm (${items.length})`}>
        <div className="mb-3 grid gap-2 sm:grid-cols-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm theo tiêu đề, tag…"
            className={`${inputCls} sm:col-span-2`}
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ItemStatus | '')}
            className={inputCls}
          >
            <option value="">Mọi trạng thái (trừ lưu trữ)</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ITEM_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Platform | '')}
            className={inputCls}
          >
            <option value="">Mọi nền tảng</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted">Chưa có thành phẩm nào.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Thành phẩm</th>
                  <th>Trạng thái</th>
                  <th>Nền tảng</th>
                  <th>Phiên bản</th>
                  <th>Cập nhật</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    onClick={() => setSelected(i.id === selected ? null : i.id)}
                    className={`cursor-pointer border-t border-line align-top ${i.id === selected ? 'bg-bg' : ''}`}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{i.title}</div>
                      <div className="text-xs text-muted">
                        {ITEM_KIND_LABEL[i.kind]} · {LANGUAGES[i.language] ?? i.language}
                        {i.market ? ` · ${i.market}` : ''}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Status s={i.status} />
                    </td>
                    <td className="py-2 pr-3">{i.platform ? PLATFORM_LABEL[i.platform] : '–'}</td>
                    <td className="py-2 pr-3 tabular-nums">{i.currentVersion || '–'}</td>
                    <td className="whitespace-nowrap py-2 text-muted">
                      {new Date(i.updatedAt).toLocaleString('vi-VN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {detail && (
        <Panel title={`Chi tiết: ${detail.title}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Status s={detail.status} />
            {(detail.status === 'draft' || detail.status === 'rejected') && (
              <button
                disabled={busy}
                className={btnGhostCls}
                onClick={() => act('submit', undefined, 'Đã gửi duyệt.')}
              >
                Gửi duyệt
              </button>
            )}
            {detail.status === 'in_review' && (
              <>
                <button
                  disabled={busy || detail.approvalBlockers.length > 0}
                  className={`${btnGhostCls} border-green-600 text-green-500`}
                  onClick={() =>
                    act(
                      'approve',
                      { note: prompt('Ghi chú khi duyệt (không bắt buộc)') || null },
                      'Đã duyệt.',
                    )
                  }
                >
                  Duyệt
                </button>
                <button
                  disabled={busy}
                  className={`${btnGhostCls} border-danger text-danger`}
                  onClick={() => {
                    const note = prompt('Lý do từ chối');
                    if (note !== null) void act('reject', { note: note || null }, 'Đã từ chối.');
                  }}
                >
                  Từ chối
                </button>
              </>
            )}
            {detail.status === 'approved' && (
              <button
                disabled={busy}
                className={btnGhostCls}
                onClick={() => {
                  const url = prompt('Đường dẫn bài đã đăng (không bắt buộc)', 'https://');
                  if (url !== null)
                    void act(
                      'publish',
                      { url: url && url !== 'https://' ? url : null },
                      'Đã đánh dấu xuất bản.',
                    );
                }}
              >
                Đánh dấu đã xuất bản
              </button>
            )}
            {detail.status !== 'archived' && (
              <button
                disabled={busy}
                className={btnGhostCls}
                onClick={() =>
                  confirm(`Lưu trữ “${detail.title}”?`) &&
                  void act('archive', undefined, 'Đã lưu trữ.')
                }
              >
                Lưu trữ
              </button>
            )}
          </div>
          {detail.approvalBlockers.length > 0 && detail.status !== 'draft' && (
            <Notice kind="error">
              Chưa duyệt được: {detail.approvalBlockers.join('; ')}. Cập nhật quyền ở Kho nội dung
              gốc.
            </Notice>
          )}
          {detail.reviewNote && (
            <p className="mb-3 text-sm">
              <span className="text-muted">Ghi chú duyệt ({detail.reviewedByName}):</span>{' '}
              {detail.reviewNote}
            </p>
          )}
          {detail.publishedUrl && (
            <p className="mb-3 text-sm">
              <span className="text-muted">Đã đăng tại: </span>
              <a
                href={detail.publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline"
              >
                {detail.publishedUrl}
              </a>
            </p>
          )}

          {detail.status !== 'published' && detail.status !== 'archived' && (
            <form
              onSubmit={newVersion}
              className="mb-4 grid gap-2 rounded-md border border-line p-3"
              autoComplete="off"
            >
              <div className="text-sm font-medium">Phiên bản mới</div>
              <textarea
                name="body"
                rows={4}
                maxLength={200000}
                defaultValue={detail.versions[0]?.body ?? ''}
                key={detail.currentVersion}
                className={inputCls}
              />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted">hoặc tệp:</span>
                <input
                  name="file"
                  type="file"
                  accept=".mp4,.mov,.webm,.png,.jpg,.jpeg,.gif,.webp,.mp3,.m4a,.wav,.ogg,.pdf,.docx"
                />
                <input
                  name="note"
                  maxLength={1000}
                  placeholder="Ghi chú thay đổi"
                  className={`${inputCls} max-w-xs`}
                />
                <button disabled={busy} className={btnCls}>
                  {busy ? 'Đang lưu…' : 'Lưu phiên bản'}
                </button>
              </div>
            </form>
          )}

          <div className="mb-1 text-xs text-muted">Lịch sử phiên bản</div>
          {detail.versions.length === 0 ? (
            <p className="text-sm text-muted">Chưa có phiên bản nào.</p>
          ) : (
            <ul className="space-y-2">
              {detail.versions.map((v) => (
                <Version
                  key={v.id}
                  itemId={detail.id}
                  v={v}
                  current={v.version === detail.currentVersion}
                />
              ))}
            </ul>
          )}
        </Panel>
      )}
    </Shell>
  );
}

export default function ContentItemsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Đang tải…</div>}>
      <ItemsPage />
    </Suspense>
  );
}
