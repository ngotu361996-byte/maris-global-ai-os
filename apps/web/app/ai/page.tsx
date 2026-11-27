'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AI_PROVIDER_KINDS,
  AI_PROVIDER_PRESETS,
  type AiProviderKind,
  type AiProviderResponse,
  type AiProviderTestResult,
  type AiUsageResponse,
  type SecretResponse,
} from '@maris/contracts';
import { BudgetsPanel } from '@/components/BudgetsPanel';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const SECRET_HINT: Partial<Record<AiProviderKind, string>> = {
  openai: 'openai.api_key',
  anthropic: 'anthropic.api_key',
  gemini: 'google.api_key',
};

export default function AiProvidersPage() {
  const me = useMe();
  const [providers, setProviders] = useState<AiProviderResponse[]>([]);
  const [secrets, setSecrets] = useState<SecretResponse[]>([]);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<AiProviderKind>('openai');
  const [models, setModels] = useState<Record<string, string[]>>({});

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<AiProviderResponse[]>('/ai/providers').then(setProviders).catch(fail);
    api<SecretResponse[]>('/secrets').then(setSecrets).catch(() => undefined);
    api<AiUsageResponse>('/ai/usage?days=30').then(setUsage).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const secretName = (ref: string | null) => secrets.find((s) => s.reference === ref)?.name ?? (ref ? 'key đã xóa?' : 'không cần key');

  async function run(label: string, fn: () => Promise<void>) {
    setError(null);
    setOk(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const num = (k: string) => (String(f.get(k) ?? '').trim() === '' ? null : Number(f.get(k)));
    const model = String(f.get('defaultModel')).trim();
    if (/^(sk-|sk_|rk-|AIza|xai-|gsk_)/.test(model) || model.length >= 120) {
      // Never send a pasted key anywhere but the Secret Vault.
      (form.elements.namedItem('defaultModel') as HTMLInputElement).value = '';
      setOk(null);
      setError('Ô “Model mặc định” đang chứa một API key. Đã xóa nó khỏi ô. Key chỉ dán vào Secret Vault; nếu key đã lộ, hãy xóa nó trên trang của nhà cung cấp và tạo key mới.');
      return;
    }
    await run('add', async () => {
      const created = await api<AiProviderResponse>('/ai/providers', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: String(f.get('name')).trim(),
          baseUrl: String(f.get('baseUrl') ?? '').trim() || null,
          secretRef: String(f.get('secretRef') ?? '') || null,
          defaultModel: model,
          inputCostPerMtok: num('inputCost'),
          outputCostPerMtok: num('outputCost'),
        }),
      });
      form.reset();
      setOk(`Đã thêm “${created.name}”. Bấm “Thử” để kiểm tra kết nối.`);
      load();
    });
  }

  async function move(index: number, delta: number) {
    const order = providers.map((p) => p.id);
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item!);
    await run('order', async () => {
      setProviders(await api<AiProviderResponse[]>('/ai/providers/order', { method: 'PUT', body: JSON.stringify({ order }) }));
    });
  }

  async function patch(p: AiProviderResponse, body: Record<string, unknown>, message: string) {
    await run(p.id, async () => {
      await api(`/ai/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setOk(message);
      load();
    });
  }

  async function test(p: AiProviderResponse) {
    await run(p.id, async () => {
      const r = await api<AiProviderTestResult>(`/ai/providers/${p.id}/test`, { method: 'POST' });
      if (r.ok) setOk(`${p.name} hoạt động (${r.model}, ${r.latencyMs} ms).`);
      else setError(`${p.name} lỗi ${r.errorCode}: ${r.message ?? ''}`);
      load();
    });
  }

  async function loadModels(p: AiProviderResponse) {
    await run(p.id, async () => {
      const list = await api<string[]>(`/ai/providers/${p.id}/models`);
      setModels((m) => ({ ...m, [p.id]: list }));
      if (!list.length) setError(`${p.name} không trả về model nào.`);
    });
  }

  async function remove(p: AiProviderResponse) {
    if (!confirm(`Xóa “${p.name}” khỏi danh sách AI? Key trong Secret Vault vẫn giữ nguyên.`)) return;
    await run(p.id, async () => {
      await api(`/ai/providers/${p.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${p.name}”.`);
      load();
    });
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const preset = AI_PROVIDER_PRESETS[kind];
  const hint = SECRET_HINT[kind];

  return (
    <Shell me={me} hideChat>
      <h1 className="mb-1 text-xl font-semibold">AI Provider</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Danh sách AI mà MARIS dùng. AI đứng đầu là AI chính; khi AI chính lỗi hoặc quá thời gian, MARIS tự chuyển sang AI kế tiếp.
        Key nằm trong Secret Vault, trang này chỉ chọn key theo tên và không bao giờ hiển thị giá trị.
      </p>
      {/* Sticky so the result of a button far down the page is always visible. */}
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title="Thứ tự AI (trên cùng là AI chính)">
        {providers.length === 0 ? (
          <p className="text-sm text-muted">Chưa có AI nào. Thêm ở khung bên dưới.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_td]:pr-3 [&_th]:pr-3">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">#</th>
                  <th>Tên</th>
                  <th>Loại</th>
                  <th>Model mặc định</th>
                  <th>Key</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {providers.map((p, i) => (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="py-2 pr-2">
                      <div className="flex flex-col gap-0.5">
                        <button disabled={i === 0 || !!busy} onClick={() => move(i, -1)} className="text-xs text-muted disabled:opacity-30" aria-label="Lên">
                          ▲
                        </button>
                        <button
                          disabled={i === providers.length - 1 || !!busy}
                          onClick={() => move(i, 1)}
                          className="text-xs text-muted disabled:opacity-30"
                          aria-label="Xuống"
                        >
                          ▼
                        </button>
                      </div>
                    </td>
                    <td className="py-2 font-medium">
                      {p.name}
                      {i === 0 && <span className="ml-2 rounded bg-accent px-1.5 text-[10px] text-black">CHÍNH</span>}
                    </td>
                    <td className="py-2 text-muted">{AI_PROVIDER_PRESETS[p.kind].label.split(' (')[0]}</td>
                    <td className="py-2">
                      {models[p.id]?.length ? (
                        <select
                          defaultValue={p.defaultModel}
                          onChange={(e) => patch(p, { defaultModel: e.target.value }, `${p.name} dùng model ${e.target.value}.`)}
                          className={`${inputCls} py-1`}
                        >
                          {!models[p.id]!.includes(p.defaultModel) && <option value={p.defaultModel}>{p.defaultModel}</option>}
                          {models[p.id]!.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-mono text-xs">{p.defaultModel}</span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted">{secretName(p.secretRef)}</td>
                    <td className="py-2 text-xs">
                      {!p.enabled ? (
                        <span className="text-muted">Đang tắt</span>
                      ) : p.health === 'open' ? (
                        <span className="text-danger" title="Lỗi liên tiếp, tạm bỏ qua khoảng 30 giây">
                          Tạm ngắt
                        </span>
                      ) : (
                        <span className="text-green-500">Sẵn sàng</span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button disabled={!!busy} onClick={() => test(p)} className={btnGhostCls}>
                          {busy === p.id ? '…' : 'Thử'}
                        </button>
                        <button disabled={!!busy} onClick={() => loadModels(p)} className={btnGhostCls}>
                          Chọn model
                        </button>
                        <button
                          disabled={!!busy}
                          onClick={() => patch(p, { enabled: !p.enabled }, p.enabled ? `Đã tắt ${p.name}.` : `Đã bật ${p.name}.`)}
                          className={btnGhostCls}
                        >
                          {p.enabled ? 'Tắt' : 'Bật'}
                        </button>
                        <button disabled={!!busy} onClick={() => remove(p)} className={`${btnGhostCls} border-danger text-danger`}>
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
      </Panel>

      <Panel title="Thêm AI">
        <form onSubmit={add} className="grid max-w-2xl gap-3" autoComplete="off">
          <label className="text-sm">
            Loại AI
            <select value={kind} onChange={(e) => setKind(e.target.value as AiProviderKind)} className={`${inputCls} mt-1`}>
              {AI_PROVIDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {AI_PROVIDER_PRESETS[k].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Tên hiển thị
            <input key={kind} name="name" required defaultValue={preset.label.split(' (')[0]} maxLength={80} className={`${inputCls} mt-1`} />
          </label>
          <label className="text-sm">
            API key (trong Secret Vault)
            <select name="secretRef" required={preset.needsKey} className={`${inputCls} mt-1`} key={`s-${kind}-${secrets.length}`} defaultValue={secrets.find((s) => s.name === hint)?.reference ?? ''}>
              <option value="">{preset.needsKey ? '— Chọn key —' : 'Không cần key'}</option>
              {secrets.map((s) => (
                <option key={s.id} value={s.reference}>
                  {s.name}
                </option>
              ))}
            </select>
            {preset.needsKey && secrets.length === 0 && (
              <span className="mt-1 block text-xs text-muted">
                Chưa có key nào. Thêm key ở <a href="/secrets" className="underline">Secret Vault</a> trước.
              </span>
            )}
          </label>
          {(kind === 'openai_compatible' || kind === 'ollama') && (
            <label className="text-sm">
              Địa chỉ API (base URL)
              <input
                name="baseUrl"
                type="url"
                required={kind === 'openai_compatible'}
                placeholder={preset.defaultBaseUrl ?? 'https://openrouter.ai/api/v1'}
                className={`${inputCls} mt-1`}
              />
            </label>
          )}
          <label className="text-sm">
            Model mặc định
            <input name="defaultModel" required maxLength={200} placeholder="Nhập tên model, sau đó có thể bấm “Chọn model”" className={`${inputCls} mt-1`} />
            <span className="mt-1 block text-xs text-muted">
              Không chắc tên model? Nhập tạm một tên, lưu lại, rồi bấm “Chọn model” để lấy danh sách thật từ nhà cung cấp.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              Giá đầu vào (USD / 1 triệu token)
              <input name="inputCost" type="number" min={0} step="any" placeholder="tùy chọn" className={`${inputCls} mt-1`} />
            </label>
            <label className="text-sm">
              Giá đầu ra (USD / 1 triệu token)
              <input name="outputCost" type="number" min={0} step="any" placeholder="tùy chọn" className={`${inputCls} mt-1`} />
            </label>
          </div>
          <div>
            <button disabled={!!busy} className={btnCls}>
              {busy === 'add' ? 'Đang thêm…' : 'Thêm AI'}
            </button>
          </div>
        </form>
      </Panel>

      <BudgetsPanel providers={providers} />

      {usage && (
        <Panel title="Token và chi phí 30 ngày qua">
          {usage.rows.length === 0 ? (
            <p className="text-sm text-muted">Chưa có lượt gọi AI nào.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">AI</th>
                  <th className="text-right">Lượt gọi</th>
                  <th className="text-right">Lỗi</th>
                  <th className="text-right">Token vào</th>
                  <th className="text-right">Token ra</th>
                  <th className="text-right">Chi phí</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((r) => (
                  <tr key={r.providerId} className="border-t border-line">
                    <td className="py-2">{r.providerName}</td>
                    <td className="text-right">{r.calls}</td>
                    <td className="text-right">{r.failures}</td>
                    <td className="text-right">{r.inputTokens.toLocaleString('vi-VN')}</td>
                    <td className="text-right">{r.outputTokens.toLocaleString('vi-VN')}</td>
                    <td className="text-right">${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line font-medium">
                  <td className="py-2">Tổng</td>
                  <td colSpan={4} />
                  <td className="text-right">${usage.totalCostUsd.toFixed(4)}</td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted">Chi phí chỉ tính khi bạn nhập giá cho từng AI; ngân sách cũng chỉ có hiệu lực khi đã nhập giá.</p>
        </Panel>
      )}
    </Shell>
  );
}
