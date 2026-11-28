'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  TIKTOK_MODE_LABEL,
  TIKTOK_POST_STATUS_LABEL,
  TIKTOK_PRIVACY,
  TIKTOK_PRIVACY_LABEL,
  TIKTOK_RULES,
  type ItemDetailResponse,
  type TiktokCreatorResponse,
  type TiktokMode,
  type TiktokPostResponse,
  type TiktokPrivacy,
  type TiktokStatusResponse,
} from '@maris/contracts';
import { btnCls, inputCls, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { postTime } from './MetaPublish';

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * "Đăng lên TikTok" for an approved video (spec Part 17), laid out by TikTok's Content Sharing
 * Guidelines: the creator's name, who may see it chosen from the creator's own options with no
 * default, interactions off unless chosen (and locked when the creator turned them off), the
 * commercial content disclosure, and the Music Usage Confirmation next to the post button.
 */
export function TiktokPublish({ detail }: { detail: ItemDetailResponse }) {
  const [t, setT] = useState<TiktokStatusResponse | null>(null);
  const [posts, setPosts] = useState<TiktokPostResponse[]>([]);
  const [hidden, setHidden] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [creators, setCreators] = useState<Record<string, TiktokCreatorResponse>>({});
  const [mode, setMode] = useState<TiktokMode>('direct');
  const [title, setTitle] = useState('');
  const [privacy, setPrivacy] = useState<TiktokPrivacy | ''>('');
  const [comment, setComment] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [aigc, setAigc] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(toLocalInput(new Date(Date.now() + 3600_000)));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = detail.versions.find((v) => v.version === detail.currentVersion);
  const isVideo = current?.file?.mime.startsWith('video/') ?? false;
  const durationSec = current?.media?.durationSec ?? null;
  const loadPosts = useCallback(() => {
    api<TiktokPostResponse[]>(`/tiktok/posts?itemId=${detail.id}`)
      .then(setPosts)
      .catch(() => {});
  }, [detail.id]);
  useEffect(() => {
    if (!isVideo) return;
    api<TiktokStatusResponse>('/tiktok')
      .then(setT)
      // No tiktok.read: the panel is not for this person.
      .catch(() => setHidden(true));
    loadPosts();
  }, [isVideo, loadPosts]);
  const waiting = posts.some((p) => ['scheduled', 'uploading', 'processing'].includes(p.status));
  useEffect(() => {
    if (!waiting) return;
    const x = setInterval(loadPosts, 10_000);
    return () => clearInterval(x);
  }, [waiting, loadPosts]);

  // TikTok's guidelines: read what each chosen creator may post when the form shows it.
  useEffect(() => {
    if (mode !== 'direct') return;
    for (const id of chosen)
      if (!creators[id])
        api<TiktokCreatorResponse>(`/tiktok/accounts/${id}/creator`, { method: 'POST' })
          .then((c) => setCreators((x) => ({ ...x, [id]: c })))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định'));
  }, [chosen, mode, creators]);

  if (!isVideo || hidden || !t) return null;
  const accounts = t.accounts.filter((a) => a.enabled && a.status === 'active');
  const audited = t.app?.audited ?? false;
  const picked = chosen.map((id) => creators[id]).filter(Boolean) as TiktokCreatorResponse[];
  // Only the choices every chosen creator has; branded content cannot be "only me".
  let options: TiktokPrivacy[] = TIKTOK_PRIVACY.filter((p) =>
    picked.every((c) => c.privacyOptions.includes(p)),
  );
  if (!audited) options = options.filter((p) => p === 'SELF_ONLY');
  if (commercial && branded) options = options.filter((p) => p !== 'SELF_ONLY');
  const off = {
    comment: picked.some((c) => c.commentDisabled),
    duet: picked.some((c) => c.duetDisabled),
    stitch: picked.some((c) => c.stitchDisabled),
  };
  const tooLong = picked.find(
    (c) => c.maxDurationSec !== null && durationSec !== null && durationSec > c.maxDurationSec,
  );
  const commercialOk = !commercial || yourBrand || branded;
  const ready =
    chosen.length > 0 &&
    commercialOk &&
    !(mode === 'direct' && (!privacy || !options.includes(privacy) || tooLong || picked.length < chosen.length));

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const made = await api<TiktokPostResponse[]>('/tiktok/posts', {
        method: 'POST',
        body: JSON.stringify({
          itemId: detail.id,
          accountIds: chosen,
          mode,
          title: title.trim(),
          privacy: mode === 'direct' ? privacy : null,
          allowComment: comment && !off.comment,
          allowDuet: duet && !off.duet,
          allowStitch: stitch && !off.stitch,
          brandOrganic: commercial && yourBrand,
          brandedContent: commercial && branded,
          aigc,
          at: when === 'later' ? new Date(at).toISOString() : null,
          consent: true,
        }),
      });
      setOk(
        when === 'later'
          ? `Đã hẹn ${made.length} bài lúc ${postTime(made[0]!.scheduledAt)}. Máy chạy MARIS cần bật lúc đó.`
          : `Đã đưa ${made.length} bài vào hàng đợi; MARIS bắt đầu gửi trong khoảng 30 giây. TikTok có thể mất vài phút để xử lý video.`,
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
    <section className="mb-4 rounded-md border border-line p-3" aria-label="Đăng lên TikTok">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Đăng lên TikTok</h3>
        <Link href="/tiktok" className="text-sm text-accent underline">
          Trung tâm TikTok
        </Link>
      </div>
      {accounts.length === 0 ? (
        <p className="text-sm text-muted">
          Chưa có tài khoản TikTok nào đang bật.{' '}
          <Link href="/tiktok" className="text-accent underline">
            Kết nối trong Trung tâm TikTok
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-2 text-sm">
          <fieldset>
            <legend className="mb-1 text-muted">Tài khoản</legend>
            <div className="flex flex-wrap gap-3">
              {accounts.map((a) => (
                <label key={a.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={chosen.includes(a.id)}
                    onChange={(e) =>
                      setChosen((x) =>
                        e.target.checked ? [...x, a.id] : x.filter((y) => y !== a.id),
                      )
                    }
                  />
                  {creators[a.id]?.nickname ?? a.displayName}
                  {a.username ? <span className="text-muted">@{a.username}</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <span className="text-muted">Cách đăng:</span>
            {(['direct', 'draft'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" checked={mode === k} onChange={() => setMode(k)} />
                {TIKTOK_MODE_LABEL[k]}
                {k === 'draft' ? ' (viết chú thích và đăng trong app TikTok)' : ''}
              </label>
            ))}
          </div>
          {mode === 'direct' && !audited && (
            <Notice kind="info">
              Ứng dụng TikTok chưa được duyệt nên chỉ đăng thẳng được ở chế độ Chỉ mình tôi. Muốn
              công khai ngay, chọn “Gửi vào hộp nháp” rồi đăng trong app TikTok.
            </Notice>
          )}
          {tooLong && (
            <Notice kind="error">
              Video dài {durationSec} giây; tài khoản {tooLong.nickname ?? ''} chỉ được đăng tối đa{' '}
              {tooLong.maxDurationSec} giây qua API.
            </Notice>
          )}
          {mode === 'direct' && (
            <>
              <label>
                <span className="text-muted">
                  Chú thích ({title.length}/{TIKTOK_RULES.titleMaxChars}), có thể kèm #hashtag và
                  @nhắc tên
                </span>
                <textarea
                  className={inputCls}
                  rows={3}
                  value={title}
                  maxLength={TIKTOK_RULES.titleMaxChars}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                <span className="text-muted">Ai được xem video này</span>
                <select
                  className={inputCls}
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value as TiktokPrivacy | '')}
                >
                  <option value="">Chọn ai được xem</option>
                  {options.map((p) => (
                    <option key={p} value={p}>
                      {TIKTOK_PRIVACY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="flex flex-wrap gap-3">
                <legend className="mb-1 text-muted">Cho phép người xem</legend>
                {(
                  [
                    ['Bình luận', comment, setComment, off.comment],
                    ['Duet', duet, setDuet, off.duet],
                    ['Stitch', stitch, setStitch, off.stitch],
                  ] as const
                ).map(([label, v, set, disabled]) => (
                  <label key={label} className={`flex items-center gap-1.5 ${disabled ? 'text-muted' : ''}`}>
                    <input
                      type="checkbox"
                      checked={v && !disabled}
                      disabled={disabled}
                      onChange={(e) => set(e.target.checked)}
                    />
                    {label}
                    {disabled ? ' (tài khoản đã tắt trong TikTok)' : ''}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <fieldset className="rounded border border-line p-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={commercial}
                onChange={(e) => setCommercial(e.target.checked)}
              />
              Đây là nội dung thương mại (quảng bá thương hiệu, sản phẩm hoặc dịch vụ)
            </label>
            {commercial && (
              <div className="mt-2 grid gap-1 pl-5">
                <label className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={yourBrand}
                    onChange={(e) => setYourBrand(e.target.checked)}
                  />
                  <span>
                    Thương hiệu của bạn: quảng bá cho chính bạn hoặc doanh nghiệp của bạn. Video
                    được gắn nhãn “Nội dung quảng cáo”.
                  </span>
                </label>
                <label className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={branded}
                    onChange={(e) => setBranded(e.target.checked)}
                  />
                  <span>
                    Nội dung có thương hiệu: hợp tác có trả phí với thương hiệu khác. Video được gắn
                    nhãn “Hợp tác trả phí” và không để Chỉ mình tôi được.
                  </span>
                </label>
                {!commercialOk && (
                  <span className="text-xs text-danger">Chọn ít nhất một loại ở trên.</span>
                )}
              </div>
            )}
          </fieldset>
          <label className="flex items-start gap-1.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={aigc}
              onChange={(e) => setAigc(e.target.checked)}
            />
            <span>Video do AI tạo hoặc chỉnh sửa nhiều (TikTok gắn nhãn nội dung AI)</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} />
              Đăng ngay
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} />
              Hẹn giờ
            </label>
            {when === 'later' && (
              <input
                type="datetime-local"
                className={`${inputCls} w-auto`}
                value={at}
                onChange={(e) => setAt(e.target.value)}
                aria-label="Thời điểm đăng"
              />
            )}
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">
              Khi bấm đăng, bạn đồng ý với{' '}
              <a
                href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Xác nhận sử dụng âm nhạc
              </a>
              {commercial && branded ? (
                <>
                  {' '}
                  và{' '}
                  <a
                    href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Chính sách nội dung có thương hiệu
                  </a>
                </>
              ) : null}{' '}
              của TikTok.
            </p>
            <button disabled={busy || !ready} className={btnCls} onClick={() => void submit()}>
              {mode === 'draft' ? 'Gửi vào hộp nháp TikTok' : when === 'now' ? 'Đăng lên TikTok' : 'Hẹn giờ đăng'}
            </button>
            {when === 'later' && (
              <p className="mt-1 text-xs text-muted">
                TikTok không có hẹn giờ qua API: MARIS giữ bài và gửi đúng giờ, máy chạy MARIS cần
                bật lúc đó.
              </p>
            )}
          </div>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {posts.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {posts.map((p) => (
            <li key={p.id} className="flex flex-wrap gap-x-2">
              <span>{p.accountName}</span>
              <span className="text-muted">
                {TIKTOK_MODE_LABEL[p.mode]} · bản {p.version} · {postTime(p.scheduledAt)}
              </span>
              <span className={p.status === 'failed' ? 'text-danger' : ''}>
                {TIKTOK_POST_STATUS_LABEL[p.status]}
                {p.uploadedPct !== null ? ` ${p.uploadedPct}%` : ''}
              </span>
              {p.url && (
                <a href={p.url} target="_blank" rel="noreferrer" className="text-accent underline">
                  Xem trên TikTok
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
