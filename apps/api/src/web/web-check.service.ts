import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { WEB_LIMITS } from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { isPrivate } from '../ai/url-guard';
import type { GoogleCtx } from '../google/google-api.service';
import { clip, pageIssues, readPage, sameSite, sitemapLocs, type Issue } from './rules';
import type { SiteRow } from './web-sync.service';

const { webChecks, webCheckIssues } = schema;

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_ISSUES = 500;
const CHILD_SITEMAPS = 3;
const PARALLEL = 4;
const USER_AGENT = 'MARIS-SiteCheck/1.0 (website owner check)';

export interface Fetched {
  /** HTTP status of the last answer; 0 when no answer came. */
  status: number;
  url: string;
  ms: number;
  type: string;
  body: string;
  /** Why no answer came: blocked, unreachable, redirect_loop. */
  failure: 'blocked' | 'unreachable' | 'redirect_loop' | null;
  detail: string;
}

const isHtml = (type: string) => /text\/html|application\/xhtml/i.test(type);

/**
 * Website checks (spec Part 18): reads the site's home page, robots.txt, the sitemap and internal
 * pages (at most WEB_LIMITS.checkPages), tests the links found on them (at most
 * WEB_LIMITS.checkLinks), and records HTTP errors, broken links, slow pages and missing SEO tags.
 * It only reads public pages over http(s): every address, and every redirect, is resolved and
 * refused when it points at a private network, unless WEBSITE_ALLOW_PRIVATE_URLS is set.
 */
