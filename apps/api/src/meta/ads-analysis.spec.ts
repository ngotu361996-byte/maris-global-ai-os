import {
  add,
  alertsFor,
  currencyOffset,
  dayIn,
  daysBetween,
  metricsOf,
  needsApproval,
  parseInsight,
  toMajor,
  toMinor,
  ZERO,
  type DayFigures,
} from './ads-analysis';

const day = (spend: number, extra: Partial<DayFigures> = {}): DayFigures => ({
  ...ZERO,
  spend,
  ...extra,
});

describe('Ads analysis rules', () => {
  it('keeps VND budgets in whole units and USD in cents', () => {
    expect(currencyOffset('VND')).toBe(1);
    expect(currencyOffset('USD')).toBe(100);
    expect(toMinor(150000, 'VND')).toBe(150000);
    expect(toMinor(12.5, 'USD')).toBe(1250);
    expect(toMajor(1250, 'USD')).toBe(12.5);
    expect(toMajor(null, 'USD')).toBeNull();
  });

  it('reads an insight row without counting a purchase twice', () => {
    const f = parseInsight({
      spend: '125000.4',
      impressions: '20000',
      reach: '9000',
      clicks: '400',
      inline_link_clicks: '300',
      actions: [
        { action_type: 'purchase', value: '3' },
        { action_type: 'omni_purchase', value: '4' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
        { action_type: 'lead', value: '2' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' },
      ],
      action_values: [
        { action_type: 'omni_purchase', value: '900000' },
        { action_type: 'purchase', value: '700000' },
      ],
    });
    expect(f).toEqual({
      spend: 125000.4,
      impressions: 20000,
      reach: 9000,
      clicks: 400,
      linkClicks: 300,
      purchases: 4,
      purchaseValue: 900000,
      leads: 2,
      messages: 5,
    });
    expect(parseInsight({ spend: 'abc', actions: 'x' as never })).toEqual(ZERO);
  });

  it('works out CTR, CPC, CPM, CPA and ROAS, and null when it cannot', () => {
    const m = metricsOf(
      day(100000, {
        impressions: 20000,
        clicks: 400,
        purchases: 2,
        leads: 1,
        messages: 1,
        purchaseValue: 350000,
      }),
    );
    expect(m).toMatchObject({ results: 4, ctr: 2, cpc: 250, cpm: 5000, cpa: 25000, roas: 3.5 });
    expect(metricsOf(ZERO)).toMatchObject({
      ctr: null,
      cpc: null,
      cpm: null,
      cpa: null,
      roas: null,
    });
    expect(add(day(0.1), day(0.2)).spend).toBe(0.3);
  });

  it('gives dates in the account time zone and fills every day', () => {
    const at = new Date('2026-11-27T20:00:00Z');
    expect(dayIn('Asia/Ho_Chi_Minh', at)).toBe('2026-11-28');
    expect(dayIn('America/Los_Angeles', at)).toBe('2026-11-27');
    expect(dayIn('Asia/Ho_Chi_Minh', at, 2)).toBe('2026-11-26');
    expect(dayIn('Not/AZone', at)).toBe('2026-11-27');
    expect(daysBetween('2026-11-29', '2026-12-02')).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
  });

  it('needs approval to raise a budget above the limit or turn on without one, never to pause', () => {
    const cur = { dailyBudget: 200000 };
    expect(needsApproval({ kind: 'status', to: 'PAUSED' }, cur, null)).toBe(false);
    expect(needsApproval({ kind: 'status', to: 'ACTIVE' }, cur, null)).toBe(true);
    expect(needsApproval({ kind: 'status', to: 'ACTIVE' }, cur, 300000)).toBe(false);
    expect(needsApproval({ kind: 'status', to: 'ACTIVE' }, cur, 100000)).toBe(true);
    expect(needsApproval({ kind: 'status', to: 'ACTIVE' }, { dailyBudget: null }, 100000)).toBe(
      false,
    );
    expect(needsApproval({ kind: 'daily_budget', to: 150000 }, cur, null)).toBe(false);
    expect(needsApproval({ kind: 'daily_budget', to: 250000 }, cur, null)).toBe(true);
    expect(needsApproval({ kind: 'daily_budget', to: 250000 }, cur, 300000)).toBe(false);
    expect(needsApproval({ kind: 'daily_budget', to: 350000 }, cur, 300000)).toBe(true);
  });

  it('points out unusual spend, rising CPA, no results, low CTR and refused ads', () => {
    const days = (list: DayFigures[]) =>
      list.map((f, i) => ({ day: `2026-11-${String(15 + i).padStart(2, '0')}`, f }));
    const normal = day(100000, { impressions: 10000, clicks: 300, purchases: 4 });
    const alerts = alertsFor({
      id: 'acc',
      name: 'TK chính',
      accountStatus: 3,
      currency: 'VND',
      today: '2026-11-28',
      campaigns: [
        {
          id: 'c1',
          name: 'Áo hè',
          effectiveStatus: 'ACTIVE',
          // 11 normal days, then 2 dear days, then today with twice the usual spend.
          days: days([
            ...Array(11).fill(normal),
            day(100000, { impressions: 10000, clicks: 300, purchases: 1 }),
            day(100000, { impressions: 10000, clicks: 300, purchases: 1 }),
            day(250000, { impressions: 20000, clicks: 500, purchases: 1 }),
          ]),
        },
        {
          id: 'c2',
          name: 'Quần',
          effectiveStatus: 'ACTIVE',
          days: days(Array(14).fill(day(50000, { impressions: 5000, clicks: 10, leads: 1 }))),
        },
        { id: 'c3', name: 'Mũ', effectiveStatus: 'ACTIVE', days: days(Array(14).fill(ZERO)) },
      ],
      disapproved: [{ campaignId: 'c1', campaignName: 'Áo hè', adName: 'Ảnh 3' }],
    });
    const codes = alerts.map((a) => `${a.code}:${a.campaignId ?? '-'}`);
    expect(codes).toEqual([
      'ACCOUNT_NOT_ACTIVE:-',
      'AD_DISAPPROVED:c1',
      'SPEND_SPIKE:c1',
      'CPA_RISING:c1',
      'LOW_CTR:c2',
      'NO_DELIVERY:c3',
    ]);
    expect(alerts[2]!.message).toContain('2,5 lần');
    expect(alerts[1]!.message).toContain('MARIS không tự gửi lại');

    const noResults = alertsFor({
      id: 'acc',
      name: 'TK',
      accountStatus: 1,
      currency: 'VND',
      today: '2026-11-28',
      campaigns: [
        {
          id: 'c4',
          name: 'Giày',
          effectiveStatus: 'ACTIVE',
          days: days(Array(14).fill(day(80000, { impressions: 4000, clicks: 60 }))),
        },
      ],
      disapproved: [],
    });
    expect(noResults.map((a) => a.code)).toEqual(['NO_RESULTS']);
  });
});
