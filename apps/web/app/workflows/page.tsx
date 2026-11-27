'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ACCESS_LEVEL_LABEL,
  CONDITION_OPERATOR_LABEL,
  CONDITION_OPERATORS,
  SKILL_FIELD_TYPE_LABEL,
  SKILL_FIELD_TYPES,
  TASK_LEVELS,
  WORKFLOW_NODE_LABEL,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_RUN_STATUS_LABEL,
  type AgentResponse,
  type ConditionOperator,
  type ConnectorResponse,
  type SkillField,
  type SkillFieldType,
  type SkillResponse,
  type TaskLevel,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowResponse,
  type WorkflowRunDetailResponse,
  type WorkflowRunResponse,
  type WorkflowRunStatus,
  type WorkflowTestResponse,
  type WorkflowVersionResponse,
} from '@maris/contracts';
import { Markdown } from '@/components/Markdown';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

type Tab = 'design' | 'run' | 'runs' | 'versions';
const TABS: [Tab, string][] = [
  ['design', 'Thiết kế'],
  ['run', 'Chạy'],
  ['runs', 'Lần chạy'],
  ['versions', 'Phiên bản'],
];
const SOURCE_LABEL: Record<WorkflowResponse['source'], string> = {
  template: 'Mẫu',
  created: 'Tự tạo',
  imported: 'Nhập từ tệp',
  copied: 'Sao chép',
};
const RUN_COLOR: Partial<Record<WorkflowRunStatus, string>> = {
  running: 'text-accent',
  waiting_approval: 'text-accent',
  completed: 'text-green-500',
  failed: 'text-danger',
  cancelled: 'text-muted',
  paused: 'text-muted',
};
const FINISHED: WorkflowRunStatus[] = ['completed', 'failed', 'cancelled'];
/** A node being edited: any field of any type may be present. */
type EditNode = WorkflowNode & Record<string, unknown>;

