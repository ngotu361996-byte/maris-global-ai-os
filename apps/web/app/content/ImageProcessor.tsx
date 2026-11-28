'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  IMAGE_FIT_LABEL,
  IMAGE_FITS,
  IMAGE_FORMATS,
  IMAGE_PRESET_INFO,
  IMAGE_PRESETS,
  LOGO_POSITION_LABEL,
  LOGO_POSITIONS,
  MEDIA_LIMITS,
  type AssetResponse,
  type FolderResponse,
  type ImagePreset,
  type MediaJobResponse,
  type MediaJobsResponse,
} from '@maris/contracts';
import { btnCls, inputCls } from '@/components/ui';
import { api } from '@/lib/api';
import { MediaJobList } from './MediaJobList';

/**
 * Image processing for one source image (spec Part 13): choose the sizes, how to fit them, a logo
 * and simple corrections. A Media Worker makes one new image item (draft) per size.
 */
export function ImageProcessor({
  asset,
  onDone,
  onError,
}: {
  asset: AssetResponse;
  onDone: (msg: string) => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<MediaJobsResponse | null>(null);
  const [folders, setFolders] = useState<FolderResponse[]>([]);
  const [logos, setLogos] = useState<AssetResponse[]>([]);
  const [presets, setPresets] = useState<ImagePreset[]>(['feed_square']);
  const [logoId, setLogoId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<MediaJobsResponse>(`/content/assets/${asset.id}/media-jobs`)
        .then(setData)
        .catch(() => {}),
    [asset.id],
  );
  useEffect(() => {
    void load();
    api<FolderResponse[]>('/content/folders?library=output')
      .then(setFolders)
      .catch(() => {});
    api<AssetResponse[]>('/content/assets?kind=image&limit=200')
      .then(setLogos)
      .catch(() => {});
  }, [load]);

  const active = data?.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  // While a job waits or runs, refresh every 2 seconds.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const tooBig = (asset.file?.sizeBytes ?? 0) > MEDIA_LIMITS.imageMaxMb * 1024 * 1024;
  const blocked =
    asset.rightsStatus === 'restricted'
      ? 'Ảnh này được đánh dấu “Không được dùng” nên không xử lý được.'
      : tooBig
        ? `Ảnh lớn hơn ${MEDIA_LIMITS.imageMaxMb} MB.`
        : asset.archivedAt
          ? 'Ảnh đã được lưu trữ.'
          : null;
  const usableLogos = logos.filter(
    (l) =>
      l.id !== asset.id &&
      l.kind === 'image' &&
      l.file &&
      !l.archivedAt &&
      l.rightsStatus !== 'restricted',
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api<MediaJobResponse>(`/content/assets/${asset.id}/process-image`, {
        method: 'POST',
        body: JSON.stringify({
          presets,
          fit: f.get('fit'),
          background: f.get('background'),
          logoAssetId: logoId || null,
          logo: {
            position: f.get('position') ?? 'bottom-right',
            sizePct: Number(f.get('sizePct') ?? 15),
            opacity: Number(f.get('opacity') ?? 100) / 100,
            marginPct: Number(f.get('marginPct') ?? 3),
          },
          autoLevel: f.get('autoLevel') === 'on',
          sharpen: f.get('sharpen') === 'on',
          format: f.get('format'),
          quality: Number(f.get('quality')),
          folderId: String(f.get('folderId') ?? '') || null,
          targetDeviceId: String(f.get('device') ?? '') || null,
        }),
      });
      await load();
      onDone(
        'Đã giao việc cho Media Worker. Mỗi cỡ ảnh sẽ thành một thành phẩm (bản nháp) để bạn xem và duyệt.',
      );
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/content/media-jobs/${id}/cancel`, { method: 'POST', body: '{}' });
      await load();
    } catch (err) {
      onError(err);
    }
  }

  const online = data?.workers.filter((w) => w.online) ?? [];
  return (
    <section className="mb-4 rounded-md border border-line p-3">
      <h3 className="mb-2 font-semibold">Xử lý ảnh</h3>
      {blocked ? (
        <p className="text-sm text-muted">{blocked}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-3 text-sm">
          {data && online.length === 0 && (
            <p className="rounded border border-yellow-600 p-2 text-xs text-yellow-500">
              Chưa có Worker nào đang bật nhận việc xử lý ảnh. Việc sẽ chờ tới khi có: cập nhật
              MARIS Worker bản 0.18 trở lên trên một máy rồi chạy lại nó.
            </p>
          )}
          <fieldset>
            <legend className="mb-1">Cỡ ảnh cần làm</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {IMAGE_PRESETS.map((p) => (
                <label key={p} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={presets.includes(p)}
                    onChange={(e) =>
                      setPresets((cur) =>
                        e.target.checked ? [...cur, p] : cur.filter((x) => x !== p),
                      )
                    }
                  />
                  <span>
                    {IMAGE_PRESET_INFO[p].label}
                    {IMAGE_PRESET_INFO[p].width
                      ? ` (${IMAGE_PRESET_INFO[p].width}×${IMAGE_PRESET_INFO[p].height})`
                      : ''}
                    <span className="block text-xs text-muted">{IMAGE_PRESET_INFO[p].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              Cách đưa vào khung
              <select name="fit" className={inputCls} defaultValue="cover">
                {IMAGE_FITS.map((f) => (
                  <option key={f} value={f}>
                    {IMAGE_FIT_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Màu nền
              <input
                name="background"
                type="color"
                defaultValue="#ffffff"
                className={`${inputCls} h-9 p-1`}
              />
            </label>
          </div>
          <label>
            Logo thương hiệu
            <select className={inputCls} value={logoId} onChange={(e) => setLogoId(e.target.value)}>
              <option value="">Không gắn logo</option>
              {usableLogos.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">
              Tải logo lên kho nội dung gốc (PNG nền trong suốt là đẹp nhất) để chọn ở đây.
            </span>
          </label>
          {logoId && (
            <div className="grid gap-3 sm:grid-cols-4">
              <label>
                Vị trí
                <select name="position" className={inputCls} defaultValue="bottom-right">
                  {LOGO_POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {LOGO_POSITION_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rộng (% ảnh)
                <input
                  name="sizePct"
                  type="number"
                  min={5}
                  max={40}
                  defaultValue={15}
                  className={inputCls}
                />
              </label>
              <label>
                Độ đậm (%)
                <input
                  name="opacity"
                  type="number"
                  min={10}
                  max={100}
                  defaultValue={100}
                  className={inputCls}
                />
              </label>
              <label>
                Cách mép (%)
                <input
                  name="marginPct"
                  type="number"
                  min={0}
                  max={10}
                  defaultValue={3}
                  className={inputCls}
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="autoLevel" /> Cân chỉnh ánh sáng tự động
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="sharpen" /> Tăng độ nét
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>
              Định dạng
              <select name="format" className={inputCls} defaultValue="jpeg">
                {IMAGE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Chất lượng
              <input
                name="quality"
                type="number"
                min={50}
                max={100}
                defaultValue={85}
                className={inputCls}
              />
            </label>
            <label>
              Lưu vào thư mục
              <select name="folderId" className={inputCls} defaultValue="">
                <option value="">(Không có thư mục)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Máy xử lý
              <select name="device" className={inputCls} defaultValue="">
                <option value="">Máy nào rảnh</option>
                {data?.workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.online ? '' : ' (đang tắt)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <button className={btnCls} disabled={busy || presets.length === 0}>
              {busy ? 'Đang giao việc…' : `Xử lý ${presets.length} cỡ ảnh`}
            </button>
          </div>
        </form>
      )}

      {data && <MediaJobList jobs={data.jobs} onCancel={cancel} />}
    </section>
  );
}
