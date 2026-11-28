'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  COMMERCE_PLATFORM_LABEL,
  ORDER_STATE_LABEL,
  ORDER_STATES,
  SHOPIFY_SCOPES,
  type ApiCallResponse,
  type CommerceChangeResponse,
  type CommerceOrdersResponse,
  type CommercePlatform,
  type CommerceReportResponse,
  type CommerceStatusResponse,
  type CommerceStoreResponse,
  type CommerceSyncResponse,
  type CommerceVariantResponse,
  type CommerceVariantsResponse,
  type OrderState,
  type SkuCompareResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 30_000;
const PAGE = 50;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '–');
const money = (n: number, currency: string) =>
  currency === 'VND'
    ? `${Math.round(n).toLocaleString('vi-VN')} ₫`
    : `${n.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

const STATE_CLS: Record<OrderState, string> = {
  new: 'border-accent text-accent',
  confirmed: 'border-accent text-accent',
  shipping: 'border-yellow-600 text-yellow-500',
  completed: 'border-green-600 text-green-500',
  returned: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

type Editing =
  | { kind: 'price'; variant: CommerceVariantResponse; value: string }
  | { kind: 'stock'; variant: CommerceVariantResponse; locationId: string; expected: number; value: string };

/**
 * Website and commerce (spec Part 18): Shopify (M22) and POSCake (M26) stores, their products,
 * stock and orders, SKUs compared across stores, and price and stock changes on Shopify. The
 * page opens on one platform's setup; everything else covers every connected store.
 */
export function CommerceCenter({ platform }: { platform: CommercePlatform }) {
  const me = useMe();
  const [s, setS] = useState<CommerceStatusResponse | null>(null);
  const [variants, setVariants] = useState<CommerceVariantsResponse | null>(null);
  const [skus, setSkus] = useState<SkuCompareResponse[]>([]);
  const [orders, setOrders] = useState<CommerceOrdersResponse | null>(null);
  const [report, setReport] = useState<CommerceReportResponse | null>(null);
  const [changes, setChanges] = useState<CommerceChangeResponse[]>([]);
  const [calls, setCalls] = useState<ApiCallResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vStore, setVStore] = useState('');
  const [vq, setVq] = useState('');
  const [low, setLow] = useState(false);
  const [vPage, setVPage] = useState(0);
  const [oState, setOState] = useState<OrderState | ''>('');
  const [oq, setOq] = useState('');
  const [oPage, setOPage] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');
  const load = useCallback(() => {
    api<CommerceStatusResponse>('/commerce').then(setS).catch(fail);
    api<CommerceVariantsResponse>(
      `/commerce/variants?${qs({ storeId: vStore, q: vq, maxStock: low ? 5 : undefined, limit: PAGE, offset: vPage * PAGE })}`,
    )
      .then(setVariants)
      .catch(() => setVariants(null));
    api<SkuCompareResponse[]>('/commerce/skus')
      .then(setSkus)
      .catch(() => setSkus([]));
    api<CommerceOrdersResponse>(
      `/commerce/orders?${qs({ state: oState, q: oq, limit: PAGE, offset: oPage * PAGE })}`,
    )
      .then(setOrders)
      .catch(() => setOrders(null));
    api<CommerceReportResponse>('/commerce/report?days=30')
      .then(setReport)
      .catch(() => setReport(null));
    api<CommerceChangeResponse[]>('/commerce/changes')
      .then(setChanges)
      .catch(() => setChanges([]));
    api<ApiCallResponse[]>('/commerce/calls')
      .then(setCalls)
      .catch(() => setCalls([]));
  }, [vStore, vq, low, vPage, oState, oq, oPage]);

  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [me, load]);

  async function run<T>(fn: () => Promise<T>, msg: (r: T) => string) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await fn();
      setOk(msg(r));
      load();
      return r;
    } catch (e) {
      fail(e);
      load();
      return null;
    } finally {
      setBusy(false);
    }
  }

  const synced = (r: CommerceSyncResponse) =>
    `Đã đọc ${r.stores} cửa hàng: ${r.variants.toLocaleString('vi-VN')} mẫu mã, ${r.orders.toLocaleString('vi-VN')} đơn mới hoặc vừa đổi, ${r.contacts} khách mới trong CRM.` +
    (r.errors.length ? ` Lưu ý: ${r.errors.join('; ')}` : '');

  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const store = await run(
      () =>
        platform === 'shopify'
          ? api<CommerceStoreResponse>('/commerce/stores/shopify', {
              method: 'POST',
              body: JSON.stringify({
                shop: String(f.get('shop') ?? ''),
                clientId: String(f.get('clientId') ?? '').trim(),
                clientSecretName: String(f.get('secretName') ?? '').trim() || undefined,
              }),
            })
          : api<CommerceStoreResponse>('/commerce/stores/poscake', {
              method: 'POST',
              body: JSON.stringify({
                shopId: String(f.get('shopId') ?? '').trim(),
                apiKeySecretName: String(f.get('secretName') ?? '').trim() || undefined,
              }),
            }),
      (r) => `Đã kết nối ${r.name}. MARIS đang đọc sản phẩm và đơn hàng…`,
    );
    if (store)
      await run(
        () => api<CommerceSyncResponse>(`/commerce/stores/${store.id}/sync`, { method: 'POST' }),
        synced,
      );
  }

  async function saveEdit() {
    if (!editing) return;
    const v = editing.variant;
    const value = Number(editing.value.replace(/[.\s]/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) {
      setError('Nhập một số không âm.');
      return;
    }
    const r = await run(
      () =>
        editing.kind === 'price'
          ? api<CommerceVariantResponse>(`/commerce/variants/${v.id}/price`, {
              method: 'PUT',
              body: JSON.stringify({ price: value, expected: v.price }),
            })
          : api<CommerceVariantResponse>(`/commerce/variants/${v.id}/stock`, {
              method: 'PUT',
              body: JSON.stringify({
                locationId: editing.locationId,
                quantity: Math.trunc(value),
                expected: editing.expected,
              }),
            }),
      (x) =>
        editing.kind === 'price'
          ? `Đã đổi giá ${x.sku ?? x.title} trên ${x.storeName} thành ${money(x.price, x.currency)}.`
          : `Đã đổi tồn kho ${x.sku ?? x.title} trên ${x.storeName}.`,
    );
    if (r) setEditing(null);
  }

  const mine = s?.stores.filter((x) => x.platform === platform) ?? [];
  const label = COMMERCE_PLATFORM_LABEL[platform];

  if (!me) return null;
  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{label}</h1>
        <div className="flex gap-3 text-sm">
          <Link href={platform === 'shopify' ? '/poscake' : '/shopify'} className="text-accent underline">
            {platform === 'shopify' ? 'POSCake' : 'Shopify'}
          </Link>
          <Link href="/crm" className="text-accent underline">
            Khách hàng (CRM)
          </Link>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted">
        Sản phẩm, tồn kho và đơn hàng của các cửa hàng Shopify và POSCake ở một chỗ. MARIS đọc lại
        {s?.syncEveryMin ? ` mỗi ${s.syncEveryMin} phút` : ' khi bấm “Đọc ngay”'}; người mua có số
        điện thoại hoặc email được đưa vào CRM. Giá và tồn kho chỉ sửa được trên Shopify, và chỉ khi
        số trên Shopify vẫn đúng như bạn đang xem. POSCake chỉ đọc.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Panel title={`Cửa hàng ${label}`}>
        {mine.map((x) => (
          <StoreCard
            key={x.id}
            x={x}
            busy={busy}
            onToggle={() =>
              void run(
                () =>
                  api(`/commerce/stores/${x.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: !x.enabled }),
                  }),
                () => (x.enabled ? `Đã tắt ${x.name}.` : `Đã bật ${x.name}.`),
              )
            }
            onSync={() =>
              void run(
                () => api<CommerceSyncResponse>(`/commerce/stores/${x.id}/sync`, { method: 'POST' }),
                synced,
              )
            }
            onRemove={() => {
              if (!window.confirm(`Ngắt kết nối ${x.name}? Dữ liệu đã đọc vẫn được giữ.`)) return;
              void run(
                () => api(`/commerce/stores/${x.id}`, { method: 'DELETE' }),
                () => `Đã ngắt kết nối ${x.name}.`,
              );
            }}
          />
        ))}
        <details className="mt-2" open={mine.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">
            {mine.length ? `Kết nối thêm cửa hàng ${label}` : `Kết nối cửa hàng ${label}`}
          </summary>
          {platform === 'shopify' ? <ShopifyGuide /> : <PoscakeGuide />}
          <form onSubmit={(e) => void connect(e)} className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            {platform === 'shopify' ? (
              <>
                <label>
                  <span className="text-muted">Cửa hàng</span>
                  <input
                    name="shop"
                    required
                    className={inputCls}
                    placeholder="ten-cua-hang.myshopify.com"
                  />
                </label>
                <label>
                  <span className="text-muted">Client ID</span>
                  <input name="clientId" required className={inputCls} autoComplete="off" />
                </label>
                <label>
                  <span className="text-muted">Tên secret của Client secret</span>
                  <input name="secretName" defaultValue="shopify.client_secret" className={inputCls} />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span className="text-muted">Shop ID</span>
                  <input name="shopId" required className={inputCls} placeholder="6036602" inputMode="numeric" />
                </label>
                <label>
                  <span className="text-muted">Tên secret của API key</span>
                  <input name="secretName" defaultValue="poscake.api_key" className={inputCls} />
                </label>
              </>
            )}
            <div className="self-end">
              <button className={btnCls} disabled={busy}>
                Kết nối và đọc dữ liệu
              </button>
            </div>
          </form>
        </details>
        {s && s.stores.length > mine.length && (
          <p className="mt-3 text-xs text-muted">
            Cửa hàng khác đã kết nối:{' '}
            {s.stores
              .filter((x) => x.platform !== platform)
              .map((x) => `${x.name} (${COMMERCE_PLATFORM_LABEL[x.platform]})`)
              .join(', ')}
            .{' '}
            <button
              className="text-accent underline"
              disabled={busy}
              onClick={() =>
                void run(() => api<CommerceSyncResponse>('/commerce/sync', { method: 'POST' }), synced)
              }
            >
              Đọc tất cả cửa hàng ngay
            </button>
          </p>
        )}
      </Panel>

      {report && report.stores.length > 0 && <ReportPanel r={report} />}

      <Panel title="Sản phẩm và tồn kho">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <select
            className={`${inputCls} w-auto`}
            value={vStore}
            onChange={(e) => {
              setVStore(e.target.value);
              setVPage(0);
            }}
            aria-label="Cửa hàng"
          >
            <option value="">Mọi cửa hàng</option>
            {s?.stores.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({COMMERCE_PLATFORM_LABEL[x.platform]})
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} w-56`}
            placeholder="Tìm tên, SKU, mã vạch"
            value={vq}
            onChange={(e) => {
              setVq(e.target.value);
              setVPage(0);
            }}
          />
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={low}
              onChange={(e) => {
                setLow(e.target.checked);
                setVPage(0);
              }}
            />
            Sắp hết (≤ 5)
          </label>
          {variants && <span className="text-muted">{variants.total.toLocaleString('vi-VN')} mẫu mã</span>}
        </div>
        {!variants || variants.items.length === 0 ? (
          <p className="text-sm text-muted">Chưa có sản phẩm nào. Kết nối cửa hàng rồi bấm “Đọc ngay”.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Sản phẩm</th>
                  <th>SKU</th>
                  <th>Cửa hàng</th>
                  <th className="text-right">Giá bán</th>
                  <th className="pl-3">Tồn kho</th>
                </tr>
              </thead>
              <tbody>
                {variants.items.map((v) => (
                  <tr key={v.id} className="border-t border-line align-top">
                    <td className="max-w-xs py-2 pr-3">
                      <div className="font-medium">{v.productTitle}</div>
                      {v.title && v.title !== 'Default Title' && <div className="text-xs text-muted">{v.title}</div>}
                      {v.productStatus !== 'ACTIVE' && v.productStatus !== 'active' && (
                        <div className="text-xs text-yellow-500">{v.productStatus}</div>
                      )}
                    </td>
                    <td className="pr-3 font-mono text-xs">
                      {v.sku ?? '–'}
                      {v.barcode && <div className="text-muted">{v.barcode}</div>}
                    </td>
                    <td className="pr-3 text-xs">{v.storeName}</td>
                    <td className="whitespace-nowrap pr-1 text-right tabular-nums">
                      {editing?.kind === 'price' && editing.variant.id === v.id ? (
                        <EditBox
                          value={editing.value}
                          onChange={(value) => setEditing({ ...editing, value })}
                          onSave={() => void saveEdit()}
                          onCancel={() => setEditing(null)}
                          busy={busy}
                          label="Giá mới"
                        />
                      ) : (
                        <>
                          {money(v.price, v.currency)}
                          {v.compareAt !== null && v.compareAt > v.price && (
                            <div className="text-xs text-muted line-through">{money(v.compareAt, v.currency)}</div>
                          )}
                          {v.editable && (
                            <button
                              className="ml-1 text-xs text-accent underline"
                              onClick={() => setEditing({ kind: 'price', variant: v, value: String(v.price) })}
                            >
                              Sửa
                            </button>
                          )}
                        </>
                      )}
                    </td>
                    <td className="pl-3 text-xs">
                      {v.available === null ? (
                        <span className="text-muted">Không theo dõi</span>
                      ) : (
                        <>
                          <div className={`tabular-nums ${v.available <= 5 ? 'text-yellow-500' : ''}`}>
                            Tổng {v.available.toLocaleString('vi-VN')}
                          </div>
                          {v.stock.map((st) =>
                            editing?.kind === 'stock' &&
                            editing.variant.id === v.id &&
                            editing.locationId === st.locationId ? (
                              <EditBox
                                key={st.locationId}
                                value={editing.value}
                                onChange={(value) => setEditing({ ...editing, value })}
                                onSave={() => void saveEdit()}
                                onCancel={() => setEditing(null)}
                                busy={busy}
                                label={`Tồn kho ${st.locationName}`}
                              />
                            ) : (
                              <div key={st.locationId} className="text-muted">
                                {st.locationName}: {st.available.toLocaleString('vi-VN')}
                                {v.editable && (
                                  <button
                                    className="ml-1 text-accent underline"
                                    onClick={() =>
                                      setEditing({
                                        kind: 'stock',
                                        variant: v,
                                        locationId: st.locationId,
                                        expected: st.available,
                                        value: String(st.available),
                                      })
                                    }
                                  >
                                    Sửa
                                  </button>
                                )}
                              </div>
                            ),
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={vPage} total={variants.total} onPage={setVPage} />
          </div>
        )}
      </Panel>

      {skus.length > 0 && (
        <Panel title="So sánh SKU giữa các cửa hàng">
          <p className="mb-2 text-xs text-muted">
            Những SKU bán ở từ hai cửa hàng trở lên. Dòng tô vàng là giá hoặc tồn kho đang khác nhau.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">SKU</th>
                  <th>Cửa hàng</th>
                  <th className="text-right">Giá</th>
                  <th className="text-right">Tồn kho</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {skus.map((g) =>
                  g.stores.map((x, i) => {
                    const ref = g.stores.find((y) => !y.editable && y.currency === x.currency);
                    return (
                      <tr key={x.variantId} className={i === 0 ? 'border-t border-line align-top' : 'align-top'}>
                        <td className="py-1 pr-3">
                          {i === 0 && (
                            <>
                              <div className="font-mono text-xs">{g.sku}</div>
                              <div className="text-xs text-muted">{g.title}</div>
                            </>
                          )}
                        </td>
                        <td className="pr-3 text-xs">
                          {x.storeName} ({COMMERCE_PLATFORM_LABEL[x.platform]})
                        </td>
                        <td className={`text-right tabular-nums ${g.priceDiffers ? 'text-yellow-500' : ''}`}>
                          {money(x.price, x.currency)}
                        </td>
                        <td className={`text-right tabular-nums ${g.stockDiffers ? 'text-yellow-500' : ''}`}>
                          {x.available === null ? '–' : x.available.toLocaleString('vi-VN')}
                        </td>
                        <td className="whitespace-nowrap pl-3 text-right">
                          {g.priceDiffers && x.editable && ref && ref.price !== x.price && (
                            <button
                              className={btnGhostCls}
                              disabled={busy}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Đổi giá ${g.sku} trên ${x.storeName} từ ${money(x.price, x.currency)} thành ${money(ref.price, ref.currency)} (giá ${ref.storeName})?`,
                                  )
                                )
                                  return;
                                void run(
                                  () =>
                                    api<CommerceVariantResponse>(`/commerce/variants/${x.variantId}/price`, {
                                      method: 'PUT',
                                      body: JSON.stringify({ price: ref.price, expected: x.price }),
                                    }),
                                  (r) => `Đã đổi giá ${g.sku} trên ${r.storeName} thành ${money(r.price, r.currency)}.`,
                                );
                              }}
                            >
                              Lấy giá {ref.storeName}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Đơn hàng">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <select
            className={`${inputCls} w-auto`}
            value={oState}
            onChange={(e) => {
              setOState(e.target.value as OrderState | '');
              setOPage(0);
            }}
            aria-label="Trạng thái đơn"
          >
            <option value="">Mọi trạng thái</option>
            {ORDER_STATES.map((x) => (
              <option key={x} value={x}>
                {ORDER_STATE_LABEL[x]}
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} w-56`}
            placeholder="Mã đơn, tên, số điện thoại"
            value={oq}
            onChange={(e) => {
              setOq(e.target.value);
              setOPage(0);
            }}
          />
          {orders && <span className="text-muted">{orders.total.toLocaleString('vi-VN')} đơn</span>}
        </div>
        {!orders || orders.items.length === 0 ? (
          <p className="text-sm text-muted">Chưa có đơn nào.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Đơn</th>
                  <th>Khách</th>
                  <th>Sản phẩm</th>
                  <th className="text-right">Tổng</th>
                  <th className="pl-3">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {orders.items.map((o) => (
                  <tr key={o.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-2 pr-3">
                      <div className="font-medium">{o.number}</div>
                      <div className="text-xs text-muted">
                        {o.storeName} · {when(o.placedAt)}
                      </div>
                    </td>
                    <td className="pr-3 text-xs">
                      {o.contactId ? (
                        <Link href={`/crm?open=${o.contactId}`} className="underline">
                          {o.customerName ?? o.phone ?? o.email}
                        </Link>
                      ) : (
                        (o.customerName ?? '–')
                      )}
                      {o.phone && <div className="text-muted">{o.phone}</div>}
                    </td>
                    <td className="max-w-xs pr-3 text-xs">
                      {o.items.slice(0, 3).map((i, k) => (
                        <div key={k}>
                          {i.quantity} × {i.title}
                          {i.sku && <span className="text-muted"> ({i.sku})</span>}
                        </div>
                      ))}
                      {o.items.length > 3 && <div className="text-muted">và {o.items.length - 3} món nữa</div>}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">{money(o.total, o.currency)}</td>
                    <td className="pl-3">
                      <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATE_CLS[o.state]}`}>
                        {ORDER_STATE_LABEL[o.state]}
                      </span>
                      <div className="mt-0.5 text-xs text-muted">{o.rawStatus}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={oPage} total={orders.total} onPage={setOPage} />
          </div>
        )}
      </Panel>

      {changes.length > 0 && (
        <Panel title="Lịch sử đổi giá và tồn kho">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-1 pr-3 text-muted">{when(c.createdAt)}</td>
                    <td className="pr-3">
                      {c.variantTitle} {c.sku && <span className="font-mono text-muted">({c.sku})</span>}
                      <div className="text-muted">
                        {c.storeName}
                        {c.locationName ? ` · ${c.locationName}` : ''}
                      </div>
                    </td>
                    <td className="whitespace-nowrap pr-3 tabular-nums">
                      {c.kind === 'price' ? 'Giá' : 'Tồn kho'} {c.oldValue.toLocaleString('vi-VN')} →{' '}
                      {c.newValue.toLocaleString('vi-VN')}
                    </td>
                    <td
                      className={`pr-3 ${c.outcome === 'done' ? 'text-green-500' : c.outcome === 'conflict' ? 'text-yellow-500' : 'text-danger'}`}
                    >
                      {c.outcome === 'done' ? 'Đã đổi' : c.outcome === 'conflict' ? 'Không đổi: số đã khác' : 'Lỗi'}
                      {c.error && c.outcome === 'failed' ? `: ${c.error}` : ''}
                    </td>
                    <td className="text-muted">{c.requestedByName ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {calls.length > 0 && (
        <Panel title="Lượt gọi Shopify và POSCake gần đây">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {calls.map((x) => (
                  <tr key={x.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-1 pr-3 text-muted">{when(x.createdAt)}</td>
                    <td className="pr-3 text-muted">{x.group}</td>
                    <td className="pr-3 font-mono">
                      {x.method} {x.path}
                    </td>
                    <td
                      className={`pr-3 ${x.outcome === 'ok' ? 'text-green-500' : x.outcome === 'refused' ? 'text-yellow-500' : 'text-danger'}`}
                    >
                      {x.outcome === 'ok' ? 'OK' : x.outcome === 'refused' ? 'Không gọi' : 'Lỗi'}
                      {x.errorCode ? ` (${x.errorCode})` : ''}
                    </td>
                    <td className="pr-3 text-muted">{x.errorMessage ?? ''}</td>
                    <td className="whitespace-nowrap text-muted">
                      {x.durationMs !== null ? `${x.durationMs} ms` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Shell>
  );
}

function StoreCard({
  x,
  busy,
  onToggle,
  onSync,
  onRemove,
}: {
  x: CommerceStoreResponse;
  busy: boolean;
  onToggle: () => void;
  onSync: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{x.name}</span>
        <span className="text-xs text-muted">{x.externalId}</span>
        <span
          className={`rounded border px-1.5 py-0.5 text-xs ${x.status === 'active' ? 'border-green-600 text-green-500' : 'border-danger text-danger'}`}
        >
          {x.status === 'active' ? 'Đang hoạt động' : 'Cần kết nối lại'}
        </span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs">
          <input type="checkbox" checked={x.enabled} disabled={busy} onChange={onToggle} />
          Đang bật
        </label>
      </div>
      <div className="mt-1 text-xs text-muted">
        {x.products.toLocaleString('vi-VN')} sản phẩm · {x.variants.toLocaleString('vi-VN')} mẫu mã ·{' '}
        {x.orders.toLocaleString('vi-VN')} đơn · tiền {x.currency} · đọc lúc {when(x.syncedAt)} · kết nối bởi{' '}
        {x.connectedByName ?? '–'}
        {x.platform === 'shopify' && ` · Client ID ${x.clientId}`} · secret “{x.secretName}”
        {!x.secretFound && <span className="text-danger"> (chưa có trong Secret Vault)</span>}
      </div>
      {x.checkError && <div className="mt-1 text-xs text-danger">{x.checkError}</div>}
      {x.syncError && <div className="mt-1 text-xs text-yellow-500">Lần đọc gần nhất: {x.syncError}</div>}
      {x.platform === 'shopify' && x.missingScopes.length > 0 && (
        <div className="mt-1 text-xs text-yellow-500">
          Ứng dụng chưa có quyền {x.missingScopes.join(', ')}.{' '}
          {x.canWrite ? '' : 'Chưa sửa được giá và tồn kho. '}Thêm quyền trong Dev Dashboard, tạo bản
          mới (Release) rồi bấm “Đọc ngay”.
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button className={btnGhostCls} disabled={busy || !x.enabled || x.status !== 'active'} onClick={onSync}>
          Đọc ngay
        </button>
        <button className={`${btnGhostCls} text-danger`} disabled={busy} onClick={onRemove}>
          Ngắt kết nối
        </button>
      </div>
    </div>
  );
}

function EditBox({
  value,
  onChange,
  onSave,
  onCancel,
  busy,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        className="w-28 rounded border border-line bg-bg px-2 py-1 text-right text-sm"
        value={value}
        aria-label={label}
        inputMode="decimal"
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button className={btnGhostCls} disabled={busy} onClick={onSave}>
        Lưu
      </button>
      <button className={btnGhostCls} disabled={busy} onClick={onCancel}>
        Hủy
      </button>
    </span>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE);
  if (pages <= 1) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <button className={btnGhostCls} disabled={page === 0} onClick={() => onPage(page - 1)}>
        Trước
      </button>
      <span className="text-muted">
        Trang {page + 1}/{pages}
      </span>
      <button className={btnGhostCls} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
        Sau
      </button>
    </div>
  );
}

function ReportPanel({ r }: { r: CommerceReportResponse }) {
  const currencies = [...new Set(r.daily.map((d) => d.currency))];
  const main = currencies.includes('VND') ? 'VND' : (currencies[0] ?? 'VND');
  const days = r.daily.filter((d) => d.currency === main);
  const max = Math.max(1, ...days.map((d) => d.revenue));
  return (
    <Panel title={`Doanh số ${r.days} ngày qua`}>
      <div className="mb-3 grid gap-3 text-sm sm:grid-cols-3">
        {r.stores.map((x) => (
          <div key={x.storeId} className="rounded-md border border-line p-2">
            <div className="text-xs text-muted">
              {x.storeName} ({COMMERCE_PLATFORM_LABEL[x.platform]})
            </div>
            <div className="text-lg font-semibold tabular-nums">{money(x.revenue, x.currency)}</div>
            <div className="text-xs text-muted">
              {x.orders.toLocaleString('vi-VN')} đơn · {x.cancelled} hủy · {x.returned} hoàn
            </div>
          </div>
        ))}
      </div>
      {days.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-xs text-muted">Doanh số theo ngày ({main}, không tính đơn hủy và hoàn)</div>
          <div className="flex h-24 items-end gap-0.5" role="img" aria-label="Doanh số theo ngày">
            {days.map((d) => (
              <div
                key={d.day}
                className="flex-1 rounded-t bg-accent"
                style={{ height: `${Math.max(2, (d.revenue / max) * 100)}%` }}
                title={`${d.day}: ${money(d.revenue, main)} · ${d.orders} đơn`}
              />
            ))}
          </div>
          <div className="mt-0.5 flex justify-between text-xs text-muted">
            <span>{days[0]!.day}</span>
            <span>{days[days.length - 1]!.day}</span>
          </div>
        </div>
      )}
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-muted">Bán chạy (số lượng)</div>
          {r.topSkus.length === 0 ? (
            <p className="text-xs text-muted">Chưa có đơn.</p>
          ) : (
            <ol className="space-y-0.5 text-xs">
              {r.topSkus.map((t) => (
                <li key={`${t.sku}:${t.title}`} className="flex justify-between gap-2">
                  <span>
                    {t.title} {t.sku && <span className="font-mono text-muted">({t.sku})</span>}
                  </span>
                  <span className="tabular-nums">{t.quantity.toLocaleString('vi-VN')}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="text-xs">
          <div className="mb-1 text-muted">Tồn kho</div>
          {r.lowStock > 0 ? (
            <span className="text-yellow-500">{r.lowStock} mẫu mã còn 5 cái trở xuống.</span>
          ) : (
            <span className="text-muted">Không có mẫu mã nào sắp hết.</span>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ShopifyGuide() {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
      <li>
        Trong trang quản trị Shopify của cửa hàng, vào <b>Settings → Apps → Develop apps</b> (hoặc bấm
        tên cửa hàng → <b>Dev Dashboard</b>), bấm <b>Create app</b> và đặt tên, ví dụ “MARIS”.
      </li>
      <li>
        Ở <b>Versions</b>, chọn quyền Admin API: <code>{SHOPIFY_SCOPES.read.join(', ')}</code> và, nếu
        muốn sửa giá và tồn kho từ MARIS, <code>{SHOPIFY_SCOPES.write.join(', ')}</code>. Muốn thấy tên,
        số điện thoại, email người mua thì bật thêm quyền đọc dữ liệu khách hàng (Protected customer
        data). Bấm <b>Release</b>.
      </li>
      <li>
        Bấm <b>Install app</b> để cài vào chính cửa hàng này.
      </li>
      <li>
        Ở <b>Settings</b> của ứng dụng, chép <b>Client secret</b> vào{' '}
        <Link href="/secrets" className="text-accent underline">
          Secret Vault
        </Link>{' '}
        với tên <code>shopify.client_secret</code>. Đừng dán secret vào đây hay vào chat.
      </li>
      <li>Nhập tên cửa hàng (…myshopify.com) và <b>Client ID</b> bên dưới.</li>
    </ol>
  );
}

function PoscakeGuide() {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
      <li>
        Trên POSCake (pos.pages.fm), mở shop rồi vào <b>Cấu hình → Nâng cao → Kết nối bên thứ 3 →
        Webhook/API</b>, tab <b>API Key</b>, bấm <b>Thêm mới</b> và chép key ngay (chỉ hiện một lần).
      </li>
      <li>
        Lưu key vào{' '}
        <Link href="/secrets" className="text-accent underline">
          Secret Vault
        </Link>{' '}
        với tên <code>poscake.api_key</code>.
      </li>
      <li>
        <b>Shop ID</b> là dãy số sau <code>/shop/</code> trên địa chỉ POSCake, ví dụ
        pos.pages.fm/shop/<b>6036602</b>/orders.
      </li>
    </ol>
  );
}