export default function WorkflowsPage() {
  const me = useMe();
  const [workflows, setWorkflows] = useState<WorkflowResponse[]>([]);
  const [skills, setSkills] = useState<SkillResponse[]>([]);
  const [connectors, setConnectors] = useState<ConnectorResponse[]>([]);
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('design');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<WorkflowResponse[]>('/workflows')
      .then(setWorkflows)
      .catch((e: Error) => setError(e.message));
    api<SkillResponse[]>('/ai/skills')
      .then(setSkills)
      .catch(() => undefined);
    api<AgentResponse[]>('/ai/agents')
      .then(setAgents)
      .catch(() => undefined);
    api<ConnectorResponse[]>('/connectors')
      .then(setConnectors)
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
      const r = await api<{ created: WorkflowResponse[]; missingSkills: string[] }>(
        '/workflows/templates',
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (r.created.length) setOk(`Đã thêm ${r.created.length} Workflow mẫu.`);
      else if (r.missingSkills.length)
        setOk(
          <>
            Workflow mẫu cần các Skill mẫu. Vào trang{' '}
            <Link href="/skills" className="underline">
              Skill
            </Link>{' '}
            bấm “Thêm các Skill mẫu” rồi quay lại.
          </>,
        );
      else setOk('Các Workflow mẫu đã có đủ.');
      load();
    });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const graph = {
        maxSteps: 50,
        nodes: [
          {
            id: 'bat_dau',
            type: 'trigger',
            label: 'Bắt đầu',
            inputs: [{ name: 'noi_dung', label: 'Nội dung', type: 'long_text', required: true }],
          },
          { id: 'xong', type: 'end', label: 'Kết thúc' },
        ],
      };
      const w = await api<WorkflowResponse>('/workflows', {
        method: 'POST',
        body: JSON.stringify({
          key: String(f.get('key')).trim(),
          name: String(f.get('name')).trim(),
          description: String(f.get('description') ?? '').trim(),
          graph,
        }),
      });
      setCreating(false);
      setSelected(w.id);
      setTab('design');
      setOk(`Đã tạo “${w.name}”. Thêm các bước rồi bấm Lưu.`);
      load();
    });
  }

  async function importFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    await run(async () => {
      let text = String(f.get('text') ?? '').trim();
      if (file instanceof File && file.size > 0) {
        if (file.size > 500_000) throw new Error('Tệp Workflow quá lớn (tối đa 500 KB).');
        text = await file.text();
      }
      if (!text) throw new Error('Chọn tệp Workflow hoặc dán nội dung tệp.');
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error('Nội dung không phải tệp Workflow (JSON) hợp lệ.');
      }
      const w = await api<WorkflowResponse>('/workflows/import', {
        method: 'POST',
        body: JSON.stringify({ manifest, replace: f.get('replace') === 'on' }),
      });
      form.reset();
      setImporting(false);
      setSelected(w.id);
      setOk(`Đã nhập “${w.name}”. Workflow đang tắt: xem kỹ các bước rồi bấm Bật.`);
      load();
    });
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const current = workflows.find((w) => w.id === selected) ?? null;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Workflow</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Workflow là dây chuyền nhiều bước: AI, Skill, điều kiện rẽ nhánh, chờ duyệt, chờ thời gian,
        điểm lưu. Bấm “Bắt đầu chạy” là bạn duyệt chi phí AI của cả lần chạy (tối đa ngân sách bạn
        nhập); các bước “Duyệt” vẫn dừng lại chờ bạn. Mọi bước AI chỉ soạn văn bản, không tự đăng
        bài hay gửi tin.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title={`Danh sách Workflow (${workflows.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={installAll} disabled={busy} className={btnCls}>
            Thêm Workflow mẫu
          </button>
          <button onClick={() => setCreating(!creating)} disabled={busy} className={btnGhostCls}>
            {creating ? 'Đóng' : '+ Tạo Workflow'}
          </button>
          <button onClick={() => setImporting(!importing)} disabled={busy} className={btnGhostCls}>
            {importing ? 'Đóng nhập tệp' : 'Nhập từ tệp'}
          </button>
        </div>
        {creating && (
          <form
            onSubmit={create}
            className="mb-4 grid max-w-2xl gap-3 rounded-md border border-line p-3"
            autoComplete="off"
          >
            <label className="text-sm">
              Mã (chữ thường không dấu, ví dụ <span className="font-mono">cham-soc-khach</span>)
              <input
                name="key"
                required
                pattern="[a-z0-9][a-z0-9_\-]{0,63}"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm">
              Tên
              <input name="name" required maxLength={80} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-sm">
              Mô tả ngắn
              <input name="description" maxLength={500} className={`${inputCls} mt-1`} />
            </label>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Tạo
            </button>
          </form>
        )}
        {importing && (
          <form
            onSubmit={importFile}
            className="mb-4 grid max-w-2xl gap-3 rounded-md border border-line p-3"
            autoComplete="off"
          >
            <label className="text-sm">
              Tệp Workflow (.json đã xuất từ MARIS)
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
              <input name="replace" type="checkbox" /> Thay Workflow cùng mã nếu đã có (lưu thành
              phiên bản mới)
            </label>
            <p className="text-xs text-muted">
              MARIS kiểm tra các bước, checksum, và các Skill, Agent mà Workflow dùng phải có sẵn ở
              đây.
            </p>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Nhập Workflow
            </button>
          </form>
        )}
        {workflows.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có Workflow nào. Bấm “Thêm Workflow mẫu” để có 2 dây chuyền bán hàng, hoặc tự tạo.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {workflows.map((w) => (
              <li key={w.id} className="py-2">
                <button
                  onClick={() => setSelected(w.id === selected ? null : w.id)}
                  className="w-full text-left"
                >
                  <div className={`font-medium ${w.id === selected ? 'text-accent' : ''}`}>
                    {w.name}
                    {w.status === 'paused' && (
                      <span className="ml-2 text-xs text-danger">(đang tắt)</span>
                    )}
                    <span className="ml-2 text-[11px] text-muted">phiên bản {w.version}</span>
                  </div>
                  {w.description && <div className="text-xs text-muted">{w.description}</div>}
                  <div className="text-[11px] text-muted">
                    {SOURCE_LABEL[w.source]} · {w.graph.nodes.length} bước · tối đa{' '}
                    {w.graph.maxSteps} lượt chạy bước
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {current && (
        <WorkflowPanel
          key={`${current.id}-${current.version}`}
          wf={current}
          skills={skills}
          connectors={connectors}
          agents={agents}
          tab={tab}
          setTab={setTab}
          busy={busy}
          run={run}
          setOk={setOk}
          reload={load}
          onDeleted={() => setSelected(null)}
        />
      )}
    </Shell>
  );
}

function WorkflowPanel({
  wf,
  skills,
  connectors,
  agents,
  tab,
  setTab,
  busy,
  run,
  setOk,
  reload,
  onDeleted,
}: {
  wf: WorkflowResponse;
  skills: SkillResponse[];
  connectors: ConnectorResponse[];
  agents: AgentResponse[];
  tab: Tab;
  setTab: (t: Tab) => void;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setOk: (n: ReactNode) => void;
  reload: () => void;
  onDeleted: () => void;
}) {
  const toggle = () =>
    run(async () => {
      await api(`/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: wf.status === 'active' ? 'paused' : 'active' }),
      });
      setOk(wf.status === 'active' ? `Đã tắt “${wf.name}”.` : `Đã bật “${wf.name}”.`);
      reload();
    });
  const copy = () => {
    const key = prompt('Mã cho bản sao (chữ thường không dấu):', `${wf.key}-ban-sao`);
    if (!key) return;
    void run(async () => {
      const c = await api<WorkflowResponse>(`/workflows/${wf.id}/copy`, {
        method: 'POST',
        body: JSON.stringify({ key, name: `${wf.name} (bản sao)` }),
      });
      setOk(`Đã sao chép thành “${c.name}”.`);
      reload();
    });
  };
  const exportFile = () =>
    run(async () => {
      const manifest = await api<unknown>(`/workflows/${wf.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${wf.key}-v${wf.version}.maris-workflow.json`;
      a.click();
      URL.revokeObjectURL(url);
      setOk(`Đã xuất “${wf.name}” phiên bản ${wf.version}.`);
    });
  const remove = () => {
    if (!confirm(`Xóa Workflow “${wf.name}”? Lịch sử các lần chạy vẫn giữ trong nhật ký.`)) return;
    void run(async () => {
      await api(`/workflows/${wf.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${wf.name}”.`);
      onDeleted();
      reload();
    });
  };

  return (
    <section id="workflow-detail" className="mb-6 rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {wf.name} <span className="text-xs font-normal text-muted">phiên bản {wf.version}</span>
          </h2>
          <div className="font-mono text-[11px] text-muted">{wf.key}</div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy} onClick={toggle} className={btnGhostCls}>
            {wf.status === 'active' ? 'Tắt' : 'Bật'}
          </button>
          <button disabled={busy} onClick={copy} className={btnGhostCls}>
            Sao chép
          </button>
          <button disabled={busy} onClick={exportFile} className={btnGhostCls}>
            Xuất tệp
          </button>
          <button
            disabled={busy}
            onClick={remove}
            className={`${btnGhostCls} border-danger text-danger`}
          >
            Xóa
          </button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line pb-2">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`${btnGhostCls} ${tab === t ? 'border-accent text-accent' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'design' && (
        <Designer
          wf={wf}
          skills={skills}
          connectors={connectors}
          agents={agents}
          busy={busy}
          run={run}
          setOk={setOk}
          reload={reload}
        />
      )}
      {tab === 'run' && (
        <RunForm wf={wf} busy={busy} run={run} setOk={setOk} onStarted={() => setTab('runs')} />
      )}
      {tab === 'runs' && <Runs wf={wf} busy={busy} run={run} />}
      {tab === 'versions' && (
        <Versions wf={wf} busy={busy} run={run} setOk={setOk} reload={reload} />
      )}
    </section>
  );
}

