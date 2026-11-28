'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  IMAGE_PRESET_INFO,
  ITEM_STATUS_LABEL,
  VIDEO_COVER,
  WORKER_JOB_STATUS_LABEL,
  type MediaJobResponse,
} from '@maris/contracts';
import { btnCls, btnGhostCls } from '@/components/ui';
import { fileUrl } from '@/lib/api';

/** A finished image or video: small preview, open and download. */
function Output({ o }: { o: MediaJobResponse['outputs'][number] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [ext, setExt] = useState('jpg');
  useEffect(() => {
    let u: string | null = null;
    fileUrl(`/content/items/${o.itemId}/versions/1/file?inline=1`)
      .then(async (x) => {
        setUrl((u = x));
        const type = (await (await fetch(x)).blob()).type;
        setExt(
          type === 'video/mp4'
            ? 'mp4'
            : type === 'image/png'
              ? 'png'
              : type === 'image/webp'
                ? 'webp'
                : 'jpg',
        );
      })
      .catch(() => setUrl(null));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [o.itemId]);
  return (
    <li className="flex items-center gap-3 rounded border border-line p-2">
      {url && o.kind === 'video' ? (
        <video
          src={url}
          controls
          preload="metadata"
          className="h-28 w-28 rounded border border-line bg-black object-contain"
        />
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={o.title}
          className="h-20 w-20 rounded border border-line object-contain"
        />
      ) : (
        <span className="flex h-20 w-20 items-center justify-center rounded border border-line text-xs text-muted">
          …
        </span>
      )}
      <span className="grid gap-1">
        <span className="text-sm">
          {o.preset === VIDEO_COVER
            ? 'Ảnh bìa'
            : `${o.kind === 'video' ? 'Video ' : ''}${IMAGE_PRESET_INFO[o.preset].label}`}{' '}
          <span className="text-xs text-muted">({ITEM_STATUS_LABEL[o.status]})</span>
        </span>
        <span className="flex flex-wrap gap-2">
          {url && (
            <a
              className={`${btnCls} px-2 py-0.5 text-xs`}
              href={url}
              download={`${o.title.replace(/[\\/:*?"<>|]/g, '-')}.${ext}`}
            >
              Tải về
            </a>
          )}
          <Link
            className={`${btnGhostCls} px-2 py-0.5 text-xs`}
            href={`/content/items?open=${o.itemId}`}
          >
            Mở để duyệt
          </Link>
        </span>
      </span>
    </li>
  );
}

const STATUS_CLS: Record<MediaJobResponse['status'], string> = {
  queued: 'border-line text-muted',
  running: 'border-accent text-accent',
  completed: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

/** The image or video jobs of one source file, newest first, with what each one made. */
export function MediaJobList({
  jobs,
  onCancel,
}: {
  jobs: MediaJobResponse[];
  onCancel: (id: string) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <ul className="mt-4 grid gap-2 text-sm">
      {jobs.map((j) => (
        <li key={j.id} className="rounded border border-line p-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded border px-1.5 py-0.5 ${STATUS_CLS[j.status]}`}>
              {WORKER_JOB_STATUS_LABEL[j.status]}
              {j.status === 'running' ? ` ${j.progress}%` : ''}
            </span>
            <span className="text-muted">
              {j.presets.map((p) => IMAGE_PRESET_INFO[p].label).join(', ')}
              {j.logoAssetId ? ' · có logo' : ''}
              {j.voiceItemId ? ' · có giọng đọc' : ''}
            </span>
            <span className="text-muted">
              {j.createdByName}, {new Date(j.createdAt).toLocaleString('vi-VN')}
              {j.deviceName ? ` · ${j.deviceName}` : ''}
            </span>
            {(j.status === 'queued' || j.status === 'running') && !j.cancelRequested && (
              <button
                className={`${btnGhostCls} px-2 py-0.5 text-xs`}
                onClick={() => onCancel(j.id)}
              >
                Hủy
              </button>
            )}
          </div>
          {j.status === 'running' && j.progressNote && (
            <p className="mt-1 text-xs text-muted">{j.progressNote}</p>
          )}
          {j.status === 'queued' && (
            <p className="mt-1 text-xs text-muted">Đang chờ một Worker nhận việc.</p>
          )}
          {j.errorMessage && <p className="mt-1 text-xs text-danger">{j.errorMessage}</p>}
          {j.outputs.length > 0 && (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {j.outputs.map((o) => (
                <Output key={o.itemId} o={o} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
