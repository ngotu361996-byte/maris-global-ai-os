'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  PLUGIN_COMPONENT_LABEL,
  PLUGIN_PERMISSION_LABEL,
  PLUGIN_SIGNATURE_LABEL,
  PLUGIN_STATUS_LABEL,
  type PluginResponse,
  type PluginSample,
  type PluginVersionResponse,
  type PublisherResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const PART_HREF = { skill: '/skills', connector: '/connectors', workflow: '/workflows' } as const;
const PART_STATUS: Record<string, string> = {
  active: 'đang bật',
  paused: 'đang tắt',
  draft: 'chưa kích hoạt',
  deleted: 'đã bị xóa',
};

const statusColor = (s: PluginResponse['status']) =>
  s === 'active' ? 'text-green-500' : s === 'revoked' ? 'text-danger' : 'text-muted';

export default function PluginsPage() {
  const me = useMe();
  const [plugins, setPlugins] = useState<PluginResponse[]>([]);
  const [publishers, setPublishers] = useState<PublisherResponse[]>([]);
  const [samples, setSamples] = useState<PluginSample[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PluginResponse[]>('/plugins')
      .then(setPlugins)
      .catch((e: Error) => setError(e.message));
    api<PublisherResponse[]>('/plugins/publishers')
      .then(setPublishers)
      .catch(() => undefined);
    api<PluginSample[]>('/plugins/samples')
      .then(setSamples)
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

  const installManifest = async (manifest: unknown, replace: boolean) => {
    const p = await api<PluginResponse>('/plugins', {
      method: 'POST',
      body: JSON.stringify({ manifest, replace }),
    });
    setOpenId(p.id);
    setOk(
      `Đã cài “${p.name}” phiên bản ${p.version}. Mọi thành phần đang tắt: đọc quyền và kết quả kiểm tra rồi bấm Kích hoạt.`,
    );
    load();
  };

  const installSample = (s: PluginSample) => run(() => installManifest(s.manifest, false));

  async function installFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    await run(async () => {
      let text = String(f.get('text') ?? '').trim();
      if (file instanceof File && file.size > 0) {
        if (file.size > 500_000) throw new Error('Tệp Plugin quá lớn (tối đa 500 KB).');
        text = await file.text();
      }
      if (!text) throw new Error('Chọn tệp Plugin hoặc dán nội dung tệp.');
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error('Nội dung không phải tệp Plugin (JSON) hợp lệ.');
      }
      await installManifest(manifest, f.get('replace') === 'on');
      form.reset();
      setInstalling(false);
    });
  }

  const remove = (p: PluginResponse) => {
    if (
      !confirm(
        `Gỡ Plugin “${p.name}”? Mọi Skill, Connector và Workflow nó đã cài sẽ bị xóa theo. Lịch sử chạy vẫn giữ nguyên.`,
      )
    )
      return;
    void run(async () => {
      await api(`/plugins/${p.id}`, { method: 'DELETE' });
      setOk(`Đã gỡ “${p.name}”.`);
      load();
    });
  };

  async function addPublisher(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      const p = await api<PublisherResponse>('/plugins/publishers', {
        method: 'POST',
        body: JSON.stringify({
          keyId: String(f.get('keyId') ?? '').trim(),
          name: String(f.get('name') ?? '').trim(),
          publicKey: String(f.get('publicKey') ?? '').trim(),
        }),
      });
      form.reset();
      setOk(
        `Đã tin cậy khóa “${p.keyId}” (vân tay ${p.fingerprint}). Hãy so vân tay này với nhà phát hành.`,
      );
      load();
    });
  }

  const revokePublisher = (p: PublisherResponse) => {
    if (
      !confirm(
        `Thôi tin cậy khóa “${p.keyId}”? Các Plugin đang bật do khóa này ký sẽ bị tạm dừng để bạn xem lại.`,
      )
    )
      return;
    void run(async () => {
      await api(`/plugins/publishers/${p.id}`, { method: 'DELETE' });
      setOk(`Đã thôi tin cậy khóa “${p.keyId}”.`);
      load();
    });
  };

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const installedKeys = new Set(plugins.map((p) => p.key));

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Trung tâm Plugin</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Plugin là một gói gồm nhiều Skill, Connector và Workflow, đi kèm một bản khai: quyền cần
        dùng, phụ thuộc, phiên bản MARIS tương thích, ngân sách, thời gian tối đa, chữ ký và các bài
        kiểm tra. Plugin chỉ chứa phần khai báo, không chạy mã, nên không đụng được cơ sở dữ liệu
        hay thứ gì nó không khai báo. Cài xong mọi thành phần đều tắt; người có quyền duyệt bật
        Plugin sau khi kiểm tra đạt.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title={`Plugin đã cài (${plugins.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          {samples
            .filter((s) => !installedKeys.has(s.key))
            .map((s) => (
              <button
                key={s.key}
                onClick={() => installSample(s)}
                disabled={busy}
                className={btnCls}
                title={s.description}
              >
                Cài Plugin mẫu “{s.name}”
              </button>
            ))}
          <button
            onClick={() => setInstalling(!installing)}
            disabled={busy}
            className={btnGhostCls}
          >
            {installing ? 'Đóng' : 'Cài từ tệp'}
          </button>
        </div>
        {installing && (
          <form
            onSubmit={installFile}
            className="mb-4 grid max-w-2xl gap-3 rounded-md border border-line p-3"
            autoComplete="off"
          >
            <label className="text-sm">
              Tệp Plugin (.json, định dạng maris.plugin/v1)
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
              <input name="replace" type="checkbox" /> Cập nhật nếu Plugin cùng mã đã cài
            </label>
            <p className="text-xs text-muted">
              MARIS kiểm tra định dạng, checksum, chữ ký, quyền, giới hạn ngân sách và thời gian,
              rồi chạy thử các bài kiểm tra trong tệp (không tốn tiền, không gọi ra ngoài). Tệp bị
              sửa sau khi đóng gói hay ký sẽ bị từ chối.
            </p>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Cài Plugin
            </button>
          </form>
        )}
        {plugins.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có Plugin nào. Bấm nút Plugin mẫu để thử, hoặc cài từ tệp do nhà phát hành gửi.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {plugins.map((p) => (
              <li key={p.id} className="py-2">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {p.name}
                      <span className="ml-2 text-[11px] text-muted">v{p.version}</span>
                      <span className={`ml-2 text-xs ${statusColor(p.status)}`}>
                        {PLUGIN_STATUS_LABEL[p.status]}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{p.description}</div>
                    <div className="text-[11px] text-muted">
                      {p.author} · {PLUGIN_SIGNATURE_LABEL[p.signatureStatus]}
                      {p.signerKeyId ? ` (${p.signerKeyId})` : ''} · {p.components.length} thành
                      phần
                    </div>
                  </div>
                  <button
                    onClick={() => setOpenId(openId === p.id ? null : p.id)}
                    className={btnGhostCls}
                  >
                    {openId === p.id ? 'Đóng' : 'Chi tiết'}
                  </button>
                </div>
                {openId === p.id && (
                  <PluginDetail
                    p={p}
                    busy={busy}
                    run={run}
                    onDone={(msg) => {
                      setOk(msg);
                      load();
                    }}
                    onRemove={() => remove(p)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Nhà phát hành tin cậy (${publishers.length})`}>
        <p className="mb-3 max-w-3xl text-xs text-muted">
          Plugin được ký bằng khóa của nhà phát hành có trong danh sách này thì bật được mà không
          cần xác nhận thêm. Chỉ thêm khóa công khai bạn nhận trực tiếp từ nhà phát hành, và so vân
          tay với họ. Thêm hay bỏ khóa cần quyền duyệt.
        </p>
        {publishers.length > 0 && (
          <ul className="mb-4 divide-y divide-line text-sm">
            {publishers.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted">{p.keyId}</span>
                  <div className="text-[11px] text-muted">Vân tay {p.fingerprint}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => revokePublisher(p)}
                  className={`${btnGhostCls} border-danger text-danger`}
                >
                  Thôi tin cậy
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addPublisher} className="grid max-w-2xl gap-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Mã khóa (giống mã trong chữ ký)
              <input
                name="keyId"
                required
                placeholder="vd: cong-ty-abc"
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-sm">
              Tên nhà phát hành
              <input name="name" required className={`${inputCls} mt-1`} />
            </label>
          </div>
          <label className="text-sm">
            Khóa công khai (PEM, bắt đầu bằng -----BEGIN PUBLIC KEY-----)
            <textarea
              name="publicKey"
              required
              rows={3}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <button disabled={busy} className={`${btnGhostCls} justify-self-start border-accent`}>
            Thêm khóa tin cậy
          </button>
        </form>
      </Panel>

      <Panel title="Extension SDK cho người làm Plugin">
        <div className="max-w-3xl space-y-2 text-xs text-muted">
          <p>
            Gói <span className="font-mono">@maris/sdk</span> trong mã nguồn giúp đóng gói và ký
            Plugin. Lệnh chạy ở thư mục dự án:
          </p>
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px]">
            {`pnpm ext keygen cong-ty-abc            # tạo khóa: .key giữ kín, .pub gửi cho khách
pnpm ext check plugin.json              # kiểm tra trường, quyền, checksum, tương thích
pnpm ext sign plugin.json cong-ty-abc.key cong-ty-abc   # đóng gói và ký
pnpm ext verify plugin.json cong-ty-abc.pub`}
          </pre>
          <p>Hướng dẫn đầy đủ ở tệp docs/EXTENSION_SDK.md.</p>
        </div>
      </Panel>
    </Shell>
  );
}

