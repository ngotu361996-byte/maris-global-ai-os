'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  YOUTUBE_FORMAT_LABEL,
  YOUTUBE_PRIVACY_LABEL,
  YOUTUBE_UPLOAD_STATUS_LABEL,
  YOUTUBE_UPLOAD_STATUSES,
  type YoutubeUploadResponse,
  type YoutubeUploadStatus,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { postTime } from '../content/items/MetaPublish';

const STATUS_CLS: Record<YoutubeUploadStatus, string> = {
  scheduled: 'border-accent text-accent',
  uploading: 'border-accent text-accent',
  processing: 'border-yellow-600 text-yellow-500',
  published: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

/**
 * YouTube Center (spec Part 17, M20): every upload of an approved video to a channel, its state
 * at YouTube, and what went wrong. Failed uploads wait here for a person to retry or cancel.
 */
export default function YoutubePage() {
  const me = useMe();
  const [rows, setRows] = useState<YoutubeUploadResponse[]>([]);
  const [status, setStatus] = useState<YoutubeUploadStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<YoutubeUploadResponse[]>(`/google/youtube/uploads${status ? `?status=${status}` : ''}`)
      .then(setRows)
      .catch(fail);
  }, [status]);
  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [me, load]);

  async function act(u: YoutubeUploadResponse, action: 'cancel' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      await api(`/google/youtube/uploads/${u.id}/${action}`, { method: 'POST' });
      setOk(action === 'cancel' ? 'Đã hủy lượt tải lên.' : 'Đã đưa video vào hàng đợi lại.');
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const failed = rows.filter((u) => u.status === 'failed');

  return (
    <Shell me={me}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Video YouTube</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/content/items?status=approved" className="text-accent underline">
            Chọn video để đăng
          </Link>
          <Link href="/google" className="text-accent underline">
            Trung tâm Google
          </Link>
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {failed.length > 0 && status === '' && (
        <Notice kind="error">{failed.length} video lỗi đang chờ bạn xử lý.</Notice>
      )}
      <Panel title="Các lượt tải lên">
        <label className="mb-3 flex max-w-sm items-center gap-2 text-sm">
          <span className="whitespace-nowrap text-muted">Trạng thái</span>
          <select
            className={`${inputCls} w-auto`}
            value={status}
            onChange={(e) => setStatus(e.target.value as YoutubeUploadStatus | '')}
          >
            <option value="">Tất cả</option>
            {YOUTUBE_UPLOAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {YOUTUBE_UPLOAD_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có video nào. Mở một video đã duyệt trong Kho thành phẩm và chọn “Đăng lên
            YouTube”.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Video</th>
                  <th>Kênh</th>
                  <th>Chế độ</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{u.title}</div>
                      <div className="text-xs text-muted">
                        <Link href={`/content/items?open=${u.itemId}`} className="underline">
                          {u.itemTitle}
                        </Link>{' '}
                        · bản {u.version} · {YOUTUBE_FORMAT_LABEL[u.format]} ·{' '}
                        {postTime(u.createdAt)} · {u.createdByName}
                        {u.madeForKids ? ' · dành cho trẻ em' : ''}
                        {u.syntheticMedia ? ' · có nội dung AI/chỉnh sửa' : ''}
                      </div>
                      {u.warnings.map((w) => (
                        <div key={w} className="text-xs text-yellow-500">
                          {w}
                        </div>
                      ))}
                      {u.errorMessage && u.status !== 'published' && (
                        <div
                          className={`text-xs ${u.status === 'failed' ? 'text-danger' : 'text-muted'}`}
                        >
                          {u.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="pr-3">{u.channelTitle}</td>
                    <td className="pr-3 text-xs">
                      {YOUTUBE_PRIVACY_LABEL[u.privacy].split(' (')[0]}
                      {u.publishAt ? (
                        <div className="text-muted">công khai {postTime(u.publishAt)}</div>
                      ) : null}
                      {u.youtubePrivacy && u.youtubePrivacy !== u.privacy && (
                        <div className="text-muted">YouTube: {u.youtubePrivacy}</div>
                      )}
                    </td>
                    <td className="pr-3">
                      <span
                        className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATUS_CLS[u.status]}`}
                      >
                        {YOUTUBE_UPLOAD_STATUS_LABEL[u.status]}
                        {u.uploadedPct !== null ? ` ${u.uploadedPct}%` : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {u.url && (
                        <a
                          href={u.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mr-2 text-accent underline"
                        >
                          Xem trên YouTube
                        </a>
                      )}
                      {u.status === 'failed' && (
                        <button
                          className={`${btnGhostCls} mr-1`}
                          disabled={busy}
                          onClick={() => void act(u, 'retry')}
                        >
                          Thử lại
                        </button>
                      )}
                      {(u.status === 'scheduled' || (u.status === 'failed' && !u.videoId)) && (
                        <button
                          className={btnGhostCls}
                          disabled={busy}
                          onClick={() => void act(u, 'cancel')}
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