@Injectable()
export class WebCheckService {
  private readonly log = new Logger(WebCheckService.name);
  private readonly running = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
  ) {}

  isRunning(siteId: string): boolean {
    return this.running.has(siteId);
  }

  /** Runs a check that was just recorded as running; never throws. */
  async run(ctx: GoogleCtx, site: SiteRow, checkId: string): Promise<void> {
    this.running.add(site.id);
    try {
      const r = await this.crawl(site.url);
      const issues = r.issues.slice(0, MAX_ISSUES);
      await this.db.withContext(ctx, async (tx) => {
        if (issues.length)
          await tx.insert(webCheckIssues).values(
            issues.map((i) => ({
              id: uuidv7(),
              checkId,
              tenantId: ctx.tenantId,
              severity: i.severity,
              kind: i.kind,
              url: clip(i.url, 1000),
              detail: clip(i.detail, 500),
            })),
          );
        await tx
          .update(webChecks)
          .set({
            status: 'done',
            pages: r.pages,
            links: r.links,
            errors: r.issues.filter((i) => i.severity === 'error').length,
            warnings: r.issues.filter((i) => i.severity === 'warning').length,
            avgMs: r.times.length ? Math.round(r.times.reduce((a, b) => a + b, 0) / r.times.length) : null,
            maxMs: r.times.length ? Math.max(...r.times) : null,
            finishedAt: new Date(),
          })
          .where(eq(webChecks.id, checkId));
      });
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null;
      this.log.warn(`check ${checkId}: ${cause ?? (e instanceof Error ? e.message : String(e))}`);
      await this.db
        .withContext(ctx, (tx) =>
          tx
            .update(webChecks)
            .set({
              status: 'failed',
              error: 'MARIS không hoàn tất được lần kiểm tra này, hãy chạy lại',
              finishedAt: new Date(),
            })
            .where(eq(webChecks.id, checkId)),
        )
        .catch(() => undefined);
    } finally {
      this.running.delete(site.id);
    }
  }

  /** Reads the site and returns what it found. */
  async crawl(home: string): Promise<{ pages: number; links: number; times: number[]; issues: Issue[] }> {
    const issues: Issue[] = [];
    const add = (severity: Issue['severity'], kind: string, url: string, detail = '') =>
      issues.push({ severity, kind, url, detail });
    const times: number[] = [];

    const first = await this.get(home);
    if (first.failure) {
      add('error', first.failure === 'redirect_loop' ? 'redirect_loop' : 'unreachable', home, first.detail);
      return { pages: 0, links: 0, times, issues };
    }
    const start = first.url;
    if (!start.startsWith('https:')) add('warning', 'no_https', start, 'Trang chủ mở bằng http');
    const origin = new URL(start).origin;

    // robots.txt and the sitemap.
    const robots = await this.get(`${origin}/robots.txt`);
    const robotsOk = robots.status === 200 && !isHtml(robots.type);
    if (!robotsOk) add('warning', 'no_robots', `${origin}/robots.txt`, robots.status ? `HTTP ${robots.status}` : robots.detail);
    const declared = robotsOk
      ? [...robots.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!).slice(0, 3)
      : [];
    const sitemapUrls = declared.length ? declared : [`${origin}/sitemap.xml`];
    const fromSitemap: string[] = [];
    let sitemapFound = false;
    const queue = [...sitemapUrls];
    let read = 0;
    while (queue.length && read < sitemapUrls.length + CHILD_SITEMAPS) {
      const u = queue.shift()!;
      read++;
      if (!sameSite(u, start)) continue;
      const s = await this.get(u);
      if (s.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(s.body)) continue;
      sitemapFound = true;
      const locs = sitemapLocs(s.body);
      fromSitemap.push(...locs.pages);
      queue.push(...locs.sitemaps.slice(0, CHILD_SITEMAPS));
    }
    if (!sitemapFound) add('warning', 'no_sitemap', sitemapUrls[0]!);

    // Pages: the home page, then the sitemap, then internal links as they are found.
    const inSitemap = new Set(fromSitemap);
    const queued = new Set([start, ...fromSitemap.filter((u) => sameSite(u, start))]);
    const pending: string[] = [...queued];
    const done = new Set<string>();
    /** Every link found, with the first page it was on. */
    const linkFrom = new Map<string, string>();
    const titles = new Map<string, string[]>();
    let pages = 0;

    while (pending.length && pages < WEB_LIMITS.checkPages) {
      const url = pending.shift()!;
      const r = url === start ? first : await this.get(url);
      done.add(url);
      pages++;
      if (r.failure) {
        add('error', r.failure === 'redirect_loop' ? 'redirect_loop' : 'unreachable', url, r.detail);
        continue;
      }
      times.push(r.ms);
      if (r.status >= 400) {
        // A page found only through a link is a broken link of the page it was on.
        const from = linkFrom.get(url);
        if (from && !inSitemap.has(url)) add('error', 'broken_link', url, `HTTP ${r.status}, trên trang ${from}`);
        else add('error', 'http_error', url, `HTTP ${r.status}`);
        continue;
      }
      if (r.status !== 200 || !isHtml(r.type)) continue;
      const facts = readPage(r.body, r.url);
      issues.push(...pageIssues(url, facts, r.ms, WEB_LIMITS.slowMs));
      if (facts.title) titles.set(facts.title, [...(titles.get(facts.title) ?? []), url]);
      for (const l of facts.links) {
        if (!linkFrom.has(l)) linkFrom.set(l, url);
        if (sameSite(l, start) && !queued.has(l) && queued.size < WEB_LIMITS.checkPages * 4) {
          queued.add(l);
          pending.push(l);
        }
      }
    }
    for (const [title, urls] of titles)
      if (urls.length > 1)
        for (const u of urls)
          add('warning', 'duplicate_title', u, `“${clip(title, 120)}” trùng ${urls.length - 1} trang khác`);

    // Links that were not read as pages.
    const links = [...linkFrom.keys()].filter((l) => !done.has(l)).slice(0, WEB_LIMITS.checkLinks);
    let i = 0;
    const worker = async () => {
      while (i < links.length) {
        const l = links[i++]!;
        const r = await this.probe(l);
        const on = `trên trang ${linkFrom.get(l)}`;
        if (r.failure === 'redirect_loop') add('error', 'redirect_loop', l, on);
        else if (r.failure) add('error', 'broken_link', l, `${r.detail}, ${on}`);
        else if (r.status >= 400) add('error', 'broken_link', l, `HTTP ${r.status}, ${on}`);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return { pages, links: links.length, times, issues };
  }

  /** HEAD, and GET when the server does not answer HEAD properly. */
  private async probe(url: string): Promise<Fetched> {
    const head = await this.fetch(url, 'HEAD');
    if (head.failure === 'blocked' || head.failure === 'redirect_loop') return head;
    if (!head.failure && ![403, 405, 501].includes(head.status)) return head;
    return this.fetch(url, 'GET', 64 * 1024);
  }

  private get(url: string): Promise<Fetched> {
    return this.fetch(url, 'GET', MAX_HTML);
  }

  /** One read, following redirects by hand so every address is checked. */
  async fetch(raw: string, method: 'GET' | 'HEAD', max = 0): Promise<Fetched> {
    const started = Date.now();
    const out = (f: Partial<Fetched>): Fetched => ({
      status: 0,
      url: raw,
      ms: Date.now() - started,
      type: '',
      body: '',
      failure: null,
      detail: '',
      ...f,
    });
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const blocked = await this.blocked(url);
      if (blocked) return out({ url, failure: blocked === 'dns' ? 'unreachable' : 'blocked', detail: blocked === 'dns' ? 'Không tìm thấy tên miền' : 'Địa chỉ mạng nội bộ, MARIS không đọc' });
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        return out({
          url,
          failure: 'unreachable',
          detail: e instanceof Error && e.name === 'TimeoutError' ? `Không trả lời sau ${TIMEOUT_MS / 1000} giây` : 'Không kết nối được',
        });
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        try {
          url = new URL(location, url).toString();
        } catch {
          return out({ url, status: res.status, failure: 'unreachable', detail: 'Chuyển hướng tới địa chỉ không hợp lệ' });
        }
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      let body = '';
      if (method === 'GET' && max > 0 && (isHtml(type) || /xml|text\/plain/i.test(type) || !type)) {
        body = await readCapped(res, max).catch(() => '');
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      return out({ url, status: res.status, type, body });
    }
    return out({ url, failure: 'redirect_loop', detail: `Hơn ${MAX_REDIRECTS} lần chuyển hướng` });
  }

  /** Null when the address may be read. */
  private async blocked(raw: string): Promise<'private' | 'dns' | 'scheme' | null> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return 'scheme';
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return 'scheme';
    if (this.config.WEBSITE_ALLOW_PRIVATE_URLS) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
      } catch {
        return 'dns';
      }
    }
    return !addresses.length ? 'dns' : addresses.some(isPrivate) ? 'private' : null;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}
