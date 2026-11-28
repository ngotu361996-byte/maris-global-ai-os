'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  META_POST_FORMAT_LABEL,
  META_POST_SLOTS,
  META_POST_STATUS_LABEL,
  type ItemDetailResponse,
  type MetaAssetResponse,
  type MetaPostResponse,
  type MetaStatusResponse,
} from '@maris/contracts';
import { btnCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';

/** yyyy-MM-ddTHH:mm in the browser's time, for a datetime-local input. */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The next time this slot (HH:mm) comes round. */
const nextSlot = (slot: string) => {
  const [h, m] = slot.split(':').map(Number);
  const d = new Date();
  d.setHours(h!, m!, 0, 0);
  if (d.getTime() < Date.now() + 5 * 60_000) d.setDate(d.getDate() + 1);
  return d;
};

export const postTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/**
 * "Đăng lên Meta" for an approved item (spec Part 14): choose Pages and Instagram accounts that
 * are on in the Meta Control Center, a time, and a caption. The publisher posts it at that time.
 */
export function MetaPublish({ detail }: { detail: ItemDetailResponse }) {
  const [assets, setAssets] = useState<MetaAssetResponse[] | null>(null);
  const [posts, setPosts] = useState<MetaPostResponse[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [videoAs, setVideoAs] = useState<'reel' | 'video'>('reel');
  const [caption, setCaption] = useState('');
  const [link, setLink] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(toLocalInput(nextSlot(META_POST_SLOTS[0])));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const current = detail.versions.find((v) => v.version === detail.currentVersion);
  const media = current?.file?.mime.split('/')[0] ?? null;
  const isText = !current?.file;

  const loadPosts = useCallback(() => {
    api<MetaPostResponse[]>(`/meta/posts?itemId=${detail.id}`)
      .then(setPosts)
      .catch(() => {});
  }, [detail.id]);
  useEffect(() => {
    api<MetaStatusResponse>('/meta')
      .then((s) => setAssets(s.connection?.status === 'active' ? s.assets : []))
      // No meta.read: the panel is not for this person.
      .catch(() => setHidden(true));
    loadPosts();
  }, [loadPosts]);
  // While a post waits or is being posted, look again so its status changes without a reload.
  const waiting = posts.some((p) => ['scheduled', 'publishing', 'processing'].includes(p.status));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(loadPosts, 10_000);
    return () => clearInterval(t);
  }, [waiting, loadPosts]);

  if (hidden || assets === null) return null;
  const usable = assets.filter(
    (a) =>
      a.enabled &&
      !a.removed &&
      (a.kind === 'page' || (a.kind === 'instagram' && (media === 'image' || media === 'video'))),
  );

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const made = await api<MetaPostResponse[]>('/meta/posts', {
        method: 'POST',
        body: JSON.stringify({
          itemId: detail.id,
          assetIds: chosen,
          videoAs,
          caption: isText ? null : caption.trim() || null,
          link: isText && link.trim() ? link.trim() : null,
          at: when === 'now' ? null : new Date(at).toISOString(),
        }),
      });
      setOk(
        when === 'now'
          ? `Đã đưa ${made.length} bài vào hàng đợi; MARIS đăng trong khoảng 30 giây.`
          : `Đã lên lịch ${made.length} bài lúc ${postTime(made[0]!.scheduledAt)}.`,
      );
      setChosen([]);
      loadPosts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-md border border-line p-3" aria-label="Đăng lên Meta">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Đăng lên Facebook và Instagram</h3>
        <Link href="/meta/posts" className="text-sm text-accent underline">
          Xem lịch đăng
        </Link>
      </div>
      {usable.length === 0 ? (
        <p className="text-sm text-muted">
          Chưa có Page hoặc tài khoản Instagram nào đang bật.{' '}
          <Link href="/meta" className="text-accent underline">
            Kết nối trong Trung tâm Meta
          </Link>
          .
        </p>
      ) : (
        <>
          <fieldset className="mb-2">
            <legend className="mb-1 text-sm text-muted">Đăng lên</legend>
            <div className="flex flex-wrap gap-3">
              {usable.map((a) => (
                <label key={a.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.includes(a.id)}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id),
                      )
                    }
                  />
                  {a.kind === 'instagram' ? `Instagram @${a.username ?? a.name}` : `Page ${a.name}`}
                </label>
              ))}
            </div>
          </fieldset>
          {media === 'video' && (
            <div className="mb-2 flex flex-wrap gap-3 text-sm">
              <span className="text-muted">Video trên Page đăng thành:</span>
              {(['reel', 'video'] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="radio" checked={videoAs === k} onChange={() => setVideoAs(k)} />
                  {k === 'reel' ? 'Reels (3–90 giây)' : 'Video thường'}
                </label>
              ))}
            </div>
          )}
          {isText ? (
            <label className="mb-2 block text-sm">
              <span className="text-muted">Đường dẫn kèm bài (không bắt buộc)</span>
              <input
                className={inputCls}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://"
              />
            </label>
          ) : (
            <label className="mb-2 block text-sm">
              <span className="text-muted">Chú thích</span>
              <textarea
                className={inputCls}
                rows={3}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Nội dung đi kèm ảnh hoặc video; Instagram tối đa 2.200 ký tự và 30 hashtag"
              />
            </label>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} />
              Đăng ngay
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} />
              Hẹn giờ
            </label>
            {when === 'later' && (
              <>
                <input
                  type="datetime-local"
                  className={`${inputCls} w-auto`}
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  aria-label="Thời điểm đăng"
                />
                <span className="text-muted">Khung gợi ý:</span>
                {META_POST_SLOTS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="rounded border border-line px-2 py-0.5"
                    onClick={() => setAt(toLocalInput(nextSlot(s)))}
                  >
                    {s}
                  </button>
                ))}
              </>
            )}
          </div>
          <button
            disabled={busy || chosen.length === 0}
            className={btnCls}
            onClick={() => void submit()}
          >
            {when === 'now' ? 'Đăng ngay' : 'Lên lịch đăng'}
          </button>
          <p className="mt-1 text-xs text-muted">
            Tối đa 3 bài mỗi ngày cho mỗi Page hoặc tài khoản, 60 bài mỗi ngày cho cả công ty.
          </p>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {posts.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {posts.map((p) => (
            <li key={p.id} className="flex flex-wrap gap-x-2">
              <span>{p.assetName}</span>
              <span className="text-muted">
                {META_POST_FORMAT_LABEL[p.format]} · bản {p.version} · {postTime(p.scheduledAt)}
              </span>
              <span className={p.status === 'failed' ? 'text-danger' : ''}>
                {META_POST_STATUS_LABEL[p.status]}
              </span>
              {p.permalink && (
                <a
                  href={p.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  Xem bài
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
