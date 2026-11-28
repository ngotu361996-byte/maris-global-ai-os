import {
  API_GROUP_INFO,
  API_GROUPS,
  GOVERNOR_LEVELS,
  type ApiGroup,
  type ApiPriority,
  type GovernorGroupState,
} from '@maris/contracts';

/**
 * The API Governor's rules (spec Part 15), as pure functions so they can be tested alone.
 * Budgets are counted over the last 24 hours. A group that has used its own budget borrows from
 * the reserve; once the reserve is gone too, the group follows its own share.
 */

export type Budgets = Record<ApiGroup, number>;

export function budgetsOf(overrides: Partial<Record<string, number>>): Budgets {
  const out = {} as Budgets;
  for (const g of API_GROUPS) {
    const v = overrides[g];
    out[g] = typeof v === 'number' && v >= 0 ? v : API_GROUP_INFO[g].budget;
  }
  return out;
}

export interface GovernorInput {
  budgets: Budgets;
  /** Calls made in the last 24 hours, by group. */
  used: Partial<Record<ApiGroup, number>>;
  /** Meta's own highest usage share from the last headers, when known and fresh. */
  platformPct: number | null;
}

export interface GroupStatus {
  used: number;
  budget: number;
  pct: number;
  /** The share the thresholds are applied to. */
  levelPct: number;
  state: Exclude<GovernorGroupState, 'blocked'>;
}

export interface GovernorStatus {
  used: number;
  budget: number;
  pct: number;
  reserveLeft: number;
  levelPct: number;
  groups: Record<ApiGroup, GroupStatus>;
}

const pctOf = (used: number, budget: number) =>
  budget > 0 ? Math.round((used / budget) * 1000) / 10 : used > 0 ? 100 : 0;

export function stateFor(levelPct: number): GroupStatus['state'] {
  if (levelPct >= 90) return 'paused';
  if (levelPct >= 85) return 'essential_only';
  if (levelPct >= 75) return 'no_background';
  return 'ok';
}

export function levelLabel(pct: number): string {
  let label: string = GOVERNOR_LEVELS[0].label;
  for (const l of GOVERNOR_LEVELS) if (pct >= l.from) label = l.label;
  return label;
}

export function governorStatus(input: GovernorInput): GovernorStatus {
  const { budgets } = input;
  const used = (g: ApiGroup) => input.used[g] ?? 0;
  let total = 0;
  let budget = 0;
  let overflow = used('reserve');
  for (const g of API_GROUPS) {
    total += used(g);
    budget += budgets[g];
    if (g !== 'reserve') overflow += Math.max(0, used(g) - budgets[g]);
  }
  const reserveLeft = Math.max(0, budgets.reserve - overflow);
  const totalPct = pctOf(total, budget);
  const platform = input.platformPct ?? 0;
  const base = Math.max(totalPct, platform);
  const groups = {} as Record<ApiGroup, GroupStatus>;
  for (const g of API_GROUPS) {
    const own = pctOf(used(g), budgets[g]);
    // While the reserve lasts a group may go past its own share.
    const groupPct = g === 'reserve' ? pctOf(overflow, budgets.reserve) : reserveLeft > 0 ? 0 : own;
    const levelPct = Math.max(base, groupPct, total >= budget && budget > 0 ? 100 : 0);
    groups[g] = {
      used: used(g),
      budget: budgets[g],
      pct: own,
      levelPct,
      state: stateFor(levelPct),
    };
  }
  return { used: total, budget, pct: totalPct, reserveLeft, levelPct: base, groups };
}

/** Whether a call of this priority may go out in a group in this state. */
export function allows(state: GovernorGroupState, priority: ApiPriority): boolean {
  if (state === 'blocked' || state === 'paused') return false;
  if (state === 'essential_only') return priority === 'essential';
  if (state === 'no_background') return priority !== 'background';
  return true;
}

/** Adaptive TTL: cached answers live longer as the budget fills (50–65%: ×2, from 65%: ×4). */
export function cacheFactor(levelPct: number): number {
  return levelPct >= 65 ? 4 : levelPct >= 50 ? 2 : 1;
}

export interface UsageDetail {
  header: string;
  key: string;
  callCount: number | null;
  totalTime: number | null;
  totalCputime: number | null;
  regainMinutes: number | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function detailOf(header: string, key: string, v: unknown): UsageDetail | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    header,
    key,
    callCount: num(o.call_count),
    totalTime: num(o.total_time),
    totalCputime: num(o.total_cputime),
    regainMinutes: num(o.estimated_time_to_regain_access),
  };
}

/**
 * Meta's rate limit headers: X-App-Usage and X-Page-Usage hold one object; X-Ad-Account-Usage
 * holds one with acc_id_util_pct; X-Business-Use-Case-Usage holds a list per business id.
 * Anything that does not parse is left out; nothing is guessed.
 */
export function parseUsageHeaders(get: (name: string) => string | null): UsageDetail[] {
  const out: UsageDetail[] = [];
  const json = (name: string): unknown => {
    const raw = get(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  for (const name of ['x-app-usage', 'x-page-usage']) {
    const d = detailOf(name, '', json(name));
    if (d) out.push(d);
  }
  const ad = json('x-ad-account-usage') as Record<string, unknown> | null;
  if (ad && typeof ad === 'object') {
    const pct = num(ad.acc_id_util_pct);
    const reset = num(ad.reset_time_duration);
    if (pct !== null)
      out.push({
        header: 'x-ad-account-usage',
        key: '',
        callCount: pct,
        totalTime: null,
        totalCputime: null,
        regainMinutes: reset !== null && reset > 0 ? Math.ceil(reset / 60) : null,
      });
  }
  const buc = json('x-business-use-case-usage');
  if (buc && typeof buc === 'object')
    for (const [id, list] of Object.entries(buc as Record<string, unknown>))
      if (Array.isArray(list))
        for (const item of list) {
          const d = detailOf(
            'x-business-use-case-usage',
            `${id}:${String((item as { type?: unknown }).type ?? '')}`,
            item,
          );
          if (d) out.push(d);
        }
  return out;
}

/** The highest share in a set of usage figures, 0–100, or null when there are none. */
export function usagePct(details: UsageDetail[]): number | null {
  const values = details.flatMap((d) =>
    [d.callCount, d.totalTime, d.totalCputime].filter((v): v is number => v !== null),
  );
  return values.length ? Math.min(100, Math.max(...values)) : null;
}

/** Minutes Meta asks us to wait, from the headers, when it says so. */
export function regainMinutes(details: UsageDetail[]): number | null {
  const m = details.map((d) => d.regainMinutes ?? 0).filter((v) => v > 0);
  return m.length ? Math.max(...m) : null;
}

export type GraphErrorKind =
  | 'rate_limited_app'
  | 'rate_limited_scope'
  | 'token_invalid'
  | 'permission'
  | 'transient'
  | 'other';

/** Graph API error codes, from Meta's error handling guide. */
export function graphErrorKind(code: number | null, transient: boolean): GraphErrorKind {
  if (code === 4 || code === 17 || code === 341) return 'rate_limited_app';
  if (code === 32 || code === 613 || (code !== null && code >= 80000 && code <= 80014))
    return 'rate_limited_scope';
  if (code === 190 || code === 102) return 'token_invalid';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'permission';
  if (transient || code === 1 || code === 2) return 'transient';
  return 'other';
}
