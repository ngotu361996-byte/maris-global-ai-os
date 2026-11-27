'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InvitationResponse, MemberResponse, RoleResponse } from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', administrator: 'Quản trị', manager: 'Quản lý', member: 'Thành viên' };
const STATUS_LABEL: Record<InvitationResponse['status'], string> = {
  pending: 'Đang chờ',
  accepted: 'Đã nhận',
  revoked: 'Đã hủy',
  expired: 'Hết hạn',
};

export default function MembersPage() {
  const me = useMe();
  const [members, setMembers] = useState<MemberResponse[]>([]);
  const [roles, setRoles] = useState<RoleResponse[]>([]);
  const [invites, setInvites] = useState<InvitationResponse[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const fail = (e: Error) => setError(e.message);
    api<MemberResponse[]>('/tenants/current/members').then(setMembers).catch(fail);
    api<RoleResponse[]>('/roles').then(setRoles).catch(fail);
    api<InvitationResponse[]>('/tenants/current/invitations').then(setInvites).catch(fail);
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    }
  };

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      const inv = await api<InvitationResponse>('/tenants/current/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: f.get('email'), roleId: f.get('roleId') }),
      });
      setLink(`${window.location.origin}/invite#${inv.token}`);
      form.reset();
    });
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const assignable = roles.filter((r) => r.key !== 'owner');
  return (
    <Shell me={me}>
      <h1 className="mb-6 text-xl font-semibold">Thành viên</h1>
      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="Mời người mới">
        <form onSubmit={invite} className="flex max-w-2xl flex-wrap gap-2">
          <input name="email" type="email" required placeholder="Email người được mời" className={`${inputCls} flex-1`} />
          <select name="roleId" required className={`${inputCls} w-40`} defaultValue={assignable.find((r) => r.key === 'member')?.id}>
            {assignable.map((r) => (
              <option key={r.id} value={r.id}>
                {ROLE_LABEL[r.key] ?? r.name}
              </option>
            ))}
          </select>
          <button className={btnCls}>Tạo lời mời</button>
        </form>
        {link && (
          <div className="mt-3 max-w-2xl text-sm">
            <Notice kind="info">
              Gửi đường dẫn này cho người được mời (dùng một lần, hết hạn sau 7 ngày). Đường dẫn chỉ hiện lúc này.
            </Notice>
            <div className="flex gap-2">
              <input readOnly value={link} className={`${inputCls} font-mono text-xs`} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className={btnGhostCls} onClick={() => navigator.clipboard.writeText(link)}>
                Sao chép
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title={`Thành viên (${members.length})`}>
        <table className="w-full text-sm">
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} className="border-t border-line first:border-0">
                <td className="py-2">
                  <div className="font-medium">{m.displayName}</div>
                  <div className="text-xs text-muted">{m.email}</div>
                </td>
                <td className="w-44">
                  {m.role === 'owner' ? (
                    <span className="text-accent">Owner</span>
                  ) : (
                    <select
                      className={inputCls}
                      value={roles.find((r) => r.key === m.role)?.id ?? ''}
                      onChange={(e) =>
                        run(() =>
                          api(`/tenants/current/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ roleId: e.target.value }) }),
                        )
                      }
                    >
                      {assignable.map((r) => (
                        <option key={r.id} value={r.id}>
                          {ROLE_LABEL[r.key] ?? r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="w-20 text-right">
                  {m.role !== 'owner' && m.userId !== me.id && (
                    <button
                      className={`${btnGhostCls} border-danger text-danger`}
                      onClick={() =>
                        confirm(`Gỡ ${m.email} khỏi Tenant?`) &&
                        run(() => api(`/tenants/current/members/${m.userId}`, { method: 'DELETE' }))
                      }
                    >
                      Gỡ
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Lời mời">
        {invites.length === 0 ? (
          <p className="text-sm text-muted">Chưa có lời mời nào.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {invites.map((i) => (
                <tr key={i.id} className="border-t border-line first:border-0">
                  <td className="py-2">{i.email}</td>
                  <td className="text-muted">{ROLE_LABEL[i.role] ?? i.role}</td>
                  <td className="text-muted">{STATUS_LABEL[i.status]}</td>
                  <td className="text-right">
                    {i.status === 'pending' && (
                      <button className={btnGhostCls} onClick={() => run(() => api(`/tenants/current/invitations/${i.id}`, { method: 'DELETE' }))}>
                        Hủy
                      </button>
                    )}
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
