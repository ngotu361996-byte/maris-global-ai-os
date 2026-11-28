import { siteUrl } from '@maris/contracts';
import { attrs, ga4Day, lastDays, pageIssues, readPage, resolveLink, sameSite, sitemapLocs } from './rules';

describe('web rules', () => {
  it('normalises a website address to its home page', () => {
    expect(siteUrl('Maris.VN')).toBe('https://maris.vn/');
    expect(siteUrl('http://maris.vn/san-pham?x=1')).toBe('http://maris.vn/');
    expect(siteUrl('https://user:pw@maris.vn')).toBeNull();
    expect(siteUrl('intranet')).toBeNull();
    expect(siteUrl('ftp://maris.vn')).toBeNull();
  });

  it('reads GA4 days and the last full days', () => {
    expect(ga4Day('20261127')).toBe('2026-11-27');
    expect(ga4Day('(other)')).toBeNull();
    expect(lastDays(new Date('2026-11-28T03:00:00Z'), 28)).toEqual({ from: '2026-10-31', to: '2026-11-27' });
  });

  it('reads tag attributes with any quoting', () => {
    expect(attrs(`<meta NAME="description" content='Đồ &amp; câu' data-x=1 hidden>`)).toEqual({
      name: 'description',
      content: 'Đồ & câu',
      'data-x': '1',
      hidden: '',
    });
  });

  it('reads what a website check needs from a page', () => {
    const f = readPage(
      `<html lang="vi"><head><title> Cần câu &#8211; Maris </title>
       <meta name="viewport" content="width=device-width"><meta name="robots" content="NOINDEX">
       <link rel="alternate canonical" href="https://maris.vn/can-cau"></head>
       <body><h1>A</h1><h1 class="x">B</h1><img src="a.png"><img src="b.png" alt="">
       <a href="/b#top">b</a><a href="b">rel</a><a href="mailto:x@y.vn">m</a><a href="#top">t</a>
       <a href="https://khac.vn/">k</a><!-- <a href="/an">x</a> -->
       <script>document.write('<a href="/js">')</script></body></html>`,
      'https://maris.vn/san-pham/',
    );
    expect(f).toEqual({
      title: 'Cần câu – Maris',
      description: null,
      h1: 2,
      canonical: 'https://maris.vn/can-cau',
      noindex: true,
      viewport: true,
      lang: true,
      imagesNoAlt: 1,
      links: ['https://maris.vn/b', 'https://maris.vn/san-pham/b', 'https://khac.vn/'],
    });
    expect(pageIssues('u', f, 4200, 3000).map((i) => i.kind)).toEqual([
      'noindex',
      'missing_description',
      'many_h1',
      'images_no_alt',
      'slow',
    ]);
    expect(pageIssues('u', { ...f, title: 'x'.repeat(71), noindex: false, h1: 0, viewport: false, lang: false }, 10, 3000).map((i) => i.kind)).toEqual([
      'long_title',
      'missing_description',
      'missing_h1',
      'missing_viewport',
      'missing_lang',
      'images_no_alt',
    ]);
  });

  it('resolves only http(s) links and compares sites', () => {
    expect(resolveLink('javascript:void(0)', 'https://a.vn/')).toBeNull();
    expect(resolveLink('//cdn.a.vn/x', 'https://a.vn/')).toBe('https://cdn.a.vn/x');
    expect(sameSite('https://www.a.vn/x', 'http://a.vn/')).toBe(true);
    expect(sameSite('https://a.vn:8080/', 'https://a.vn/')).toBe(false);
    expect(sameSite('https://b.a.vn/', 'https://a.vn/')).toBe(false);
  });

  it('reads sitemaps and sitemap indexes', () => {
    expect(sitemapLocs('<urlset><url><loc> https://a.vn/?a=1&amp;b=2 </loc></url></urlset>')).toEqual({
      pages: ['https://a.vn/?a=1&b=2'],
      sitemaps: [],
    });
    expect(sitemapLocs('<sitemapindex><sitemap><loc>https://a.vn/s1.xml</loc></sitemap></sitemapindex>')).toEqual({
      pages: [],
      sitemaps: ['https://a.vn/s1.xml'],
    });
  });
});
