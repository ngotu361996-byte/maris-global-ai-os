'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AiProviderResponse, BudgetResponse } from '@maris/contracts';
import { btnCls, btnGhostCls, inputCls, Panel } from '@/components/ui';
import { api } from '@/lib/api';

/** Cost Governor: monthly budgets for the whole business or one AI, with the 80% warning. */
export function BudgetsPanel({ providers }: { providers: AiProviderResponse[] }) {
  const [budgets, setBudgets] = useState<BudgetResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<BudgetResponse[]>('/ai/budgets').then(setBudgets).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const scopeName = (id: string | null) => (id ? (providers.find((p) => p.id === id)?.name ?? 'AI đã xóa') : 'Toàn doanh nghiệp');
  const noPrices = providers.some((p) => p.enabled && (p.inputCostPerMtok == null || p.outputCostPerMtok == null));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setBusy(true);
    try {
      await api('/ai/budgets', {
        method: 'PUT',
        body: JSON.stringify({ providerId: String(f.get('scope')) || null, monthlyUsd: Number(f.get('monthlyUsd')) }),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: BudgetResponse) {
    if (!confirm(`Bỏ ngân sách của ${scopeName(b.providerId)}?`)) return;
    try {
      await api(`/ai/budgets/${b.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    }
  }

  return (
    <Panel title="Ngân sách AI theo tháng">
      <p className="mb-3 max-w-3xl text-xs text-muted">
        Khi dùng tới 80% ngân sách, MARIS cảnh báo ở thanh Công việc đang chạy. Khi hết 100%: AI có ngân sách riêng sẽ được bỏ qua
        (chuyển sang AI dự phòng); ngân sách toàn doanh nghiệp hết thì mọi AI dừng tới tháng sau hoặc tới khi bạn tăng ngân sách.
        Tháng tính theo giờ UTC.
      </p>
      {noPrices && (
        <p className="mb-3 text-xs text-danger">Có AI chưa nhập giá token, nên chi phí của AI đó được tính là 0 và ngân sách không chặn được nó.</p>
      )}
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {budgets.length > 0 && (
        <ul className="mb-4 space-y-2 text-sm">
          {budgets.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3">
              <span className="w-40 font-medium">{scopeName(b.providerId)}</span>
              <span className="h-2 w-40 overflow-hidden rounded bg-bg">
                <span
                  className={`block h-full ${b.state === 'exceeded' ? 'bg-danger' : b.state === 'warning' ? 'bg-accent' : 'bg-green-600'}`}
                  style={{ width: `${Math.min(100, b.ratio * 100)}%` }}
                />
              </span>
              <span className="text-xs">
                ${b.spentUsd.toFixed(4)} / ${b.monthlyUsd.toFixed(2)} ({Math.round(b.ratio * 100)}%)
                {b.state === 'warning' && <span className="ml-2 text-accent">Sắp hết</span>}
                {b.state === 'exceeded' && <span className="ml-2 text-danger">Đã hết</span>}
              </span>
              <button onClick={() => remove(b)} className={`${btnGhostCls} border-danger text-danger`}>
                Bỏ
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Áp dụng cho
          <select name="scope" className={`${inputCls} mt-1`}>
            <option value="">Toàn doanh nghiệp</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          USD mỗi tháng
          <input name="monthlyUsd" type="number" min="0.01" step="0.01" required className={`${inputCls} mt-1 w-32`} />
        </label>
        <button disabled={busy} className={btnCls}>
          Lưu ngân sách
        </button>
      </form>
    </Panel>
  );
}
