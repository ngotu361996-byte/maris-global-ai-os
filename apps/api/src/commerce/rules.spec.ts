import { shopifyDomain } from '@maris/contracts';
import { grantedScopes,
  graphqlProblem,
  money,
  poscakeMoney,
  poscakeOrderState,
  poscakeTime,
  shopifyOrderState,
  shopifyTokenMessage,
  skuNorm,
  throttleWaitSec,
} from './rules';

describe('commerce rules', () => {
  it('matches SKUs without spaces and case', () => {
    expect(skuNorm(' ao-thun 01 ')).toBe('AO-THUN01');
    expect(skuNorm('')).toBeNull();
    expect(skuNorm(null)).toBeNull();
  });

  it('reads money from both stores', () => {
    expect(money('199000.00')).toBe(199000);
    expect(money('12.345')).toBe(12.35);
    expect(money('abc')).toBe(0);
    expect(poscakeMoney(140000, 'VND')).toBe(140000);
    expect(poscakeMoney(1999, 'USD')).toBe(19.99);
  });

  it('finds the myshopify domain in what people type', () => {
    expect(shopifyDomain('maris-fishing')).toBe('maris-fishing.myshopify.com');
    expect(shopifyDomain('https://Maris-Fishing.myshopify.com/admin')).toBe('maris-fishing.myshopify.com');
    expect(shopifyDomain('https://admin.shopify.com/store/maris-fishing/products')).toBe(
      'maris-fishing.myshopify.com',
    );
    expect(shopifyDomain('marisfishing.vn')).toBeNull();
  });

  it('maps Shopify orders to MARIS states', () => {
    expect(shopifyOrderState({ displayFinancialStatus: 'PENDING' }).state).toBe('new');
    expect(shopifyOrderState({ displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED' }).state).toBe('confirmed');
    expect(shopifyOrderState({ displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED' }).state).toBe('completed');
    expect(shopifyOrderState({ displayFinancialStatus: 'REFUNDED' }).state).toBe('returned');
    expect(shopifyOrderState({ cancelledAt: '2026-11-01T00:00:00Z', displayFinancialStatus: 'PAID' }).state).toBe('cancelled');
  });

  it('maps POSCake statuses and times', () => {
    expect(poscakeOrderState(0)).toEqual({ state: 'new', raw: 'Mới' });
    expect(poscakeOrderState(2).state).toBe('shipping');
    expect(poscakeOrderState(3).state).toBe('completed');
    expect(poscakeOrderState(5).state).toBe('returned');
    expect(poscakeOrderState(6).state).toBe('cancelled');
    expect(poscakeOrderState(99).raw).toBe('Trạng thái 99');
    expect(poscakeTime('2026-01-15T03:20:00')?.toISOString()).toBe('2026-01-15T03:20:00.000Z');
    expect(poscakeTime('nope')).toBeNull();
  });

  it('explains Shopify refusals and throttling', () => {
    expect(shopifyTokenMessage({ error: 'shop_not_permitted' })).toMatch(/không cùng tổ chức/);
    expect(shopifyTokenMessage({ error: 'invalid_client' })).toMatch(/Client ID hoặc Client secret/);
    expect(graphqlProblem([{ message: 'Throttled', extensions: { code: 'THROTTLED' } }])?.kind).toBe('rate');
    expect(graphqlProblem([{ message: 'no', extensions: { code: 'ACCESS_DENIED' } }])?.kind).toBe('permission');
    expect(graphqlProblem(undefined)).toBeNull();
    expect(
      throttleWaitSec({ cost: { requestedQueryCost: 400, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } }),
    ).toBe(3);
  });

  it('counts the read scope that a write scope includes', () => {
    expect(grantedScopes('write_products,read_orders, write_inventory read_locations')).toEqual([
      'read_inventory',
      'read_locations',
      'read_orders',
      'read_products',
      'write_inventory',
      'write_products',
    ]);
    expect(grantedScopes(undefined)).toEqual([]);
  });
});