/* ---------------- design ---------------- */

function newNode(type: WorkflowNodeType, taken: string[]): EditNode {
  let i = 1;
  while (taken.includes(`${type}_${i}`)) i += 1;
  const id = `${type}_${i}`;
  const label = WORKFLOW_NODE_LABEL[type];
  switch (type) {
    case 'trigger':
      return { id, type, label, inputs: [] } as EditNode;
    case 'ai':
      return {
        id,
        type,
        label,
        prompt: '',
        agentKey: null,
        requiredLevel: 'prepare',
        budgetUsd: 0.2,
        timeoutSec: 120,
      } as EditNode;
    case 'skill':
      return { id, type, label, skillKey: '', inputs: {}, agentKey: null } as EditNode;
    case 'connector':
      return { id, type, label, connectorKey: '', capability: '', inputs: {} } as EditNode;
    case 'condition':
      return {
        id,
        type,
        label,
        value: '',
        operator: 'contains',
        compare: '',
        then: null,
        else: null,
      } as EditNode;
    case 'approval':
      return {
        id,
        type,
        label,
        message: 'Xem kết quả trước khi dùng.',
        onReject: null,
      } as EditNode;
    case 'delay':
      return { id, type, label, seconds: 60 } as EditNode;
    default:
      return { id, type, label } as EditNode;
  }
}

