'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  IMAGE_FIT_LABEL,
  IMAGE_FITS,
  IMAGE_PRESET_INFO,
  ITEM_STATUS_LABEL,
  LOGO_POSITION_LABEL,
  LOGO_POSITIONS,
  MEDIA_LIMITS,
  VIDEO_PRESETS,
  VIDEO_QUALITIES,
  VIDEO_QUALITY_LABEL,
  VOICE_MIX_LABEL,
  VOICE_MIXES,
  type AssetResponse,
  type FolderResponse,
  type ItemResponse,
  type MediaJobResponse,
  type MediaJobsResponse,
  type VideoPreset,
} from '@maris/contracts';
import { btnCls, inputCls } from '@/components/ui';
import { api } from '@/lib/api';
import { MediaJobList } from './MediaJobList';

/** "1:05", "65" or "1:02:03" in seconds; empty is null; anything else is NaN. */
export function parseClock(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Video processing for one source video (spec Part 12): keep a part of it, make it in the chosen
 * aspect ratios, clean it up, add the logo and a voice-over, and take a cover picture. A Media
 * Worker with FFmpeg makes one new video item (draft) per ratio.
 */
export function VideoProcessor({
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
  const [voices, setVoices] = useState<ItemResponse[]>([]);
  const [presets, setPresets] = useState<VideoPreset[]>(['story']);
  const [logoId, setLogoId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [cover, setCover] = useState(true);
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
    api<ItemResponse[]>('/content/items?kind=audio&limit=200')
      .then(setVoices)
      .catch(() => {});
  }, [load]);

  const active = data?.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const tooBig = (asset.file?.sizeBytes ?? 0) > MEDIA_LIMITS.videoMaxMb * 1024 * 1024;
  const blocked =
    asset.rightsStatus === 'restricted'
      ? 'Video này được đánh dấu “Không được dùng” nên không xử lý được.'
      : tooBig
        ? `Video lớn hơn ${MEDIA_LIMITS.videoMaxMb} MB.`
        : asset.archivedAt
          ? 'Video đã được lưu trữ.'
          : null;
  const usableLogos = logos.filter(
    (l) => l.kind === 'image' && l.file && !l.archivedAt && l.rightsStatus !== 'restricted',
  );
  const usableVoices = voices.filter(
    (v) => v.currentVersion > 0 && v.status !== 'rejected' && v.status !== 'archived',
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const start = parseClock(String(f.get('start') ?? ''));
    const end = parseClock(String(f.get('end') ?? ''));
    const at = parseClock(String(f.get('coverAt') ?? ''));
    if ([start, end, at].some((n) => Number.isNaN(n)))
      return onError(new Error('Thời điểm ghi dạng giây (65) hoặc phút:giây (1:05)'));
    setBusy(true);
    try {
      await api<MediaJobResponse>(`/content/assets/${asset.id}/process-video`, {
        method: 'POST',
        body: JSON.stringify({
          presets,
          fit: f.get('fit'),
          background: f.get('background'),
          startSec: start ?? 0,
          endSec: end,
          logoAssetId: logoId || null,
          logo: {
            position: f.get('position') ?? 'bottom-right',
            sizePct: Number(f.get('sizePct') ?? 15),
            opacity: Number(f.get('opacity') ?? 100) / 100,
            marginPct: Number(f.get('marginPct') ?? 3),
          },
          voiceItemId: voiceId || null,
          voiceMix: f.get('voiceMix') ?? 'mix',
          originalVolume: Number(f.get('originalVolume') ?? 25) / 100,
          denoise: f.get('denoise') === 'on',
          sharpen: f.get('sharpen') === 'on',
          quality: f.get('quality'),
          coverAtSec: cover ? (at ?? 1) : null,
          folderId: String(f.get('folderId') ?? '') || null,
          targetDeviceId: String(f.get('device') ?? '') || null,
        }),
      });
      await load();
      onDone(
        'Đã giao việc cho Media Worker. Mỗi tỉ lệ khung hình sẽ thành một video (bản nháp) để bạn xem và duyệt. Video dài có thể mất vài phút.',
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
  const voice = usableVoices.find((v) => v.id === voiceId);
  return (
    <section className="mb-4 rounded-md border border-line p-3">
      <h3 className="mb-2 font-semibold">Xử lý video</h3>
      {blocked ? (
        <p className="text-sm text-muted">{blocked}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-3 text-sm">
          {data && online.length === 0 && (
            <p className="rounded border border-yellow-600 p-2 text-xs text-yellow-500">
              Chưa có Worker nào đang bật nhận việc xử lý video. Việc sẽ chờ tới khi có: cài FFmpeg
              trên một máy (winget install --id Gyan.FFmpeg -e), cập nhật MARIS Worker bản 0.19 trở
              lên rồi chạy lại nó.
            </p>
          )}
          <fieldset>
            <legend className="mb-1">Tỉ lệ khung hình cần làm</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {VIDEO_PRESETS.map((p) => (
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
                    <span className="block text-xs text-muted">
                      {p === 'original' ? 'Giữ khung hình gốc' : IMAGE_PRESET_INFO[p].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              Cắt từ (giây hoặc phút:giây)
              <input name="start" placeholder="0:00" className={inputCls} />
            </label>
            <label>
              Đến (để trống là tới hết)
              <input name="end" placeholder="hết video" className={inputCls} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              Cách đưa vào khung
              <select name="fit" className={inputCls} defaultValue="cover">
                {IMAGE_FITS.map((f) => (
                  <option key={f} value={f}>
                    {IMAGE_FIT_LABEL[f].replace('ảnh', 'hình')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Màu nền
              <input
                name="background"
                type="color"
                defaultValue="#000000"
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
                Rộng (% khung)
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
          <label>
            Giọng đọc lồng vào
            <select
              className={inputCls}
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              <option value="">Không lồng giọng đọc</option>
              {usableVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} ({ITEM_STATUS_LABEL[v.status]})
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">
              Tạo giọng đọc AI từ một kịch bản ở Kho thành phẩm (nút “Giọng đọc AI”), rồi chọn ở
              đây.
            </span>
          </label>
          {voice && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                Tiếng gốc của video
                <select name="voiceMix" className={inputCls} defaultValue="mix">
                  {VOICE_MIXES.map((m) => (
                    <option key={m} value={m}>
                      {VOICE_MIX_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Âm lượng tiếng gốc khi trộn (%)
                <input
                  name="originalVolume"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={25}
                  className={inputCls}
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="denoise" /> Giảm nhiễu
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="sharpen" /> Tăng độ nét
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} />{' '}
              Làm ảnh bìa (thumbnail)
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {cover && (
              <label>
                Ảnh bìa lấy ở giây
                <input name="coverAt" placeholder="0:01" className={inputCls} />
              </label>
            )}
            <label>
              Chất lượng
              <select name="quality" className={inputCls} defaultValue="standard">
                {VIDEO_QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {VIDEO_QUALITY_LABEL[q]}
                  </option>
                ))}
              </select>
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
              {busy ? 'Đang giao việc…' : `Xử lý ${presets.length} video`}
            </button>
          </div>
        </form>
      )}
      {data && <MediaJobList jobs={data.jobs} onCancel={cancel} />}
    </section>
  );
}
