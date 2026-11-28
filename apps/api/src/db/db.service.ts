import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { APP_CONFIG, AppConfig } from '../config';

export type Db = PostgresJsDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbContext {
  userId?: string | null;
  tenantId?: string | null;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly client: postgres.Sql;
  readonly db: Db;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = postgres(config.DATABASE_URL, { max: 10, onnotice: () => {} });
    this.db = drizzle(this.client);
  }

  /**
   * Runs fn in a transaction with app.user_id / app.tenant_id set via SET LOCAL,
   * so Row-Level Security policies see them. Callers must have verified the
   * tenant against the user's membership before passing tenantId.
   */
  async withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true),
                   set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true)`,
      );
      return fn(tx);
    });
  }

  /**
   * System job context: sets app.system so policies that allow a named system job
   * (for example the outbox relay) apply. Never use for user requests.
   */
  async withSystem<T>(
    job:
      | 'outbox_relay'
      | 'meta_publisher'
      | 'meta_inbox'
      | 'meta_leads'
      | 'meta_ads'
      | 'youtube_uploader',
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system', ${job}, true)`);
      return fn(tx);
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
