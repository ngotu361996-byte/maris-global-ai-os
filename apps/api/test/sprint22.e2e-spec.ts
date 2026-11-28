import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { localDay, MetaPublishService } from '../src/meta/meta-publish.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner22@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ shop',
  tenantName: 'Shop Đăng Bài',
};
const APP_ID = '223456789012';
const APP_SECRET = 'app-secret-222';
const LONG = 'long-user-token-22';
const PAGE_TOKEN = 'page-token-5551';
const PAGE2_TOKEN = 'page-token-5552';
const TZ = 'Asia/Ho_Chi_Minh';

/** The start of a PNG whose header gives this size. */
const png = (w: number, h: number) => {
  const b = Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000080600000000', 'hex');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
/** An MP4 whose index (at the start) says this size and length. */
const mp4 = (w: number, h: number, sec: number) => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(sec * 1000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeInt32BE(0x10000, 40);
  tkhd.writeUInt32BE(w * 65536, 76);
  tkhd.writeUInt32BE(h * 65536, 80);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\x02\0isom', 'latin1')),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
    box('mdat', Buffer.from(`${w}x${h}x${sec}`)),
  ]);
};

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  raw: Buffer;
}

/** A stand-in for graph.facebook.com, graph-video and rupload that checks what MARIS sends. */
class FakeGraph {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  fail: Record<string, { status: number; body: unknown } | 'drop'> = {};
  badProof = 0;
  reelStatus = 'IN_PROGRESS';
  publishNotReady = 0;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  posts(method: string, re: RegExp) {
    return this.hits.filter((h) => h.method === method && re.test(h.path));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url!, this.url);
    const path = u.pathname.replace(/^\/v23\.0/, '');
    const params: Record<string, string> = Object.fromEntries(u.searchParams);
    const type = req.headers['content-type'] ?? '';
    if (type.startsWith('application/x-www-form-urlencoded'))
      Object.assign(params, Object.fromEntries(new URLSearchParams(raw.toString())));
    if (type.startsWith('multipart/form-data')) {
      // Enough of a multipart reader for plain fields.
      const text = raw.toString('latin1');
      for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g))
        params[m[1]!] = Buffer.from(m[2]!, 'latin1').toString('utf8');
      const f = /name="source"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)/.exec(text);
      if (f) params['source'] = `${f[1]} (${f[2]})`;
    }
    this.hits.push({ method: req.method!, path, params, headers: req.headers, raw });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const f = this.fail[`${req.method} ${path}`];
    if (f === 'drop') return req.socket.destroy();
    if (f) return send(f.status, f.body);

    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (bearer && !bearer.includes('|') && !req.headers.authorization?.startsWith('OAuth')) {
      const proof = createHmac('sha256', APP_SECRET).update(bearer).digest('hex');
      if (params['appsecret_proof'] !== proof) this.badProof++;
    }

    // ---- sign-in, as in Sprint 21
    if (path === '/oauth/access_token') {
      if (params['code'] === 'good-code')
        return send(200, { access_token: 'short-token', token_type: 'bearer', expires_in: 3600 });
      return send(200, { access_token: LONG, token_type: 'bearer', expires_in: 5_184_000 });
    }
    if (path === '/me') return send(200, { id: '2001', name: 'Tú' });
    if (path === '/me/permissions')
      return send(200, {
        data: [
          'pages_show_list',
          'pages_read_engagement',
          'pages_manage_posts',
          'instagram_basic',
          'instagram_content_publish',
        ].map((permission) => ({ permission, status: 'granted' })),
      });
    if (path === '/me/accounts')
      return send(200, {
        data: [
          {
            id: '5551',
            name: 'Áo Thun Tú',
            category: 'Clothing',
            tasks: ['CREATE_CONTENT'],
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: '1784', username: 'aothuntu', name: 'IG' },
          },
          {
            id: '5552',
            name: 'Tú Outlet',
            category: 'Shopping',
            tasks: ['CREATE_CONTENT'],
            access_token: PAGE2_TOKEN,
          },
        ],
      });
    if (path === '/me/adaccounts') return send(200, { data: [] });

    // ---- the resumable upload host: the whole file, with the page token
    const up = /^\/(video-upload|ig-api-upload)\/v23\.0\/(.+)$/.exec(path);
    if (up) {
      if (req.headers.authorization !== `OAuth ${PAGE_TOKEN}`)
        return send(401, { error: { code: 190, message: 'bad upload token' } });
      if (req.headers.offset !== '0' || req.headers.file_size !== String(raw.length))
        return send(400, { error: { code: 100, message: 'bad offset' } });
      return send(200, { success: true });
    }

    // ---- publishing, each Page with its own token
    const pageOf: Record<string, string> = {
      '5551': PAGE_TOKEN,
      '5552': PAGE2_TOKEN,
      '1784': PAGE_TOKEN,
    };
    const owner = /^\/(\d+)\//.exec(path)?.[1];
    if (owner && pageOf[owner] && bearer !== pageOf[owner])
      return send(400, { error: { code: 190, message: 'wrong page token' } });
    if (req.method === 'POST' && /^\/\d+\/feed$/.test(path))
      return send(200, { id: `${owner}_90${this.hits.length}` });
    if (req.method === 'POST' && /^\/\d+\/photos$/.test(path)) {
      if (!params['source']) return send(400, { error: { code: 324, message: 'no file' } });
      if (params['published'] === 'false') return send(200, { id: 'tmp-photo' });
      return send(200, { id: 'photo-1', post_id: `${owner}_photo1` });
    }
    if (req.method === 'POST' && /^\/\d+\/videos$/.test(path)) return send(200, { id: 'video-1' });
    if (req.method === 'POST' && /^\/\d+\/video_reels$/.test(path))
      return params['upload_phase'] === 'start'
        ? send(200, { video_id: 'reel-1', upload_url: 'https://rupload.facebook.com/x' })
        : send(200, { success: true });
    if (req.method === 'POST' && path === '/1784/media')
      return send(200, { id: params['media_type'] === 'REELS' ? 'c-reel' : 'c-image' });
    if (req.method === 'POST' && path === '/1784/media_publish') {
      if (this.publishNotReady > 0) {
        this.publishNotReady--;
        return send(400, { error: { code: 9007, message: 'Media ID is not available' } });
      }
      return send(200, { id: params['creation_id'] === 'c-reel' ? 'ig-reel-1' : 'ig-image-1' });
    }
    if (req.method === 'GET' && path === '/tmp-photo')
      return send(200, {
        images: [
          { source: 'https://scontent.example/small.jpg', width: 320 },
          { source: 'https://scontent.example/big.jpg', width: 1080 },
        ],
      });
    if (req.method === 'GET' && path === '/c-reel')
      return send(200, { status_code: this.reelStatus, status: this.reelStatus });
    if (req.method === 'GET' && /^\/ig-/.test(path))
      return send(200, { permalink: `https://www.instagram.com/p/${path.slice(1)}/` });
    if (req.method === 'GET' && params['fields'] === 'permalink_url')
      return send(200, { permalink_url: `/${path.slice(1)}/posts` });
    send(404, { error: { code: 803, message: `unknown ${req.method} ${path}` } });
  }
}

