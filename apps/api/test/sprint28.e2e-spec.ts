import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner28@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ shop',
  tenantName: 'Maris Fishing',
};
const SHOP = 'maris-fishing.myshopify.com';
const CLIENT_ID = 'a1b2c3d4e5f6client28';
const CLIENT_SECRET = 'shpss_secret_28';
const POS_SHOP = '6036602';
const POS_KEY = 'pos-api-key-28';
const ALL_SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders';

interface Hit {
  method: string;
  path: string;
  query: Record<string, string[]>;
  body: Record<string, unknown> | null;
  headers: IncomingMessage['headers'];
}

const gid = (type: string, n: number | string) => `gid://shopify/${type}/${n}`;

/** Shopify (under /<shop domain>) and POSCake (under /pos) on one local server. */
class FakeStores {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  token = 'shpat_token_1';
  tokens = 0;
  scope = ALL_SCOPES;
  throttleNext = 0;
  revokeNext = false;
  /** Locations answers ACCESS_DENIED to this token (scopes granted after it was issued). */
  deniedToken: string | null = null;
  posFail: number | null = null;
  variants = [
    { id: 1, product: 10, title: 'S', sku: 'AO-01', price: '199000.00', qty: { 1: 7, 2: 3 }, tracked: true },
    { id: 2, product: 10, title: 'M', sku: 'AO-02', price: '199000.00', qty: { 1: 2 }, tracked: true },
    { id: 3, product: 11, title: 'Default Title', sku: 'CAN-CAU', price: '850000.00', qty: {}, tracked: false },
  ];
  orders = [
    {
      id: 1001,
      createdAt: '2026-11-20T03:00:00Z',
      updatedAt: '2026-11-20T04:00:00Z',
      cancelledAt: null as string | null,
      fin: 'PAID',
      ful: 'FULFILLED',
      total: '398000.00',
      phone: '+84 912 345 678',
      email: 'lan@example.com',
      name: 'Nguyễn Lan',
      items: [{ sku: 'AO-01', title: 'Áo thun - S', quantity: 2, price: '199000.00' }],
    },
    {
      id: 1002,
      createdAt: '2026-11-21T03:00:00Z',
      updatedAt: '2026-11-21T05:00:00Z',
      cancelledAt: '2026-11-21T05:00:00Z' as string | null,
      fin: 'VOIDED',
      ful: 'UNFULFILLED',
      total: '850000.00',
      phone: null as string | null,
      email: 'minh@example.com',
      name: 'Trần Minh',
      items: [{ sku: 'CAN-CAU', title: 'Cần câu', quantity: 1, price: '850000.00' }],
    },
  ];
  posVariations = [
    {
      id: 'b1f0-1',
      product_id: 'p-1',
      display_id: 'AO-01',
      barcode: '893000000001',
      retail_price: 189000,
      remain_quantity: 12,
      fields: [{ name: 'Size', value: 'S' }],
      variations_warehouses: [{ warehouse_id: 'w-1', remain_quantity: 12 }],
      product: { id: 'p-1', name: 'Áo thun cotton' },
    },
    {
      id: 'b1f0-2',
      product_id: 'p-2',
      display_id: 'MOI-CAU',
      barcode: null,
      retail_price: 25000,
      remain_quantity: 0,
      fields: [],
      variations_warehouses: [{ warehouse_id: 'w-1', remain_quantity: 0 }],
      product: { id: 'p-2', name: 'Mồi câu' },
    },
  ];
  posOrders = [
    {
      id: 501,
      display_id: 501,
      status: 3,
      inserted_at: '2026-11-22T02:00:00',
      updated_at: '2026-11-22T06:00:00',
      bill_full_name: 'Lan Nguyễn',
      bill_phone_number: '0912345678',
      bill_email: null,
      total_price: 189000,
      items: [{ quantity: 1, variation_info: { name: 'Áo thun cotton S', display_id: 'AO-01', retail_price: 189000 } }],
    },
  ];

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  of(re: RegExp, op?: string) {
    return this.hits.filter((h) => re.test(h.path) && (!op || String(h.body?.query ?? '').includes(op)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, this.url);
    const query: Record<string, string[]> = {};
    for (const [k, v] of u.searchParams) (query[k] ??= []).push(v);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const type = req.headers['content-type'] ?? '';
    const body = type.startsWith('application/json')
      ? (JSON.parse(raw || '{}') as Record<string, unknown>)
      : type.startsWith('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(raw))
        : null;
    this.hits.push({ method: req.method!, path: u.pathname, query, body, headers: req.headers });
    const send = (status: number, b: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(b));
    };

    if (u.pathname.startsWith('/pos/')) return this.pos(u.pathname.slice(4), query, send);

    if (!u.pathname.startsWith(`/${SHOP}/`)) return send(404, { errors: 'Not Found' });
    const path = u.pathname.slice(SHOP.length + 1);
    if (path === '/admin/oauth/access_token') {
      if (body?.grant_type !== 'client_credentials' || body.client_id !== CLIENT_ID)
        return send(400, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (body.client_secret !== CLIENT_SECRET)
        return send(400, { error: 'invalid_client', error_description: 'Client authentication failed' });
      this.tokens++;
      this.token = `shpat_token_${this.tokens}`;
      return send(200, { access_token: this.token, scope: this.scope, expires_in: 86399 });
    }
    if (path !== '/admin/api/2026-10/graphql.json') return send(404, { errors: 'Not Found' });
    if (this.revokeNext) {
      this.revokeNext = false;
      this.token = 'revoked';
    }
    if (req.headers['x-shopify-access-token'] !== this.token)
      return send(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
    const q = String(body?.query ?? '');
    const vars = (body?.variables ?? {}) as Record<string, unknown>;
    const cost = { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 } };
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return send(200, {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { ...cost, throttleStatus: { ...cost.throttleStatus, currentlyAvailable: 299 } } },
      });
    }
    const ok = (data: unknown) => send(200, { data, extensions: { cost } });
    if (q.startsWith('query Shop')) return ok({ shop: { name: 'Maris Fishing', currencyCode: 'VND' } });
    if (q.startsWith('query Locations') && this.deniedToken === this.token)
      return send(200, {
        data: null,
        errors: [{ message: 'Access denied for locations field.', extensions: { code: 'ACCESS_DENIED' } }],
        extensions: { cost },
      });
    if (q.startsWith('query Locations'))
      return ok({
        locations: {
          nodes: [
            { id: gid('Location', 1), name: 'Kho Hà Nội', isActive: true },
            { id: gid('Location', 2), name: 'Kho Sài Gòn', isActive: true },
          ],
        },
      });
    if (q.startsWith('query Variants')) {
      // Two pages: variants 1-2, then 3.
      const second = vars.after === 'cursor-2';
      const list = second ? this.variants.slice(2) : this.variants.slice(0, 2);
      return ok({
        productVariants: {
          pageInfo: { hasNextPage: !second, endCursor: second ? null : 'cursor-2' },
          nodes: list.map((v) => ({
            id: gid('ProductVariant', v.id),
            title: v.title,
            sku: v.sku,
            barcode: null,
            price: v.price,
            compareAtPrice: null,
            inventoryQuantity: Object.values(v.qty).reduce((a, b) => a + b, 0),
            product: {
              id: gid('Product', v.product),
              title: v.product === 10 ? 'Áo thun cotton' : 'Cần câu carbon',
              status: 'ACTIVE',
              productType: 'Thời trang',
              vendor: 'Maris',
            },
            inventoryItem: {
              id: gid('InventoryItem', v.id * 100),
              tracked: v.tracked,
              inventoryLevels: {
                nodes: Object.entries(v.qty).map(([loc, n]) => ({
                  location: { id: gid('Location', loc) },
                  quantities: [{ name: 'available', quantity: n }],
                })),
              },
            },
          })),
        },
      });
    }
    if (q.startsWith('query Orders')) {
      const since = /updated_at:>'([^']+)'/.exec(String(vars.q ?? ''))?.[1];
      const list = this.orders.filter((o) => !since || o.updatedAt > since);
      return ok({
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: list.map((o) => ({
            id: gid('Order', o.id),
            name: `#${o.id}`,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
            cancelledAt: o.cancelledAt,
            email: o.email,
            phone: o.phone,
            displayFinancialStatus: o.fin,
            displayFulfillmentStatus: o.ful,
            currentTotalPriceSet: { shopMoney: { amount: o.total, currencyCode: 'VND' } },
            customer: { displayName: o.name },
            billingAddress: { name: o.name, phone: o.phone },
            lineItems: {
              nodes: o.items.map((i) => ({
                sku: i.sku,
                title: i.title,
                quantity: i.quantity,
                originalUnitPriceSet: { shopMoney: { amount: i.price } },
              })),
            },
          })),
        },
      });
    }
    if (q.startsWith('query VariantPrice')) {
      const v = this.variants.find((x) => gid('ProductVariant', x.id) === vars.id);
      return ok({ productVariant: v ? { id: vars.id, price: v.price, product: { id: gid('Product', v.product) } } : null });
    }
    if (q.startsWith('mutation SetPrice')) {
      const list = vars.variants as { id: string; price: string }[];
      const v = this.variants.find((x) => gid('ProductVariant', x.id) === list[0]!.id)!;
      if (Number(list[0]!.price) > 1e9)
        return ok({ productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: ['price'], message: 'Price is too big' }] } });
      v.price = Number(list[0]!.price).toFixed(2);
      return ok({ productVariantsBulkUpdate: { productVariants: [{ id: list[0]!.id, price: v.price }], userErrors: [] } });
    }
    if (q.startsWith('mutation SetStock')) {
      if (!q.includes('@idempotent(key: $key)') || !vars.key)
        return send(200, { errors: [{ message: 'idempotent key required' }] });
      const input = vars.input as {
        quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number }[];
      };
      const qn = input.quantities[0]!;
      const v = this.variants.find((x) => gid('InventoryItem', x.id * 100) === qn.inventoryItemId)!;
      const loc = qn.locationId.split('/').pop()! as unknown as 1;
      const now = (v.qty as Record<string, number>)[loc] ?? 0;
      if (now !== qn.changeFromQuantity)
        return ok({
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', field: ['input'], message: 'The changeFromQuantity value does not match' }],
          },
        });
      (v.qty as Record<string, number>)[loc] = qn.quantity;
      return ok({ inventorySetQuantities: { inventoryAdjustmentGroup: { reason: 'correction' }, userErrors: [] } });
    }
    return send(200, { errors: [{ message: `unknown ${q.slice(0, 40)}` }] });
  }

  private pos(
    path: string,
    query: Record<string, string[]>,
    send: (status: number, b: unknown) => void,
  ) {
    if (this.posFail) {
      const s = this.posFail;
      this.posFail = null;
      return send(s, { success: false, message: 'Unauthorized' });
    }
    if (query.api_key?.[0] !== POS_KEY) return send(401, { success: false, message: 'Invalid api_key' });
    if (path === '/shops')
      return send(200, { success: true, shops: [{ id: Number(POS_SHOP), name: 'Maris Fishing POS' }] });
    if (path === `/shops/${POS_SHOP}/warehouses`)
      return send(200, { success: true, data: [{ id: 'w-1', name: 'Kho chính' }] });
    if (path === `/shops/${POS_SHOP}/products/variations`)
      return send(200, {
        success: true,
        data: this.posVariations,
        page_number: 1,
        page_size: 100,
        total_entries: this.posVariations.length,
        total_pages: 1,
      });
    if (path === `/shops/${POS_SHOP}/orders`) {
      const start = Number(query.startDateTime?.[0] ?? 0);
      const list = this.posOrders.filter((o) => new Date(`${o.updated_at}Z`).getTime() / 1000 > start);
      return send(200, { success: true, data: list, page_number: 1, total_pages: 1 });
    }
    return send(404, { success: false, message: 'Not found' });
  }
}

