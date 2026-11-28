import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  COMMERCE_LIMITS,
  SHOPIFY_SCOPES,
  type ApiCallResponse,
  type CommerceChangeResponse,
  type CommerceOrderResponse,
  type CommerceOrdersResponse,
  type CommerceReportResponse,
  type CommerceStatusResponse,
  type CommerceStoreResponse,
  type CommerceSyncResponse,
  type CommerceVariantResponse,
  type CommerceVariantsResponse,
  type ConnectPoscake,
  type ConnectShopify,
  type ListOrders,
  type ListVariants,
  type SetPrice,
  type SetStock,
  type SkuCompareResponse,
  type UpdateStore,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import {
  CommerceApiService,
  CommerceError,
  targetOf,
  type StoreRow,
  type StoreTarget,
} from './commerce-api.service';
import { CommerceSyncService } from './commerce-sync.service';
import { clip, money } from './rules';

const {
  commerceStores,
  commerceLocations,
  commerceProducts,
  commerceVariants,
  commerceStock,
  commerceOrders,
  commerceChanges,
  apiCalls,
  users,
  secrets,
} = schema;

type VariantRow = typeof commerceVariants.$inferSelect;

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const esc = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

const PRICE_QUERY = `query VariantPrice($id: ID!) {
  productVariant(id: $id) { id price product { id } }
}`;

