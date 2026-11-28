import {
  allows,
  budgetsOf,
  cacheFactor,
  governorStatus,
  graphErrorKind,
  levelLabel,
  parseUsageHeaders,
  regainMinutes,
  usagePct,
} from './governor';

describe('API Governor rules', () => {
  const budgets = budgetsOf({});

  it('uses the budgets of spec Part 15, 3,000 calls in all, and takes overrides', () => {
    expect(Object.values(budgets).reduce((a, b) => a + b, 0)).toBe(3000);
    expect(budgetsOf({ reply: 600, nope: 5 }).reply).toBe(600);
  });

  it('goes through the thresholds as the whole budget fills', () => {
    const at = (n: number) =>
      governorStatus({ budgets, used: { page_insights: 680, reserve: n }, platformPct: null });
    expect(at(0).groups.reply.state).toBe('ok');
    // 680 + 1,570 = 2,250 = 75%
    expect(at(1570).groups.reply.state).toBe('no_background');
    expect(at(1870).groups.reply.state).toBe('essential_only'); // 85%
    expect(at(2020).groups.reply.state).toBe('paused'); // 90%
    expect(levelLabel(at(1570).levelPct)).toBe('Hoãn đồng bộ không cần thiết');
  });

  it('lets a group go past its own share while the reserve lasts, then stops it', () => {
    const borrowing = governorStatus({ budgets, used: { sync: 150 }, platformPct: null });
    expect(borrowing.reserveLeft).toBe(750);
    expect(borrowing.groups.sync.state).toBe('ok');
    const spent = governorStatus({ budgets, used: { sync: 100, reply: 1200 }, platformPct: null });
    expect(spent.reserveLeft).toBe(0);
    expect(spent.groups.reply.state).toBe('paused');
    expect(spent.groups.sync.state).toBe('paused'); // used its whole share and nothing is left
    expect(spent.groups.publish.state).toBe('ok');
  });

  it('follows Meta’s own figures when they are higher', () => {
    const s = governorStatus({ budgets, used: {}, platformPct: 92 });
    expect(s.groups.publish.state).toBe('paused');
  });

  it('lets only the right priorities through', () => {
    expect(allows('ok', 'background')).toBe(true);
    expect(allows('no_background', 'background')).toBe(false);
    expect(allows('no_background', 'normal')).toBe(true);
    expect(allows('essential_only', 'normal')).toBe(false);
    expect(allows('essential_only', 'essential')).toBe(true);
    expect(allows('paused', 'essential')).toBe(false);
    expect(allows('blocked', 'essential')).toBe(false);
    expect([cacheFactor(10), cacheFactor(55), cacheFactor(70)]).toEqual([1, 2, 4]);
  });

  it('reads Meta’s rate limit headers and the wait Meta asks for', () => {
    const headers: Record<string, string> = {
      'x-app-usage': '{"call_count":28,"total_time":25,"total_cputime":25}',
      'x-business-use-case-usage':
        '{"112233":[{"type":"pages","call_count":96,"total_cputime":3,"total_time":5,"estimated_time_to_regain_access":12}]}',
      'x-page-usage': 'not json',
      'x-ad-account-usage': '{"acc_id_util_pct":40,"reset_time_duration":300}',
    };
    const d = parseUsageHeaders((n) => headers[n] ?? null);
    expect(d.map((x) => x.header)).toEqual([
      'x-app-usage',
      'x-ad-account-usage',
      'x-business-use-case-usage',
    ]);
    expect(usagePct(d)).toBe(96);
    expect(regainMinutes(d)).toBe(12);
    expect(usagePct([])).toBeNull();
  });

  it('sorts Graph error codes', () => {
    expect(graphErrorKind(4, false)).toBe('rate_limited_app');
    expect(graphErrorKind(80001, false)).toBe('rate_limited_scope');
    expect(graphErrorKind(32, false)).toBe('rate_limited_scope');
    expect(graphErrorKind(190, false)).toBe('token_invalid');
    expect(graphErrorKind(200, false)).toBe('permission');
    expect(graphErrorKind(2, false)).toBe('transient');
    expect(graphErrorKind(100, false)).toBe('other');
  });
});
