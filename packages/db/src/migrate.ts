import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Applies every *.sql file in order, each in its own transaction, recording it in
 * public.schema_migrations. Must run with the owner (admin) connection, never the app role.
 */
export async function migrate(adminUrl: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM public.schema_migrations`).map((r) => r.name),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = readFileSync(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO public.schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql.end();
  }
  return applied;
}