function Designer({
  wf,
  skills,
  connectors,
  agents,
  busy,
  run,
  setOk,
  reload,
}: {
  wf: WorkflowResponse;
  skills: SkillResponse[];
  connectors: ConnectorResponse[];
  agents: AgentResponse[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setOk: (n: ReactNode) => void;
  reload: () => void;
}) {
  const [nodes, setNodes] = useState<EditNode[]>(
    () => structuredClone(wf.graph.nodes) as EditNode[],
  );
  const [maxSteps, setMaxSteps] = useState(wf.graph.maxSteps);
  const [note, setNote] = useState('');
  const [addType, setAddType] = useState<WorkflowNodeType>('ai');
  const ids = nodes.map((n) => n.id);
  const set = (i: number, patch: Record<string, unknown>) =>
    setNodes(nodes.map((n, j) => (j === i ? ({ ...n, ...patch } as EditNode) : n)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 1 || j >= nodes.length) return;
    const copy = [...nodes];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    setNodes(copy);
  };

  const save = () =>
    run(async () => {
      const graph: WorkflowGraph = { maxSteps, nodes: nodes as WorkflowNode[] };
      const u = await api<WorkflowResponse>(`/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ graph, note: note || undefined }),
      });
      setOk(
        u.version === wf.version
          ? 'Không có thay đổi ở các bước.'
          : `Đã lưu phiên bản ${u.version}.`,
      );
      reload();
    });

  const targetOptions = (self: string, endLabel: string) => (
    <>
      <option value="">{endLabel}</option>
      {nodes
        .filter((n) => n.id !== self && n.type !== 'trigger')
        .map((n) => (
          <option key={n.id} value={n.id}>
            {n.label} ({n.id})
          </option>
        ))}
    </>
  );

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">
        Viết <span className="font-mono">{'{{input.ten_o}}'}</span> để lấy ô nhập ở bước Bắt đầu,{' '}
        <span className="font-mono">{'{{steps.ma_buoc}}'}</span> để lấy kết quả của một bước trước.
        Mỗi lần lưu tạo một phiên bản mới; lần chạy đang dở vẫn dùng phiên bản cũ.
      </p>
      <ol className="grid gap-3">
        {nodes.map((n, i) => (
          <li key={i} className="rounded-md border border-line p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-bg px-2 py-0.5 text-xs text-accent">
                {i + 1}. {WORKFLOW_NODE_LABEL[n.type]}
              </span>
              <input
                aria-label="Mã bước"
                value={n.id}
                onChange={(e) => set(i, { id: e.target.value })}
                className={`${inputCls} w-40 font-mono text-xs`}
              />
              <input
                aria-label="Tên bước"
                value={n.label}
                onChange={(e) => set(i, { label: e.target.value })}
                className={`${inputCls} min-w-0 flex-1`}
              />
              {n.type !== 'trigger' && (
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i <= 1}
                    className={btnGhostCls}
                    aria-label="Lên"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i >= nodes.length - 1}
                    className={btnGhostCls}
                    aria-label="Xuống"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setNodes(nodes.filter((_, j) => j !== i))}
                    className={`${btnGhostCls} text-danger`}
                  >
                    Bỏ
                  </button>
                </span>
              )}
            </div>
            <NodeFields
              node={n}
              skills={skills}
              connectors={connectors}
              agents={agents}
              set={(p) => set(i, p)}
              targetOptions={targetOptions}
            />
            {!['condition', 'end'].includes(n.type) && (
              <label className="mt-2 block text-xs">
                Bước tiếp theo
                <select
                  value={n.next === undefined ? '__below' : (n.next ?? '')}
                  onChange={(e) =>
                    set(i, {
                      next: e.target.value === '__below' ? undefined : e.target.value || null,
                    })
                  }
                  className={`${inputCls} mt-1`}
                >
                  <option value="__below">Bước ngay bên dưới</option>
                  {targetOptions(n.id, 'Kết thúc lần chạy')}
                </select>
              </label>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={addType}
          onChange={(e) => setAddType(e.target.value as WorkflowNodeType)}
          className={`${inputCls} w-48`}
          aria-label="Loại bước"
        >
          {WORKFLOW_NODE_TYPES.filter((t) => t !== 'trigger').map((t) => (
            <option key={t} value={t}>
              {WORKFLOW_NODE_LABEL[t]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNodes([...nodes, newNode(addType, ids)])}
          disabled={nodes.length >= 30}
          className={btnGhostCls}
        >
          + Thêm bước
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Giới hạn số lượt chạy bước mỗi lần (chặn vòng lặp vô hạn)
          <input
            type="number"
            min={1}
            max={200}
            value={maxSteps}
            onChange={(e) => setMaxSteps(Number(e.target.value))}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="text-sm">
          Ghi chú phiên bản (không bắt buộc)
          <input
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputCls} mt-1`}
          />
        </label>
      </div>
      <button disabled={busy} onClick={save} className={`${btnCls} justify-self-start`}>
        Lưu thành phiên bản mới
      </button>
    </div>
  );
}

function NodeFields({
  node,
  skills,
  connectors,
  agents,
  set,
  targetOptions,
}: {
  node: EditNode;
  skills: SkillResponse[];
  connectors: ConnectorResponse[];
  agents: AgentResponse[];
  set: (patch: Record<string, unknown>) => void;
  targetOptions: (self: string, endLabel: string) => ReactNode;
}) {
  const agentSelect = (
    <label className="text-xs">
      Agent thực hiện
      <select
        value={(node.agentKey as string | null) ?? ''}
        onChange={(e) => set({ agentKey: e.target.value || null })}
        className={`${inputCls} mt-1`}
      >
        <option value="">Không chọn (AI mặc định)</option>
        {agents.map((a) => (
          <option key={a.id} value={a.key}>
            {a.name} ({ACCESS_LEVEL_LABEL[a.accessLevel]})
          </option>
        ))}
      </select>
    </label>
  );
  switch (node.type) {
    case 'trigger':
      return <FieldsEditor fields={node.inputs} onChange={(inputs) => set({ inputs })} />;
    case 'ai':
      return (
        <div className="grid gap-2">
          <label className="text-xs">
            Yêu cầu cho AI
            <textarea
              value={node.prompt}
              rows={3}
              maxLength={8000}
              onChange={(e) => set({ prompt: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-4">
            {agentSelect}
            <label className="text-xs">
              Mức quyền
              <select
                value={node.requiredLevel}
                onChange={(e) => set({ requiredLevel: e.target.value as TaskLevel })}
                className={`${inputCls} mt-1`}
              >
                {TASK_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {ACCESS_LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Ngân sách bước (USD)
              <input
                value={node.budgetUsd}
                inputMode="decimal"
                onChange={(e) => set({ budgetUsd: Number(e.target.value.replace(',', '.')) || 0 })}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-xs">
              Tối đa (giây)
              <input
                type="number"
                min={10}
                max={600}
                value={node.timeoutSec}
                onChange={(e) => set({ timeoutSec: Number(e.target.value) })}
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>
        </div>
      );
    case 'skill': {
      const skill = skills.find((s) => s.key === node.skillKey);
      return (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              Skill
              <select
                value={node.skillKey}
                onChange={(e) => set({ skillKey: e.target.value, inputs: {} })}
                className={`${inputCls} mt-1`}
              >
                <option value="">(chọn Skill)</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.key}>
                    {s.name}
                    {s.status === 'paused' ? ' (đang tắt)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {agentSelect}
          </div>
          {skill?.inputs.map((f) => (
            <label key={f.name} className="text-xs">
              {f.label}
              {!f.required && ' (không bắt buộc)'}
              {f.type === 'choice' ? ` · chọn một: ${f.options?.join(', ')}` : ''}
              <input
                value={node.inputs[f.name] ?? ''}
                onChange={(e) => set({ inputs: { ...node.inputs, [f.name]: e.target.value } })}
                placeholder="{{input.ten_o}} hoặc chữ cố định"
                className={`${inputCls} mt-1`}
              />
            </label>
          ))}
        </div>
      );
    }
    case 'connector': {
      const usable = connectors.filter((c) => c.kind === 'http');
      const conn = usable.find((c) => c.key === node.connectorKey);
      const cap = conn?.capabilities.find((c) => c.key === node.capability);
      return (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              Connector
              <select
                value={node.connectorKey}
                onChange={(e) => set({ connectorKey: e.target.value, capability: '', inputs: {} })}
                className={`${inputCls} mt-1`}
              >
                <option value="">(chọn Connector)</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.key}>
                    {c.name}
                    {c.status !== 'active' ? ' (chưa bật)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Thao tác
              <select
                value={node.capability}
                onChange={(e) => set({ capability: e.target.value, inputs: {} })}
                className={`${inputCls} mt-1`}
              >
                <option value="">(chọn thao tác)</option>
                {conn?.capabilities.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                    {c.risk === 'write' ? ' (gửi ra ngoài)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {cap?.risk === 'write' && (
            <p className="text-xs text-accent">
              Bước này gửi hoặc thay đổi dữ liệu bên ngoài MARIS. Nên đặt một bước Duyệt ngay trước
              nó.
            </p>
          )}
          {conn && conn.status !== 'active' && (
            <p className="text-xs text-danger">
              Connector này chưa bật: lần chạy sẽ dừng ở bước này cho tới khi người có quyền duyệt
              bật nó ở trang Connector.
            </p>
          )}
          {cap?.inputs.map((f) => (
            <label key={f.name} className="text-xs">
              {f.label}
              {!f.required && ' (không bắt buộc)'}
              <input
                value={node.inputs[f.name] ?? ''}
                onChange={(e) => set({ inputs: { ...node.inputs, [f.name]: e.target.value } })}
                placeholder="{{input.ten_o}}, {{steps.ma_buoc}} hoặc chữ cố định"
                className={`${inputCls} mt-1`}
              />
            </label>
          ))}
        </div>
      );
    }
    case 'condition':
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs">
            Giá trị cần xét
            <input
              value={node.value}
              onChange={(e) => set({ value: e.target.value })}
              placeholder="{{steps.ma_buoc}}"
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="text-xs">
            Phép so sánh
            <select
              value={node.operator}
              onChange={(e) => set({ operator: e.target.value as ConditionOperator })}
              className={`${inputCls} mt-1`}
            >
              {CONDITION_OPERATORS.map((o) => (
                <option key={o} value={o}>
                  {CONDITION_OPERATOR_LABEL[o]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            So với
            <input
              value={node.compare}
              onChange={(e) => set({ compare: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="text-xs">
            Nếu đúng, đi tới
            <select
              value={node.then ?? ''}
              onChange={(e) => set({ then: e.target.value || null })}
              className={`${inputCls} mt-1`}
            >
              {targetOptions(node.id, 'Kết thúc lần chạy')}
            </select>
          </label>
          <label className="text-xs">
            Nếu sai, đi tới
            <select
              value={node.else ?? ''}
              onChange={(e) => set({ else: e.target.value || null })}
              className={`${inputCls} mt-1`}
            >
              {targetOptions(node.id, 'Kết thúc lần chạy')}
            </select>
          </label>
        </div>
      );
    case 'approval':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Lời nhắn cho người duyệt
            <input
              value={node.message}
              onChange={(e) => set({ message: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="text-xs">
            Nếu bị từ chối, đi tới
            <select
              value={node.onReject ?? ''}
              onChange={(e) => set({ onReject: e.target.value || null })}
              className={`${inputCls} mt-1`}
            >
              {targetOptions(node.id, 'Dừng lần chạy (đã hủy)')}
            </select>
          </label>
        </div>
      );
    case 'delay':
      return (
        <label className="text-xs">
          Chờ bao nhiêu giây (tối đa 86400 = 1 ngày)
          <input
            type="number"
            min={1}
            max={86400}
            value={node.seconds}
            onChange={(e) => set({ seconds: Number(e.target.value) })}
            className={`${inputCls} mt-1 max-w-xs`}
          />
        </label>
      );
    case 'checkpoint':
      return (
        <p className="text-xs text-muted">
          Lưu lại kết quả tới đây. Nếu bước sau lỗi, có thể chạy tiếp từ điểm này mà không làm lại
          các bước trước.
        </p>
      );
    case 'end':
      return <p className="text-xs text-muted">Kết thúc lần chạy.</p>;
  }
}

function FieldsEditor({
  fields,
  onChange,
}: {
  fields: SkillField[];
  onChange: (f: SkillField[]) => void;
}) {
  const setRow = (i: number, patch: Partial<SkillField>) =>
    onChange(fields.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2">
      <div className="text-xs text-muted">Ô nhập khi bắt đầu chạy</div>
      {fields.map((r, i) => (
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
            onClick={() => onChange(fields.filter((_, j) => j !== i))}
            className={`${btnGhostCls} text-danger`}
          >
            Bỏ
          </button>
          {r.type === 'choice' && (
            <input
              aria-label="Lựa chọn"
              value={(r.options ?? []).join(', ')}
              onChange={(e) =>
                setRow(i, {
                  options: e.target.value
                    .split(',')
                    .map((o) => o.trim())
                    .filter(Boolean),
                })
              }
              placeholder="Lựa chọn 1, Lựa chọn 2"
              className={`${inputCls} sm:col-span-5`}
            />
          )}
        </div>
      ))}
      {fields.length < 12 && (
        <button
          type="button"
          onClick={() =>
            onChange([...fields, { name: '', label: '', type: 'text', required: true }])
          }
          className={`${btnGhostCls} justify-self-start`}
        >
          + Thêm ô
        </button>
      )}
    </div>
  );
}

/* ---------------- run ---------------- */

function RunForm({
  wf,
  busy,
  run,
  setOk,
  onStarted,
}: {
  wf: WorkflowResponse;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setOk: (n: ReactNode) => void;
  onStarted: () => void;
}) {
  const [trace, setTrace] = useState<WorkflowTestResponse | null>(null);
  const trigger = wf.graph.nodes[0] as Extract<WorkflowNode, { type: 'trigger' }>;
  const read = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const inputs: Record<string, string> = {};
    for (const field of trigger.inputs)
      inputs[field.name] = String(f.get(`in_${field.name}`) ?? '');
    return { inputs, budgetUsd: Number(String(f.get('budgetUsd') ?? '1').replace(',', '.')) };
  };
  const test = (form: HTMLFormElement | null) =>
    form &&
    run(async () => {
      setTrace(
        await api<WorkflowTestResponse>(`/workflows/${wf.id}/test`, {
          method: 'POST',
          body: JSON.stringify({ inputs: read(form).inputs }),
        }),
      );
    });
  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = read(e.currentTarget);
    await run(async () => {
      await api(`/workflows/${wf.id}/runs`, { method: 'POST', body: JSON.stringify(body) });
      setOk(`Đã bắt đầu chạy “${wf.name}”.`);
      onStarted();
    });
  }
  return (
    <div className="grid gap-4">
      <form onSubmit={start} className="grid max-w-2xl gap-3" autoComplete="off">
        {trigger.inputs.map((f) => (
          <label key={f.name} className="text-sm">
            {f.label}
            {!f.required && <span className="text-xs text-muted"> (không bắt buộc)</span>}
            {f.type === 'long_text' ? (
              <textarea
                name={`in_${f.name}`}
                required={f.required}
                rows={3}
                className={`${inputCls} mt-1`}
              />
            ) : f.type === 'choice' ? (
              <select name={`in_${f.name}`} required={f.required} className={`${inputCls} mt-1`}>
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
                className={`${inputCls} mt-1`}
              />
            )}
          </label>
        ))}
        <label className="text-sm">
          Ngân sách tối đa cho lần chạy này (USD)
          <input
            name="budgetUsd"
            required
            inputMode="decimal"
            defaultValue="1"
            className={`${inputCls} mt-1 max-w-xs`}
          />
          <span className="mt-1 block text-xs text-muted">
            Đây là mức trần của cả lần chạy. Mỗi bước AI được dùng tới ngân sách riêng của bước,
            nhưng không quá phần còn lại. Bấm “Chạy thử” để xem mức tốn tối đa.
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => test(e.currentTarget.form)}
            className={btnGhostCls}
          >
            Chạy thử (không tốn tiền)
          </button>
          <button disabled={busy || wf.status !== 'active'} className={btnCls}>
            Bắt đầu chạy (duyệt chi phí)
          </button>
        </div>
        {wf.status !== 'active' && (
          <p className="text-xs text-danger">
            Workflow đang tắt. Bật lên để chạy thật; chạy thử vẫn được.
          </p>
        )}
      </form>
      {trace && (
        <div className="rounded-md border border-line p-3 text-sm">
          <div className="mb-2 font-medium">
            Chạy thử:{' '}
            {trace.outcome === 'completed' ? 'đi hết dây chuyền' : 'dừng vì chạm giới hạn số bước'}{' '}
            · {trace.aiSteps} bước AI · tốn tối đa khoảng ${trace.maxBudgetUsd}
          </div>
          <ol className="grid gap-2">
            {trace.steps.map((s, i) => (
              <li key={i} className="rounded border border-line p-2 text-xs">
                <div className="font-medium">
                  {i + 1}. {s.label}{' '}
                  <span className="text-muted">({WORKFLOW_NODE_LABEL[s.nodeType]})</span>
                </div>
                {s.input && <pre className="mt-1 whitespace-pre-wrap text-muted">{s.input}</pre>}
                {s.output && <div className="mt-1">→ {s.output}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Runs({
  wf,
  busy,
  run,
}: {
  wf: WorkflowResponse;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [runs, setRuns] = useState<WorkflowRunResponse[]>([]);
  const [open, setOpen] = useState<WorkflowRunDetailResponse | null>(null);
  const loadRuns = useCallback(
    () => api<WorkflowRunResponse[]>(`/workflows/${wf.id}/runs`).then(setRuns),
    [wf.id],
  );
  useEffect(() => {
    void loadRuns().then(() => undefined);
  }, [loadRuns]);
  useEffect(() => {
    if (runs[0] && !open)
      void api<WorkflowRunDetailResponse>(`/workflows/runs/${runs[0].id}`).then(setOpen);
  }, [runs, open]);
  // Follow an unfinished run.
  useEffect(() => {
    if (!open || FINISHED.includes(open.status)) return;
    const t = setInterval(() => {
      void api<WorkflowRunDetailResponse>(`/workflows/runs/${open.id}`).then((d) => {
        setOpen(d);
        if (FINISHED.includes(d.status) || d.status !== open.status) void loadRuns();
      });
    }, 1500);
    return () => clearInterval(t);
  }, [open, loadRuns]);

  const act = (path: string, body?: unknown) =>
    open &&
    run(async () => {
      setOpen(
        await api<WorkflowRunDetailResponse>(`/workflows/runs/${open.id}/${path}`, {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        }),
      );
      await loadRuns();
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <ul className="divide-y divide-line text-sm">
        {runs.length === 0 && <li className="py-2 text-muted">Chưa chạy lần nào.</li>}
        {runs.map((r) => (
          <li key={r.id}>
            <button
              onClick={() =>
                void api<WorkflowRunDetailResponse>(`/workflows/runs/${r.id}`).then(setOpen)
              }
              className={`w-full py-2 text-left ${open?.id === r.id ? 'text-accent' : ''}`}
            >
              <div className={RUN_COLOR[r.status]}>{WORKFLOW_RUN_STATUS_LABEL[r.status]}</div>
              <div className="text-[11px] text-muted">
                {new Date(r.createdAt).toLocaleString('vi-VN')} · v{r.version} · $
                {r.costUsd.toFixed(4)}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div id="run-detail" className="min-w-0 text-sm">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`font-medium ${RUN_COLOR[open.status]}`}>
              {WORKFLOW_RUN_STATUS_LABEL[open.status]}
            </span>
            <span className="text-xs text-muted">
              phiên bản {open.version} · {open.stepsTaken} lượt bước · đã dùng $
              {open.costUsd.toFixed(4)} / ${open.budgetUsd}
              {open.status === 'running' && open.waitingFor === 'task' ? ' · AI đang làm' : ''}
              {open.status === 'running' && open.waitingFor === 'delay' ? ' · đang chờ' : ''}
            </span>
          </div>
          {open.errorMessage && (
            <Notice kind={open.status === 'failed' ? 'error' : 'info'}>{open.errorMessage}</Notice>
          )}
          <div className="mb-3 flex flex-wrap gap-1">
            {open.status === 'waiting_approval' && (
              <>
                <button disabled={busy} onClick={() => act('approve')} className={btnCls}>
                  Duyệt và chạy tiếp
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    const note = prompt('Lý do từ chối (không bắt buộc):') ?? undefined;
                    void act('reject', { note: note || undefined });
                  }}
                  className={`${btnGhostCls} border-danger text-danger`}
                >
                  Từ chối
                </button>
              </>
            )}
            {(open.status === 'running' || open.status === 'waiting_approval') && (
              <button disabled={busy} onClick={() => act('pause')} className={btnGhostCls}>
                Tạm dừng
              </button>
            )}
            {open.status === 'paused' && (
              <button disabled={busy} onClick={() => act('resume')} className={btnGhostCls}>
                Tiếp tục
              </button>
            )}
            {!FINISHED.includes(open.status) && (
              <button
                disabled={busy}
                onClick={() => act('cancel')}
                className={`${btnGhostCls} text-danger`}
              >
                Hủy lần chạy
              </button>
            )}
            {(open.status === 'failed' || open.status === 'cancelled') && open.hasCheckpoint && (
              <button disabled={busy} onClick={() => act('restore')} className={btnGhostCls}>
                Chạy tiếp từ điểm lưu
              </button>
            )}
          </div>
          <ol className="grid gap-2">
            {open.steps.map((s) => (
              <li key={s.seq} className="rounded-md border border-line p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">
                    {s.seq}. {s.label}
                  </span>
                  <span className="text-muted">{WORKFLOW_NODE_LABEL[s.nodeType]}</span>
                  <span
                    className={
                      s.status === 'failed'
                        ? 'text-danger'
                        : s.status === 'completed'
                          ? 'text-green-500'
                          : 'text-accent'
                    }
                  >
                    {
                      {
                        running: 'đang chạy',
                        waiting: 'đang chờ',
                        completed: 'xong',
                        failed: 'lỗi',
                        cancelled: 'đã hủy',
                      }[s.status]
                    }
                  </span>
                  {s.costUsd > 0 && <span className="text-muted">${s.costUsd.toFixed(4)}</span>}
                </div>
                {s.input && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted">Đầu vào</summary>
                    <pre className="mt-1 whitespace-pre-wrap">{s.input}</pre>
                  </details>
                )}
                {s.output &&
                  (s.nodeType === 'ai' || s.nodeType === 'skill' ? (
                    <details className="mt-1 text-xs" open>
                      <summary className="cursor-pointer text-muted">Kết quả</summary>
                      <div className="mt-1">
                        <Markdown text={s.output} />
                      </div>
                    </details>
                  ) : (
                    <div className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                      → {s.nodeType === 'trigger' ? 'Đã nhận dữ liệu' : s.output}
                    </div>
                  ))}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Versions({
  wf,
  busy,
  run,
  setOk,
  reload,
}: {
  wf: WorkflowResponse;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setOk: (n: ReactNode) => void;
  reload: () => void;
}) {
  const [list, setList] = useState<WorkflowVersionResponse[]>([]);
  useEffect(() => {
    void api<WorkflowVersionResponse[]>(`/workflows/${wf.id}/versions`).then(setList);
  }, [wf.id, wf.version]);
  const restore = (v: number) =>
    run(async () => {
      const u = await api<WorkflowResponse>(`/workflows/${wf.id}/versions/${v}/restore`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setOk(`Đã khôi phục phiên bản ${v} thành phiên bản ${u.version}.`);
      reload();
    });
  return (
    <ul className="divide-y divide-line text-sm">
      {list.map((v) => (
        <li key={v.version} className="flex flex-wrap items-center gap-2 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              Phiên bản {v.version}
              {v.version === wf.version && (
                <span className="ml-2 text-xs text-accent">(đang dùng)</span>
              )}
            </div>
            <div className="text-[11px] text-muted">
              {new Date(v.createdAt).toLocaleString('vi-VN')} · {v.nodes} bước
              {v.note ? ` · ${v.note}` : ''} ·{' '}
              <span className="font-mono">{v.checksum.slice(0, 12)}</span>
            </div>
          </div>
          {v.version !== wf.version && (
            <button disabled={busy} onClick={() => restore(v.version)} className={btnGhostCls}>
              Khôi phục
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