describe('Sprint 22 (e2e): publishing to Facebook Pages and Instagram', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let publisher: MetaPublishService;
  const graph = new FakeGraph();
  const redis = new Redis(REDIS_URL);
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const M = '/api/v1/meta';
  const C = '/api/v1/content';
  const asset = { page1: '', page2: '', ig: '' };
  const item = { text: '', text2: '', photo: '', video: '', draft: '' };

  const create = (body: object) =>
    http
      .post(`${C}/items`)
      .set(as())
      .send(body)
      .expect(201)
      .then((r) => r.body.id as string);
  const upload = (id: string, name: string, data: Buffer) =>
    http
      .post(`${C}/items/${id}/versions/upload`)
      .set(as())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(name))
      .send(data)
      .expect(201);
  const approve = async (id: string) => {
    await http.post(`${C}/items/${id}/submit`).set(as()).expect(200);
    await http.post(`${C}/items/${id}/approve`).set(as()).send({}).expect(200);
  };
  const schedule = (body: object, t = token) => http.post(`${M}/posts`).set(as(t)).send(body);
  const post = async (id: string) =>
    ((await http.get(`${M}/posts`).set(as()).expect(200)).body as { id: string }[]).find(
      (p) => p.id === id,
    ) as unknown as Record<string, unknown>;
  /** Makes waiting posts due now, as if their time had come. */
  const dueNow = () =>
    db`UPDATE meta.posts SET next_attempt_at = now() - interval '1 second'
       WHERE status IN ('scheduled', 'processing')`;
  const audits = (action: string) =>
    db`SELECT target_id, metadata FROM security.audit_logs WHERE action = ${action}`;

  beforeAll(async () => {
    await resetDatabase();
    await graph.start();
    app = await startApp({
      META_GRAPH_URL: graph.url,
      META_GRAPH_VIDEO_URL: graph.url,
      META_UPLOAD_URL: graph.url,
      META_DIALOG_URL: graph.url,
      META_RETRY_BASE_MS: '1',
      META_PUBLISHER_ENABLED: 'false',
      META_TIMEZONE: TZ,
    });
    publisher = app.get(MetaPublishService);
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const roles = (await http.get('/api/v1/roles').set(as()).expect(200)).body as {
      id: string;
      key: string;
    }[];
    const inv = await http
      .post('/api/v1/tenants/current/invitations')
      .set(as())
      .send({ email: 's22.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'member' })
        .expect(200)
    ).body.token;

    await http
      .put(`${M}/app`)
      .set(as())
      .send({ appId: APP_ID, appSecretName: 'meta.app_secret' })
      .expect(200);
    await http
      .post('/api/v1/secrets')
      .set(as())
      .send({ name: 'meta.app_secret', value: APP_SECRET })
      .expect(201);
    const { url } = (await http.post(`${M}/oauth/start`).set(as()).expect(200)).body;
    const s = (
      await http
        .post(`${M}/oauth/callback`)
        .set(as())
        .send({ code: 'good-code', state: new URL(url).searchParams.get('state') })
        .expect(200)
    ).body as { assets: { id: string; externalId: string }[] };
    const by = (x: string) => s.assets.find((a) => a.externalId === x)!.id;
    asset.page1 = by('5551');
    asset.page2 = by('5552');
    asset.ig = by('1784');

    item.text = await create({
      title: 'Bài khai trương',
      kind: 'ad',
      language: 'vi',
      platform: 'facebook',
      body: 'Khai trương cửa hàng mới, giảm giá 20% cho 100 khách đầu tiên.',
    });
    item.text2 = await create({
      title: 'Bài cuối tuần',
      kind: 'text',
      language: 'vi',
      platform: 'facebook',
      body: 'Cuối tuần này cửa hàng mở cửa đến 22 giờ.',
    });
    item.photo = await create({
      title: 'Ảnh áo mới',
      kind: 'image',
      language: 'vi',
      platform: 'instagram',
    });
    await upload(item.photo, 'ao-moi.png', png(1080, 1350));
    item.video = await create({
      title: 'Video áo mới',
      kind: 'video',
      language: 'vi',
      platform: 'instagram',
    });
    await upload(item.video, 'ao-moi.mp4', mp4(1080, 1920, 20));
    for (const id of [item.text, item.text2, item.photo, item.video]) await approve(id);
    item.draft = await create({
      title: 'Bản nháp',
      kind: 'text',
      language: 'vi',
      platform: 'facebook',
      body: 'Chưa duyệt.',
    });
  });

  afterAll(async () => {
    await app.close();
    await graph.stop();
    await redis.quit();
    await db.end();
  });

  it('only schedules approved items, for people with meta.publish, in a form the account takes', async () => {
    await schedule({ itemId: item.text, assetIds: [asset.page1] }, memberToken).expect(403);
    expect(
      (await schedule({ itemId: item.draft, assetIds: [asset.page1] }).expect(409)).body.error.code,
    ).toBe('META_POST_NOT_APPROVED');
    // Instagram takes only images and videos.
    expect(
      (await schedule({ itemId: item.text, assetIds: [asset.ig] }).expect(400)).body.error.code,
    ).toBe('META_POST_FORMAT');
    expect(
      (
        await schedule({
          itemId: item.text,
          assetIds: [asset.page1],
          at: '2020-01-01T00:00:00Z',
        }).expect(400)
      ).body.error.code,
    ).toBe('META_POST_PAST');
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    expect(
      (await schedule({ itemId: item.photo, assetIds: [asset.ig], caption: tags }).expect(400)).body
        .error.code,
    ).toBe('META_POST_MEDIA');
    await http.patch(`${M}/assets/${asset.page2}`).set(as()).send({ enabled: false }).expect(200);
    expect(
      (await schedule({ itemId: item.text, assetIds: [asset.page2] }).expect(409)).body.error.code,
    ).toBe('META_ASSET_OFF');
    await http.patch(`${M}/assets/${asset.page2}`).set(as()).send({ enabled: true }).expect(200);
    expect(await db`SELECT 1 FROM meta.posts`).toHaveLength(0);
  });

  it('posts a text to a Page with its own token, then marks the item published', async () => {
    const [p] = (
      await schedule({
        itemId: item.text,
        assetIds: [asset.page1],
        link: 'https://aothuntu.vn',
      }).expect(201)
    ).body;
    expect(p).toMatchObject({
      format: 'feed',
      status: 'scheduled',
      assetName: 'Áo Thun Tú',
      link: 'https://aothuntu.vn',
    });
    expect(p.localDay).toBe(localDay(new Date(), TZ));
    // The same version cannot be queued twice for the same Page.
    expect(
      (await schedule({ itemId: item.text, assetIds: [asset.page1] }).expect(409)).body.error.code,
    ).toBe('META_POST_DUPLICATE');

    expect(await publisher.runOnce()).toBe(1);
    const feed = graph.posts('POST', /^\/5551\/feed$/);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.params).toMatchObject({
      message: 'Khai trương cửa hàng mới, giảm giá 20% cho 100 khách đầu tiên.',
      link: 'https://aothuntu.vn',
    });
    expect(feed[0]!.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(graph.badProof).toBe(0);
    const done = await post(p.id);
    expect(done).toMatchObject({ status: 'published', errorCode: null });
    expect(done.permalink).toMatch(/^https:\/\/www\.facebook\.com\/5551_90\d+\/posts$/);
    const it = (await http.get(`${C}/items/${item.text}`).set(as()).expect(200)).body;
    expect(it).toMatchObject({ status: 'published', publishedUrl: done.permalink });
    expect(await audits('meta.post_published')).toHaveLength(1);
    expect((await audits('content.item.published'))[0]!.metadata).toMatchObject({
      via: 'meta',
      postId: p.id,
    });
    // A call to Meta is logged by path, with the publish group.
    const calls = await db`SELECT api_group, path FROM integration.api_calls WHERE method = 'POST'`;
    expect(calls).toContainEqual({ api_group: 'publish', path: '/5551/feed' });
  });

  it('sends a photo to a Page as a file and to Instagram by address', async () => {
    const posts = (
      await schedule({
        itemId: item.photo,
        assetIds: [asset.page2, asset.ig],
        caption: 'Áo mới về #aothun',
      }).expect(201)
    ).body as { id: string; format: string }[];
    expect(posts.map((p) => p.format).sort()).toEqual(['ig_image', 'photo']);
    graph.publishNotReady = 1;
    expect(await publisher.runOnce()).toBe(2);

    const page = graph.posts('POST', /^\/5552\/photos$/)[0]!;
    expect(page.params).toMatchObject({
      caption: 'Áo mới về #aothun',
      published: 'true',
      source: 'ao-moi.png (image/png)',
    });
    // Instagram: an unpublished photo on the linked Page, then its largest image by address.
    const tmp = graph.posts('POST', /^\/5551\/photos$/)[0]!;
    expect(tmp.params).toMatchObject({ published: 'false', temporary: 'true' });
    expect(graph.posts('POST', /^\/1784\/media$/)[0]!.params).toMatchObject({
      image_url: 'https://scontent.example/big.jpg',
      caption: 'Áo mới về #aothun',
    });
    const photo = posts.find((p) => p.format === 'photo')!;
    const ig = posts.find((p) => p.format === 'ig_image')!;
    expect(await post(photo.id)).toMatchObject({ status: 'published', externalId: '5552_photo1' });
    // The container was not ready the first time: the post waits, keeping what it made.
    expect(await post(ig.id)).toMatchObject({ status: 'processing' });

    await dueNow();
    expect(await publisher.runOnce()).toBe(1);
    expect(await post(ig.id)).toMatchObject({
      status: 'published',
      externalId: 'ig-image-1',
      permalink: 'https://www.instagram.com/p/ig-image-1/',
    });
    // The image was uploaded and the container made only once.
    expect(graph.posts('POST', /^\/5551\/photos$/)).toHaveLength(1);
    expect(graph.posts('POST', /^\/1784\/media$/)).toHaveLength(1);
  });

  it('uploads Reels to a Page in three steps and to Instagram, waiting while Meta processes it', async () => {
    const posts = (
      await schedule({
        itemId: item.video,
        assetIds: [asset.page1, asset.ig],
        caption: 'Mẫu mới',
      }).expect(201)
    ).body as { id: string; format: string }[];
    expect(posts.map((p) => p.format).sort()).toEqual(['ig_reel', 'reel']);
    expect(await publisher.runOnce()).toBe(2);

    const reels = graph.posts('POST', /^\/5551\/video_reels$/);
    expect(reels.map((h) => h.params['upload_phase'])).toEqual(['start', 'finish']);
    expect(reels[1]!.params).toMatchObject({
      video_id: 'reel-1',
      video_state: 'PUBLISHED',
      description: 'Mẫu mới',
    });
    const uploads = graph.hits.filter((h) => /upload\//.test(h.path));
    expect(uploads.map((h) => h.path).sort()).toEqual([
      '/ig-api-upload/v23.0/c-reel',
      '/video-upload/v23.0/reel-1',
    ]);
    expect(uploads[0]!.raw.equals(mp4(1080, 1920, 20))).toBe(true);
    const reel = posts.find((p) => p.format === 'reel')!;
    const ig = posts.find((p) => p.format === 'ig_reel')!;
    expect(await post(reel.id)).toMatchObject({
      status: 'published',
      permalink: 'https://www.facebook.com/reel/reel-1',
    });
    expect(await post(ig.id)).toMatchObject({ status: 'processing' });

    await dueNow();
    await publisher.runOnce();
    expect(await post(ig.id)).toMatchObject({ status: 'processing' });
    graph.reelStatus = 'FINISHED';
    await dueNow();
    await publisher.runOnce();
    expect(await post(ig.id)).toMatchObject({ status: 'published', externalId: 'ig-reel-1' });
    // Uploaded once; only the status was asked again.
    expect(graph.hits.filter((h) => h.path === '/ig-api-upload/v23.0/c-reel')).toHaveLength(1);
    expect(graph.posts('GET', /^\/c-reel$/)).toHaveLength(2);

    // The same video as a normal Page video goes to the video host.
    const [v] = (
      await schedule({ itemId: item.video, assetIds: [asset.page2], videoAs: 'video' }).expect(201)
    ).body;
    await publisher.runOnce();
    expect(graph.posts('POST', /^\/5552\/videos$/)[0]!.params.source).toBe(
      'ao-moi.mp4 (video/mp4)',
    );
    expect(await post(v.id)).toMatchObject({ status: 'published', format: 'video' });
  });

  it('holds to 3 posts per Page and 60 per day, counted in the market’s day', async () => {
    const at = new Date(Date.now() + 10 * 86400_000);
    const day = localDay(at, TZ);
    const [u] = await db`SELECT id FROM identity.users LIMIT 1`;
    const fill = (assetId: string, n: number) =>
      db`INSERT INTO meta.posts (id, tenant_id, item_id, version, asset_id, format, scheduled_at, local_day, status, next_attempt_at, created_by)
         SELECT gen_random_uuid(), ${tenantId}, ${item.text2}, g, ${assetId}, 'feed', ${at}, ${day}, 'scheduled', ${at}, ${u!.id}
         FROM generate_series(100, ${99 + n}) g`;
    await fill(asset.page1, 3);
    let r = await schedule({
      itemId: item.text2,
      assetIds: [asset.page1],
      at: at.toISOString(),
    }).expect(409);
    expect(r.body.error).toMatchObject({ code: 'META_POST_LIMIT' });
    expect(r.body.error.message).toContain('Áo Thun Tú');
    // Page 2 still has room that day.
    await schedule({ itemId: item.text2, assetIds: [asset.page2], at: at.toISOString() }).expect(
      201,
    );
    await db`DELETE FROM meta.posts WHERE local_day = ${day}`;

    const day2 = new Date(at.getTime() + 86400_000);
    await db`INSERT INTO meta.posts (id, tenant_id, item_id, version, asset_id, format, scheduled_at, local_day, status, next_attempt_at, created_by)
             SELECT gen_random_uuid(), ${tenantId}, ${item.text2}, g, ${asset.ig}, 'ig_image', ${day2}, ${localDay(day2, TZ)}, 'scheduled', ${day2}, ${u!.id}
             FROM generate_series(100, 159) g`;
    r = await schedule({
      itemId: item.text2,
      assetIds: [asset.page2],
      at: day2.toISOString(),
    }).expect(409);
    expect(r.body.error.message).toContain('60 bài mỗi ngày');
    await db`DELETE FROM meta.posts WHERE version >= 100`;
  });

  it('retries Meta errors, waits out the Governor, and leaves an unknown result to a person', async () => {
    const [p] = (await schedule({ itemId: item.text2, assetIds: [asset.page2] }).expect(201)).body;
    // Meta answers with a temporary error: nothing went out, so try again in 5 minutes.
    graph.fail['POST /5552/feed'] = {
      status: 500,
      body: { error: { code: 2, message: 'Service temporarily unavailable' } },
    };
    await publisher.runOnce();
    let s = await post(p.id);
    expect(s).toMatchObject({ status: 'scheduled', attempts: 1, errorCode: 'META_GRAPH_ERROR' });
    expect(Date.parse(String(s.nextAttemptAt)) - Date.now()).toBeGreaterThan(4 * 60_000);

    // Meta told us to stop: the post moves later and the attempt does not count.
    await redis.set(
      `meta:block:${tenantId}:all`,
      new Date(Date.now() + 3600_000).toISOString(),
      'PX',
      3600_000,
    );
    await dueNow();
    const before = graph.posts('POST', /^\/5552\/feed$/).length;
    await publisher.runOnce();
    s = await post(p.id);
    expect(s).toMatchObject({ status: 'scheduled', attempts: 1 });
    expect(Date.parse(String(s.nextAttemptAt)) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(graph.posts('POST', /^\/5552\/feed$/)).toHaveLength(before);
    await redis.del(`meta:block:${tenantId}:all`);

    // The connection drops mid-write: it may have been posted, so it is not sent again by itself.
    graph.fail['POST /5552/feed'] = 'drop';
    await dueNow();
    await publisher.runOnce();
    s = await post(p.id);
    expect(s).toMatchObject({
      status: 'failed',
      errorCode: 'META_POST_UNKNOWN',
      nextAttemptAt: null,
    });
    await dueNow();
    expect(await publisher.runOnce()).toBe(0);
    expect((await audits('meta.post_failed')).map((a) => a.target_id)).toContain(p.id);

    // A person checks the Page and retries.
    await http.post(`${M}/posts/${p.id}/retry`).set(as(memberToken)).expect(403);
    delete graph.fail['POST /5552/feed'];
    expect((await http.post(`${M}/posts/${p.id}/retry`).set(as()).expect(200)).body).toMatchObject({
      status: 'scheduled',
      attempts: 0,
      errorCode: null,
    });
    await publisher.runOnce();
    expect(await post(p.id)).toMatchObject({ status: 'published' });
    expect(await audits('meta.post_retried')).toHaveLength(1);
  });

  it('gives up after three Meta errors and marks posts stopped half-way as unknown', async () => {
    const id = await create({
      title: 'Bài giờ mở cửa',
      kind: 'text',
      language: 'vi',
      platform: 'facebook',
      body: 'Mở cửa đến 23 giờ.',
    });
    await approve(id);
    // Each Page takes 3 posts a day; Page 1 has had 2 today.
    await redis.del(...(await redis.keys(`meta:cb:*`)), 'none');
    const [p] = (await schedule({ itemId: id, assetIds: [asset.page1] }).expect(201)).body;
    graph.fail['POST /5551/feed'] = {
      status: 400,
      body: { error: { code: 1, message: 'An unknown error occurred' } },
    };
    for (let i = 0; i < 3; i++) {
      await dueNow();
      await publisher.runOnce();
    }
    expect(await post(p.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      errorCode: 'META_GRAPH_ERROR',
    });
    delete graph.fail['POST /5551/feed'];

    // A run that stopped while posting (its lock ran out) is not repeated by itself.
    await http.post(`${M}/posts/${p.id}/retry`).set(as()).expect(200);
    await db`UPDATE meta.posts SET status = 'publishing', locked_until = now() - interval '1 minute' WHERE id = ${p.id}`;
    await publisher.runOnce();
    expect(await post(p.id)).toMatchObject({ status: 'failed', errorCode: 'META_POST_UNKNOWN' });
  });

  it('cancels a waiting post, which can then be scheduled again', async () => {
    const at = new Date(Date.now() + 2 * 86400_000).toISOString();
    const [p] = (await schedule({ itemId: item.photo, assetIds: [asset.page1], at }).expect(201))
      .body;
    expect(await publisher.runOnce()).toBe(0);
    expect((await http.post(`${M}/posts/${p.id}/cancel`).set(as()).expect(200)).body.status).toBe(
      'cancelled',
    );
    expect(
      (await http.post(`${M}/posts/${p.id}/cancel`).set(as()).expect(409)).body.error.code,
    ).toBe('META_POST_STATE');
    await schedule({ itemId: item.photo, assetIds: [asset.page1], at }).expect(201);
    const list = (await http.get(`${M}/posts?status=cancelled`).set(as(memberToken)).expect(403))
      .body;
    expect(list.error.code).toBeDefined();
    const cancelled = (await http.get(`${M}/posts?status=cancelled`).set(as()).expect(200)).body;
    expect(cancelled.map((c: { id: string }) => c.id)).toEqual([p.id]);
    expect(await audits('meta.post_cancelled')).toHaveLength(1);
  });
});
