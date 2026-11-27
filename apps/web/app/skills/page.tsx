'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ACCESS_LEVEL_LABEL,
  SKILL_FIELD_TYPE_LABEL,
  SKILL_FIELD_TYPES,
  TASK_LEVELS,
  type AgentResponse,
  type SkillField,
  type SkillFieldType,
  type SkillResponse,
  type TaskLevel,
  type TaskResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const SOURCE_LABEL: Record<SkillResponse['source'], string> = {
  template: 'Skill mẫu',
  created: 'Tự tạo',
  imported: 'Nhập từ tệp',
};

/** One editable row of the input-field editor. Options are typed as one comma-separated line. */
interface FieldRow {
  name: string;
  label: string;
  type: SkillFieldType;
  required: boolean;
  options: string;
}

const toRows = (fields: SkillField[]): FieldRow[] =>
  fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    required: f.required,
    options: (f.options ?? []).join(', '),
  }));

const toFields = (rows: FieldRow[]): SkillField[] =>
  rows.map((r) => ({
    name: r.name.trim(),
    label: r.label.trim(),
    type: r.type,
    required: r.required,
    ...(r.type === 'choice'
      ? {
          options: r.options
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
        }
      : {}),
  }));

export default function SkillsPage() {
  const me = useMe();
  const [skills, setSkills] = useState<SkillResponse[]>([]);
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [open, setOpen] = useState<{ id: string; mode: 'run' | 'edit' | 'info' } | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<SkillResponse[]>('/ai/skills')
      .then(setSkills)
      .catch((e: Error) => setError(e.message));
    api<AgentResponse[]>('/ai/agents')
      .then(setAgents)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  const installAll = () =>
    run(async () => {
      const created = await api<SkillResponse[]>('/ai/skills/templates', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setOk(created.length ? `Đã thêm ${created.length} Skill mẫu.` : 'Các Skill mẫu đã có đủ.');
      load();
    });

  const toggle = (s: SkillResponse) =>
    run(async () => {
      await api(`/ai/skills/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: s.status === 'active' ? 'paused' : 'active' }),
      });
      setOk(s.status === 'active' ? `Đã tắt “${s.name}”.` : `Đã bật “${s.name}”.`);
      load();
    });

  const remove = (s: SkillResponse) => {
    if (!confirm(`Xóa Skill “${s.name}”? Các công việc đã tạo từ Skill này vẫn giữ nguyên.`))
      return;
    void run(async () => {
      await api(`/ai/skills/${s.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${s.name}”.`);
      load();
    });
  };

  const exportFile = (s: SkillResponse) =>
    run(async () => {
      const manifest = await api<unknown>(`/ai/skills/${s.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${s.key}-${s.version}.maris-skill.json`;
      a.click();
      URL.revokeObjectURL(url);
      setOk(`Đã xuất “${s.name}” phiên bản ${s.version}.`);
    });

  async function importSkill(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    await run(async () => {
      let text = String(f.get('text') ?? '').trim();
      if (file instanceof File && file.size > 0) {
        if (file.size > 200_000) throw new Error('Tệp Skill quá lớn (tối đa 200 KB).');
        text = await file.text();
      }
      if (!text) throw new Error('Chọn tệp Skill hoặc dán nội dung tệp.');
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error('Nội dung không phải tệp Skill (JSON) hợp lệ.');
      }
      const s = await api<SkillResponse>('/ai/skills/import', {
        method: 'POST',
        body: JSON.stringify({ manifest, replace: f.get('replace') === 'on' }),
      });
      form.reset();
      setImporting(false);
      setOk(
        `Đã nhập “${s.name}” phiên bản ${s.version}. Skill đang tắt: đọc kỹ hướng dẫn rồi bấm Bật.`,
      );
      load();
    });
  }

  async function runSkill(s: SkillResponse, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const inputs: Record<string, string> = {};
    for (const field of s.inputs) inputs[field.name] = String(f.get(`in_${field.name}`) ?? '');
    await run(async () => {
      const agentId = String(f.get('agentId') ?? '') || null;
      const t = await api<TaskResponse>(`/ai/skills/${s.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ inputs, agentId }),
      });
      setOpen(null);
      setOk(
        <>
          Đã tạo công việc “{t.title}”. Công việc đang chờ duyệt ở trang{' '}
          <Link href="/tasks" className="underline">
            Giao việc
          </Link>
          ; AI chỉ chạy sau khi được duyệt.
        </>,
      );
    });
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Skill</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Skill là một việc AI làm đi làm lại, đóng gói sẵn: các ô cần nhập, hướng dẫn cho AI, tiêu
        chí đạt, mức quyền, ngân sách và thời gian tối đa. Chạy một Skill sẽ tạo một công việc chờ
        duyệt. Skill chỉ soạn văn bản, không chạy mã và không tự kết nối ra ngoài. Skill nhập từ tệp
        luôn ở trạng thái tắt cho tới khi bạn đọc và bật.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title={`Danh sách Skill (${skills.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={installAll} disabled={busy} className={btnCls}>
            Thêm các Skill mẫu
          </button>
          <button onClick={() => setImporting(!importing)} disabled={busy} className={btnGhostCls}>
            {importing ? 'Đóng nhập tệp' : 'Nhập Skill từ tệp'}
          </button>
        </div>
        {importing && (
          <form
            onSubmit={importSkill}
            className="mb-4 grid max-w-2xl gap-3 rounded-md border border-line p-3"
            autoComplete="off"
          >
            <label className="text-sm">
              Tệp Skill (.json đã xuất từ MARIS)
              <input
                name="file"
                type="file"
                accept=".json,application/json"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm">
              Hoặc dán nội dung tệp
              <textarea name="text" rows={4} className={`${inputCls} mt-1 font-mono text-xs`} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input name="replace" type="checkbox" /> Thay Skill cùng mã nếu đã có
            </label>
            <p className="text-xs text-muted">
              MARIS kiểm tra định dạng, quyền (chỉ được soạn văn bản), phụ thuộc và checksum. Tệp bị
              sửa sau khi xuất sẽ bị từ chối.
            </p>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Nhập Skill
            </button>
          </form>
        )}
        {skills.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có Skill nào. Bấm “Thêm các Skill mẫu” để có 6 Skill bán hàng, hoặc tạo Skill riêng
            ở khung bên dưới.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {skills.map((s) => {
              const mode = open?.id === s.id ? open.mode : null;
              const toggleMode = (m: 'run' | 'edit' | 'info') =>
                setOpen(mode === m ? null : { id: s.id, mode: m });
              return (
                <li key={s.id} className="py-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {s.name}
                        {s.status === 'paused' && (
                          <span className="ml-2 text-xs text-danger">(đang tắt)</span>
                        )}
                        <span className="ml-2 text-[11px] text-muted">v{s.version}</span>
                      </div>
                      <div className="text-xs text-muted">{s.description}</div>
                      <div className="text-[11px] text-muted">
                        {SOURCE_LABEL[s.source]} · Quyền: {ACCESS_LEVEL_LABEL[s.requiredLevel]} ·
                        Ngân sách ${s.budgetUsd} · Tối đa {s.timeoutSec} giây
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button
                        disabled={busy || s.status !== 'active'}
                        onClick={() => toggleMode('run')}
                        className={`${btnGhostCls} border-accent`}
                      >
                        {mode === 'run' ? 'Đóng' : 'Chạy'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => toggleMode('info')}
                        className={btnGhostCls}
                      >
                        {mode === 'info' ? 'Đóng' : 'Chi tiết'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => toggleMode('edit')}
                        className={btnGhostCls}
                      >
                        {mode === 'edit' ? 'Đóng' : 'Sửa'}
                      </button>
                      <button disabled={busy} onClick={() => exportFile(s)} className={btnGhostCls}>
                        Xuất tệp
                      </button>
                      <button disabled={busy} onClick={() => toggle(s)} className={btnGhostCls}>
                        {s.status === 'active' ? 'Tắt' : 'Bật'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => remove(s)}
                        className={`${btnGhostCls} border-danger text-danger`}
                      >
                        Xóa
                      </button>
                    </div>
                  </div>
                  {mode === 'run' && (
                    <form
                      onSubmit={(e) => runSkill(s, e)}
                      className="mt-3 grid max-w-2xl gap-3"
                      autoComplete="off"
                    >
                      {s.inputs.map((f) => (
                        <label key={f.name} className="text-sm">
                          {f.label}
                          {!f.required && (
                            <span className="text-xs text-muted"> (không bắt buộc)</span>
                          )}
                          {f.type === 'long_text' ? (
                            <textarea
                              name={`in_${f.name}`}
                              required={f.required}
                              rows={3}
                              maxLength={f.maxLength ?? 8000}
                              className={`${inputCls} mt-1`}
                            />
                          ) : f.type === 'choice' ? (
                            <select
                              name={`in_${f.name}`}
                              required={f.required}
                              className={`${inputCls} mt-1`}
                            >
                              {!f.required && <option value="">(không chọn)</option>}
                              {f.options?.map((o) => (
                                <option key={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              name={`in_${f.name}`}
                              required={f.required}
                              inputMode={f.type === 'number' ? 'decimal' : undefined}
                              maxLength={f.maxLength ?? 8000}
                              className={`${inputCls} mt-1`}
                            />
                          )}
                        </label>
                      ))}
                      <label className="text-sm">
                        Agent thực hiện
                        <select name="agentId" defaultValue="" className={`${inputCls} mt-1`}>
                          <option value="">Không chọn (AI mặc định)</option>
                          {agents
                            .filter((a) => a.status === 'active')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} ({ACCESS_LEVEL_LABEL[a.accessLevel]})
                              </option>
                            ))}
                        </select>
                      </label>
                      <button disabled={busy} className={`${btnCls} justify-self-start`}>
                        Tạo công việc chờ duyệt
                      </button>
                    </form>
                  )}
                  {mode === 'info' && (
                    <dl className="mt-3 grid max-w-3xl gap-x-4 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
                      <dt className="text-muted">Mã</dt>
                      <dd className="font-mono">{s.key}</dd>
                      <dt className="text-muted">Tác giả</dt>
                      <dd>{s.author}</dd>
                      <dt className="text-muted">Quyền xin</dt>
                      <dd className="font-mono">{s.permissions.join(', ')}</dd>
                      <dt className="text-muted">Phụ thuộc</dt>
                      <dd>{s.dependencies.length ? s.dependencies.join(', ') : 'Không có'}</dd>
                      <dt className="text-muted">Tương thích</dt>
                      <dd className="font-mono">MARIS {s.compatibility.maris}</dd>
                      <dt className="text-muted">Checksum</dt>
                      <dd className="break-all font-mono">{s.checksum}</dd>
                      <dt className="text-muted">Ô nhập</dt>
                      <dd>
                        {s.inputs
                          .map(
                            (f) =>
                              `${f.label} (${SKILL_FIELD_TYPE_LABEL[f.type]}${f.required ? '' : ', không bắt buộc'})`,
                          )
                          .join('; ') || 'Không có'}
                      </dd>
                      <dt className="text-muted">Hướng dẫn cho AI</dt>
                      <dd className="whitespace-pre-wrap">{s.instructions}</dd>
                      <dt className="text-muted">Tiêu chí đạt</dt>
                      <dd className="whitespace-pre-wrap">{s.successCriteria}</dd>
                      <dt className="text-muted">Cập nhật</dt>
                      <dd>{new Date(s.updatedAt).toLocaleString('vi-VN')}</dd>
                    </dl>
                  )}
                  {mode === 'edit' && (
                    <SkillForm
                      skill={s}
                      busy={busy}
                      submitLabel="Lưu (tăng phiên bản)"
                      onSubmit={(body) =>
                        run(async () => {
                          const u = await api<SkillResponse>(`/ai/skills/${s.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify(body),
                          });
                          setOpen(null);
                          setOk(`Đã lưu “${u.name}” (phiên bản ${u.version}).`);
                          load();
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Tạo Skill mới">
        <SkillForm
          busy={busy}
          withKey
          submitLabel="Tạo Skill"
          onSubmit={(body) =>
            run(async () => {
              const s = await api<SkillResponse>('/ai/skills', {
                method: 'POST',
                body: JSON.stringify(body),
              });
              setOk(`Đã tạo “${s.name}”.`);
              load();
            })
          }
        />
      </Panel>
    </Shell>
  );
}