function PluginDetail({
  p,
  busy,
  run,
  onDone,
  onRemove,
}: {
  p: PluginResponse;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onDone: (msg: string) => void;
  onRemove: () => void;
}) {
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  const [versions, setVersions] = useState<PluginVersionResponse[]>([]);
  useEffect(() => {
    api<PluginVersionResponse[]>(`/plugins/${p.id}/versions`)
      .then(setVersions)
      .catch(() => undefined);
  }, [p.id, p.updatedAt]);

  const sigCheck = p.checks.find((c) => c.key === 'signature');
  const otherFailed = p.checks.filter((c) => !c.ok && c.key !== 'signature');
  const needsOverride = !!sigCheck && !sigCheck.ok && p.signatureStatus !== 'trusted';

  const activate = () =>
    run(async () => {
      const r = await api<PluginResponse>(`/plugins/${p.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ allowUnsigned }),
      });
      onDone(`Đã bật “${r.name}” và ${r.components.length} thành phần của nó.`);
    });
  const pause = () =>
    run(async () => {
      await api(`/plugins/${p.id}/pause`, { method: 'POST', body: '{}' });
      onDone(`Đã tạm dừng “${p.name}”.`);
    });
  const revoke = () => {
    const reason = prompt(
      `Thu hồi “${p.name}”? Plugin sẽ tắt hẳn và không bật lại được, chỉ gỡ được. Ghi lý do:`,
    );
    if (!reason?.trim()) return;
    void run(async () => {
      await api(`/plugins/${p.id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onDone(`Đã thu hồi “${p.name}”.`);
    });
  };
  const exportFile = () =>
    run(async () => {
      const manifest = await api<unknown>(`/plugins/${p.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.key}-${p.version}.maris-plugin.json`;
      a.click();
      URL.revokeObjectURL(url);
      onDone(`Đã xuất “${p.name}” phiên bản ${p.version}.`);
    });
  const restore = (v: PluginVersionResponse) => {
    if (!confirm(`Quay về phiên bản ${v.version}? Plugin sẽ tắt cho tới khi bạn bật lại.`)) return;
    void run(async () => {
      await api(`/plugins/${p.id}/versions/${v.id}/restore`, { method: 'POST', body: '{}' });
      onDone(`Đã quay về phiên bản ${v.version}. Plugin đang tắt.`);
    });
  };

  return (
    <div className="mt-3 grid gap-4 rounded-md border border-line p-3 text-xs">
      {p.status === 'revoked' && (
        <p className="text-danger">Đã thu hồi: {p.revokedReason}. Chỉ còn gỡ được.</p>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold">Quyền Plugin xin</h3>
        <ul className="list-disc pl-5">
          {p.permissions.map((perm) => (
            <li key={perm}>
              {PLUGIN_PERMISSION_LABEL[perm]} <span className="font-mono text-muted">({perm})</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-muted">
          Ngân sách tối đa mỗi lần chạy ${p.resources.maxRunUsd} · Thời gian tối đa {p.timeoutSec}{' '}
          giây · Cần MARIS {p.compatibility.maris}
          {p.dependencies.length > 0 &&
            ` · Phụ thuộc: ${p.dependencies.map((d) => `${d.key} ${d.version}`).join(', ')}`}
          {p.homepage && (
            <>
              {' · '}
              <a href={p.homepage} target="_blank" rel="noreferrer noopener" className="underline">
                Trang nhà phát hành
              </a>
            </>
          )}
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold">Thành phần</h3>
        <ul className="divide-y divide-line">
          {p.components.map((c) => (
            <li key={`${c.kind}:${c.key}`} className="flex gap-2 py-1">
              <span className="w-20 text-muted">{PLUGIN_COMPONENT_LABEL[c.kind]}</span>
              <Link href={PART_HREF[c.kind]} className="flex-1 underline">
                {c.name}
              </Link>
              <span className={c.status === 'active' ? 'text-green-500' : 'text-muted'}>
                {PART_STATUS[c.status] ?? c.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {p.checks.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Kiểm tra trước khi bật</h3>
          <ul>
            {p.checks.map((c) => (
              <li key={c.key} className="py-0.5">
                <span className={c.ok ? 'text-green-500' : 'text-danger'}>{c.ok ? '✓' : '✗'}</span>{' '}
                <span className="font-medium">{c.label}:</span> {c.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold">Bài kiểm tra trong tệp</h3>
        <ul>
          {p.tests.map((t, i) => (
            <li key={i} className="py-0.5">
              <span className={t.ok ? 'text-green-500' : 'text-danger'}>{t.ok ? '✓' : '✗'}</span>{' '}
              {t.name}{' '}
              <span className="text-muted">
                ({PLUGIN_COMPONENT_LABEL[t.kind]} {t.key})
              </span>
              : <span className="text-muted">{t.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="text-muted">
        Checksum <span className="break-all font-mono">{p.checksum}</span>
      </section>

      {versions.length > 1 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Các phiên bản đã cài</h3>
          <ul>
            {versions.map((v, i) => (
              <li key={v.id} className="flex items-center gap-2 py-0.5">
                <span className="flex-1">
                  v{v.version} · {PLUGIN_SIGNATURE_LABEL[v.signatureStatus]} ·{' '}
                  {new Date(v.createdAt).toLocaleString('vi-VN')}
                  {i === 0 && ' (mới nhất)'}
                </span>
                {i > 0 && p.status !== 'revoked' && (
                  <button disabled={busy} onClick={() => restore(v)} className={btnGhostCls}>
                    Quay về bản này
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.status !== 'revoked' && p.status !== 'active' && needsOverride && (
        <label className="flex max-w-2xl items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowUnsigned}
            onChange={(e) => setAllowUnsigned(e.target.checked)}
            className="mt-1"
          />
          <span>
            Tôi biết Plugin này chưa có chữ ký của nhà phát hành tin cậy, đã đọc các quyền ở trên và
            vẫn muốn bật. Việc này được ghi vào nhật ký.
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {p.status !== 'revoked' && p.status !== 'active' && (
          <button
            disabled={busy || otherFailed.length > 0 || (needsOverride && !allowUnsigned)}
            onClick={activate}
            className={btnCls}
          >
            Kích hoạt
          </button>
        )}
        {p.status === 'active' && (
          <button disabled={busy} onClick={pause} className={btnGhostCls}>
            Tạm dừng
          </button>
        )}
        {p.status !== 'revoked' && (
          <button
            disabled={busy}
            onClick={revoke}
            className={`${btnGhostCls} border-danger text-danger`}
          >
            Thu hồi
          </button>
        )}
        <button disabled={busy} onClick={exportFile} className={btnGhostCls}>
          Xuất tệp
        </button>
        <button
          disabled={busy}
          onClick={onRemove}
          className={`${btnGhostCls} border-danger text-danger`}
        >
          Gỡ
        </button>
      </div>
    </div>
  );
}
