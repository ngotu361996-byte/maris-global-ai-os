'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_LABEL,
  type AiProviderResponse,
  type ModelResponse,
} from '@maris/contracts';
import { btnCls, btnGhostCls, inputCls, Panel } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * Model Registry: which models each AI offers, what they are good at and their own prices.
 * Chat modes use it: Lập trình and Phát triển phần mềm prefer a "Lập trình" model, Nghiên cứu and
 * Chuyên gia prefer "Suy luận sâu".
 */
export function ModelsPanel({ providers }: { providers: AiProviderResponse[] }) {
  const [models, setModels] = useState<ModelResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ModelResponse[]>('/ai/models')
      .then(setModels)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? 'AI đã xóa';

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const num = (k: string) =>
      String(f.get(k) ?? '').trim() === '' ? null : Number(String(f.get(k)).replace(',', '.'));
    void run(async () => {
      await api('/ai/models', {
        method: 'POST',
        body: JSON.stringify({
          providerId: String(f.get('providerId')),
          model: String(f.get('model') ?? '').trim(),
          capabilities: f.getAll('capabilities').map(String),
          contextWindow: num('contextWindow'),
          inputCostPerMtok: num('inputCost'),
          outputCostPerMtok: num('outputCost'),
        }),
      });
      form.reset();
    });
  }

  const toggleCap = (m: ModelResponse, cap: string) =>
    run(() =>
      api(`/ai/models/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          capabilities: m.capabilities.includes(cap as never)
            ? m.capabilities.filter((c) => c !== cap)
            : [...m.capabilities, cap],
        }),
      }),
    );

  return (
    <Panel title="Danh mục model">
      <p className="mb-3 max-w-3xl text-xs text-muted">
        Ghi lại các model của từng AI, model đó giỏi việc gì và giá riêng của nó. Khi chat ở chế độ
        Lập trình hoặc Phát triển phần mềm, MARIS tự chọn model có khả năng “Lập trình”; chế độ
        Nghiên cứu và Chuyên gia chọn model “Suy luận sâu”. Nếu bạn đã chọn model cụ thể trong cuộc
        trò chuyện thì MARIS giữ nguyên lựa chọn đó. Model bị tắt sẽ không bao giờ được dùng. Giá
        của model (nếu có) được dùng thay giá của AI.
      </p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {models.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1">AI</th>
                <th>Model</th>
                <th>Khả năng (bấm để bật/tắt)</th>
                <th>Giá / 1 triệu token</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {models.map((m) => (
                <tr key={m.id} className={m.enabled ? '' : 'opacity-50'}>
                  <td className="py-2">{providerName(m.providerId)}</td>
                  <td className="font-mono text-xs">
                    {m.model}
                    {m.contextWindow && (
                      <div className="text-[11px] text-muted">
                        {m.contextWindow.toLocaleString('vi-VN')} token ngữ cảnh
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {MODEL_CAPABILITIES.map((c) => (
                        <button
                          key={c}
                          disabled={busy}
                          onClick={() => toggleCap(m, c)}
                          className={`rounded border px-1.5 text-[11px] ${m.capabilities.includes(c) ? 'border-accent text-accent' : 'border-line text-muted'}`}
                        >
                          {MODEL_CAPABILITY_LABEL[c]}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="text-xs text-muted">
                    {m.inputCostPerMtok == null && m.outputCostPerMtok == null
                      ? 'Theo giá của AI'
                      : `$${m.inputCostPerMtok ?? 0} vào · $${m.outputCostPerMtok ?? 0} ra`}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api(`/ai/models/${m.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ enabled: !m.enabled }),
                            }),
                          )
                        }
                        className={btnGhostCls}
                      >
                        {m.enabled ? 'Tắt' : 'Bật'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          confirm(`Xóa ${m.model} khỏi danh mục?`) &&
                          run(() => api(`/ai/models/${m.id}`, { method: 'DELETE' }))
                        }
                        className={`${btnGhostCls} border-danger text-danger`}
                      >
                        Xóa
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {providers.length === 0 ? (
        <p className="text-sm text-muted">
          Thêm một AI ở trên trước, rồi ghi model của nó vào đây.
        </p>
      ) : (
        <form onSubmit={add} className="grid max-w-3xl gap-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              AI
              <select name="providerId" className={`${inputCls} mt-1`}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Tên model
              <input
                name="model"
                required
                maxLength={200}
                placeholder="Ví dụ: gpt-4o"
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="mb-1">Khả năng</legend>
            <div className="flex flex-wrap gap-3">
              {MODEL_CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" name="capabilities" value={c} />
                  {MODEL_CAPABILITY_LABEL[c]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Giá đầu vào (USD / 1 triệu token)
              <input
                name="inputCost"
                type="number"
                min={0}
                step="any"
                placeholder="tùy chọn"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm">
              Giá đầu ra (USD / 1 triệu token)
              <input
                name="outputCost"
                type="number"
                min={0}
                step="any"
                placeholder="tùy chọn"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm">
              Ngữ cảnh tối đa (token)
              <input
                name="contextWindow"
                type="number"
                min={1}
                step={1}
                placeholder="tùy chọn"
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>
          <div>
            <button disabled={busy} className={btnCls}>
              Thêm vào danh mục
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
