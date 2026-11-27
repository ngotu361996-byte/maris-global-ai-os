export const inputCls = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm';
export const btnCls = 'rounded-md bg-accent px-3 py-2 text-sm font-medium text-black disabled:opacity-60';
export const btnGhostCls = 'rounded-md border border-line px-2 py-1 text-xs disabled:opacity-60';

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: React.ReactNode }) {
  const color = kind === 'error' ? 'border-danger text-danger' : kind === 'ok' ? 'border-green-600 text-green-500' : 'border-accent';
  return <p className={`mb-3 rounded-md border p-2 text-sm ${color}`}>{children}</p>;
}
