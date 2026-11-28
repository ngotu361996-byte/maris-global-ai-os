/**
 * Pure rules of the Website and SEO Center: reading GA4 and Search Console answers, and reading a
 * web page for a website check. No network here.
 */

/** A day as YYYY-MM-DD from GA4's YYYYMMDD. */
export function ga4Day(v: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function int(v: unknown): number {
  return Math.round(num(v));
}

/** YYYY-MM-DD of a date in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The days [from, to] of the last `days` full days before `now` (UTC). */
export function lastDays(now: Date, days: number): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

export function clip(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

// ------------------------------------------------------------------------------- page reading

export interface PageFacts {
  title: string | null;
  description: string | null;
  h1: number;
  canonical: string | null;
  noindex: boolean;
  viewport: boolean;
  lang: boolean;
  imagesNoAlt: number;
  /** Links on the page, resolved against the page address, http(s) only, without #fragment. */
  links: string[];
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

/** The attributes of one tag, names in lower case. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(re)) out[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** Reads what a website check needs from an HTML page. A light reader, not a full parser. */
export function readPage(html: string, pageUrl: string): PageFacts {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  let description: string | null = null;
  let canonical: string | null = null;
  let noindex = false;
  let viewport = false;
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const name = (a.name ?? '').toLowerCase();
    if (name === 'description') description = a.content ?? '';
    if ((name === 'robots' || name === 'googlebot') && /noindex/i.test(a.content ?? '')) noindex = true;
    if (name === 'viewport') viewport = true;
  }
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) canonical = a.href ?? null;
  }
  const html0 = /<html\b[^>]*>/i.exec(body);
  const lang = html0 ? Boolean(attrs(html0[0]).lang) : false;
  const h1 = (body.match(/<h1[\s>]/gi) ?? []).length;
  let imagesNoAlt = 0;
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) if (!('alt' in attrs(m[0]))) imagesNoAlt++;
  const links = new Set<string>();
  for (const m of body.matchAll(/<a\b[^>]*>/gi)) {
    const href = attrs(m[0]).href;
    const u = resolveLink(href, pageUrl);
    if (u) links.add(u);
  }
  return {
    title: title ? decode(title[1]!) : null,
    description: description === null ? null : description,
    h1,
    canonical,
    noindex,
    viewport,
    lang,
    imagesNoAlt,
    links: [...links],
  };
}

/** An http(s) link resolved against the page, without its #fragment; null for others. */
export function resolveLink(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Same site: same host and port, ignoring "www.". */
export function sameSite(a: string, b: string): boolean {
  try {
    const h = (u: string) => new URL(u).host.toLowerCase().replace(/^www\./, '');
    return h(a) === h(b);
  } catch {
    return false;
  }
}

/** Page addresses listed in a sitemap (or the sitemaps of a sitemap index). */
export function sitemapLocs(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
  return /<sitemapindex\b/i.test(xml) ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

export interface Issue {
  severity: 'error' | 'warning';
  kind: string;
  url: string;
  detail: string;
}

/** SEO problems of one page that answered 200 with HTML. */
export function pageIssues(url: string, f: PageFacts, ms: number, slowMs: number): Issue[] {
  const out: Issue[] = [];
  const add = (severity: Issue['severity'], kind: string, detail = '') =>
    out.push({ severity, kind, url, detail: clip(detail, 500) });
  if (f.noindex) add('warning', 'noindex');
  if (!f.title) add('error', 'missing_title');
  else if (f.title.length > 70) add('warning', 'long_title', `${f.title.length} ký tự`);
  if (!f.description) add('warning', 'missing_description');
  else if (f.description.length > 170) add('warning', 'long_description', `${f.description.length} ký tự`);
  if (f.h1 === 0) add('warning', 'missing_h1');
  else if (f.h1 > 1) add('warning', 'many_h1', `${f.h1} thẻ H1`);
  if (!f.viewport) add('warning', 'missing_viewport');
  if (!f.lang) add('warning', 'missing_lang');
  if (f.imagesNoAlt > 0) add('warning', 'images_no_alt', `${f.imagesNoAlt} ảnh`);
  if (ms > slowMs) add('warning', 'slow', `${(ms / 1000).toFixed(1)} giây`);
  return out;
}
