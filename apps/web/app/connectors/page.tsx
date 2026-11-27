'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  CAPABILITY_RISK_LABEL,
  CONNECTOR_AUTH_LABEL,
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_KIND_LABEL,
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_TEMPLATES,
  type ConnectorAuth,
  type ConnectorAuthType,
  type ConnectorCallResponse,
  type ConnectorCapability,
  type ConnectorKind,
  type ConnectorResponse,
  type ConnectorTokenResponse,
  type SecretResponse,
  type WebhookEventResponse,
  type WorkflowResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api, API_URL } from '@/lib/api';
import { useMe } from '@/lib/useMe';

type Tab = 'capabilities' | 'settings' | 'calls' | 'webhook';
const STATUS_COLOR: Record<ConnectorResponse['status'], string> = {
  draft: 'text-accent',
  active: 'text-green-500',
  paused: 'text-muted',
};
const SAMPLE_CAPABILITIES = `[
  {
    "key": "lay_thong_tin",
    "label": "Lấy thông tin",
    "risk": "read",
    "method": "GET",
    "path": "/thong-tin/{{input.ma}}",
    "inputs": [{ "name": "ma", "label": "Mã", "type": "text" }]
  }
]`;

export default function ConnectorsPage() {
  const me = useMe();
  const [items, setItems] = useState<ConnectorResponse[]>([]);
  const [secrets, setSecrets] = useState<SecretResponse[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('capabilities');
  const [mode, setMode] = useState<'create' | 'import' | null>(null);
  // A new webhook token is shown once; it lives here so reloading the connector does not hide it.
  const [token, setToken] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ConnectorResponse[]>('/connectors')
      .then(setItems)
      .catch((e: Error) => setError(e.message));
    api<SecretResponse[]>('/secrets')
      .then(setSecrets)
      .catch(() => undefined);
    api<WorkflowResponse[]>('/workflows')
      .then(setWorkflows)
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
      const created = await api<ConnectorResponse[]>('/connectors/templates', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setOk(
        created.length
          ? `Đã thêm ${created.length} Connector mẫu. Tất cả đang "Chưa kích hoạt": làm theo phần Chuẩn bị của từng cái rồi bấm Kích hoạt.`
          : 'Các Connector mẫu đã có đủ.',
      );
      load();
    });

  async function importFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    await run(async () => {
      let text = String(f.get('text') ?? '').trim();
      if (file instanceof File && file.size > 0) {
        if (file.size > 200_000) throw new Error('Tệp quá lớn (tối đa 200 KB).');
        text = await file.text();
      }
      if (!text) throw new Error('Chọn tệp Connector hoặc dán nội dung tệp.');
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error('Nội dung không phải tệp Connector (JSON) hợp lệ.');
      }
      const c = await api<ConnectorResponse>('/connectors/import', {
        method: 'POST',
        body: JSON.stringify({ manifest, replace: f.get('replace') === 'on' }),
      });
      form.reset();
      setMode(null);
      setSelected(c.id);
      setOk(`Đã nhập “${c.name}”. Connector chưa kích hoạt: đọc kỹ các thao tác rồi mới bật.`);
      load();
    });
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const current = items.find((c) => c.id === selected) ?? null;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Connector</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Connector nối MARIS với dịch vụ bên ngoài (Telegram, GitHub, n8n, Make, API riêng). Mỗi
        Connector khai báo rõ các thao tác được phép, thao tác nào chỉ đọc và thao tác nào gửi ra
        ngoài. Khóa đăng nhập nằm trong{' '}
        <Link href="/secrets" className="underline">
          Secret Vault
        </Link>
        , Connector chỉ ghi tên của khóa. Connector mới, nhập từ tệp hoặc vừa đổi địa chỉ đều ở
        trạng thái “Chưa kích hoạt” cho tới khi người có quyền duyệt bật lên. Dữ liệu nhận về chỉ là
        dữ liệu, AI không coi đó là mệnh lệnh.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title={`Danh sách Connector (${items.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={installAll} disabled={busy} className={btnCls}>
            Thêm Connector mẫu
          </button>
          <button
            onClick={() => setMode(mode === 'create' ? null : 'create')}
            disabled={busy}
            className={btnGhostCls}
          >
            {mode === 'create' ? 'Đóng' : '+ Tạo Connector'}
          </button>
          <button
            onClick={() => setMode(mode === 'import' ? null : 'import')}
            disabled={busy}
            className={btnGhostCls}
          >
            {mode === 'import' ? 'Đóng nhập tệp' : 'Nhập từ tệp'}
          </button>
        </div>
        {mode === 'import' && (
          <form
            onSubmit={importFile}
            className="mb-4 grid max-w-2xl gap-3 rounded-md border border-line p-3"
            autoComplete="off"
          >
            <label className="text-sm">
              Tệp Connector (.json đã xuất từ MARIS)
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
              <input name="replace" type="checkbox" /> Thay Connector cùng mã nếu đã có
            </label>
            <p className="text-xs text-muted">
              Tệp không chứa khóa bí mật, chỉ có tên khóa cần dùng. Tệp bị sửa sau khi xuất sẽ bị từ
              chối.
            </p>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Nhập Connector
            </button>
          </form>
        )}
        {mode === 'create' && (
          <ConnectorForm
            secrets={secrets}
            workflows={workflows}
            busy={busy}
            onSubmit={(body) =>
              run(async () => {
                const c = await api<ConnectorResponse>('/connectors', {
                  method: 'POST',
                  body: JSON.stringify(body),
                });
                setMode(null);
                setSelected(c.id);
                setTab('capabilities');
                setOk(`Đã tạo “${c.name}” (chưa kích hoạt).`);
                load();
              })
            }
          />
        )}
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có Connector nào. Bấm “Thêm Connector mẫu” để có Telegram, GitHub, n8n và một cổng
            nhận Webhook.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {items.map((c) => (
              <li key={c.id} className="py-2">
                <button
                  onClick={() => {
                    setSelected(c.id === selected ? null : c.id);
                    setTab(c.kind === 'webhook' ? 'webhook' : 'capabilities');
                  }}
                  className="w-full text-left"
                >
                  <div className="font-medium">
                    <span className={c.id === selected ? 'text-accent' : ''}>{c.name}</span>
                    <span className={`ml-2 text-xs ${STATUS_COLOR[c.status]}`}>
                      {CONNECTOR_STATUS_LABEL[c.status]}
                    </span>
                  </div>
                  <div className="text-xs text-muted">{c.description || c.key}</div>
                  <div className="text-[11px] text-muted">
                    {CONNECTOR_KIND_LABEL[c.kind]}
                    {c.baseUrl ? ` · ${c.baseUrl}` : ''}
                    {c.kind === 'http' ? ` · ${c.capabilities.length} thao tác` : ''}
                    {c.missingSecrets.length > 0 && (
                      <span className="text-danger">
                        {' '}
                        · Thiếu secret: {c.missingSecrets.join(', ')}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {current && (
        <ConnectorPanel
          key={`${current.id}-${current.updatedAt}`}
          c={current}
          tab={tab}
          setTab={setTab}
          secrets={secrets}
          workflows={workflows}
          busy={busy}
          run={run}
          setOk={setOk}
          reload={load}
          onDeleted={() => setSelected(null)}
          token={token?.id === current.id ? token.value : null}
          setToken={(value) => setToken({ id: current.id, value })}
        />
      )}
    </Shell>
  );
}

function ConnectorPanel({
  c,
  tab,
  setTab,
  secrets,
  workflows,
  busy,
  run,
  setOk,
  reload,
  onDeleted,
  token,
  setToken,
}: {
  c: ConnectorResponse;
  tab: Tab;
  setTab: (t: Tab) => void;
  secrets: SecretResponse[];
  workflows: WorkflowResponse[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setOk: (n: ReactNode) => void;
  reload: () => void;
  onDeleted: () => void;
  token: string | null;
  setToken: (token: string) => void;
}) {
  const template = CONNECTOR_TEMPLATES.find((t) => t.key === c.key);
  const tabs: [Tab, string][] =
    c.kind === 'webhook'
      ? [
          ['webhook', 'Webhook'],
          ['settings', 'Cấu hình'],
        ]
      : [
          ['capabilities', 'Thao tác'],
          ['settings', 'Cấu hình'],
          ['calls', 'Nhật ký gọi'],
        ];
  const shown = tabs.some(([t]) => t === tab) ? tab : tabs[0]![0];

  const activate = () =>
    run(async () => {
      await api(`/connectors/${c.id}/activate`, { method: 'POST', body: '{}' });
      setOk(`Đã bật “${c.name}”. Workflow có thể dùng Connector này.`);
      reload();
    });
  const pause = () =>
    run(async () => {
      await api(`/connectors/${c.id}/pause`, { method: 'POST', body: '{}' });
      setOk(`Đã tạm tắt “${c.name}”.`);
      reload();
    });
  const exportFile = () =>
    run(async () => {
      const manifest = await api<unknown>(`/connectors/${c.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${c.key}.maris-connector.json`;
      a.click();
      URL.revokeObjectURL(url);
      setOk(`Đã xuất “${c.name}” (không kèm khóa bí mật).`);
    });
  const remove = () => {
    if (!confirm(`Xóa Connector “${c.name}”? Workflow đang dùng nó sẽ dừng ở bước Connector.`))
      return;
    void run(async () => {
      await api(`/connectors/${c.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${c.name}”.`);
      onDeleted();
      reload();
    });
  };

  return (
    <section id="connector-detail" className="mb-6 rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">
            {c.name}
            <span className={`ml-2 text-sm ${STATUS_COLOR[c.status]}`}>
              {CONNECTOR_STATUS_LABEL[c.status]}
            </span>
          </h2>
          <div className="font-mono text-xs text-muted">{c.key}</div>
        </div>
        <div className="flex flex-wrap gap-1">
          {c.status === 'active' ? (
            <button disabled={busy} onClick={pause} className={btnGhostCls}>
              Tạm tắt
            </button>
          ) : (
            <button disabled={busy} onClick={activate} className={`${btnGhostCls} border-accent`}>
              Kích hoạt
            </button>
          )}
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
      {c.status !== 'active' && (
        <div className="mb-3 rounded-md border border-line p-2 text-xs">
          <div className="font-medium">Chuẩn bị trước khi kích hoạt</div>
          {template && <p className="mt-1">{template.setup}</p>}
          {c.missingSecrets.length > 0 ? (
            <p className="mt-1 text-danger">
              Chưa có khóa trong Secret Vault: {c.missingSecrets.join(', ')}. Vào{' '}
              <Link href="/secrets" className="underline">
                Secret Vault
              </Link>{' '}
              và tạo khóa đúng tên này. Đừng dán khóa vào chat hay gửi qua tin nhắn.
            </p>
          ) : (
            <p className="mt-1 text-muted">
              Khóa đã sẵn sàng. Có thể bấm “Thử” ở từng thao tác chỉ đọc trước, rồi Kích hoạt (cần
              quyền duyệt).
            </p>
          )}
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-line pb-2">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`${btnGhostCls} ${shown === t ? 'border-accent text-accent' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      {shown === 'capabilities' && <Capabilities c={c} busy={busy} run={run} />}
      {shown === 'calls' && <Calls c={c} />}
      {shown === 'webhook' && (
        <Webhook
          c={c}
          workflows={workflows}
          busy={busy}
          run={run}
          reload={reload}
          token={token}
          setToken={setToken}
        />
      )}
      {shown === 'settings' && (
        <ConnectorForm
          existing={c}
          secrets={secrets}
          workflows={workflows}
          busy={busy}
          onSubmit={(body) =>
            run(async () => {
              const { key: _key, kind: _kind, ...patch } = body;
              const u = await api<ConnectorResponse>(`/connectors/${c.id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch),
              });
              setOk(
                u.status === 'draft' && c.status !== 'draft'
                  ? `Đã lưu. Vì địa chỉ, khóa hoặc thao tác đã đổi, “${u.name}” quay về Chưa kích hoạt để duyệt lại.`
                  : `Đã lưu “${u.name}”.`,
              );
              reload();
            })
          }
        />
      )}
    </section>
  );
}

function Capabilities({
  c,
  busy,
  run,
}: {
  c: ConnectorResponse;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [trying, setTrying] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectorCallResponse | null>(null);

  async function tryCall(cap: ConnectorCapability, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const inputs: Record<string, string> = {};
    for (const field of cap.inputs) inputs[field.name] = String(f.get(`in_${field.name}`) ?? '');
    if (
      cap.risk === 'write' &&
      !confirm(`“${cap.label}” sẽ gửi hoặc thay đổi dữ liệu thật ở bên ngoài. Tiếp tục?`)
    )
      return;
    await run(async () => {
      setResult(
        await api<ConnectorCallResponse>(`/connectors/${c.id}/call`, {
          method: 'POST',
          body: JSON.stringify({ capability: cap.key, inputs }),
        }),
      );
    });
  }

  return (
    <ul className="grid gap-2 text-sm">
      {c.capabilities.map((cap) => (
        <li key={cap.key} className="rounded-md border border-line p-2">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {cap.label}
                <span
                  className={`ml-2 text-xs ${cap.risk === 'write' ? 'text-accent' : 'text-muted'}`}
                >
                  {CAPABILITY_RISK_LABEL[cap.risk]}
                </span>
              </div>
              {cap.description && <div className="text-xs text-muted">{cap.description}</div>}
              <div className="break-all font-mono text-[11px] text-muted">
                {cap.method} {cap.path}
                {cap.outputPath ? ` → ${cap.outputPath}` : ''}
              </div>
            </div>
            <button
              disabled={busy || c.status === 'paused'}
              onClick={() => {
                setTrying(trying === cap.key ? null : cap.key);
                setResult(null);
              }}
              className={btnGhostCls}
            >
              {trying === cap.key ? 'Đóng' : 'Thử'}
            </button>
          </div>
          {trying === cap.key && (
            <form
              onSubmit={(e) => tryCall(cap, e)}
              className="mt-2 grid max-w-2xl gap-2"
              autoComplete="off"
            >
              {cap.inputs.map((f) => (
                <label key={f.name} className="text-xs">
                  {f.label}
                  {f.type === 'long_text' ? (
                    <textarea
                      name={`in_${f.name}`}
                      required={f.required}
                      rows={3}
                      className={`${inputCls} mt-1`}
                    />
                  ) : (
                    <input
                      name={`in_${f.name}`}
                      required={f.required}
                      className={`${inputCls} mt-1`}
                    />
                  )}
                </label>
              ))}
              <button disabled={busy} className={`${btnCls} justify-self-start`}>
                {cap.risk === 'write' ? 'Gửi thật' : 'Gọi thử'}
              </button>
              {result && <CallView call={result} />}
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

function CallView({ call }: { call: ConnectorCallResponse }) {
  return (
    <div className="rounded-md border border-line p-2 text-xs">
      <div className={call.status === 'ok' ? 'text-green-500' : 'text-danger'}>
        {call.status === 'ok' ? 'Thành công' : call.status === 'pending' ? 'Đang gọi' : 'Lỗi'}
        {call.httpStatus !== null && ` · HTTP ${call.httpStatus}`}
        {call.durationMs !== null && ` · ${call.durationMs} ms`}
      </div>
      <div className="break-all font-mono text-muted">{call.request}</div>
      {call.errorMessage && <div className="text-danger">{call.errorMessage}</div>}
      {call.output !== null && call.output !== '' && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
          {call.output}
        </pre>
      )}
    </div>
  );
}

function Calls({ c }: { c: ConnectorResponse }) {
  const [calls, setCalls] = useState<ConnectorCallResponse[] | null>(null);
  useEffect(() => {
    api<ConnectorCallResponse[]>(`/connectors/${c.id}/calls`)
      .then(setCalls)
      .catch(() => setCalls([]));
  }, [c.id]);
  if (!calls) return <p className="text-sm text-muted">Đang tải…</p>;
  if (!calls.length) return <p className="text-sm text-muted">Chưa có lần gọi nào.</p>;
  return (
    <ul className="grid gap-2">
      {calls.map((call) => (
        <li key={call.id}>
          <div className="mb-1 text-[11px] text-muted">
            {new Date(call.createdAt).toLocaleString('vi-VN')} · {call.capability}
            {call.workflowRunId ? ' · từ Workflow' : ' · gọi thử'}
          </div>
          <CallView call={call} />
        </li>
      ))}
    </ul>
  );
}

function Webhook({
  c,
  workflows,
  busy,
  run,
  reload,
  token,
  setToken,
}: {
  c: ConnectorResponse;
  workflows: WorkflowResponse[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  reload: () => void;
  token: string | null;
  setToken: (token: string) => void;
}) {
  const [events, setEvents] = useState<WebhookEventResponse[] | null>(null);
  useEffect(() => {
    api<WebhookEventResponse[]>(`/connectors/${c.id}/events`)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [c.id]);
  const url = `${API_URL}${c.webhook?.path ?? ''}`;
  const wf = workflows.find((w) => w.key === c.webhook?.workflowKey);
  const rotate = () => {
    if (
      c.webhook?.hasToken &&
      !confirm('Tạo mã mới? Mã cũ ngừng hoạt động ngay, bên gửi phải đổi sang mã mới.')
    )
      return;
    void run(async () => {
      const r = await api<ConnectorTokenResponse>(`/connectors/${c.id}/token`, {
        method: 'POST',
        body: '{}',
      });
      setToken(r.token);
      reload();
    });
  };
  const fields = wf
    ? ((wf.graph.nodes[0] as { inputs?: { name: string }[] }).inputs?.map((f) => f.name) ?? [])
    : [];
  const sample = JSON.stringify(Object.fromEntries(fields.map((f) => [f, '...'])));

  return (
    <div className="grid gap-3 text-sm">
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Địa chỉ nhận</dt>
        <dd className="break-all font-mono">POST {url}</dd>
        <dt className="text-muted">Header bắt buộc</dt>
        <dd className="font-mono">X-Maris-Token: (mã bí mật)</dd>
        <dt className="text-muted">Chạy Workflow</dt>
        <dd>
          {c.webhook?.workflowKey
            ? `${wf?.name ?? c.webhook.workflowKey} · ngân sách mỗi lần $${c.webhook.runBudgetUsd}`
            : 'Không, chỉ ghi nhận'}
        </dd>
        {fields.length > 0 && (
          <>
            <dt className="text-muted">Nội dung JSON</dt>
            <dd className="break-all font-mono">{sample}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted">
        Workflow chạy dưới tên người đã bấm Kích hoạt, nên người đó cần quyền duyệt. Chỉ các ô trùng
        tên ô nhập của Workflow được lấy từ nội dung gửi tới.
      </p>
      <div>
        <button disabled={busy} onClick={rotate} className={btnGhostCls}>
          {c.webhook?.hasToken ? 'Tạo mã bí mật mới' : 'Tạo mã bí mật'}
        </button>
      </div>
      {token && (
        <div className="rounded-md border border-accent p-2 text-xs">
          <div className="font-medium">Mã bí mật (chỉ hiện một lần)</div>
          <div className="mt-1 break-all font-mono">{token}</div>
          <p className="mt-1 text-muted">
            Dán mã này vào header X-Maris-Token ở n8n, Make hoặc website gửi tới. MARIS chỉ lưu dấu
            vân tay của mã nên không xem lại được.
          </p>
        </div>
      )}
      <div>
        <div className="mb-1 font-medium">Lần nhận gần đây</div>
        {!events ? (
          <p className="text-xs text-muted">Đang tải…</p>
        ) : !events.length ? (
          <p className="text-xs text-muted">Chưa nhận lần nào.</p>
        ) : (
          <ul className="grid gap-1 text-xs">
            {events.map((e) => (
              <li key={e.id} className="rounded-md border border-line p-2">
                <span
                  className={
                    e.status === 'rejected'
                      ? 'text-danger'
                      : e.status === 'started'
                        ? 'text-green-500'
                        : ''
                  }
                >
                  {
                    { accepted: 'Đã nhận', rejected: 'Từ chối', started: 'Đã chạy Workflow' }[
                      e.status
                    ]
                  }
                </span>{' '}
                · {new Date(e.receivedAt).toLocaleString('vi-VN')} · {e.detail}
                {e.bodyExcerpt && (
                  <pre className="mt-1 whitespace-pre-wrap break-all text-muted">
                    {e.bodyExcerpt}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface FormBody {
  key: string;
  kind: ConnectorKind;
  name: string;
  description: string;
  baseUrl: string | null;
  auth: ConnectorAuth;
  headers: Record<string, string>;
  timeoutSec: number;
  capabilities: unknown[];
  webhook: { workflowKey: string | null; runBudgetUsd: number } | null;
}

function ConnectorForm({
  existing,
  secrets,
  workflows,
  busy,
  onSubmit,
}: {
  existing?: ConnectorResponse;
  secrets: SecretResponse[];
  workflows: WorkflowResponse[];
  busy: boolean;
  onSubmit: (body: FormBody) => void;
}) {
  const [kind, setKind] = useState<ConnectorKind>(existing?.kind ?? 'http');
  const [authType, setAuthType] = useState<ConnectorAuthType>(existing?.auth.type ?? 'none');
  const [localError, setLocalError] = useState<string | null>(null);
  const auth = existing?.auth;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError(null);
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    let capabilities: unknown[] = [];
    const headers: Record<string, string> = {};
    if (kind === 'http') {
      try {
        const parsed = JSON.parse(text('capabilities') || '[]') as unknown;
        if (!Array.isArray(parsed)) throw new Error();
        capabilities = parsed;
      } catch {
        setLocalError('Danh sách thao tác phải là JSON dạng [ {...}, ... ].');
        return;
      }
      for (const line of text('headers').split('\n')) {
        if (!line.trim()) continue;
        const i = line.indexOf(':');
        if (i < 1) {
          setLocalError(`Header "${line}" phải có dạng Tên: giá trị`);
          return;
        }
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    const secret = text('secret');
    const authBody: ConnectorAuth =
      kind === 'webhook' || authType === 'none'
        ? { type: 'none' }
        : authType === 'header'
          ? { type: 'header', header: text('header'), secret }
          : authType === 'query'
            ? { type: 'query', param: text('param'), secret }
            : { type: authType, secret };
    onSubmit({
      key: text('key'),
      kind,
      name: text('name'),
      description: text('description'),
      baseUrl: kind === 'http' ? text('baseUrl') || null : null,
      auth: authBody,
      headers,
      timeoutSec: Number(text('timeoutSec')) || 15,
      capabilities,
      webhook:
        kind === 'webhook'
          ? {
              workflowKey: text('workflowKey') || null,
              runBudgetUsd: Number(text('runBudgetUsd').replace(',', '.')) || 0.5,
            }
          : null,
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 grid max-w-3xl gap-3 rounded-md border border-line p-3"
      autoComplete="off"
    >
      {localError && <Notice kind="error">{localError}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          Loại
          <select
            value={kind}
            disabled={!!existing}
            onChange={(e) => setKind(e.target.value as ConnectorKind)}
            className={`${inputCls} mt-1`}
          >
            {(['http', 'webhook'] as const).map((k) => (
              <option key={k} value={k}>
                {CONNECTOR_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Mã (không dấu)
          <input
            name="key"
            required
            disabled={!!existing}
            defaultValue={existing?.key}
            placeholder="api-cua-hang"
            className={`${inputCls} mt-1 font-mono`}
          />
        </label>
        <label className="text-sm">
          Tên
          <input
            name="name"
            required
            defaultValue={existing?.name}
            className={`${inputCls} mt-1`}
          />
        </label>
      </div>
      <label className="text-sm">
        Mô tả
        <input
          name="description"
          defaultValue={existing?.description}
          className={`${inputCls} mt-1`}
        />
      </label>
      {kind === 'http' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <label className="text-sm">
              Địa chỉ API (https)
              <input
                name="baseUrl"
                required
                defaultValue={existing?.baseUrl ?? ''}
                placeholder="https://api.example.com/v1"
                className={`${inputCls} mt-1 font-mono`}
              />
            </label>
            <label className="text-sm">
              Tối đa (giây)
              <input
                name="timeoutSec"
                type="number"
                min={1}
                max={60}
                defaultValue={existing?.timeoutSec ?? 15}
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Cách đăng nhập
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as ConnectorAuthType)}
                className={`${inputCls} mt-1`}
              >
                {CONNECTOR_AUTH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONNECTOR_AUTH_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            {authType !== 'none' && (
              <label className="text-sm">
                Tên khóa trong Secret Vault
                <input
                  name="secret"
                  required
                  list="secret-names"
                  defaultValue={auth && auth.type !== 'none' ? auth.secret : ''}
                  placeholder="dich_vu.api_key"
                  className={`${inputCls} mt-1 font-mono`}
                />
                <datalist id="secret-names">
                  {secrets.map((s) => (
                    <option key={s.id} value={s.name} />
                  ))}
                </datalist>
              </label>
            )}
            {authType === 'header' && (
              <label className="text-sm">
                Tên header
                <input
                  name="header"
                  required
                  defaultValue={auth?.type === 'header' ? auth.header : 'X-Api-Key'}
                  className={`${inputCls} mt-1 font-mono`}
                />
              </label>
            )}
            {authType === 'query' && (
              <label className="text-sm">
                Tên tham số
                <input
                  name="param"
                  required
                  defaultValue={auth?.type === 'query' ? auth.param : 'key'}
                  className={`${inputCls} mt-1 font-mono`}
                />
              </label>
            )}
          </div>
          <label className="text-sm">
            Header cố định (mỗi dòng một header, dạng Tên: giá trị; không đặt khóa bí mật ở đây)
            <textarea
              name="headers"
              rows={2}
              defaultValue={Object.entries(existing?.headers ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-sm">
            Các thao tác (JSON). Mỗi thao tác có key, label, risk (read hoặc write), method, path,
            inputs; tùy chọn query, body, outputPath. Dùng {'{{input.ten_o}}'} để chèn ô nhập và{' '}
            {'{{secret}}'} khi khóa nằm trong đường dẫn.
            <textarea
              name="capabilities"
              rows={12}
              defaultValue={
                existing ? JSON.stringify(existing.capabilities, null, 2) : SAMPLE_CAPABILITIES
              }
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Workflow sẽ chạy khi nhận được
            <select
              name="workflowKey"
              defaultValue={existing?.webhook?.workflowKey ?? ''}
              className={`${inputCls} mt-1`}
            >
              <option value="">Không chạy, chỉ ghi nhận</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.key}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Ngân sách mỗi lần chạy (USD, tối đa 5)
            <input
              name="runBudgetUsd"
              inputMode="decimal"
              defaultValue={existing?.webhook?.runBudgetUsd ?? 0.5}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>
      )}
      <button disabled={busy} className={`${btnCls} justify-self-start`}>
        {existing ? 'Lưu' : 'Tạo Connector (chưa kích hoạt)'}
      </button>
    </form>
  );
}
