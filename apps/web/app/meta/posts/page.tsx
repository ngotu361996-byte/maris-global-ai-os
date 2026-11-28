'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  META_POST_FORMAT_LABEL,
  META_POST_STATUS_LABEL,
  META_POST_STATUSES,
  type MetaPostResponse,
  type MetaPostStatus,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { postTime } from '../../content/items/MetaPublish';

const STATUS_CLS: Record<MetaPostStatus, string> = {
  scheduled: 'border-accent text-accent',
  publishing: 'border-accent text-accent',
  processing: 'border-yellow-600 text-yellow-500',
  published: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

function Status({ s }: { s: MetaPostStatus }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATUS_CLS[s]}`}>
      {META_POST_STATUS_LABEL[s]}
    </span>
  );
}

/**
 * Lịch đăng (spec Part 14): every post to Pages and Instagram, when it goes out, and what
 * happened. Failed posts wait here (the dead letter queue) for a person to retry or cancel.
 */
export default function MetaPostsPage() {
  const me = useMe();
  const [posts, setPosts] = useState<MetaPostResponse[]>([]);
  const [status, setStatus] = useState<MetaPostStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<MetaPostResponse[]>(`/meta/posts${status ? `?status=${status}` : ''}`)
      .then(setPosts)
      .catch(fail);
  }, [status]);
  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [me, load]);

  async function act(p: MetaPostResponse, action: 'cancel' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      await api(`/meta/posts/${p.id}/${action}`, { method: 'POST' });
      setOk(action === 'cancel' ? 'Đã hủy bài.' : 'Đã đưa bài vào hàng đợi lại.');
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const failed = posts.filter((p) => p.status === 'failed');

  return (
    <Shell me={me}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Lịch đăng Facebook và Instagram</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/content/items?status=approved" className="text-accent underline">
            Chọn thành phẩm để đăng
          </Link>
          <Link href="/meta" className="text-accent underline">
            Trung tâm Meta
          </Link>
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {failed.length > 0 && status === '' && (
        <Notice kind="error">
          {failed.length} bài đăng lỗi đang chờ bạn xử lý. Với lỗi “không rõ bài đã lên chưa”, hãy
          mở Page kiểm tra trước, rồi bấm Thử lại nếu bài chưa có.
        </Notice>
      )}
      <Panel title="Các bài đăng">
        <label className="mb-3 flex max-w-sm items-center gap-2 text-sm">
          <span className="whitespace-nowrap text-muted">Trạng thái</span>
          <select
            className={`${inputCls} w-auto`}
            value={status}
            onChange={(e) => setStatus(e.target.value as MetaPostStatus | '')}
          >
            <option value="">Tất cả</option>
            {META_POST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {META_POST_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {posts.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có bài nào. Mở một thành phẩm đã duyệt trong Kho thành phẩm và chọn “Đăng lên
            Facebook và Instagram”.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 pr-3 font-normal">Giờ đăng</th>
                  <th className="py-1 pr-3 font-normal">Thành phẩm</th>
                  <th className="py-1 pr-3 font-normal">Đăng lên</th>
                  <th className="py-1 pr-3 font-normal">Trạng thái</th>
                  <th className="py-1 pr-3 font-normal">Ghi chú</th>
                  <th className="py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-2 pr-3">
                      {postTime(p.publishedAt ?? p.scheduledAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <Link
                        href={`/content/items?open=${p.itemId}`}
                        className="text-accent underline"
                      >
                        {p.itemTitle}
                      </Link>
                      <div className="text-xs text-muted">
                        Bản {p.version} · {p.createdByName}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {p.assetName}
                      <div className="text-xs text-muted">{META_POST_FORMAT_LABEL[p.format]}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <Status s={p.status} />
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {p.errorMessage && (
                        <span className={p.status === 'failed' ? 'text-danger' : 'text-muted'}>
                          {p.errorMessage}
                        </span>
                      )}
                      {p.nextAttemptAt && p.attempts > 0 && (
                        <div className="text-muted">
                          Thử lại lần {p.attempts + 1} lúc {postTime(p.nextAttemptAt)}
                        </div>
                      )}
                      {p.permalink && (
                        <a
                          href={p.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent underline"
                        >
                          Xem bài trên {p.assetKind === 'instagram' ? 'Instagram' : 'Facebook'}
                        </a>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2">
                      {p.status === 'failed' && (
                        <button
                          disabled={busy}
                          className={`${btnGhostCls} mr-2`}
                          onClick={() => void act(p, 'retry')}
                        >
                          Thử lại
                        </button>
                      )}
                      {(p.status === 'scheduled' || p.status === 'failed') && (
                        <button
                          disabled={busy}
                          className={btnGhostCls}
                          onClick={() =>
                            confirm(`Hủy bài “${p.itemTitle}” lên ${p.assetName}?`) &&
                            void act(p, 'cancel')
                          }
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
    </Shell>
  );
}
