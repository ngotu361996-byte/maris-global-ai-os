import { QA_STATUS_LABEL, type QaLevel, type QaReport, type QaStatus } from '@maris/contracts';

export const QA_STATUS_CLS: Record<QaStatus, string> = {
  pass: 'border-green-600 text-green-500',
  warning: 'border-yellow-600 text-yellow-500',
  fail: 'border-danger text-danger',
};

const LEVEL: Record<QaLevel, { mark: string; cls: string }> = {
  error: { mark: '✕', cls: 'text-danger' },
  warning: { mark: '⚠', cls: 'text-yellow-500' },
  info: { mark: 'i', cls: 'text-muted' },
};

export function QaBadge({ s }: { s: QaStatus }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${QA_STATUS_CLS[s]}`}>
      {QA_STATUS_LABEL[s]}
    </span>
  );
}

/**
 * The automatic quality checks of the current version (spec Part 12, M30). Errors stop
 * "Gửi duyệt" and "Duyệt"; warnings are for the reviewer to judge.
 */
export function QaPanel({ qa }: { qa: QaReport }) {
  return (
    <section className="mb-4 rounded-md border border-line p-3" aria-label="Kiểm định tự động">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Kiểm định tự động</h3>
        <QaBadge s={qa.status} />
        <span className="text-xs text-muted">phiên bản {qa.version}</span>
      </div>
      {qa.checks.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Không thấy vấn đề về độ dài, hashtag, chỗ chưa điền, lời quảng cáo rủi ro hoặc cỡ tệp.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {qa.checks.map((c, i) => (
            <li key={`${c.code}-${i}`} className="flex gap-2">
              <span className={`w-4 shrink-0 text-center ${LEVEL[c.level].cls}`}>
                {LEVEL[c.level].mark}
              </span>
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        {qa.status === 'fail'
          ? 'Lỗi (✕) phải sửa bằng một phiên bản mới trước khi gửi duyệt hoặc duyệt.'
          : qa.status === 'warning'
            ? 'Cảnh báo (⚠) không chặn gửi duyệt; người duyệt xem và quyết định.'
            : 'Kiểm định chỉ dựa trên quy tắc; người duyệt vẫn đọc lại nội dung.'}
      </p>
    </section>
  );
}