describe('Sprint 28 (e2e): Shopify and POSCake', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const stores = new FakeStores();
  const redis = new Redis(REDIS_URL);
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let shopifyId = '';
  let posId = '';
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const B = '/api/v1/commerce';
  const variant = async (sku: string, storeId: string) =>
    (
      (await http.get(`${B}/variants?storeId=${storeId}&q=${sku}`).set(as()).expect(200)).body.items as {
        id: string;
        sku: string;
        price: number;
        available: number | null;
        stock: { locationId: string; locationName: string; available: number }[];
      }[]
    ).find((v) => v.sku === sku)!;

  beforeAll(async () => {
    await resetDatabase();
    await stores.start();
    app = await startApp({
      SHOPIFY_ORIGIN: stores.url,
      POSCAKE_API_URL: `${stores.url}/pos`,
      COMMERCE_RETRY_BASE_MS: '1',
      COMMERCE_SYNC_MIN: '0',
      TIKTOK_PUBLISHER_ENABLED: 'false',
      YOUTUBE_UPLOADER_ENABLED: 'false',
    });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as { id: string; key: string }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as())
      .send({ email: 's28.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'member' })
        .expect(200)
    ).body.token;
  });

  afterAll(async () => {
    await app.close();
    await stores.stop();
    await redis.quit();
    await db.end();
  });

  it('keeps stores to commerce.read and connecting to commerce.manage', async () => {
    await http.get(B).set(as(memberToken)).expect(403);
    await http
      .post(`${B}/stores/shopify`)
      .set(as(memberToken))
      .send({ shop: SHOP, clientId: CLIENT_ID })
      .expect(403);
    expect((await http.get(B).set(as()).expect(200)).body).toEqual({ stores: [], syncEveryMin: 0 });
    await http.post(`${B}/stores/shopify`).set(as()).send({ shop: 'maris.vn', clientId: CLIENT_ID }).expect(400);
    const missing = await http
      .post(`${B}/stores/shopify`)
      .set(as())
      .send({ shop: SHOP, clientId: CLIENT_ID })
      .expect(409);
    expect(missing.body.error.code).toBe('COMMERCE_SECRET_MISSING');
  });

  it('connects Shopify with the client credentials grant', async () => {
    await http.post('/api/v1/secrets').set(as()).send({ name: 'shopify.client_secret', value: 'wrong' }).expect(201);
    const bad = await http
      .post(`${B}/stores/shopify`)
      .set(as())
      .send({ shop: 'https://admin.shopify.com/store/maris-fishing', clientId: CLIENT_ID })
      .expect(409);
    expect(bad.body.error.message).toMatch(/Client ID hoặc Client secret/);
    const secretId = ((await http.get('/api/v1/secrets').set(as()).expect(200)).body as { id: string; name: string }[]).find(
      (s) => s.name === 'shopify.client_secret',
    )!.id;
    await http.delete(`/api/v1/secrets/${secretId}`).set(as()).expect(204);
    await http.post('/api/v1/secrets').set(as()).send({ name: 'shopify.client_secret', value: CLIENT_SECRET }).expect(201);

    const s = await http
      .post(`${B}/stores/shopify`)
      .set(as())
      .send({ shop: 'https://admin.shopify.com/store/maris-fishing', clientId: CLIENT_ID })
      .expect(201);
    expect(s.body).toMatchObject({
      platform: 'shopify',
      externalId: SHOP,
      name: 'Maris Fishing',
      currency: 'VND',
      status: 'active',
      secretFound: true,
      canWrite: true,
      missingScopes: [],
    });
    shopifyId = s.body.id;
    const tokenCall = stores.of(/oauth\/access_token$/).at(-1)!;
    expect(tokenCall.body).toMatchObject({ grant_type: 'client_credentials', client_id: CLIENT_ID });
    const [audit] = await db`SELECT metadata FROM security.audit_logs WHERE action = 'commerce.store_connected'`;
    expect(audit!.metadata).toMatchObject({ platform: 'shopify', store: SHOP });
    expect(JSON.stringify(audit!.metadata)).not.toContain(CLIENT_SECRET);
  });

  it('connects POSCake with a shop API key that is never logged', async () => {
    await http.post('/api/v1/secrets').set(as()).send({ name: 'poscake.api_key', value: POS_KEY }).expect(201);
    const wrong = await http.post(`${B}/stores/poscake`).set(as()).send({ shopId: '42' }).expect(404);
    expect(wrong.body.error.message).toMatch(/Maris Fishing POS \(6036602\)/);
    const s = await http.post(`${B}/stores/poscake`).set(as()).send({ shopId: POS_SHOP }).expect(201);
    expect(s.body).toMatchObject({ platform: 'poscake', name: 'Maris Fishing POS', canWrite: false });
    posId = s.body.id;
    const calls = await db`SELECT path FROM integration.api_calls WHERE provider = 'poscake'`;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.path).not.toContain(POS_KEY);
  });

  it('reads products, stock and orders, and joins buyers to CRM', async () => {
    stores.throttleNext = 1;
    const r = await http.post(`${B}/sync`).set(as()).expect(200);
    expect(r.body).toMatchObject({ stores: 2, variants: 5, orders: 3, errors: [] });
    // A throttled query waits and is sent again.
    expect(stores.of(/graphql\.json$/, 'query Locations').length).toBe(2);
    expect(stores.of(/graphql\.json$/, 'query Variants').length).toBe(2);

    const ao = await variant('AO-01', shopifyId);
    expect(ao).toMatchObject({ price: 199000, available: 10 });
    expect(ao.stock.map((s) => [s.locationName, s.available])).toEqual([
      ['Kho Hà Nội', 7],
      ['Kho Sài Gòn', 3],
    ]);
    expect((await variant('CAN-CAU', shopifyId)).available).toBeNull();
    expect((await variant('AO-01', posId)).price).toBe(189000);

    const orders = (await http.get(`${B}/orders`).set(as()).expect(200)).body;
    expect(orders.total).toBe(3);
    const byNo = new Map((orders.items as { number: string; state: string; contactId: string | null }[]).map((o) => [o.number, o]));
    expect(byNo.get('#1001')!.state).toBe('completed');
    expect(byNo.get('#1002')!.state).toBe('cancelled');
    expect(byNo.get('501')!.state).toBe('completed');
    // The same phone number on Shopify and POSCake is one customer.
    expect(byNo.get('501')!.contactId).toBe(byNo.get('#1001')!.contactId);
    const contacts = await db`SELECT name, source FROM crm.contacts ORDER BY name`;
    expect(contacts.map((c) => c.source).sort()).toEqual(['shopify', 'shopify']);
    const acts = await db`SELECT kind, body FROM crm.activities WHERE kind = 'order' ORDER BY body`;
    expect(acts).toHaveLength(3);
    expect(acts.map((a) => a.body).join('\n')).toMatch(/Đơn #1001 trên Maris Fishing: 398\.000 ₫/);

    const ord = (await http.get(`${B}/orders?state=cancelled`).set(as()).expect(200)).body;
    expect(ord.items.map((o: { number: string }) => o.number)).toEqual(['#1002']);
    const found = (await http.get(`${B}/orders?q=0912`).set(as()).expect(200)).body;
    expect(found.total).toBe(1);
  });

  it('reads only orders updated since the last read, without repeating history', async () => {
    stores.orders[0]!.updatedAt = '2026-11-25T00:00:00Z';
    stores.orders[0]!.fin = 'REFUNDED';
    await http.post(`${B}/stores/${shopifyId}/sync`).set(as()).expect(200);
    const q = stores.of(/graphql\.json$/, 'query Orders').at(-1)!;
    expect(String((q.body!.variables as { q: string }).q)).toBe("updated_at:>'2026-11-21T05:00:00.000Z'");
    const o = (await http.get(`${B}/orders?q=1001`).set(as()).expect(200)).body.items[0];
    expect(o.state).toBe('returned');
    const [{ n }] = await db`SELECT count(*)::int AS n FROM crm.activities WHERE kind = 'order'`;
    expect(n).toBe(3);
  });

  it('compares SKUs across stores', async () => {
    const skus = (await http.get(`${B}/skus`).set(as()).expect(200)).body as {
      sku: string;
      priceDiffers: boolean;
      stores: { storeName: string; price: number; editable: boolean }[];
    }[];
    expect(skus.map((s) => s.sku)).toEqual(['AO-01']);
    expect(skus[0]!.priceDiffers).toBe(true);
    expect(skus[0]!.stores.map((s) => [s.storeName, s.price, s.editable])).toEqual([
      ['Maris Fishing', 199000, true],
      ['Maris Fishing POS', 189000, false],
    ]);
  });

  it('changes a Shopify price only if it is still what the person saw', async () => {
    const ao = await variant('AO-01', shopifyId);
    await http.put(`${B}/variants/${ao.id}/price`).set(as(memberToken)).send({ price: 189000, expected: 199000 }).expect(403);
    stores.variants[0]!.price = '209000.00';
    const stale = await http.put(`${B}/variants/${ao.id}/price`).set(as()).send({ price: 189000, expected: 199000 }).expect(409);
    expect(stale.body.error.code).toBe('COMMERCE_CONFLICT');
    expect((await variant('AO-01', shopifyId)).price).toBe(209000);
    expect(stores.of(/graphql\.json$/, 'mutation SetPrice')).toHaveLength(0);

    const done = await http.put(`${B}/variants/${ao.id}/price`).set(as()).send({ price: 189000, expected: 209000 }).expect(200);
    expect(done.body.price).toBe(189000);
    expect(stores.variants[0]!.price).toBe('189000.00');
    const changes = (await http.get(`${B}/changes`).set(as()).expect(200)).body as { outcome: string; oldValue: number; newValue: number }[];
    expect(changes.map((c) => [c.outcome, c.oldValue, c.newValue])).toEqual([
      ['done', 209000, 189000],
      ['conflict', 209000, 189000],
    ]);
    const audits = await db`SELECT metadata FROM security.audit_logs WHERE action = 'commerce.price_set' ORDER BY created_at`;
    expect(audits.map((a) => (a.metadata as { outcome: string }).outcome)).toEqual(['conflict', 'done']);
    // Now the prices match across stores.
    const skus = (await http.get(`${B}/skus`).set(as()).expect(200)).body;
    expect(skus[0].priceDiffers).toBe(false);
  });

  it('sets Shopify stock with compare-and-set and an idempotency key; POSCake is read only', async () => {
    const ao = await variant('AO-01', shopifyId);
    const hn = ao.stock.find((s) => s.locationName === 'Kho Hà Nội')!;
    const stale = await http
      .put(`${B}/variants/${ao.id}/stock`)
      .set(as())
      .send({ locationId: hn.locationId, quantity: 20, expected: 6 })
      .expect(409);
    expect(stale.body.error.code).toBe('COMMERCE_CONFLICT');
    const ok = await http
      .put(`${B}/variants/${ao.id}/stock`)
      .set(as())
      .send({ locationId: hn.locationId, quantity: 20, expected: 7 })
      .expect(200);
    expect(ok.body.available).toBe(23);
    expect(stores.variants[0]!.qty[1]).toBe(20);
    const m = stores.of(/graphql\.json$/, 'mutation SetStock').at(-1)!;
    const v = m.body!.variables as { key: string; input: { quantities: { changeFromQuantity: number; locationId: string }[] } };
    expect(v.input.quantities[0]).toMatchObject({ changeFromQuantity: 7, locationId: gid('Location', 1) });
    const [change] = await db`SELECT id FROM commerce.changes WHERE outcome = 'done' AND kind = 'stock'`;
    expect(v.key).toBe(change!.id);

    const can = await variant('CAN-CAU', shopifyId);
    const other = hn.locationId;
    expect(
      (await http.put(`${B}/variants/${can.id}/stock`).set(as()).send({ locationId: other, quantity: 1, expected: 0 }).expect(409))
        .body.error.code,
    ).toBe('COMMERCE_NOT_TRACKED');
    const pos = await variant('AO-01', posId);
    expect(
      (await http.put(`${B}/variants/${pos.id}/price`).set(as()).send({ price: 1, expected: 189000 }).expect(409)).body.error
        .code,
    ).toBe('COMMERCE_READ_ONLY');
  });

  it('gets a new Shopify token once when the old one is refused', async () => {
    const before = stores.tokens;
    stores.revokeNext = true;
    await http.post(`${B}/stores/${shopifyId}/sync`).set(as()).expect(200);
    expect(stores.tokens).toBe(before + 1);
    expect((await http.get(B).set(as()).expect(200)).body.stores[0].status).toBe('active');
  });

  it('takes newly approved scopes without a restart, counting read scopes that writes include', async () => {
    stores.scope = 'write_products,write_inventory,read_orders';
    stores.deniedToken = stores.token;
    const before = stores.tokens;
    const r = await http.post(`${B}/stores/${shopifyId}/sync`).set(as()).expect(200);
    expect(r.body.errors).toEqual([]);
    expect(stores.tokens).toBe(before + 1);
    const s = (await http.get(B).set(as()).expect(200)).body.stores.find((x: { id: string }) => x.id === shopifyId);
    expect(s).toMatchObject({ status: 'active', canWrite: true, syncError: null });
    expect(s.missingScopes).toEqual(['read_locations']);
    const calls = (await http.get(`${B}/calls`).set(as()).expect(200)).body as { errorCode: string | null }[];
    expect(calls.some((c) => c.errorCode === 'SHOPIFY_RESCOPED')).toBe(true);
    // Another refusal soon after does not fetch yet another token.
    stores.deniedToken = stores.token;
    await http.post(`${B}/stores/${shopifyId}/sync`).set(as());
    expect(stores.tokens).toBe(before + 1);
    stores.deniedToken = null;
    stores.scope = ALL_SCOPES;
  });

  it('reports sales per store and marks a refused POSCake key', async () => {
    const r = (await http.get(`${B}/report?days=365`).set(as()).expect(200)).body;
    const by = new Map((r.stores as { storeName: string; orders: number; revenue: number; cancelled: number; returned: number }[]).map((s) => [s.storeName, s]));
    expect(by.get('Maris Fishing')).toMatchObject({ orders: 2, revenue: 0, cancelled: 1, returned: 1 });
    expect(by.get('Maris Fishing POS')).toMatchObject({ orders: 1, revenue: 189000 });
    expect(r.topSkus[0]).toMatchObject({ sku: 'AO-01', quantity: 1 });
    expect(r.lowStock).toBeGreaterThanOrEqual(1);

    stores.posFail = 401;
    const bad = await http.post(`${B}/stores/${posId}/sync`).set(as()).expect(409);
    expect(bad.body.error.code).toBe('POSCAKE_AUTH');
    const s = (await http.get(B).set(as()).expect(200)).body.stores.find((x: { id: string }) => x.id === posId);
    expect(s).toMatchObject({ status: 'invalid' });
    expect(s.checkError).toMatch(/API key/);
    // Connecting again with a good key makes it active.
    await http.post(`${B}/stores/poscake`).set(as()).send({ shopId: POS_SHOP }).expect(201);
    expect((await http.get(B).set(as()).expect(200)).body.stores.find((x: { id: string }) => x.id === posId).status).toBe('active');
  });

  it('turns a store off and disconnects it, keeping what was read', async () => {
    await http.patch(`${B}/stores/${posId}`).set(as()).send({ enabled: false }).expect(200);
    const r = await http.post(`${B}/sync`).set(as()).expect(200);
    expect(r.body.stores).toBe(1);
    await http.delete(`${B}/stores/${posId}`).set(as()).expect(204);
    const st = (await http.get(B).set(as()).expect(200)).body.stores;
    expect(st.map((s: { name: string }) => s.name)).toEqual(['Maris Fishing']);
    expect((await http.get(`${B}/variants`).set(as()).expect(200)).body.total).toBe(3);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM commerce.orders WHERE store_id = ${posId}`;
    expect(n).toBe(1);
    const acts = await db`SELECT action FROM security.audit_logs WHERE action LIKE 'commerce.store%' ORDER BY created_at`;
    expect(acts.map((a) => a.action)).toEqual([
      'commerce.store_connected',
      'commerce.store_connected',
      'commerce.store_connected',
      'commerce.store_updated',
      'commerce.store_disconnected',
    ]);
  });
});