function SkillForm({
  skill,
  busy,
  withKey,
  submitLabel,
  onSubmit,
}: {
  skill?: SkillResponse;
  busy: boolean;
  withKey?: boolean;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState<FieldRow[]>(
    skill
      ? toRows(skill.inputs)
      : [{ name: 'san_pham', label: 'Tên sản phẩm', type: 'text', required: true, options: '' }],
  );
  const setRow = (i: number, patch: Partial<FieldRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    await onSubmit({
      ...(withKey ? { key: text('key') } : {}),
      name: text('name'),
      description: text('description'),
      inputs: toFields(rows),
      instructions: text('instructions'),
      successCriteria: text('successCriteria'),
      requiredLevel: text('requiredLevel') as TaskLevel,
      budgetUsd: Number(text('budgetUsd').replace(',', '.')),
      timeoutSec: Number(text('timeoutSec')),
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 grid max-w-2xl gap-3" autoComplete="off">
      {withKey && (
        <label className="text-sm">
          Mã Skill (chữ thường không dấu, ví dụ <span className="font-mono">chao-khach-moi</span>)
          <input
            name="key"
            required
            pattern="[a-z0-9][a-z0-9_\-]{0,63}"
            className={`${inputCls} mt-1`}
          />
        </label>
      )}
      <label className="text-sm">
        Tên Skill
        <input
          name="name"
          required
          maxLength={80}
          defaultValue={skill?.name}
          className={`${inputCls} mt-1`}
        />
      </label>
      <label className="text-sm">
        Mô tả ngắn
        <input
          name="description"
          required
          maxLength={500}
          defaultValue={skill?.description}
          className={`${inputCls} mt-1`}
        />
      </label>

      <fieldset className="rounded-md border border-line p-3">
        <legend className="px-1 text-sm">Ô nhập khi chạy</legend>
        <p className="mb-2 text-xs text-muted">
          Tên ô dùng trong hướng dẫn bằng cách viết <span className="font-mono">{'{{ten_o}}'}</span>
          . Ô dạng lựa chọn cần danh sách, cách nhau bằng dấu phẩy.
        </p>
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_8rem_auto_auto]">
              <input
                aria-label="Tên ô"
                value={r.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="ten_o"
                className={`${inputCls} font-mono`}
              />
              <input
                aria-label="Nhãn"
                value={r.label}
                onChange={(e) => setRow(i, { label: e.target.value })}
                placeholder="Nhãn hiển thị"
                className={inputCls}
              />
              <select
                aria-label="Loại"
                value={r.type}
                onChange={(e) => setRow(i, { type: e.target.value as SkillFieldType })}
                className={inputCls}
              >
                {SKILL_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SKILL_FIELD_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={r.required}
                  onChange={(e) => setRow(i, { required: e.target.checked })}
                />{' '}
                Bắt buộc
              </label>
              <button
                type="button"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                className={`${btnGhostCls} text-danger`}
              >
                Bỏ
              </button>
              {r.type === 'choice' && (
                <input
                  aria-label="Lựa chọn"
                  value={r.options}
                  onChange={(e) => setRow(i, { options: e.target.value })}
                  placeholder="Shopee, TikTok Shop, Lazada"
                  className={`${inputCls} sm:col-span-5`}
                />
              )}
            </div>
          ))}
        </div>
        {rows.length < 12 && (
          <button
            type="button"
            onClick={() =>
              setRows([...rows, { name: '', label: '', type: 'text', required: true, options: '' }])
            }
            className={`${btnGhostCls} mt-2`}
          >
            + Thêm ô
          </button>
        )}
      </fieldset>

      <label className="text-sm">
        Hướng dẫn cho AI
        <textarea
          name="instructions"
          required
          maxLength={8000}
          rows={4}
          defaultValue={skill?.instructions}
          className={`${inputCls} mt-1`}
        />
      </label>
      <label className="text-sm">
        Tiêu chí đạt
        <input
          name="successCriteria"
          required
          maxLength={2000}
          defaultValue={skill?.successCriteria}
          className={`${inputCls} mt-1`}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          Mức quyền cần
          <select
            name="requiredLevel"
            defaultValue={skill?.requiredLevel ?? 'prepare'}
            className={`${inputCls} mt-1`}
          >
            {TASK_LEVELS.map((l) => (
              <option key={l} value={l}>
                {ACCESS_LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Ngân sách mỗi lần (USD)
          <input
            name="budgetUsd"
            required
            inputMode="decimal"
            defaultValue={skill?.budgetUsd ?? 0.5}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="text-sm">
          Thời gian tối đa (giây)
          <input
            name="timeoutSec"
            required
            type="number"
            min={10}
            max={600}
            defaultValue={skill?.timeoutSec ?? 120}
            className={`${inputCls} mt-1`}
          />
        </label>
      </div>
      <button disabled={busy} className={`${btnCls} justify-self-start`}>
        {submitLabel}
      </button>
    </form>
  );
}
