import type { OrderState } from '@maris/contracts';

/** Pure rules for Shopify and POSCake data: no I/O here, so they are tested on their own. */

/** The SKU stores are matched by: no spaces, capitals. Empty means none. */
export function skuNorm(sku: string | null | undefined): string | null {
  const v = (sku ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 200);
  return v || null;
}

export const clip = (v: unknown, n: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
};

/** A money amount from a store: Shopify sends decimals as text, POSCake whole numbers. */
export function money(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

/**
 * POSCake keeps amounts in its smallest unit: equal to the amount for VND, a hundredth for other
 * currencies.
 */
export function poscakeMoney(v: unknown, currency: string): number {
  const n = money(v);
  return currency === 'VND' ? n : Math.round(n) / 100;
}

/** An integer count (stock), or null when the store did not say. */
export function count(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-1_000_000_000, Math.min(1_000_000_000, Math.trunc(n))) : null;
}

/** The number at the end of a Shopify global id: gid://shopify/Order/123 → 123. */
export function gidTail(gid: string): string {
  return gid.split('/').pop() ?? gid;
}

/** POSCake times are UTC without a zone ("2026-01-15T03:20:00"). */
export function poscakeTime(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ShopifyOrderStatus {
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
}

/** MARIS's order state for a Shopify order, and the store's own words for it. */
export function shopifyOrderState(o: ShopifyOrderStatus): { state: OrderState; raw: string } {
  const fin = (o.displayFinancialStatus ?? '').toUpperCase();
  const ful = (o.displayFulfillmentStatus ?? '').toUpperCase();
  const raw = [fin, ful].filter(Boolean).join(' · ') || 'UNKNOWN';
  if (o.cancelledAt) return { state: 'cancelled', raw: `CANCELLED · ${raw}` };
  if (fin === 'REFUNDED' || fin === 'VOIDED') return { state: 'returned', raw };
  if (ful === 'FULFILLED') return { state: 'completed', raw };
  if (ful === 'PARTIALLY_FULFILLED' || ful === 'IN_PROGRESS') return { state: 'shipping', raw };
  if (fin === 'PAID' || fin === 'PARTIALLY_PAID' || fin === 'PARTIALLY_REFUNDED')
    return { state: 'confirmed', raw };
  return { state: 'new', raw };
}

/** POSCake's order statuses (its Open API documentation) and what they mean in MARIS. */
export const POSCAKE_STATUS: Record<number, { state: OrderState; label: string }> = {
  0: { state: 'new', label: 'Mới' },
  17: { state: 'new', label: 'Chờ xác nhận' },
  11: { state: 'confirmed', label: 'Chờ hàng' },
  12: { state: 'confirmed', label: 'Chờ in' },
  13: { state: 'confirmed', label: 'Đã in' },
  20: { state: 'confirmed', label: 'Đã đặt hàng' },
  1: { state: 'confirmed', label: 'Đã xác nhận' },
  8: { state: 'confirmed', label: 'Đang đóng hàng' },
  9: { state: 'shipping', label: 'Chờ lấy hàng' },
  2: { state: 'shipping', label: 'Đã gửi hàng' },
  3: { state: 'completed', label: 'Đã nhận' },
  16: { state: 'completed', label: 'Đã thu tiền' },
  4: { state: 'returned', label: 'Đang hoàn' },
  15: { state: 'returned', label: 'Hoàn một phần' },
  5: { state: 'returned', label: 'Đã hoàn' },
  6: { state: 'cancelled', label: 'Đã hủy' },
  7: { state: 'cancelled', label: 'Đã xóa' },
};

export function poscakeOrderState(status: unknown): { state: OrderState; raw: string } {
  const n = Number(status);
  const s = POSCAKE_STATUS[n];
  return s ? { state: s.state, raw: s.label } : { state: 'new', raw: `Trạng thái ${String(status)}` };
}

export type CommerceErrorKind =
  | 'auth'
  | 'permission'
  | 'rate'
  | 'not_found'
  | 'transient'
  | 'invalid'
  | 'other';

/** What kind of failure an HTTP answer from a store is. */
export function httpErrorKind(status: number): CommerceErrorKind {
  if (status === 401) return 'auth';
  if (status === 402 || status === 403 || status === 423) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate';
  if (status >= 500) return 'transient';
  if (status === 400 || status === 422) return 'invalid';
  return 'other';
}

/** Words to show for a Shopify token refusal. */
export function shopifyTokenMessage(body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; error_description?: unknown; errors?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const desc = typeof b.error_description === 'string' ? b.error_description : '';
  if (code === 'shop_not_permitted' || /shop_not_permitted/.test(desc))
    return 'Ứng dụng và cửa hàng không cùng tổ chức Shopify: tạo ứng dụng từ Dev Dashboard mở trong trang quản trị của chính cửa hàng này';
  if (code === 'invalid_client' || /client/i.test(desc))
    return 'Shopify không nhận Client ID hoặc Client secret: chép lại từ Dev Dashboard (mục Settings của ứng dụng)';
  if (code === 'app_not_installed' || /install/i.test(desc))
    return 'Ứng dụng chưa được cài vào cửa hàng: bấm Install app trong Dev Dashboard';
  return (desc || code || (typeof b.errors === 'string' ? b.errors : '') || 'Shopify từ chối cấp mã truy cập').slice(0, 300);
}

export interface GraphqlError {
  message?: string;
  extensions?: { code?: string };
}

/** The first GraphQL error that stops the whole answer (throttling, access). */
export function graphqlProblem(
  errors: GraphqlError[] | undefined,
): { kind: CommerceErrorKind; message: string } | null {
  if (!errors?.length) return null;
  const throttled = errors.find((e) => e.extensions?.code === 'THROTTLED');
  if (throttled) return { kind: 'rate', message: 'Shopify đang giới hạn lượt gọi' };
  const denied = errors.find((e) => e.extensions?.code === 'ACCESS_DENIED');
  if (denied)
    return {
      kind: 'permission',
      message: `Ứng dụng thiếu quyền trên Shopify: ${String(denied.message ?? '').slice(0, 250)}`,
    };
  return { kind: 'invalid', message: String(errors[0]!.message ?? 'Lỗi GraphQL').slice(0, 300) };
}

/** Seconds to wait before a throttled Shopify query has enough points again. */
export function throttleWaitSec(ext: unknown): number {
  const cost = (ext as { cost?: Record<string, unknown> } | undefined)?.cost;
  const status = cost?.throttleStatus as
    | { currentlyAvailable?: number; restoreRate?: number }
    | undefined;
  const need = Number(cost?.requestedQueryCost ?? 0);
  const have = Number(status?.currentlyAvailable ?? 0);
  const rate = Number(status?.restoreRate ?? 50) || 50;
  return Math.min(30, Math.max(1, Math.ceil((need - have) / rate)));
}

/** Money as shown in Vietnamese, with its currency. */
export function moneyText(n: number, currency: string): string {
  return currency === 'VND'
    ? `${Math.round(n).toLocaleString('vi-VN')} ₫`
    : `${n.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
