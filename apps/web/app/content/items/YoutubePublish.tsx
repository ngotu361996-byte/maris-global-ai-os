'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  YOUTUBE_CATEGORIES,
  YOUTUBE_FORMAT_LABEL,
  YOUTUBE_PRIVACY,
  YOUTUBE_PRIVACY_LABEL,
  YOUTUBE_RULES,
  YOUTUBE_UPLOAD_STATUS_LABEL,
  type GoogleStatusResponse,
  type ItemDetailResponse,
  type ItemResponse,
  type YoutubeCategory,
  type YoutubeFormat,
  type YoutubePrivacy,
  type YoutubeUploadResponse,
} from '@maris/contracts';
import { btnCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { postTime } from './MetaPublish';

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * "Đăng lên YouTube" for an approved video (spec Part 17): channels on in the Google Center,
 * video or Shorts, title, description, tags, privacy, the made-for-kids and AI-content answers,
 * an optional thumbnail, and when YouTube makes it public.
 */
export function YoutubePublish({ detail }: { detail: ItemDetailResponse }) {
  const [g, setG] = useState<GoogleStatusResponse | null>(null);
  const [uploads, setUploads] = useState<YoutubeUploadResponse[]>([]);
  const [images, setImages] = useState<ItemResponse[]>([]);
  const [hidden, setHidden] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const current = detail.versions.find((v) => v.version === detail.currentVersion);
  const media = current?.media ?? null;
  const vertical = media?.width && media.height ? media.height >= media.width : false;
  const [format, setFormat] = useState<YoutubeFormat>(
    vertical && (media?.durationSec ?? 999) <= YOUTUBE_RULES.shortMaxSec ? 'short' : 'video',
  );
  const [title, setTitle] = useState(detail.title.slice(0, YOUTUBE_RULES.titleMaxChars));
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [categoryId, setCategoryId] = useState<YoutubeCategory>('22');
  const [privacy, setPrivacy] = useState<YoutubePrivacy>('public');
  const [kids, setKids] = useState<'' | 'yes' | 'no'>('');
  const [synthetic, setSynthetic] = useState(false);
  const [thumb, setThumb] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(toLocalInput(new Date(Date.now() + 86400_000)));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isVideo = current?.file?.mime.startsWith('video/') ?? false;
  const loadUploads = useCallback(() => {
    api<YoutubeUploadResponse[]>(`/google/youtube/uploads?itemId=${detail.id}`)
      .then(setUploads)
      .catch(() => {});
  }, [detail.id]);
  useEffect(() => {
    if (!isVideo) return;
    api<GoogleStatusResponse>('/google')
      .then(setG)
      // No google.read: the panel is not for this person.
      .catch(() => setHidden(true));
    api<ItemResponse[]>('/content/items?kind=image&status=approved&limit=50')
      .then(setImages)
      .catch(() => setImages([]));
    loadUploads();
  }, [isVideo, loadUploads]);
  const waiting = uploads.some((u) => ['scheduled', 'uploading', 'processing'].includes(u.status));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(loadUploads, 10_000);
    return () => clearInterval(t);
  }, [waiting, loadUploads]);

  if (!isVideo || hidden || !g) return null;
  const channels = g.channels.filter((c) => c.enabled && !c.removed);
  const audited = g.app?.youtubeAudited ?? false;

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const made = await api<YoutubeUploadResponse[]>('/google/youtube/uploads', {
        method: 'POST',
        body: JSON.stringify({
          itemId: detail.id,
          channelIds: chosen,
          format,
          title: title.trim(),
          description: description.trim(),
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          categoryId,
          privacy,
          madeForKids: kids === 'yes',
          syntheticMedia: synthetic,
          thumbnailItemId: thumb || null,
          at: when === 'later' ? new Date(at).toISOString() : null,
        }),
      });
      setOk(
        when === 'later'
          ? `Đã đưa ${made.length} video vào hàng đợi. MARIS tải lên ngay ở chế độ riêng tư; YouTube công khai lúc ${postTime(made[0]!.publishAt ?? at)}.`
          : `Đã đưa ${made.length} video vào hàng đợi; MARIS bắt đầu tải lên trong khoảng 30 giây.`,
      );
      setChosen([]);
      loadUploads();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  const bytes = new TextEncoder().encode(description).length;
  return (
    <section className="mb-4 rounded-md border border-line p-3" aria-label="Đăng lên YouTube">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Đăng lên YouTube</h3>
        <Link href="/youtube" className="text-sm text-accent underline">
          Xem video YouTube
        </Link>
      </div>
      {channels.length === 0 ? (
        <p className="text-sm text-muted">
          Chưa có kênh YouTube nào đang bật.{' '}
          <Link href="/google" className="text-accent underline">
            Kết nối trong Trung tâm Google
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-2 text-sm">
          {!audited && (
            <Notice kind="info">
              Dự án Google chưa được YouTube xét duyệt: video tải qua API luôn ở chế độ Riêng tư.
              MARIS tải lên ở chế độ Riêng tư; bạn mở công khai trong YouTube Studio.
            </Notice>
          )}
          <fieldset>
            <legend className="mb-1 text-muted">Kênh</legend>
            <div className="flex flex-wrap gap-3">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={chosen.includes(c.id)}
                    onChange={(e) =>
                      setChosen((x) =>
                        e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id),
                      )
                    }
                  />
                  {c.title}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <span className="text-muted">Đăng thành:</span>
            {(['video', 'short'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" checked={format === k} onChange={() => setFormat(k)} />
                {YOUTUBE_FORMAT_LABEL[k]}
                {k === 'short' ? ' (video dọc, tối đa 3 phút)' : ''}
              </label>
            ))}
          </div>
          <label>
            <span className="text-muted">
              Tiêu đề ({[...title].length}/{YOUTUBE_RULES.titleMaxChars})
            </span>
            <input
              className={inputCls}
              value={title}
              maxLength={YOUTUBE_RULES.titleMaxChars}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span className="text-muted">
              Mô tả ({bytes}/{YOUTUBE_RULES.descriptionMaxBytes} byte)
            </span>
            <textarea
              className={inputCls}
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Giới thiệu video, đường dẫn mua hàng, hashtag"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label>
              <span className="text-muted">Thẻ (cách nhau bằng dấu phẩy)</span>
              <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <label>
              <span className="text-muted">Danh mục</span>
              <select
                className={inputCls}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value as YoutubeCategory)}
              >
                {Object.entries(YOUTUBE_CATEGORIES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-muted">Chế độ hiển thị</span>
              <select
                className={inputCls}
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value as YoutubePrivacy)}
              >
                {YOUTUBE_PRIVACY.map((p) => (
                  <option key={p} value={p}>
                    {YOUTUBE_PRIVACY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-muted">Ảnh bìa (thành phẩm ảnh đã duyệt, không bắt buộc)</span>
              <select className={inputCls} value={thumb} onChange={(e) => setThumb(e.target.value)}>
                <option value="">Để YouTube tự chọn</option>
                {images.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-1 text-muted">
              Video này có dành cho trẻ em không? (YouTube bắt buộc trả lời)
            </legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={kids === 'no'} onChange={() => setKids('no')} />
              Không, không dành cho trẻ em
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={kids === 'yes'} onChange={() => setKids('yes')} />
              Có, dành cho trẻ em
            </label>
          </fieldset>
          <label className="flex items-start gap-1.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={synthetic}
              onChange={(e) => setSynthetic(e.target.checked)}
            />
            <span>
              Video có nội dung giống thật do AI tạo hoặc đã chỉnh sửa (YouTube yêu cầu khai báo)
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} />
              Đăng ngay
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={when === 'later'}
                disabled={!audited || privacy !== 'public'}
                onChange={() => setWhen('later')}
              />
              Hẹn giờ công khai
            </label>
            {when === 'later' && (
              <input
                type="datetime-local"
                className={`${inputCls} w-auto`}
                value={at}
                onChange={(e) => setAt(e.target.value)}
                aria-label="Thời điểm công khai"
              />
            )}
          </div>
          <div>
            <button
              disabled={busy || chosen.length === 0 || !kids || !title.trim()}
              className={btnCls}
              onClick={() => void submit()}
            >
              {when === 'now' ? 'Tải lên YouTube' : 'Tải lên và hẹn giờ'}
            </button>
            <p className="mt-1 text-xs text-muted">
              Mỗi video tốn khoảng 1.650 đơn vị hạn mức YouTube (hôm nay đã dùng{' '}
              {g.quota.used.toLocaleString('vi-VN')}/{g.quota.quota.toLocaleString('vi-VN')}). Video
              hẹn giờ được tải lên ngay và YouTube tự công khai đúng giờ, máy không cần bật.
            </p>
          </div>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {uploads.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {uploads.map((u) => (
            <li key={u.id} className="flex flex-wrap gap-x-2">
              <span>{u.channelTitle}</span>
              <span className="text-muted">
                {YOUTUBE_FORMAT_LABEL[u.format]} · bản {u.version} · {postTime(u.createdAt)}
              </span>
              <span className={u.status === 'failed' ? 'text-danger' : ''}>
                {YOUTUBE_UPLOAD_STATUS_LABEL[u.status]}
                {u.uploadedPct !== null ? ` ${u.uploadedPct}%` : ''}
              </span>
              {u.url && (
                <a href={u.url} target="_blank" rel="noreferrer" className="text-accent underline">
                  Xem trên YouTube
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
