import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { COMMERCE_LIMITS, type CommerceSyncResponse } from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { addActivity, lockContacts, matchOrCreate } from '../crm/contacts-core';
import {
  CommerceApiService,
  CommerceError,
  targetOf,
  type CommerceCtx,
  type StoreRow,
} from './commerce-api.service';
import {
  clip,
  count,
  gidTail,
  money,
  moneyText,
  poscakeMoney,
  poscakeOrderState,
  poscakeTime,
  shopifyOrderState,
  skuNorm,
} from './rules';

const {
  commerceStores,
  commerceLocations,
  commerceProducts,
  commerceVariants,
  commerceStock,
  commerceOrders,
} = schema;

const TICK_MS = 60_000;
const SHOPIFY_PAGE = 50;
const SHOPIFY_ORDER_PAGE = 25;
const POSCAKE_PAGE = 100;
/** Orders read per store in one sync; the rest come next time (the cursor moves). */
const MAX_ORDERS = 2_000;

type CommerceOrderItem = schema.CommerceOrderItem;
type CommerceOrderState = schema.CommerceOrderState;

interface LocationIn {
  externalId: string;
  name: string;
  active: boolean;
}

interface VariantIn {
  product: { externalId: string; title: string; status: string; productType: string | null; vendor: string | null };
  externalId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  compareAt: number | null;
  inventoryItemId: string | null;
  available: number | null;
  /** Stock per location, by the store's location id. */
  stock: { location: string; available: number }[];
}

interface OrderIn {
  externalId: string;
  number: string;
  state: CommerceOrderState;
  raw: string;
  total: number;
  currency: string;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  items: CommerceOrderItem[];
  placedAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------------- queries

const SHOPIFY_LOCATIONS = `query Locations {
  locations(first: 100, includeInactive: true) { nodes { id name isActive } }
}`;

const SHOPIFY_VARIANTS = `query Variants($after: String) {
  productVariants(first: ${SHOPIFY_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku barcode price compareAtPrice inventoryQuantity
      product { id title status productType vendor }
      inventoryItem {
        id tracked
        inventoryLevels(first: 10) {
          nodes { location { id } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }
}`;

const SHOPIFY_ORDERS = `query Orders($after: String, $q: String) {
  orders(first: ${SHOPIFY_ORDER_PAGE}, after: $after, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt email phone
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer { displayName }
      billingAddress { name phone }
      lineItems(first: 20) {
        nodes { sku title quantity originalUnitPriceSet { shopMoney { amount } } }
      }
    }
  }
}`;

interface ShopifyVariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  product?: { id: string; title?: string; status?: string; productType?: string; vendor?: string } | null;
  inventoryItem?: {
    id: string;
    tracked?: boolean;
    inventoryLevels?: {
      nodes?: { location?: { id: string }; quantities?: { name: string; quantity: number }[] }[];
    };
  } | null;
}

interface ShopifyOrderNode {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
  email?: string | null;
  phone?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } } | null;
  customer?: { displayName?: string | null } | null;
  billingAddress?: { name?: string | null; phone?: string | null } | null;
  lineItems?: {
    nodes?: {
      sku?: string | null;
      title?: string;
      quantity?: number;
      originalUnitPriceSet?: { shopMoney?: { amount?: string } };
    }[];
  };
}

interface PoscakeVariation {
  id: string;
  product_id?: string;
  display_id?: string | null;
  barcode?: string | null;
  retail_price?: number | string | null;
  remain_quantity?: number | null;
  fields?: { name?: string; value?: string }[] | null;
  variations_warehouses?: { warehouse_id?: string; remain_quantity?: number | null }[] | null;
  product?: { id?: string; name?: string; display_id?: string | null; is_locked?: boolean } | null;
}