const PRICE_MUTATION = `mutation SetPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

const STOCK_MUTATION = `mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { reason }
    userErrors { code field message }
  }
}`;

/**
 * Shopify and POSCake stores (spec Part 18, M22 and M26). Reading needs commerce.read; connecting,
 * disconnecting, turning stores on or off and reading now need commerce.manage; changing a price
 * or a stock level on Shopify needs commerce.write, is checked against the value the person saw,
 * and is recorded with the audit log in one transaction.
 */
@Injectable()
export class CommerceService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly api: CommerceApiService,
    private readonly syncer: CommerceSyncService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------------- stores

  async status(ctx: Ctx): Promise<CommerceStatusResponse> {
    return this.db.withContext(ctx, async (tx) => ({
      stores: await this.storesIn(tx, ctx.tenantId),
      syncEveryMin: this.config.COMMERCE_SYNC_MIN,
    }));
  }

  async connectShopify(ctx: Ctx, input: ConnectShopify): Promise<CommerceStoreResponse> {
    await this.db.withContext(ctx, (tx) => this.checkRoom(tx, ctx.tenantId, 'shopify', input.shop));
    const t: StoreTarget = {
      id: null,
      platform: 'shopify',
      externalId: input.shop,
      clientId: input.clientId,
      secretName: input.clientSecretName,
    };
    const { scopes } = await this.api.shopifyToken(ctx, t, true);
    const r = await this.api.shopify<{ shop: { name?: string; currencyCode?: string } }>(
      ctx,
      t,
      'connect',
      'Shop',
      'query Shop { shop { name currencyCode } }',
    );
    const name = clip(r.data.shop.name, 200) ?? input.shop;
    const currency = /^[A-Z]{3}$/.test(r.data.shop.currencyCode ?? '') ? r.data.shop.currencyCode! : 'VND';
    return this.saveStore(ctx, {
      platform: 'shopify',
      externalId: input.shop,
      name,
      clientId: input.clientId,
      secretName: input.clientSecretName,
      currency,
      scopes,
    });
  }

  async connectPoscake(ctx: Ctx, input: ConnectPoscake): Promise<CommerceStoreResponse> {
    await this.db.withContext(ctx, (tx) => this.checkRoom(tx, ctx.tenantId, 'poscake', input.shopId));
    const t: StoreTarget = {
      id: null,
      platform: 'poscake',
      externalId: input.shopId,
      clientId: null,
      secretName: input.apiKeySecretName,
    };
    // The shops the key reaches; POSCake has sent them as "shops" and as "data".
    const r = await this.api.poscake<{
      shops?: { id?: number | string; name?: string; currency?: string }[];
      data?: { id?: number | string; name?: string; currency?: string }[];
    }>(ctx, t, 'connect', '/shops');
    const shops = r.shops ?? r.data ?? [];
    const shop = shops.find((s) => String(s.id) === input.shopId);
    if (!shop)
      throw new CommerceError(
        404,
        'POSCAKE_SHOP_NOT_FOUND',
        shops.length
          ? `API key này không mở được shop ${input.shopId}. Shop của key: ${shops.map((s) => `${s.name ?? ''} (${String(s.id)})`).join(', ').slice(0, 300)}`
          : `API key này không mở được shop ${input.shopId}`,
      );
    const currency = /^[A-Z]{3}$/.test(shop.currency ?? '') ? shop.currency! : 'VND';
    return this.saveStore(ctx, {
      platform: 'poscake',
      externalId: input.shopId,
      name: clip(shop.name, 200) ?? `POSCake ${input.shopId}`,
      clientId: null,
      secretName: input.apiKeySecretName,
      currency,
      scopes: [],
    });
  }

  private async checkRoom(tx: Tx, tenantId: string, platform: StoreRow['platform'], externalId: string) {
    const rows = await tx
      .select({ id: commerceStores.id, platform: commerceStores.platform, ext: commerceStores.externalId })
      .from(commerceStores)
      .where(and(eq(commerceStores.tenantId, tenantId), ne(commerceStores.status, 'removed')));
    if (rows.length >= COMMERCE_LIMITS.stores && !rows.some((r) => r.platform === platform && r.ext === externalId))
      throw new CommerceError(409, 'COMMERCE_STORE_LIMIT', `Tối đa ${COMMERCE_LIMITS.stores} cửa hàng`);
  }

  /** A new store, or new credentials for a store already connected (it becomes active again). */
  private async saveStore(
    ctx: Ctx,
    s: Pick<StoreRow, 'platform' | 'externalId' | 'name' | 'clientId' | 'secretName' | 'currency' | 'scopes'>,
  ): Promise<CommerceStoreResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [old] = await tx
        .select()
        .from(commerceStores)
        .where(
          and(
            eq(commerceStores.tenantId, ctx.tenantId),
            eq(commerceStores.platform, s.platform),
            eq(commerceStores.externalId, s.externalId),
            ne(commerceStores.status, 'removed'),
          ),
        );
      let id: string;
      if (old) {
        id = old.id;
        await tx
          .update(commerceStores)
          .set({ ...s, status: 'active', checkError: null })
          .where(eq(commerceStores.id, old.id));
        this.api.forget(old.id);
      } else {
        id = uuidv7();
        await tx.insert(commerceStores).values({
          id,
          tenantId: ctx.tenantId,
          ...s,
          connectedBy: ctx.userId,
        });
      }
      await this.log(tx, ctx, 'commerce.store_connected', id, {
        platform: s.platform,
        store: s.externalId,
        name: s.name,
        secretName: s.secretName,
        reconnected: Boolean(old),
      });
      const stores = await this.storesIn(tx, ctx.tenantId);
      return stores.find((x) => x.id === id)!;
    });
  }

  async setStore(ctx: Ctx, id: string, input: UpdateStore): Promise<CommerceStoreResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const store = await this.storeIn(tx, ctx.tenantId, id);
      await tx.update(commerceStores).set({ enabled: input.enabled }).where(eq(commerceStores.id, id));
      await this.log(tx, ctx, 'commerce.store_updated', id, { enabled: input.enabled, name: store.name });
      return (await this.storesIn(tx, ctx.tenantId)).find((x) => x.id === id)!;
    });
  }

  /** Stops reading the store; what MARIS read stays for reports. */
  async disconnect(ctx: Ctx, id: string): Promise<void> {
    await this.db.withContext(ctx, async (tx) => {
      const store = await this.storeIn(tx, ctx.tenantId, id);
      await tx
        .update(commerceStores)
        .set({ status: 'removed', enabled: false, removedAt: new Date() })
        .where(eq(commerceStores.id, id));
      await this.log(tx, ctx, 'commerce.store_disconnected', id, {
        platform: store.platform,
        store: store.externalId,
        name: store.name,
      });
    });
    this.api.forget(id);
  }

  /** Reads one store now, or every enabled store. */
  async sync(ctx: Ctx, id?: string): Promise<CommerceSyncResponse> {
    const stores = await this.db.withContext(ctx, async (tx) =>
      id
        ? [await this.storeIn(tx, ctx.tenantId, id)]
        : tx
            .select()
            .from(commerceStores)
            .where(
              and(
                eq(commerceStores.tenantId, ctx.tenantId),
                eq(commerceStores.status, 'active'),
                eq(commerceStores.enabled, true),
              ),
            )
            .orderBy(asc(commerceStores.connectedAt), asc(commerceStores.id)),
    );
    const out: CommerceSyncResponse = { stores: 0, variants: 0, orders: 0, contacts: 0, errors: [] };
    for (const s of stores) {
      if (s.status !== 'active')
        throw new CommerceError(409, 'COMMERCE_STORE_INVALID', `Kết nối ${s.name} đã hết hiệu lực, cần kết nối lại`);
      try {
        const r = await this.syncer.syncStore(ctx, s);
        out.stores++;
        out.variants += r.variants;
        out.orders += r.orders;
        out.contacts += r.contacts;
        out.errors.push(...r.errors.map((e) => `${s.name}: ${e}`));
      } catch (e) {
        if (id) throw e;
        out.errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------- reading

  async variants(ctx: Ctx, q: ListVariants): Promise<CommerceVariantsResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const where = and(
        eq(commerceVariants.tenantId, ctx.tenantId),
        eq(commerceVariants.present, true),
        ne(commerceStores.status, 'removed'),
        q.storeId ? eq(commerceVariants.storeId, q.storeId) : undefined,
        q.maxStock !== undefined ? lte(commerceVariants.available, q.maxStock) : undefined,
        q.q
          ? or(
              ilike(commerceProducts.title, `%${esc(q.q)}%`),
              ilike(commerceVariants.title, `%${esc(q.q)}%`),
              ilike(commerceVariants.sku, `%${esc(q.q)}%`),
              ilike(commerceVariants.barcode, `%${esc(q.q)}%`),
            )
          : undefined,
      );
      const base = tx
        .select({ v: commerceVariants, p: commerceProducts, s: commerceStores })
        .from(commerceVariants)
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(where);
      const [{ total }] = (await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(commerceVariants)
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(where)) as [{ total: number }];
      const rows = await base
        .orderBy(asc(commerceProducts.title), asc(commerceVariants.title), asc(commerceVariants.id))
        .limit(q.limit)
        .offset(q.offset);
      const stock = await this.stockOf(tx, rows.map((r) => r.v.id));
      return {
        total,
        items: rows.map(({ v, p, s }) => this.variantResponse(v, p, s, stock.get(v.id) ?? [])),
      };
    });
  }

  private async stockOf(tx: Tx, ids: string[]) {
    const map = new Map<string, { locationId: string; locationName: string; available: number }[]>();
    if (!ids.length) return map;
    const rows = await tx
      .select({ variantId: commerceStock.variantId, locationId: commerceStock.locationId, name: commerceLocations.name, available: commerceStock.available })
      .from(commerceStock)
      .innerJoin(commerceLocations, eq(commerceLocations.id, commerceStock.locationId))
      .where(inArray(commerceStock.variantId, ids))
      .orderBy(asc(commerceLocations.name));
    for (const r of rows) {
      const list = map.get(r.variantId) ?? [];
      list.push({ locationId: r.locationId, locationName: r.name, available: r.available });
      map.set(r.variantId, list);
    }
    return map;
  }

  private variantResponse(
    v: VariantRow,
    p: typeof commerceProducts.$inferSelect,
    s: StoreRow,
    stock: { locationId: string; locationName: string; available: number }[],
  ): CommerceVariantResponse {
    return {
      id: v.id,
      storeId: s.id,
      storeName: s.name,
      platform: s.platform,
      productTitle: p.title,
      productStatus: p.status,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      price: Number(v.price),
      compareAt: num(v.compareAt),
      currency: s.currency,
      available: v.available,
      stock,
      editable: s.platform === 'shopify' && s.status === 'active' && s.enabled,
      syncedAt: v.syncedAt.toISOString(),
    };
  }

  /** SKUs sold in more than one store, with each store's price and stock. */
  async skus(ctx: Ctx): Promise<SkuCompareResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const shared = tx
        .select({ k: commerceVariants.skuNorm })
        .from(commerceVariants)
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(
          and(
            eq(commerceVariants.tenantId, ctx.tenantId),
            eq(commerceVariants.present, true),
            isNotNull(commerceVariants.skuNorm),
            ne(commerceStores.status, 'removed'),
          ),
        )
        .groupBy(commerceVariants.skuNorm)
        .having(sql`count(DISTINCT ${commerceVariants.storeId}) > 1`)
        .orderBy(commerceVariants.skuNorm)
        .limit(500);
      const rows = await tx
        .select({ v: commerceVariants, p: commerceProducts, s: commerceStores })
        .from(commerceVariants)
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(
          and(
            eq(commerceVariants.tenantId, ctx.tenantId),
            eq(commerceVariants.present, true),
            ne(commerceStores.status, 'removed'),
            inArray(commerceVariants.skuNorm, shared),
          ),
        )
        .orderBy(asc(commerceVariants.skuNorm), asc(commerceStores.name));
      const groups = new Map<string, SkuCompareResponse>();
      for (const { v, p, s } of rows) {
        const key = v.skuNorm!;
        const g = groups.get(key) ?? {
          sku: v.sku ?? key,
          title: [p.title, v.title].filter(Boolean).join(' · '),
          stores: [],
          priceDiffers: false,
          stockDiffers: false,
        };
        g.stores.push({
          variantId: v.id,
          storeId: s.id,
          storeName: s.name,
          platform: s.platform,
          title: [p.title, v.title].filter(Boolean).join(' · '),
          price: Number(v.price),
          currency: s.currency,
          available: v.available,
          editable: s.platform === 'shopify' && s.status === 'active' && s.enabled,
        });
        groups.set(key, g);
      }
      return [...groups.values()].map((g) => ({
        ...g,
        priceDiffers: new Set(g.stores.map((x) => `${x.price} ${x.currency}`)).size > 1,
        stockDiffers: new Set(g.stores.map((x) => x.available)).size > 1,
      }));
    });
  }

  async orders(ctx: Ctx, q: ListOrders): Promise<CommerceOrdersResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const where = and(
        eq(commerceOrders.tenantId, ctx.tenantId),
        q.storeId ? eq(commerceOrders.storeId, q.storeId) : undefined,
        q.state ? eq(commerceOrders.state, q.state) : undefined,
        q.q
          ? or(
              ilike(commerceOrders.number, `%${esc(q.q)}%`),
              ilike(commerceOrders.customerName, `%${esc(q.q)}%`),
              ilike(commerceOrders.phone, `%${esc(q.q)}%`),
              ilike(commerceOrders.email, `%${esc(q.q)}%`),
            )
          : undefined,
      );
      const [{ total }] = (await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(commerceOrders)
        .where(where)) as [{ total: number }];
      const rows = await tx
        .select({ o: commerceOrders, s: commerceStores })
        .from(commerceOrders)
        .innerJoin(commerceStores, eq(commerceStores.id, commerceOrders.storeId))
        .where(where)
        .orderBy(desc(commerceOrders.placedAt), desc(commerceOrders.id))
        .limit(q.limit)
        .offset(q.offset);
      return {
        total,
        items: rows.map(
          ({ o, s }): CommerceOrderResponse => ({
            id: o.id,
            storeId: s.id,
            storeName: s.name,
            platform: s.platform,
            number: o.number,
            state: o.state,
            rawStatus: o.rawStatus,
            total: Number(o.total),
            currency: o.currency,
            customerName: o.customerName,
            phone: o.phone,
            email: o.email,
            contactId: o.contactId,
            items: o.items,
            placedAt: o.placedAt.toISOString(),
            updatedAt: o.updatedExt.toISOString(),
          }),
        ),
      };
    });
  }

  async report(ctx: Ctx, days: number): Promise<CommerceReportResponse> {
    const since = new Date(Date.now() - days * 86_400_000);
    return this.db.withContext(ctx, async (tx) => {
      const live = sql`${commerceOrders.state} NOT IN ('cancelled', 'returned')`;
      const per = await tx
        .select({
          storeId: commerceStores.id,
          storeName: commerceStores.name,
          platform: commerceStores.platform,
          currency: commerceStores.currency,
          orders: sql<number>`count(${commerceOrders.id})::int`,
          revenue: sql<string>`coalesce(sum(${commerceOrders.total}) FILTER (WHERE ${live}), 0)`,
          cancelled: sql<number>`count(*) FILTER (WHERE ${commerceOrders.state} = 'cancelled')::int`,
          returned: sql<number>`count(*) FILTER (WHERE ${commerceOrders.state} = 'returned')::int`,
        })
        .from(commerceStores)
        .leftJoin(
          commerceOrders,
          and(eq(commerceOrders.storeId, commerceStores.id), gte(commerceOrders.placedAt, since)),
        )
        .where(and(eq(commerceStores.tenantId, ctx.tenantId), ne(commerceStores.status, 'removed')))
        .groupBy(commerceStores.id)
        .orderBy(asc(commerceStores.name));
      // Days in Vietnam time (spec: Asia/Ho_Chi_Minh is the business day).
      const dayExpr = sql<string>`to_char(${commerceOrders.placedAt} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
      const daily = await tx
        .select({
          day: dayExpr,
          currency: commerceOrders.currency,
          orders: sql<number>`count(*)::int`,
          revenue: sql<string>`coalesce(sum(${commerceOrders.total}) FILTER (WHERE ${live}), 0)`,
        })
        .from(commerceOrders)
        .innerJoin(commerceStores, eq(commerceStores.id, commerceOrders.storeId))
        .where(
          and(
            eq(commerceOrders.tenantId, ctx.tenantId),
            gte(commerceOrders.placedAt, since),
            ne(commerceStores.status, 'removed'),
          ),
        )
        .groupBy(dayExpr, commerceOrders.currency)
        .orderBy(dayExpr);
      const top = await tx.execute<{ sku: string; title: string; quantity: number }>(sql`
        SELECT coalesce(i->>'sku', '') AS sku, max(i->>'title') AS title,
               sum((i->>'quantity')::int)::int AS quantity
        FROM commerce.orders o
        JOIN commerce.stores s ON s.id = o.store_id
        CROSS JOIN LATERAL jsonb_array_elements(o.items) AS i
        WHERE o.tenant_id = ${ctx.tenantId} AND o.placed_at >= ${since.toISOString()}
          AND s.status <> 'removed' AND o.state NOT IN ('cancelled', 'returned')
        GROUP BY coalesce(i->>'sku', ''), CASE WHEN coalesce(i->>'sku', '') = '' THEN i->>'title' END
        ORDER BY 3 DESC, 1
        LIMIT 10`);
      const [{ low }] = (await tx
        .select({ low: sql<number>`count(*)::int` })
        .from(commerceVariants)
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(
          and(
            eq(commerceVariants.tenantId, ctx.tenantId),
            eq(commerceVariants.present, true),
            ne(commerceStores.status, 'removed'),
            lte(commerceVariants.available, 5),
          ),
        )) as [{ low: number }];
      return {
        days,
        stores: per.map((p) => ({ ...p, revenue: Number(p.revenue) })),
        daily: daily.map((d) => ({ ...d, revenue: Number(d.revenue) })),
        topSkus: [...top].map((t) => ({ sku: t.sku, title: t.title ?? '', quantity: Number(t.quantity) })),
        lowStock: low,
      };
    });
  }

  async changes(ctx: Ctx): Promise<CommerceChangeResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({
          c: commerceChanges,
          store: commerceStores.name,
          title: commerceVariants.title,
          product: commerceProducts.title,
          sku: commerceVariants.sku,
          loc: commerceLocations.name,
          who: users.displayName,
        })
        .from(commerceChanges)
        .innerJoin(commerceStores, eq(commerceStores.id, commerceChanges.storeId))
        .innerJoin(commerceVariants, eq(commerceVariants.id, commerceChanges.variantId))
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .leftJoin(commerceLocations, eq(commerceLocations.id, commerceChanges.locationId))
        .leftJoin(users, eq(users.id, commerceChanges.requestedBy))
        .where(eq(commerceChanges.tenantId, ctx.tenantId))
        .orderBy(desc(commerceChanges.createdAt), desc(commerceChanges.id))
        .limit(50);
      return rows.map(({ c, store, title, product, sku, loc, who }) => ({
        id: c.id,
        storeName: store,
        variantTitle: [product, title].filter(Boolean).join(' · '),
        sku,
        kind: c.kind,
        locationName: loc,
        oldValue: Number(c.oldValue),
        newValue: Number(c.newValue),
        outcome: c.outcome,
        error: c.error,
        requestedByName: who,
        createdAt: c.createdAt.toISOString(),
      }));
    });
  }

  async calls(ctx: Ctx): Promise<ApiCallResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({ c: apiCalls, name: users.displayName })
        .from(apiCalls)
        .leftJoin(users, eq(users.id, apiCalls.calledBy))
        .where(
          and(eq(apiCalls.tenantId, ctx.tenantId), inArray(apiCalls.provider, ['shopify', 'poscake'])),
        )
        .orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
        .limit(50);
      return rows.map(({ c, name }) => ({
        id: c.id,
        group: `${c.provider} ${c.apiGroup}`,
        method: c.method,
        path: c.path,
        outcome: c.outcome,
        httpStatus: c.httpStatus,
        errorCode: c.errorCode,
        errorMessage: c.errorMessage,
        durationMs: c.durationMs,
        calledByName: name,
        createdAt: c.createdAt.toISOString(),
      }));
    });
  }

  // ---------------------------------------------------------------------------------- writing

  /** The variant and its store, if MARIS may change it on Shopify. */
  private async writable(ctx: Ctx, variantId: string) {
    return this.db.withContext(ctx, async (tx) => {
      const [row] = await tx
        .select({ v: commerceVariants, p: commerceProducts, s: commerceStores })
        .from(commerceVariants)
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(and(eq(commerceVariants.id, variantId), eq(commerceVariants.tenantId, ctx.tenantId)));
      if (!row || !row.v.present)
        throw new CommerceError(404, 'COMMERCE_VARIANT_NOT_FOUND', 'Không tìm thấy mẫu mã này');
      if (row.s.platform !== 'shopify')
        throw new CommerceError(409, 'COMMERCE_READ_ONLY', 'MARIS chỉ đọc dữ liệu POSCake, không sửa giá hay tồn kho');
      if (row.s.status !== 'active' || !row.s.enabled)
        throw new CommerceError(409, 'COMMERCE_STORE_OFF', `Cửa hàng ${row.s.name} đang tắt hoặc cần kết nối lại`);
      return row;
    });
  }

  private async needScope(ctx: Ctx, s: StoreRow, scope: string): Promise<void> {
    const { scopes } = await this.api.shopifyToken(ctx, targetOf(s));
    if (!scopes.includes(scope))
      throw new CommerceError(
        409,
        'SHOPIFY_SCOPE_MISSING',
        `Ứng dụng Shopify chưa có quyền ${scope}: thêm quyền này trong Dev Dashboard, tạo bản mới rồi cài lại vào cửa hàng`,
      );
  }

  async setPrice(ctx: Ctx, variantId: string, input: SetPrice): Promise<CommerceVariantResponse> {
    const { v, s } = await this.writable(ctx, variantId);
    await this.needScope(ctx, s, 'write_products');
    const t = targetOf(s);
    const live = await this.api.shopify<{ productVariant: { id: string; price: string; product: { id: string } } | null }>(
      ctx,
      t,
      'read',
      'VariantPrice',
      PRICE_QUERY,
      { id: v.externalId },
    );
    const pv = live.data.productVariant;
    if (!pv) throw new CommerceError(404, 'COMMERCE_VARIANT_NOT_FOUND', 'Mẫu mã này không còn trên Shopify');
    const current = money(pv.price);
    if (current !== input.expected) {
      await this.record(ctx, v, s, { kind: 'price', old: current, new: input.price, outcome: 'conflict', error: 'Giá trên Shopify đã khác giá đang xem' }, { price: current.toFixed(2) });
      throw new CommerceError(
        409,
        'COMMERCE_CONFLICT',
        `Giá trên Shopify đã đổi thành ${current.toLocaleString('vi-VN')} ${s.currency}. MARIS đã cập nhật; xem lại rồi đổi lại nếu cần.`,
      );
    }
    const r = await this.api.shopify<{
      productVariantsBulkUpdate: {
        productVariants: { id: string; price: string }[] | null;
        userErrors: { field?: string[]; message: string }[];
      } | null;
    }>(ctx, t, 'write', 'SetPrice', PRICE_MUTATION, {
      productId: pv.product.id,
      variants: [{ id: v.externalId, price: input.price.toFixed(2) }],
    });
    const errs = r.data.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length || !r.data.productVariantsBulkUpdate) {
      const error = errs.map((e) => e.message).join('; ').slice(0, 500) || 'Shopify không đổi giá';
      await this.record(ctx, v, s, { kind: 'price', old: current, new: input.price, outcome: 'failed', error });
      throw new CommerceError(422, 'SHOPIFY_USER_ERROR', `Shopify không đổi giá: ${error}`);
    }
    const now = money(r.data.productVariantsBulkUpdate.productVariants?.[0]?.price ?? input.price);
    return this.record(ctx, v, s, { kind: 'price', old: current, new: now, outcome: 'done' }, { price: now.toFixed(2) });
  }

  async setStock(ctx: Ctx, variantId: string, input: SetStock): Promise<CommerceVariantResponse> {
    const { v, s } = await this.writable(ctx, variantId);
    if (!v.inventoryItemId || v.available === null)
      throw new CommerceError(409, 'COMMERCE_NOT_TRACKED', 'Shopify không theo dõi tồn kho của mẫu mã này');
    const [loc] = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(commerceLocations)
        .where(and(eq(commerceLocations.id, input.locationId), eq(commerceLocations.storeId, s.id))),
    );
    if (!loc) throw new CommerceError(404, 'COMMERCE_LOCATION_NOT_FOUND', 'Không tìm thấy địa điểm kho này');
    await this.needScope(ctx, s, 'write_inventory');
    const changeId = uuidv7();
    const r = await this.api.shopify<{
      inventorySetQuantities: {
        userErrors: { code?: string; field?: string[]; message: string }[];
      } | null;
    }>(ctx, targetOf(s), 'write', 'SetStock', STOCK_MUTATION, {
      key: changeId,
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `maris://commerce/changes/${changeId}`,
        quantities: [
          {
            inventoryItemId: v.inventoryItemId,
            locationId: loc.externalId,
            quantity: input.quantity,
            // Shopify changes it only if it still holds what the person saw.
            changeFromQuantity: input.expected,
          },
        ],
      },
    });
    const errs = r.data.inventorySetQuantities?.userErrors ?? [];
    const stale = errs.some((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE');
    if (errs.length || !r.data.inventorySetQuantities) {
      const error = errs.map((e) => e.message).join('; ').slice(0, 500) || 'Shopify không đổi tồn kho';
      await this.record(ctx, v, s, {
        id: changeId,
        kind: 'stock',
        locationId: loc.id,
        old: input.expected,
        new: input.quantity,
        outcome: stale ? 'conflict' : 'failed',
        error,
      });
      throw stale
        ? new CommerceError(409, 'COMMERCE_CONFLICT', 'Tồn kho trên Shopify đã đổi so với số đang xem. Bấm “Đọc ngay” để lấy số mới rồi đổi lại.')
        : new CommerceError(422, 'SHOPIFY_USER_ERROR', `Shopify không đổi tồn kho: ${error}`);
    }
    return this.record(
      ctx,
      v,
      s,
      { id: changeId, kind: 'stock', locationId: loc.id, old: input.expected, new: input.quantity, outcome: 'done' },
      { stock: { locationId: loc.id, available: input.quantity } },
    );
  }

  /**
   * Records a change attempt and, when it went through, MARIS's copy of the new value, with the
   * audit log, in one transaction.
   */
  private async record(
    ctx: Ctx,
    v: VariantRow,
    s: StoreRow,
    c: {
      id?: string;
      kind: 'price' | 'stock';
      locationId?: string;
      old: number;
      new: number;
      outcome: 'done' | 'failed' | 'conflict';
      error?: string;
    },
    apply?: { price?: string; stock?: { locationId: string; available: number } },
  ): Promise<CommerceVariantResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const id = c.id ?? uuidv7();
      await tx.insert(commerceChanges).values({
        id,
        tenantId: ctx.tenantId,
        storeId: s.id,
        variantId: v.id,
        kind: c.kind,
        locationId: c.locationId ?? null,
        oldValue: c.old.toFixed(2),
        newValue: c.new.toFixed(2),
        outcome: c.outcome,
        error: c.error?.slice(0, 500) ?? null,
        requestedBy: ctx.userId,
      });
      if (apply?.price !== undefined)
        await tx.update(commerceVariants).set({ price: apply.price }).where(eq(commerceVariants.id, v.id));
      if (apply?.stock) {
        await tx
          .insert(commerceStock)
          .values({ tenantId: ctx.tenantId, variantId: v.id, locationId: apply.stock.locationId, available: apply.stock.available })
          .onConflictDoUpdate({
            target: [commerceStock.variantId, commerceStock.locationId],
            set: { available: apply.stock.available },
          });
        await tx
          .update(commerceVariants)
          .set({
            available: sql`(SELECT coalesce(sum(available), 0) FROM commerce.stock WHERE variant_id = ${v.id})`,
          })
          .where(eq(commerceVariants.id, v.id));
      }
      await this.log(tx, ctx, c.kind === 'price' ? 'commerce.price_set' : 'commerce.stock_set', v.id, {
        store: s.name,
        sku: v.sku,
        locationId: c.locationId ?? null,
        old: c.old,
        new: c.new,
        outcome: c.outcome,
        changeId: id,
      });
      const [row] = await tx
        .select({ v: commerceVariants, p: commerceProducts, s: commerceStores })
        .from(commerceVariants)
        .innerJoin(commerceProducts, eq(commerceProducts.id, commerceVariants.productId))
        .innerJoin(commerceStores, eq(commerceStores.id, commerceVariants.storeId))
        .where(eq(commerceVariants.id, v.id));
      const stock = await this.stockOf(tx, [v.id]);
      return this.variantResponse(row!.v, row!.p, row!.s, stock.get(v.id) ?? []);
    });
  }

  // ---------------------------------------------------------------------------------- helpers

  private async storeIn(tx: Tx, tenantId: string, id: string): Promise<StoreRow> {
    const [s] = await tx
      .select()
      .from(commerceStores)
      .where(and(eq(commerceStores.id, id), eq(commerceStores.tenantId, tenantId), ne(commerceStores.status, 'removed')));
    if (!s) throw new CommerceError(404, 'COMMERCE_STORE_NOT_FOUND', 'Không tìm thấy cửa hàng');
    return s;
  }

  private async storesIn(tx: Tx, tenantId: string): Promise<CommerceStoreResponse[]> {
    const rows = await tx
      .select({
        s: commerceStores,
        who: users.displayName,
        products: sql<number>`(SELECT count(*)::int FROM commerce.products p WHERE p.store_id = ${commerceStores.id} AND p.present)`,
        variants: sql<number>`(SELECT count(*)::int FROM commerce.variants v WHERE v.store_id = ${commerceStores.id} AND v.present)`,
        orders: sql<number>`(SELECT count(*)::int FROM commerce.orders o WHERE o.store_id = ${commerceStores.id})`,
      })
      .from(commerceStores)
      .leftJoin(users, eq(users.id, commerceStores.connectedBy))
      .where(and(eq(commerceStores.tenantId, tenantId), ne(commerceStores.status, 'removed')))
      .orderBy(asc(commerceStores.connectedAt));
    const names = [...new Set(rows.map((r) => r.s.secretName))];
    const found = names.length
      ? await tx
          .select({ name: secrets.name })
          .from(secrets)
          .where(and(eq(secrets.tenantId, tenantId), inArray(secrets.name, names), isNull(secrets.deletedAt)))
      : [];
    const have = new Set(found.map((f) => f.name));
    return rows.map(({ s, who, products, variants, orders }) => {
      const missing =
        s.platform === 'shopify'
          ? [...SHOPIFY_SCOPES.read, ...SHOPIFY_SCOPES.write].filter((x) => !s.scopes.includes(x))
          : [];
      return {
        id: s.id,
        platform: s.platform,
        externalId: s.externalId,
        name: s.name,
        clientId: s.clientId,
        secretName: s.secretName,
        secretFound: have.has(s.secretName),
        currency: s.currency,
        scopes: s.scopes,
        missingScopes: missing,
        canWrite:
          s.platform === 'shopify' && SHOPIFY_SCOPES.write.every((x) => s.scopes.includes(x)),
        status: s.status,
        checkError: s.checkError,
        enabled: s.enabled,
        syncedAt: s.syncedAt?.toISOString() ?? null,
        syncError: s.syncError,
        products,
        variants,
        orders,
        connectedByName: who,
        connectedAt: s.connectedAt.toISOString(),
      };
    });
  }

  private log(tx: Tx, ctx: Ctx, action: string, targetId: string | null, metadata: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'commerce',
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}

