'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ASSET_KIND_LABEL,
  ASSET_KINDS,
  ASSET_SOURCE_LABEL,
  RIGHTS_LABEL,
  RIGHTS_STATUSES,
  type AssetKind,
  type AssetResponse,
  type FolderResponse,
  type RightsStatus,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api, fileUrl, uploadTo } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const RIGHTS_CLS: Record<RightsStatus, string> = {
  owned: 'border-green-600 text-green-500',
  licensed: 'border-green-600 text-green-500',
  permission: 'border-green-600 text-green-500',
  unknown: 'border-yellow-500 text-yellow-500',
  restricted: 'border-danger text-danger',
};

function Rights({ a }: { a: Pick<AssetResponse, 'rightsStatus' | 'usable' | 'rightsExpiresAt'> }) {
  const expired = !a.usable && ['owned', 'licensed', 'permission'].includes(a.rightsStatus);
  return (
    <span
      className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${expired ? RIGHTS_CLS.restricted : RIGHTS_CLS[a.rightsStatus]}`}
    >
      {expired ? 'Hết hạn quyền' : RIGHTS_LABEL[a.rightsStatus]}
    </span>
  );
}

const size = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;

function Preview({ a }: { a: AssetResponse }) {
  const [url, setUrl] = useState<string | null>(null);
  const media = a.file && /^(image|video|audio)\//.test(a.file.mime);
  useEffect(() => {
    if (!media) return;
    let u: string | null = null;
    fileUrl(`/content/assets/${a.id}/file?inline=1`)
      .then((x) => setUrl((u = x)))
      .catch(() => setUrl(null));
    return () => {
      if (u) URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [a.id, media]);
  if (!a.file) return null;
  if (!media || !url)
    return (
      <p className="mb-3 text-xs text-muted">
        {media ? 'Đang tải xem trước…' : 'Tệp không xem trước được, hãy tải về.'}
      </p>
    );
  if (a.file.mime.startsWith('image/'))
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={a.title} className="mb-3 max-h-80 rounded border border-line" />;
  if (a.file.mime.startsWith('video/'))
    return <video src={url} controls className="mb-3 max-h-80 rounded border border-line" />;
  return <audio src={url} controls className="mb-3 w-full" />;
}

export default function ContentSourcePage() {
  const me = useMe();
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [folders, setFolders] = useState<FolderResponse[]>([]);
  const [folder, setFolder] = useState<string>('');
  const [kind, setKind] = useState<AssetKind | ''>('');
  const [rights, setRights] = useState<RightsStatus | ''>('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<AssetResponse | null>(null);
  const [mode, setMode] = useState<'upload' | 'text' | 'product'>('upload');
  const [specs, setSpecs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (kind) p.set('kind', kind);
    if (rights) p.set('rights', rights);
    if (folder) p.set('folderId', folder);
    api<AssetResponse[]>(`/content/assets?${p}`).then(setAssets).catch(fail);
    api<FolderResponse[]>('/content/folders?library=source')
      .then(setFolders)
      .catch(() => {});
  }, [q, kind, rights, folder]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const files = (form.elements.namedItem('files') as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    setError(null);
    setOk(null);
    const done: string[] = [];
    try {
      for (const [i, file] of [...files].entries()) {
        setBusy(`Đang tải ${i + 1}/${files.length}: ${file.name}`);
        const p = new URLSearchParams({ rightsStatus: String(f.get('rightsStatus')) });
        if (folder) p.set('folderId', folder);
        const holder = String(f.get('rightsHolder') ?? '').trim();
        if (holder) p.set('rightsHolder', holder);
        const tags = String(f.get('tags') ?? '').trim();
        if (tags) p.set('tags', tags);
        await uploadTo<AssetResponse>(`/content/assets/upload?${p}`, file);
        done.push(file.name);
      }
      setOk(`Đã thêm ${done.length} tệp vào kho.`);
      form.reset();
    } catch (err) {
      fail(err);
      if (done.length) setOk(`Đã thêm ${done.length} tệp trước khi gặp lỗi.`);
    } finally {
      setBusy(null);
      load();
    }
  }

  async function createText(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setOk(null);
    const base = {
      title: String(f.get('title')).trim(),
      folderId: folder || null,
      rightsStatus: String(f.get('rightsStatus')),
      sourceRef: String(f.get('sourceRef') ?? '').trim() || null,
      tags: String(f.get('tags') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      description: String(f.get('description') ?? '').trim() || null,
    };
    const body =
      mode === 'product'
        ? {
            ...base,
            kind: 'product',
            product: {
              name: base.title,
              sku: String(f.get('sku') ?? '').trim() || undefined,
              price: f.get('price') ? Number(f.get('price')) : undefined,
              currency: f.get('price') ? 'VND' : undefined,
              url: String(f.get('url') ?? '').trim() || undefined,
              specs: specs
                .split('\n')
                .map((l) => l.split(':'))
                .filter((p) => p.length >= 2 && p[0]!.trim() && p.slice(1).join(':').trim())
                .map((p) => ({ key: p[0]!.trim(), value: p.slice(1).join(':').trim() })),
            },
          }
        : { ...base, kind: String(f.get('textKind')), body: String(f.get('body')) };
    try {
      const a = await api<AssetResponse>('/content/assets', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setOk(`Đã thêm “${a.title}”.`);
      form.reset();
      setSpecs('');
      setSelected(a);
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function newFolder() {
    const name = prompt('Tên thư mục mới');
    if (!name?.trim()) return;
    try {
      const f = await api<FolderResponse>('/content/folders', {
        method: 'POST',
        body: JSON.stringify({ library: 'source', name: name.trim() }),
      });
      setFolder(f.id);
    } catch (err) {
      fail(err);
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    const exp = String(f.get('rightsExpiresAt') ?? '');
    try {
      const a = await api<AssetResponse>(`/content/assets/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: String(f.get('title')).trim(),
          description: String(f.get('description') ?? '').trim() || null,
          tags: String(f.get('tags') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          rightsStatus: String(f.get('rightsStatus')),
          rightsHolder: String(f.get('rightsHolder') ?? '').trim() || null,
          rightsNote: String(f.get('rightsNote') ?? '').trim() || null,
          rightsExpiresAt: exp ? new Date(`${exp}T23:59:59`).toISOString() : null,
          folderId: String(f.get('folderId') ?? '') || null,
        }),
      });
      setSelected(a);
      setOk('Đã lưu.');
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function act(action: 'verify' | 'archive' | 'restore') {
    if (!selected) return;
    if (action === 'archive' && !confirm(`Lưu trữ “${selected.title}”? Tệp gốc vẫn được giữ.`))
      return;
    try {
      const a = await api<AssetResponse>(`/content/assets/${selected.id}/${action}`, {
        method: 'POST',
      });
      setSelected(action === 'archive' ? null : a);
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function download(a: AssetResponse) {
    try {
      const url = await fileUrl(`/content/assets/${a.id}/file`);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.file?.name ?? a.title;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      fail(err);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Kho nội dung gốc</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Video, hình ảnh, âm thanh, tài liệu, thông tin sản phẩm và nội dung tham khảo, kèm nguồn gốc
        và quyền sử dụng. Tệp gốc không bao giờ bị ghi đè. Thành phẩm dùng nguồn “Chưa rõ quyền” hay
        “Không được dùng” sẽ không duyệt được.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-muted">Thư mục</span>
            <button className={btnGhostCls} onClick={newFolder}>
              + Thêm
            </button>
          </div>
          <ul className="space-y-1 text-sm">
            <li>
              <button
                className={`w-full rounded px-2 py-1 text-left ${folder === '' ? 'bg-bg text-accent' : ''}`}
                onClick={() => setFolder('')}
              >
                Tất cả
              </button>
            </li>
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  className={`flex w-full justify-between rounded px-2 py-1 text-left ${folder === f.id ? 'bg-bg text-accent' : ''}`}
                  onClick={() => setFolder(f.id)}
                >
                  <span>{f.name}</span>
                  <span className="text-xs text-muted">{f.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div>
          <Panel title="Thêm nội dung gốc">
            <div className="mb-3 flex flex-wrap gap-2">
              {(
                [
                  ['upload', 'Tải tệp lên'],
                  ['text', 'Văn bản, tham khảo'],
                  ['product', 'Thông tin sản phẩm'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`${btnGhostCls} ${mode === m ? 'border-accent text-accent' : ''}`}
                >
                  {label}
                </button>
              ))}
              {folder && (
                <span className="self-center text-xs text-muted">
                  Vào thư mục: {folderName(folder)}
                </span>
              )}
            </div>
            {mode === 'upload' ? (
              <form onSubmit={upload} className="grid gap-3" autoComplete="off">
                <input
                  name="files"
                  type="file"
                  multiple
                  required
                  accept=".mp4,.mov,.webm,.png,.jpg,.jpeg,.gif,.webp,.mp3,.m4a,.wav,.ogg,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json"
                  className="text-sm"
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm">
                    Quyền sử dụng
                    <select name="rightsStatus" defaultValue="owned" className={`${inputCls} mt-1`}>
                      {RIGHTS_STATUSES.map((r) => (
                        <option key={r} value={r}>
                          {RIGHTS_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Chủ sở hữu (không bắt buộc)
                    <input name="rightsHolder" maxLength={200} className={`${inputCls} mt-1`} />
                  </label>
                  <label className="text-sm">
                    Tag, cách nhau dấu phẩy
                    <input
                      name="tags"
                      maxLength={500}
                      placeholder="áo thun, hè 2026"
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <button disabled={!!busy} className={btnCls}>
                    {busy ? 'Đang tải…' : 'Tải lên'}
                  </button>
                  {busy && <span className="text-xs text-muted">{busy}</span>}
                </div>
              </form>
            ) : (
              <form onSubmit={createText} className="grid gap-3" autoComplete="off">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm sm:col-span-2">
                    {mode === 'product' ? 'Tên sản phẩm' : 'Tiêu đề'}
                    <input name="title" required maxLength={200} className={`${inputCls} mt-1`} />
                  </label>
                  {mode === 'text' ? (
                    <label className="text-sm">
                      Loại
                      <select name="textKind" defaultValue="text" className={`${inputCls} mt-1`}>
                        <option value="text">{ASSET_KIND_LABEL.text}</option>
                        <option value="reference">{ASSET_KIND_LABEL.reference}</option>
                      </select>
                    </label>
                  ) : (
                    <label className="text-sm">
                      Mã SKU
                      <input name="sku" maxLength={100} className={`${inputCls} mt-1`} />
                    </label>
                  )}
                </div>
                {mode === 'product' ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm">
                        Giá (VND)
                        <input name="price" type="number" min={0} className={`${inputCls} mt-1`} />
                      </label>
                      <label className="text-sm">
                        Trang sản phẩm
                        <input
                          name="url"
                          type="url"
                          maxLength={1000}
                          placeholder="https://"
                          className={`${inputCls} mt-1`}
                        />
                      </label>
                    </div>
                    <label className="text-sm">
                      Thông số đã xác minh, mỗi dòng một mục dạng “Tên: giá trị”
                      <textarea
                        value={specs}
                        onChange={(e) => setSpecs(e.target.value)}
                        rows={4}
                        placeholder={'Chất liệu: Cotton 100%\nSize: S, M, L, XL'}
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                  </>
                ) : (
                  <label className="text-sm">
                    Nội dung
                    <textarea
                      name="body"
                      required
                      rows={5}
                      maxLength={200000}
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm">
                    Quyền sử dụng
                    <select name="rightsStatus" defaultValue="owned" className={`${inputCls} mt-1`}>
                      {RIGHTS_STATUSES.map((r) => (
                        <option key={r} value={r}>
                          {RIGHTS_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Nguồn (đường dẫn hoặc ghi chú)
                    <input name="sourceRef" maxLength={1000} className={`${inputCls} mt-1`} />
                  </label>
                  <label className="text-sm">
                    Tag
                    <input name="tags" maxLength={500} className={`${inputCls} mt-1`} />
                  </label>
                </div>
                <div>
                  <button className={btnCls}>Thêm vào kho</button>
                </div>
              </form>
            )}
          </Panel>

          <Panel title={`Nội dung (${assets.length})`}>
            <div className="mb-3 grid gap-2 sm:grid-cols-4">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Tìm theo tên, mô tả, tag…"
                className={`${inputCls} sm:col-span-2`}
              />
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as AssetKind | '')}
                className={inputCls}
              >
                <option value="">Mọi loại</option>
                {ASSET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ASSET_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <select
                value={rights}
                onChange={(e) => setRights(e.target.value as RightsStatus | '')}
                className={inputCls}
              >
                <option value="">Mọi quyền</option>
                {RIGHTS_STATUSES.map((r) => (
                  <option key={r} value={r}>
                    {RIGHTS_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            {assets.length === 0 ? (
              <p className="text-sm text-muted">Chưa có nội dung nào.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-1">Tên</th>
                      <th>Loại</th>
                      <th>Quyền</th>
                      <th>Dùng trong</th>
                      <th>Thêm lúc</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr
                        key={a.id}
                        onClick={() => setSelected(a.id === selected?.id ? null : a)}
                        className={`cursor-pointer border-t border-line align-top ${a.id === selected?.id ? 'bg-bg' : ''}`}
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium">{a.title}</div>
                          <div className="text-xs text-muted">
                            {a.file
                              ? `${a.file.name} · ${size(a.file.sizeBytes)}`
                              : ASSET_SOURCE_LABEL[a.source]}
                            {a.tags.length > 0 && ` · ${a.tags.map((t) => `#${t}`).join(' ')}`}
                          </div>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {ASSET_KIND_LABEL[a.kind]}
                          {a.verifiedAt && (
                            <div className="text-xs text-green-500">Đã xác minh</div>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <Rights a={a} />
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {a.usedBy > 0 ? `${a.usedBy} thành phẩm` : '–'}
                        </td>
                        <td className="whitespace-nowrap py-2 text-muted">
                          {new Date(a.createdAt).toLocaleDateString('vi-VN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {selected && (
            <Panel title={`Chi tiết: ${selected.title}`}>
              <Preview a={selected} />
              <div className="mb-3 flex flex-wrap gap-2">
                {selected.file && (
                  <button className={btnGhostCls} onClick={() => download(selected)}>
                    Tải về
                  </button>
                )}
                {!selected.file && !selected.verifiedAt && (
                  <button className={btnGhostCls} onClick={() => act('verify')}>
                    Xác minh thông tin
                  </button>
                )}
                <Link className={btnGhostCls} href={`/content/items?from=${selected.id}`}>
                  Tạo thành phẩm từ nội dung này
                </Link>
                {selected.archivedAt ? (
                  <button className={btnGhostCls} onClick={() => act('restore')}>
                    Khôi phục
                  </button>
                ) : (
                  <button
                    className={`${btnGhostCls} border-danger text-danger`}
                    onClick={() => act('archive')}
                  >
                    Lưu trữ
                  </button>
                )}
              </div>
              <dl className="mb-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {[
                  ['Loại', ASSET_KIND_LABEL[selected.kind]],
                  [
                    'Nguồn',
                    `${ASSET_SOURCE_LABEL[selected.source]}${selected.sourceRef ? `: ${selected.sourceRef}` : ''}`,
                  ],
                  [
                    'Thêm bởi',
                    `${selected.createdByName}, ${new Date(selected.createdAt).toLocaleString('vi-VN')}`,
                  ],
                  [
                    'Xác minh',
                    selected.verifiedAt
                      ? `${selected.verifiedByName}, ${new Date(selected.verifiedAt).toLocaleString('vi-VN')}`
                      : null,
                  ],
                  ['SHA-256', selected.file?.sha256.slice(0, 16)],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-muted">{k}:</dt>
                      <dd className="break-all">{v}</dd>
                    </div>
                  ))}
              </dl>
              {selected.product && (
                <div className="mb-3 rounded-md border border-line bg-bg p-3 text-sm">
                  <div className="font-medium">{selected.product.name}</div>
                  <div className="text-xs text-muted">
                    {[
                      selected.product.sku,
                      selected.product.price !== undefined
                        ? `${selected.product.price.toLocaleString('vi-VN')} ${selected.product.currency ?? ''}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <ul className="mt-2 list-disc pl-5">
                    {selected.product.specs.map((s, i) => (
                      <li key={i}>
                        {s.key}: {s.value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.body && (
                <pre className="mb-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2 text-sm">
                  {selected.body}
                </pre>
              )}
              <form
                key={selected.id + selected.updatedAt}
                onSubmit={save}
                className="grid gap-3"
                autoComplete="off"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    Tiêu đề
                    <input
                      name="title"
                      defaultValue={selected.title}
                      required
                      maxLength={200}
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                  <label className="text-sm">
                    Thư mục
                    <select
                      name="folderId"
                      defaultValue={selected.folderId ?? ''}
                      className={`${inputCls} mt-1`}
                    >
                      <option value="">Không có</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="text-sm">
                  Mô tả
                  <textarea
                    name="description"
                    defaultValue={selected.description ?? ''}
                    rows={2}
                    maxLength={5000}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <label className="text-sm">
                  Tag
                  <input
                    name="tags"
                    defaultValue={selected.tags.join(', ')}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm">
                    Quyền sử dụng
                    <select
                      name="rightsStatus"
                      defaultValue={selected.rightsStatus}
                      className={`${inputCls} mt-1`}
                    >
                      {RIGHTS_STATUSES.map((r) => (
                        <option key={r} value={r}>
                          {RIGHTS_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Chủ sở hữu
                    <input
                      name="rightsHolder"
                      defaultValue={selected.rightsHolder ?? ''}
                      maxLength={200}
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                  <label className="text-sm">
                    Hết hạn quyền
                    <input
                      name="rightsExpiresAt"
                      type="date"
                      defaultValue={
                        selected.rightsExpiresAt ? selected.rightsExpiresAt.slice(0, 10) : ''
                      }
                      className={`${inputCls} mt-1`}
                    />
                  </label>
                </div>
                <label className="text-sm">
                  Ghi chú về quyền (giấy phép, thỏa thuận…)
                  <textarea
                    name="rightsNote"
                    defaultValue={selected.rightsNote ?? ''}
                    rows={2}
                    maxLength={2000}
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <div>
                  <button className={btnCls}>Lưu thay đổi</button>
                </div>
              </form>
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}