interface PoscakeOrder {
  id: number | string;
  display_id?: number | string | null;
  status?: number;
  inserted_at?: string;
  updated_at?: string;
  bill_full_name?: string | null;
  bill_phone_number?: string | null;
  bill_email?: string | null;
  total_price?: number | null;
  items?: {
    quantity?: number;
    variation_info?: { name?: string; display_id?: string | null; retail_price?: number | null } | null;
  }[];
}

interface PoscakePage<T> {
  data?: T[];
  page_number?: number;
  total_pages?: number;
}

/**
 * Reads connected stores (spec Part 18): locations or warehouses, every variant with its price and
 * stock, and the orders updated since the last read. Runs every COMMERCE_SYNC_MIN minutes for
 * every enabled store, and on request. Buyers join CRM contacts with the same phone number or
 * email; a new order is added to the contact's history.
 */
@Injectable()
export class CommerceSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CommerceSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  /** Stores being read now, so two reads of one store never overlap. */
  private readonly running = new Set<string>();
  private lastPoll = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly api: CommerceApiService,
  ) {}

  onModuleInit(): void {
    if (!this.config.COMMERCE_SYNC_MIN) return;
    this.timer = setInterval(() => void this.pollOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every enabled store whose last read is older than COMMERCE_SYNC_MIN. */
  async pollOnce(): Promise<number> {
    if (this.polling || Date.now() - this.lastPoll < this.config.COMMERCE_SYNC_MIN * 60_000) return 0;
    this.polling = true;
    this.lastPoll = Date.now();
    try {
      const stores = await this.db.withSystem('commerce_sync', (tx) =>
        tx
          .select()
          .from(commerceStores)
          .where(and(eq(commerceStores.status, 'active'), eq(commerceStores.enabled, true))),
      );
      let n = 0;
      for (const s of stores) {
        try {
          await this.syncStore({ tenantId: s.tenantId, userId: null }, s);
          n++;
        } catch (e) {
          this.log.warn(`store ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return n;
    } finally {
      this.polling = false;
    }
  }

  /** Reads one store. Errors are kept on the store and thrown. */
  async syncStore(ctx: CommerceCtx, store: StoreRow): Promise<CommerceSyncResponse> {
    if (this.running.has(store.id))
      throw new CommerceError(409, 'COMMERCE_SYNC_RUNNING', `MARIS đang đọc ${store.name}`);
    this.running.add(store.id);
    const started = new Date();
    const out: CommerceSyncResponse = { stores: 1, variants: 0, orders: 0, contacts: 0, errors: [] };
    try {
      if (store.platform === 'shopify') await this.syncShopify(ctx, store, started, out);
      else await this.syncPoscake(ctx, store, started, out);
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(commerceStores)
          .set({ syncedAt: new Date(), syncError: out.errors[0]?.slice(0, 500) ?? null })
          .where(eq(commerceStores.id, store.id)),
      );
      return out;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(commerceStores)
          .set({ syncError: message.slice(0, 500) })
          .where(eq(commerceStores.id, store.id)),
      );
      throw e;
    } finally {
      this.running.delete(store.id);
    }
  }

  // ---------------------------------------------------------------------------------- Shopify

  private async syncShopify(
    ctx: CommerceCtx,
    store: StoreRow,
    started: Date,
    out: CommerceSyncResponse,
  ): Promise<void> {
    const t = targetOf(store);
    const { scopes } = await this.api.shopifyToken(ctx, t);
    if (scopes.length && scopes.join(',') !== store.scopes.join(','))
      await this.db.withContext(ctx, (tx) =>
        tx.update(commerceStores).set({ scopes }).where(eq(commerceStores.id, store.id)),
      );

    const loc = await this.api.shopify<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(
      ctx,
      t,
      'sync',
      'Locations',
      SHOPIFY_LOCATIONS,
    );
    await this.saveLocations(
      ctx,
      store,
      loc.data.locations.nodes.map((l) => ({ externalId: l.id, name: l.name, active: l.isActive })),
    );

    let after: string | null = null;
    for (;;) {
      const r: {
        data: {
          productVariants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: ShopifyVariantNode[];
          };
        };
        warnings: string[];
      } = await this.api.shopify(ctx, t, 'sync', 'Variants', SHOPIFY_VARIANTS, { after });
      const page = r.data.productVariants;
      const rows: VariantIn[] = page.nodes
        .filter((v) => v.product)
        .map((v) => {
          const levels = v.inventoryItem?.inventoryLevels?.nodes ?? [];
          const tracked = v.inventoryItem?.tracked !== false;
          return {
            product: {
              externalId: v.product!.id,
              title: clip(v.product!.title, 500) ?? gidTail(v.product!.id),
              status: clip(v.product!.status, 40) ?? 'ACTIVE',
              productType: clip(v.product!.productType, 200),
              vendor: clip(v.product!.vendor, 200),
            },
            externalId: v.id,
            title: clip(v.title, 500) ?? '',
            sku: clip(v.sku, 200),
            barcode: clip(v.barcode, 200),
            price: money(v.price),
            compareAt: v.compareAtPrice ? money(v.compareAtPrice) : null,
            inventoryItemId: clip(v.inventoryItem?.id, 200),
            available: tracked ? count(v.inventoryQuantity) : null,
            stock: tracked
              ? levels
                  .filter((l) => l.location?.id)
                  .map((l) => ({
                    location: l.location!.id,
                    available: count(l.quantities?.find((q) => q.name === 'available')?.quantity) ?? 0,
                  }))
              : [],
          };
        });
      out.variants += await this.saveVariants(ctx, store, rows);
      if (r.warnings.length && !out.errors.length) out.errors.push(r.warnings[0]!);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      if (out.variants >= COMMERCE_LIMITS.maxVariants) {
        out.errors.push(`Chỉ đọc ${COMMERCE_LIMITS.maxVariants} mẫu mã đầu tiên`);
        break;
      }
      after = page.pageInfo.endCursor;
    }
    if (!out.errors.some((e) => e.startsWith('Chỉ đọc'))) await this.markGone(ctx, store, started);

    const since = store.ordersCursor ?? new Date(Date.now() - COMMERCE_LIMITS.firstOrderDays * 86_400_000);
    const q = `updated_at:>'${since.toISOString()}'`;
    after = null;
    let cursor = since;
    for (;;) {
      const r: {
        data: {
          orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrderNode[] };
        };
        warnings: string[];
      } = await this.api.shopify(ctx, t, 'sync', 'Orders', SHOPIFY_ORDERS, { after, q });
      const page = r.data.orders;
      const rows: OrderIn[] = page.nodes.map((o) => {
        const st = shopifyOrderState(o);
        return {
          externalId: o.id,
          number: clip(o.name, 100) ?? gidTail(o.id),
          state: st.state,
          raw: st.raw.slice(0, 200),
          total: money(o.currentTotalPriceSet?.shopMoney?.amount),
          currency: clip(o.currentTotalPriceSet?.shopMoney?.currencyCode, 3) ?? store.currency,
          customerName: clip(o.customer?.displayName ?? o.billingAddress?.name, 200),
          phone: clip(o.phone ?? o.billingAddress?.phone, 40),
          email: clip(o.email, 200),
          items: (o.lineItems?.nodes ?? []).map((li) => ({
            sku: clip(li.sku, 200),
            title: clip(li.title, 300) ?? '',
            quantity: count(li.quantity) ?? 0,
            price: money(li.originalUnitPriceSet?.shopMoney?.amount),
          })),
          placedAt: new Date(o.createdAt),
          updatedAt: new Date(o.updatedAt),
        };
      });
      if (r.warnings.length && !out.errors.length) out.errors.push(r.warnings[0]!);
      const saved = await this.saveOrders(ctx, store, rows);
      out.orders += saved.orders;
      out.contacts += saved.contacts;
      for (const o of rows) if (o.updatedAt > cursor) cursor = o.updatedAt;
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor || out.orders >= MAX_ORDERS) break;
      after = page.pageInfo.endCursor;
    }
    await this.saveCursor(ctx, store, cursor);
  }

  // ---------------------------------------------------------------------------------- POSCake

  private async syncPoscake(
    ctx: CommerceCtx,
    store: StoreRow,
    started: Date,
    out: CommerceSyncResponse,
  ): Promise<void> {
    const t = targetOf(store);
    const base = `/shops/${store.externalId}`;
    const wh = await this.api.poscake<{ data?: { id: string; name?: string }[] }>(ctx, t, 'sync', `${base}/warehouses`);
    await this.saveLocations(
      ctx,
      store,
      (wh.data ?? [])
        .filter((w) => w.id)
        .map((w) => ({ externalId: String(w.id), name: clip(w.name, 300) ?? String(w.id), active: true })),
    );

    let capped = false;
    for (let page = 1; ; page++) {
      const r = await this.api.poscake<PoscakePage<PoscakeVariation>>(ctx, t, 'sync', `${base}/products/variations`, {
        page_number: page,
        page_size: POSCAKE_PAGE,
      });
      const rows: VariantIn[] = (r.data ?? [])
        .filter((v) => v.id)
        .map((v) => {
          const productId = String(v.product_id ?? v.product?.id ?? v.id);
          const name = clip(v.product?.name, 500) ?? productId;
          const attrs = (v.fields ?? [])
            .map((f) => clip(f.value, 100))
            .filter(Boolean)
            .join(' / ');
          return {
            product: {
              externalId: productId,
              title: name,
              status: v.product?.is_locked ? 'locked' : 'active',
              productType: null,
              vendor: null,
            },
            externalId: String(v.id),
            title: attrs.slice(0, 500),
            sku: clip(v.display_id, 200) ?? clip(v.barcode, 200),
            barcode: clip(v.barcode, 200),
            price: poscakeMoney(v.retail_price, store.currency),
            compareAt: null,
            inventoryItemId: null,
            available: count(v.remain_quantity),
            stock: (v.variations_warehouses ?? [])
              .filter((w) => w.warehouse_id)
              .map((w) => ({ location: String(w.warehouse_id), available: count(w.remain_quantity) ?? 0 })),
          };
        });
      out.variants += await this.saveVariants(ctx, store, rows);
      if (!rows.length || page >= (r.total_pages ?? page)) break;
      if (out.variants >= COMMERCE_LIMITS.maxVariants) {
        out.errors.push(`Chỉ đọc ${COMMERCE_LIMITS.maxVariants} mẫu mã đầu tiên`);
        capped = true;
        break;
      }
    }
    if (!capped) await this.markGone(ctx, store, started);

    const since = store.ordersCursor ?? new Date(Date.now() - COMMERCE_LIMITS.firstOrderDays * 86_400_000);
    const until = new Date();
    let cursor = since;
    for (let page = 1; ; page++) {
      const r = await this.api.poscake<PoscakePage<PoscakeOrder>>(ctx, t, 'sync', `${base}/orders`, {
        updateStatus: 'updated_at',
        startDateTime: Math.floor(since.getTime() / 1000),
        endDateTime: Math.floor(until.getTime() / 1000),
        page_number: page,
        page_size: POSCAKE_PAGE,
      });
      const rows: OrderIn[] = [];
      for (const o of r.data ?? []) {
        if (o.id === undefined || o.id === null) continue;
        const placed = poscakeTime(o.inserted_at);
        const updated = poscakeTime(o.updated_at) ?? placed;
        if (!placed || !updated) continue;
        const st = poscakeOrderState(o.status);
        rows.push({
          externalId: String(o.id),
          number: String(o.display_id ?? o.id).slice(0, 100),
          state: st.state,
          raw: st.raw,
          total: poscakeMoney(o.total_price, store.currency),
          currency: store.currency,
          customerName: clip(o.bill_full_name, 200),
          phone: clip(o.bill_phone_number, 40),
          email: clip(o.bill_email, 200),
          items: (o.items ?? []).map((i) => ({
            sku: clip(i.variation_info?.display_id, 200),
            title: clip(i.variation_info?.name, 300) ?? '',
            quantity: count(i.quantity) ?? 0,
            price: poscakeMoney(i.variation_info?.retail_price, store.currency),
          })),
          placedAt: placed,
          updatedAt: updated,
        });
      }
      const saved = await this.saveOrders(ctx, store, rows);
      out.orders += saved.orders;
      out.contacts += saved.contacts;
      for (const o of rows) if (o.updatedAt > cursor) cursor = o.updatedAt;
      if (!(r.data ?? []).length || page >= (r.total_pages ?? page) || out.orders >= MAX_ORDERS) break;
    }
    // POSCake filters by the time asked for, so the next read starts where this one ended.
    await this.saveCursor(ctx, store, out.orders >= MAX_ORDERS ? cursor : until);
  }

  // ---------------------------------------------------------------------------------- saving

  private async saveLocations(ctx: CommerceCtx, store: StoreRow, rows: LocationIn[]): Promise<void> {
    if (!rows.length) return;
    await this.db.withContext(ctx, async (tx) => {
      for (const l of rows)
        await tx
          .insert(commerceLocations)
          .values({ id: uuidv7(), tenantId: ctx.tenantId, storeId: store.id, ...l })
          .onConflictDoUpdate({
            target: [commerceLocations.storeId, commerceLocations.externalId],
            set: { name: l.name, active: l.active },
          });
    });
  }

  /** Stores one page of variants with their products and stock; returns how many. */
  private async saveVariants(ctx: CommerceCtx, store: StoreRow, rows: VariantIn[]): Promise<number> {
    if (!rows.length) return 0;
    return this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      const locs = await tx
        .select({ id: commerceLocations.id, ext: commerceLocations.externalId })
        .from(commerceLocations)
        .where(eq(commerceLocations.storeId, store.id));
      const locOf = new Map(locs.map((l) => [l.ext, l.id]));
      const productIds = new Map<string, string>();
      for (const v of rows) {
        if (productIds.has(v.product.externalId)) continue;
        const [p] = await tx
          .insert(commerceProducts)
          .values({ id: uuidv7(), tenantId: ctx.tenantId, storeId: store.id, ...v.product, syncedAt: now })
          .onConflictDoUpdate({
            target: [commerceProducts.storeId, commerceProducts.externalId],
            set: {
              title: v.product.title,
              status: v.product.status,
              productType: v.product.productType,
              vendor: v.product.vendor,
              present: true,
              syncedAt: now,
            },
          })
          .returning({ id: commerceProducts.id });
        productIds.set(v.product.externalId, p!.id);
      }
      for (const v of rows) {
        const values = {
          productId: productIds.get(v.product.externalId)!,
          title: v.title,
          sku: v.sku,
          skuNorm: skuNorm(v.sku),
          barcode: v.barcode,
          price: v.price.toFixed(2),
          compareAt: v.compareAt === null ? null : v.compareAt.toFixed(2),
          inventoryItemId: v.inventoryItemId,
          available: v.available,
          present: true,
          syncedAt: now,
        };
        const [row] = await tx
          .insert(commerceVariants)
          .values({ id: uuidv7(), tenantId: ctx.tenantId, storeId: store.id, externalId: v.externalId, ...values })
          .onConflictDoUpdate({
            target: [commerceVariants.storeId, commerceVariants.externalId],
            set: values,
          })
          .returning({ id: commerceVariants.id });
        await tx.delete(commerceStock).where(eq(commerceStock.variantId, row!.id));
        const stock = v.stock
          .filter((s) => locOf.has(s.location))
          .map((s) => ({
            tenantId: ctx.tenantId,
            variantId: row!.id,
            locationId: locOf.get(s.location)!,
            available: s.available,
          }));
        if (stock.length) await tx.insert(commerceStock).values(stock).onConflictDoNothing();
      }
      return rows.length;
    });
  }

  /** Variants and products not seen in a full read are gone from the store. */
  private async markGone(ctx: CommerceCtx, store: StoreRow, started: Date): Promise<void> {
    await this.db.withContext(ctx, async (tx) => {
      await tx
        .update(commerceVariants)
        .set({ present: false })
        .where(
          and(
            eq(commerceVariants.storeId, store.id),
            eq(commerceVariants.present, true),
            lt(commerceVariants.syncedAt, started),
          ),
        );
      await tx
        .update(commerceProducts)
        .set({ present: false })
        .where(
          and(
            eq(commerceProducts.storeId, store.id),
            eq(commerceProducts.present, true),
            lt(commerceProducts.syncedAt, started),
          ),
        );
    });
  }

  /** Stores orders and joins their buyers to CRM contacts. */
  private async saveOrders(
    ctx: CommerceCtx,
    store: StoreRow,
    rows: OrderIn[],
  ): Promise<{ orders: number; contacts: number }> {
    if (!rows.length) return { orders: 0, contacts: 0 };
    return this.db.withContext(ctx, async (tx) => {
      await lockContacts(tx, ctx.tenantId);
      const known = await tx
        .select({ ext: commerceOrders.externalId, contactId: commerceOrders.contactId })
        .from(commerceOrders)
        .where(
          and(
            eq(commerceOrders.storeId, store.id),
            inArray(
              commerceOrders.externalId,
              rows.map((r) => r.externalId),
            ),
          ),
        );
      const had = new Map(known.map((k) => [k.ext, k.contactId]));
      let contacts = 0;
      for (const o of rows) {
        let contactId = had.get(o.externalId) ?? null;
        if (!contactId && (o.phone || o.email)) {
          const m = await matchOrCreate(tx, {
            tenantId: ctx.tenantId,
            name: o.customerName,
            phone: o.phone,
            email: o.email,
            source: store.platform,
            actorId: null,
            fallbackName: `Khách ${store.name} ${o.number}`,
          });
          contactId = m.contact.id;
          if (m.created) contacts++;
        }
        const values = {
          number: o.number,
          state: o.state,
          rawStatus: o.raw,
          total: o.total.toFixed(2),
          currency: o.currency,
          customerName: o.customerName,
          phone: o.phone,
          email: o.email,
          contactId,
          items: o.items.slice(0, 100),
          placedAt: o.placedAt,
          updatedExt: o.updatedAt,
          syncedAt: new Date(),
        };
        await tx
          .insert(commerceOrders)
          .values({ id: uuidv7(), tenantId: ctx.tenantId, storeId: store.id, externalId: o.externalId, ...values })
          .onConflictDoUpdate({
            target: [commerceOrders.storeId, commerceOrders.externalId],
            set: values,
          });
        if (contactId && !had.has(o.externalId))
          await addActivity(tx, {
            tenantId: ctx.tenantId,
            contactId,
            kind: 'order',
            body: `Đơn ${o.number} trên ${store.name}: ${moneyText(o.total, o.currency)} (${o.raw})`,
            data: { storeId: store.id, platform: store.platform, order: o.number },
            actorId: null,
          });
      }
      return { orders: rows.length, contacts };
    });
  }

  private async saveCursor(ctx: CommerceCtx, store: StoreRow, cursor: Date): Promise<void> {
    await this.db.withContext(ctx, (tx: Tx) =>
      tx
        .update(commerceStores)
        .set({ ordersCursor: cursor })
        .where(and(eq(commerceStores.id, store.id), ne(commerceStores.status, 'removed'))),
    );
  }
}
