'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  CONTENT_AI_LIMITS,
  CONTENT_TONES,
  GENERATION_STATUS_LABEL,
  ITEM_STATUS_LABEL,
  LANGUAGES,
  PLATFORM_LABEL,
  PLATFORMS,
  type AssetResponse,
  type GenerationResponse,
  type ItemDetailResponse,
} from '@maris/contracts';
import { btnCls, btnGhostCls, inputCls } from '@/components/ui';
import { api } from '@/lib/api';

const GEN_CLS: Record<GenerationResponse['status'], string> = {
  running: 'border-accent text-accent',
  done: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

const usd = (n: number) => `${n.toFixed(n < 0.01 ? 4 : 3)} USD`;

/**
 * AI content writing for one item: write the next version from verified product facts, make a
 * version in another language or platform, and follow each run with its cost and warnings.
 */
export function AiWriter({
  detail,
  assets,
  onChange,
  onOpen,
  onError,
}: {
  detail: ItemDetailResponse;
  assets: AssetResponse[];
  onChange: (d: ItemDetailResponse, msg: string) => void;
  onOpen: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const products = assets.filter((a) => a.kind === 'product' && !a.archivedAt);
  const references = assets.filter(
    (a) => (a.kind === 'text' || a.kind === 'reference') && !a.archivedAt,
  );
  // Facts the current version already uses are ticked by default.
  const used = new Set(detail.versions[0]?.sources.map((s) => s.id) ?? []);
  const [picked, setPicked] = useState<string[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPicked(products.filter((p) => used.has(p.id) && p.verifiedAt).map((p) => p.id));
    setRefs(references.filter((r) => used.has(r.id)).map((r) => r.id));
    // Reset when another item is opened or it gains a version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.currentVersion, assets.length]);

  const running = detail.generations.find((g) => g.status === 'running');
  // While the AI writes, refresh every 2 seconds.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api<ItemDetailResponse>(`/content/items/${detail.id}`)
        .then((d) => {
          const g = d.generations.find((x) => x.id === running.id);
          if (g && g.status !== 'running')
            onChange(
              d,
              g.status === 'done'
                ? g.warnings.length
                  ? `AI đã viết xong phiên bản ${g.version}, có điểm cần kiểm tra.`
                  : `AI đã viết xong phiên bản ${g.version}.`
                : `AI viết không thành công: ${g.errorMessage ?? g.errorCode ?? ''}`,
            );
          else if (d.generations[0]?.progress !== running.progress) onChange(d, '');
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running, detail.id, onChange]);

  const editable = detail.status !== 'published' && detail.status !== 'archived';
  const hasText = !!detail.versions.find((v) => v.version === detail.currentVersion)?.body;

  async function post(path: string, body: object, msg: string) {
    setBusy(true);
    try {
      onChange(
        await api<ItemDetailResponse>(path, { method: 'POST', body: JSON.stringify(body) }),
        msg,
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  function write(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void post(
      `/content/items/${detail.id}/generate`,
      {
        productAssetIds: picked,
        sourceAssetIds: refs,
        brief: String(f.get('brief') ?? '').trim() || null,
        tone: String(f.get('tone') ?? '').trim() || null,
        budgetUsd: Number(f.get('budget')) || CONTENT_AI_LIMITS.budgetDefaultUsd,
      },
      'AI đang viết. Kết quả sẽ thành phiên bản mới (bản nháp) để bạn xem và duyệt.',
    );
  }

  async function variant(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const d = await api<ItemDetailResponse>(`/content/items/${detail.id}/variants`, {
        method: 'POST',
        body: JSON.stringify({
          language: String(f.get('language')),
          market: String(f.get('market') ?? '').trim() || null,
          platform: String(f.get('platform')) || null,
          budgetUsd: CONTENT_AI_LIMITS.budgetDefaultUsd,
        }),
      });
      onChange(d, `Đã tạo “${d.title}”. AI đang viết bản này.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) =>
    set(on ? [...list, id] : list.filter((x) => x !== id));

  return (
    <div className="mb-4 grid gap-3">
      {editable && !running && (
        <form onSubmit={write} className="grid gap-2 rounded-md border border-accent/50 p-3">
          <div className="text-sm font-medium">AI viết phiên bản mới</div>
          <p className="text-xs text-muted">
            AI chỉ được dùng thông tin sản phẩm đã xác minh. Con số hoặc lời quảng cáo không có
            trong thông tin sản phẩm sẽ bị đánh dấu, và bản đó chưa duyệt được cho đến khi bạn sửa.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="text-sm">
              Thông tin sản phẩm ({picked.length})
              <div className="mt-1 max-h-36 overflow-auto rounded-md border border-line bg-bg p-2">
                {products.length === 0 ? (
                  <p className="text-xs text-muted">
                    Chưa có. Thêm ở Kho nội dung gốc, mục Thông tin sản phẩm.
                  </p>
                ) : (
                  products.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
                      <input
                        type="checkbox"
                        disabled={!p.verifiedAt}
                        checked={picked.includes(p.id)}
                        onChange={(e) => toggle(picked, setPicked, p.id, e.target.checked)}
                      />
                      <span className={p.verifiedAt ? '' : 'text-muted'}>{p.title}</span>
                      {!p.verifiedAt && (
                        <span className="text-xs text-yellow-500">(chưa xác minh)</span>
                      )}
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="text-sm">
              Tham khảo thêm ({refs.length})
              <div className="mt-1 max-h-36 overflow-auto rounded-md border border-line bg-bg p-2">
                {references.length === 0 ? (
                  <p className="text-xs text-muted">Không có văn bản tham khảo.</p>
                ) : (
                  references.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 py-0.5 text-sm">
                      <input
                        type="checkbox"
                        disabled={r.rightsStatus === 'restricted'}
                        checked={refs.includes(r.id)}
                        onChange={(e) => toggle(refs, setRefs, r.id, e.target.checked)}
                      />
                      <span>{r.title}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
          <label className="text-sm">
            Yêu cầu thêm (không bắt buộc)
            <textarea
              name="brief"
              rows={2}
              maxLength={CONTENT_AI_LIMITS.briefMaxChars}
              placeholder="Ví dụ: Giảm 20% từ 01/12 đến 05/12, nhấn mạnh vải mát cho mùa hè"
              className={`${inputCls} mt-1`}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Giọng văn
              <input
                name="tone"
                list="content-tones"
                maxLength={100}
                defaultValue={CONTENT_TONES[0]}
                className={`${inputCls} mt-1 w-60`}
              />
              <datalist id="content-tones">
                {CONTENT_TONES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              Ngân sách tối đa (USD)
              <input
                name="budget"
                type="number"
                step="0.05"
                min="0.05"
                max={CONTENT_AI_LIMITS.budgetMaxUsd}
                defaultValue={CONTENT_AI_LIMITS.budgetDefaultUsd}
                className={`${inputCls} mt-1 w-32`}
              />
            </label>
            <button disabled={busy} className={btnCls}>
              {busy ? 'Đang gửi…' : 'AI viết'}
            </button>
          </div>
        </form>
      )}

      {detail.generations.length > 0 && (
        <div className="rounded-md border border-line p-3">
          <div className="mb-2 text-sm font-medium">Các lần AI viết</div>
          <ul className="space-y-2 text-sm">
            {detail.generations.map((g) => (
              <li key={g.id} className="border-t border-line pt-2 first:border-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 text-xs ${GEN_CLS[g.status]}`}>
                    {GENERATION_STATUS_LABEL[g.status]}
                  </span>
                  <span className="text-xs text-muted">
                    {g.mode === 'variant' ? 'Chuyển thể' : 'Viết mới'} · {g.createdByName},{' '}
                    {new Date(g.createdAt).toLocaleString('vi-VN')} · {usd(g.costUsd)}
                    {g.version ? ` · thành phiên bản ${g.version}` : ''}
                  </span>
                  {g.status === 'running' && (
                    <button
                      disabled={busy}
                      className={`${btnGhostCls} border-danger text-danger`}
                      onClick={() =>
                        void post(`/content/generations/${g.id}/cancel`, {}, 'Đã hủy lần AI viết.')
                      }
                    >
                      Hủy
                    </button>
                  )}
                </div>
                {g.progress && <p className="mt-1 text-xs text-accent">{g.progress}</p>}
                {g.warnings.map((w) => (
                  <p key={w} className="mt-1 text-xs text-yellow-500">
                    ⚠ {w}
                  </p>
                ))}
                {g.errorMessage && g.status !== 'done' && (
                  <p className="mt-1 text-xs text-danger">{g.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-md border border-line p-3">
        <div className="mb-2 text-sm font-medium">Bản ngôn ngữ hoặc nền tảng khác</div>
        {detail.variants.length > 0 && (
          <ul className="mb-2 space-y-1 text-sm">
            {detail.variants.map((v) => (
              <li key={v.id}>
                <button className="text-accent underline" onClick={() => onOpen(v.id)}>
                  {v.title}
                </button>{' '}
                <span className="text-xs text-muted">
                  {LANGUAGES[v.language] ?? v.language}
                  {v.platform ? ` · ${PLATFORM_LABEL[v.platform]}` : ''} ·{' '}
                  {ITEM_STATUS_LABEL[v.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hasText ? (
          <form onSubmit={variant} className="flex flex-wrap items-end gap-3" autoComplete="off">
            <label className="text-sm">
              Ngôn ngữ
              <select
                name="language"
                defaultValue={detail.language.startsWith('vi') ? 'en' : 'vi'}
                className={`${inputCls} mt-1`}
              >
                {Object.entries(LANGUAGES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Thị trường
              <input
                name="market"
                maxLength={50}
                placeholder={detail.market ?? 'VN, US…'}
                className={`${inputCls} mt-1 w-28`}
              />
            </label>
            <label className="text-sm">
              Nền tảng
              <select name="platform" defaultValue="" className={`${inputCls} mt-1`}>
                <option value="">
                  Giữ nguyên{detail.platform ? ` (${PLATFORM_LABEL[detail.platform]})` : ''}
                </option>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy} className={btnGhostCls}>
              AI tạo bản này
            </button>
          </form>
        ) : (
          <p className="text-xs text-muted">
            Cần có phiên bản chữ trước, rồi AI mới chuyển sang ngôn ngữ hoặc nền tảng khác.
          </p>
        )}
      </div>
    </div>
  );
}
