import { z } from 'zod';

/**
 * Website and commerce: Shopify and POSCake (spec Part 18, M22 and M26). Stores are connected
 * with the tenant's own credentials (kept in the Secret Vault). MARIS reads products, variants,
 * stock and orders; buyers join CRM contacts. Products are matched across stores by SKU. A price
 * or a stock level is changed on Shopify only with commerce.write and only if it still has the
 * value the person saw. POSCake is read only.
 */

export const COMMERCE_PLATFORMS = ['shopify', 'poscake'] as const;
export type CommercePlatform = (typeof COMMERCE_PLATFORMS)[number];
export const COMMERCE_PLATFORM_LABEL: Record<CommercePlatform, string> = {
  shopify: 'Shopify',
  poscake: 'POSCake',
};

export const COMMERCE_LIMITS = {
  /** Stores per tenant (both platforms). */
  stores: 10,
  /** Orders older than this are not read the first time (Shopify keeps 60 days without read_all_orders). */
  firstOrderDays: 60,
  /** Variants read per store in one sync. */
  maxVariants: 20_000,
} as const;

/** The Shopify Admin API access scopes MARIS uses. */
export const SHOPIFY_SCOPES = {
  read: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
  write: ['write_products', 'write_inventory'],
} as const;

export const ORDER_STATES = [
  'new',
  'confirmed',
  'shipping',
  'completed',
  'returned',
  'cancelled',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  new: 'Mới',
  confirmed: 'Đã xác nhận',
  shipping: 'Đang giao',
  completed: 'Hoàn tất',
  returned: 'Hoàn trả',
  cancelled: 'Đã hủy',
};

const secretName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Tên secret chỉ gồm chữ thường, số, dấu chấm, gạch');

export const connectShopifySchema = z.object({
  /** "maris-fishing", "maris-fishing.myshopify.com" or the admin address. */
  shop: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .transform((v, c) => {
      const d = shopifyDomain(v);
      if (!d) {
        c.addIssue({
          code: 'custom',
          message: 'Nhập tên cửa hàng dạng ten-cua-hang.myshopify.com',
        });
        return z.NEVER;
      }
      return d;
    }),
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Client ID không đúng dạng'),
  clientSecretName: secretName.default('shopify.client_secret'),
});
export type ConnectShopify = z.infer<typeof connectShopifySchema>;

/**
 * The myshopify.com domain in what a person typed: a bare handle, the domain, a URL on it, or the
 * admin address admin.shopify.com/store/<handle>.
 */
export function shopifyDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  const admin = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(v);
  if (admin) v = admin[1]!;
  v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!v.includes('.')) v = `${v}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(v) ? v : null;
}

export const connectPoscakeSchema = z.object({
  shopId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, 'Shop ID là dãy số (số sau /shop/ trên địa chỉ POSCake)'),
  apiKeySecretName: secretName.default('poscake.api_key'),
});
export type ConnectPoscake = z.infer<typeof connectPoscakeSchema>;

export const updateStoreSchema = z.object({ enabled: z.boolean() });
export type UpdateStore = z.infer<typeof updateStoreSchema>;

export const listVariantsSchema = z.object({
  storeId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  /** Only variants with at most this many available. */
  maxStock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListVariants = z.infer<typeof listVariantsSchema>;

export const listOrdersSchema = z.object({
  storeId: z.uuid().optional(),
  state: z.enum(ORDER_STATES).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListOrders = z.infer<typeof listOrdersSchema>;

/** A new price; `expected` is the price the person saw, so a newer change is not overwritten. */
export const setPriceSchema = z.object({
  price: z.number().min(0).max(1e12),
  expected: z.number().min(0).max(1e12),
});
export type SetPrice = z.infer<typeof setPriceSchema>;

export const setStockSchema = z.object({
  locationId: z.uuid(),
  quantity: z.number().int().min(0).max(10_000_000),
  expected: z.number().int().min(-10_000_000).max(10_000_000),
});
export type SetStock = z.infer<typeof setStockSchema>;

export interface CommerceStoreResponse {
  id: string;
  platform: CommercePlatform;
  externalId: string;
  name: string;
  clientId: string | null;
  secretName: string;
  secretFound: boolean;
  currency: string;
  scopes: string[];
  /** Shopify scopes MARIS needs that the store did not grant. */
  missingScopes: string[];
  canWrite: boolean;
  status: 'active' | 'invalid' | 'removed';
  checkError: string | null;
  enabled: boolean;
  syncedAt: string | null;
  syncError: string | null;
  products: number;
  variants: number;
  orders: number;
  connectedByName: string | null;
  connectedAt: string;
}

export interface CommerceStatusResponse {
  stores: CommerceStoreResponse[];
  /** Minutes between automatic reads; 0 means only on request. */
  syncEveryMin: number;
}

export interface CommerceStockResponse {
  locationId: string;
  locationName: string;
  available: number;
}

export interface CommerceVariantResponse {
  id: string;
  storeId: string;
  storeName: string;
  platform: CommercePlatform;
  productTitle: string;
  productStatus: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  compareAt: number | null;
  currency: string;
  available: number | null;
  stock: CommerceStockResponse[];
  /** The store lets MARIS change this variant's price and stock. */
  editable: boolean;
  syncedAt: string;
}

export interface CommerceVariantsResponse {
  items: CommerceVariantResponse[];
  total: number;
}

export interface SkuStoreEntry {
  variantId: string;
  storeId: string;
  storeName: string;
  platform: CommercePlatform;
  title: string;
  price: number;
  currency: string;
  available: number | null;
  editable: boolean;
}

export interface SkuCompareResponse {
  sku: string;
  title: string;
  stores: SkuStoreEntry[];
  priceDiffers: boolean;
  stockDiffers: boolean;
}

export interface CommerceOrderItemResponse {
  sku: string | null;
  title: string;
  quantity: number;
  price: number;
}

export interface CommerceOrderResponse {
  id: string;
  storeId: string;
  storeName: string;
  platform: CommercePlatform;
  number: string;
  state: OrderState;
  rawStatus: string;
  total: number;
  currency: string;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  contactId: string | null;
  items: CommerceOrderItemResponse[];
  placedAt: string;
  updatedAt: string;
}

export interface CommerceOrdersResponse {
  items: CommerceOrderResponse[];
  total: number;
}

export interface CommerceChangeResponse {
  id: string;
  storeName: string;
  variantTitle: string;
  sku: string | null;
  kind: 'price' | 'stock';
  locationName: string | null;
  oldValue: number;
  newValue: number;
  outcome: 'done' | 'failed' | 'conflict';
  error: string | null;
  requestedByName: string | null;
  createdAt: string;
}

export interface CommerceReportStore {
  storeId: string;
  storeName: string;
  platform: CommercePlatform;
  currency: string;
  orders: number;
  /** Orders not cancelled or returned. */
  revenue: number;
  cancelled: number;
  returned: number;
}

export interface CommerceReportResponse {
  days: number;
  stores: CommerceReportStore[];
  /** Per day, every currency summed separately: [{day, currency, orders, revenue}]. */
  daily: { day: string; currency: string; orders: number; revenue: number }[];
  topSkus: { sku: string; title: string; quantity: number }[];
  lowStock: number;
}

export interface CommerceSyncResponse {
  stores: number;
  variants: number;
  orders: number;
  contacts: number;
  errors: string[];
}
