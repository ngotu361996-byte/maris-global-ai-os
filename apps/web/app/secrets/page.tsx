'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SecretResponse } from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const SUGGESTED = ['openai.api_key', 'anthropic.api_key', 'google.api_key'];

export default function SecretsPage() {
  const me = useMe();
  const [items, setItems] = useState<SecretResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<SecretResponse[]>('/secrets').then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    const value = String(f.get('value')).trim();
    // Catches the common slip of typing the key's name into the value box.
    if (value === name || /^[a-z0-9_.-]+\.(api_key|key|token)$/i.test(value)) {
      setOk(null);
      setError('Ô “Giá trị” đang chứa tên key, không phải key thật. Dán key (ví dụ bắt đầu bằng sk-) vào ô Giá trị.');
      return;
    }
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const created = await api<SecretResponse>('/secrets', {
        method: 'POST',
        body: JSON.stringify({ name: String(f.get('name')).trim(), value: String(f.get('value')) }),
      });
      form.reset(); // the value leaves the page as soon as it is saved
      setOk(`Đã lưu “${created.name}”. Từ giờ hệ thống chỉ dùng nó qua mã ${created.reference}.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: SecretResponse) {
    if (!confirm(`Xóa “${s.name}”? Module nào đang dùng key này sẽ ngừng hoạt động.`)) return;
    setError(null);
    try {
      await api(`/secrets/${s.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${s.name}”.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Secret Vault</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted">
        Nơi lưu API key và mật khẩu kết nối. Giá trị được mã hóa ngay khi lưu và không bao giờ hiển thị lại, kể cả với
        bạn. Muốn đổi key thì xóa và thêm lại. Đừng dán key vào chat hay gửi qua tin nhắn.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Panel title="Thêm key">
        <form onSubmit={add} className="grid max-w-2xl gap-3" autoComplete="off">
          <label className="text-sm">
            Tên
            <input name="name" required list="secret-names" placeholder="openai.api_key" className={`${inputCls} mt-1`} pattern="[a-z0-9][a-z0-9_.\-]{0,99}" title="Chữ thường, số, dấu . _ -" />
            <datalist id="secret-names">
              {SUGGESTED.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            Giá trị
            <input name="value" type="password" required placeholder="Dán key vào đây" className={`${inputCls} mt-1`} autoComplete="new-password" spellCheck={false} />
          </label>
          <div>
            <button disabled={busy} className={btnCls}>
              {busy ? 'Đang lưu…' : 'Lưu vào Secret Vault'}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={`Key đã lưu (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">Chưa có key nào.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1">Tên</th>
                <th>Mã tham chiếu</th>
                <th>Ngày thêm</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-2 font-medium">{s.name}</td>
                  <td className="font-mono text-xs text-muted">{s.reference}</td>
                  <td className="text-muted">{new Date(s.createdAt).toLocaleString('vi-VN')}</td>
                  <td className="text-right">
                    <button onClick={() => remove(s)} className={`${btnGhostCls} border-danger text-danger`}>
                      Xóa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Shell>
  );
}
