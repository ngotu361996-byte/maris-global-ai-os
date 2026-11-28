import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { TiktokPublishService } from '../src/tiktok/tiktok-publish.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner27@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ shop',
  tenantName: 'Shop TikTok',
};
const CLIENT_KEY = 'awtiktok27key0001';
const CLIENT_SECRET = 'tiktok-client-secret-27';
const REFRESH = 'rft.refresh-27';
const REFRESH_2 = 'rft.refresh-27-rotated';
const ACCESS = 'act.access-27';
const ACCESS_2 = 'act.access-27-new';
const OPEN_ID = '-000OpenId27.abc';
const POST_ID = '7300000000000000001';
const ALL_SCOPES = 'user.info.basic,video.publish,video.upload,user.info.profile,user.info.stats,video.list';

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
    box('mdat', Buffer.alloc(4000, 7)),
  ]);
};

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  json: Record<string, unknown> | null;
}

const ok = (data: unknown) => ({ data, error: { code: 'ok', message: '', log_id: 'log1' } });
const err = (code: string, message = code) => ({
  data: {},
  error: { code, message, log_id: 'log2' },
});

/** A stand-in for www.tiktok.com and open.tiktokapis.com (and its upload host). */
class FakeTiktok {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  fail: Record<string, { status: number; body: unknown } | 'drop'> = {};
  challenge = '';
  scope = ALL_SCOPES;
  access = ACCESS;
  refresh = REFRESH;
  /** Refresh tokens TikTok still takes. */
  refreshTokens = new Set([REFRESH]);
  revoked = false;
  privacyOptions = ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
  processed = false;
  failNext = '';
  uploads = new Map<
    string,
    { size: number; chunk: number; count: number; got: number; mode: string; privacy: string | null }
  >();

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  of(method: string, re: RegExp) {
    return this.hits.filter((h) => h.method === method && re.test(h.path));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, this.url);
    const path = u.pathname;
    const params: Record<string, string> = Object.fromEntries(u.searchParams);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] ?? '';
    if (type.startsWith('application/x-www-form-urlencoded'))
      Object.assign(params, Object.fromEntries(new URLSearchParams(raw.toString())));
    const json = type.startsWith('application/json') ? JSON.parse(raw.toString() || '{}') : null;
    this.hits.push({ method: req.method!, path, params, headers: req.headers, json });
    const f = this.fail[`${req.method} ${path}`];
    if (f === 'drop') {
      delete this.fail[`${req.method} ${path}`];
      return req.socket.destroy();
    }
    if (f) {
      delete this.fail[`${req.method} ${path}`];
      return send(f.status, f.body);
    }

    if (path === '/v2/oauth/token/') {
      if (params['client_secret'] !== CLIENT_SECRET || params['client_key'] !== CLIENT_KEY)
        return send(401, { error: 'invalid_client', error_description: 'Client key or secret' });
      if (params['grant_type'] === 'authorization_code') {
        if (params['code'] !== 'good-code') return send(400, { error: 'invalid_grant' });
        const challenge = createHash('sha256')
          .update(params['code_verifier'] ?? '')
          .digest('hex');
        if (challenge !== this.challenge)
          return send(400, { error: 'invalid_request', error_description: 'PKCE' });
        return send(200, {
          access_token: this.access,
          expires_in: 86400,
          open_id: OPEN_ID,
          refresh_token: REFRESH,
          refresh_expires_in: 31536000,
          scope: this.scope,
          token_type: 'Bearer',
        });
      }
      if (params['grant_type'] === 'refresh_token') {
        if (this.revoked || !this.refreshTokens.has(params['refresh_token']!))
          return send(400, { error: 'invalid_grant', error_description: 'Refresh token is invalid' });
        // TikTok hands out a new refresh token; the old one stops working.
        this.refreshTokens = new Set([REFRESH_2]);
        this.access = ACCESS_2;
        return send(200, {
          access_token: ACCESS_2,
          expires_in: 86400,
          open_id: OPEN_ID,
          refresh_token: REFRESH_2,
          refresh_expires_in: 31536000,
          scope: this.scope,
        });
      }
    }
    if (path === '/v2/oauth/revoke/') return send(200, {});

    // The upload host: pre-signed, no token.
    if (req.method === 'PUT' && path === '/upload/') {
      if (req.headers.authorization) return send(400, err('invalid_params', 'token on upload'));
      const up = this.uploads.get(params['upload_id']!);
      if (!up) return send(404, err('invalid_params', 'upload'));
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
      if (!m || Number(m[1]) !== up.got || Number(m[3]) !== up.size || raw.length !== Number(m[2]) - Number(m[1]) + 1)
        return send(400, err('invalid_params', 'range'));
      up.got += raw.length;
      return send(up.got === up.size ? 201 : 206, null);
    }

    if (req.headers.authorization !== `Bearer ${this.access}` || this.revoked)
      return send(401, err('access_token_invalid', 'The access token is invalid or not found'));

    if (req.method === 'GET' && path === '/v2/user/info/')
      return send(
        200,
        ok({
          user: {
            open_id: OPEN_ID,
            display_name: 'Shop Tú',
            avatar_url: 'https://p16-sign.tiktokcdn.com/a.jpeg',
            ...(params['fields']!.includes('username') ? { username: 'shoptu' } : {}),
            ...(params['fields']!.includes('follower_count')
              ? { follower_count: 5000, following_count: 12, likes_count: 88000, video_count: 31 }
              : {}),
          },
        }),
      );
    if (req.method === 'POST' && path === '/v2/post/publish/creator_info/query/')
      return send(
        200,
        ok({
          creator_avatar_url: 'https://p16-sign.tiktokcdn.com/a.jpeg',
          creator_username: 'shoptu',
          creator_nickname: 'Shop Tú',
          privacy_level_options: this.privacyOptions,
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
        }),
      );
    if (
      req.method === 'POST' &&
      (path === '/v2/post/publish/video/init/' || path === '/v2/post/publish/inbox/video/init/')
    ) {
      const s = (json?.source_info ?? {}) as Record<string, number | string>;
      if (s.source !== 'FILE_UPLOAD' || Number(s.total_chunk_count) < 1)
        return send(400, err('invalid_params', 'source_info'));
      const draft = path.includes('/inbox/');
      if (draft && json?.post_info) return send(400, err('invalid_params', 'post_info'));
      const id = String(this.uploads.size + 1);
      const privacy = draft ? null : String((json?.post_info as Record<string, unknown>).privacy_level);
      this.uploads.set(id, {
        size: Number(s.video_size),
        chunk: Number(s.chunk_size),
        count: Number(s.total_chunk_count),
        got: 0,
        mode: draft ? 'draft' : 'direct',
        privacy,
      });
      return send(
        200,
        ok({ publish_id: `v_pub_file~v2-1.${id}`, upload_url: `${this.url}/upload/?upload_id=${id}` }),
      );
    }
    if (req.method === 'POST' && path === '/v2/post/publish/status/fetch/') {
      const id = String(json?.publish_id ?? '').split('.').pop()!;
      const up = this.uploads.get(id);
      if (!up) return send(400, err('invalid_params', 'publish_id'));
      if (up.got < up.size) return send(200, ok({ status: 'PROCESSING_UPLOAD', uploaded_bytes: up.got }));
      if (this.failNext) {
        const reason = this.failNext;
        this.failNext = '';
        return send(200, ok({ status: 'FAILED', fail_reason: reason }));
      }
      if (up.mode === 'draft') return send(200, ok({ status: 'SEND_TO_USER_INBOX' }));
      if (!this.processed) return send(200, ok({ status: 'PROCESSING_DOWNLOAD' }));
      // TikTok sends the id as a bare 64-bit number, past what JavaScript numbers hold.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify(
          ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['ID'] }),
        ).replace('["ID"]', up.privacy === 'SELF_ONLY' ? '[]' : `[ ${POST_ID} ]`),
      );
    }
    if (req.method === 'POST' && path === '/v2/video/list/') {
      const now = Math.floor(Date.now() / 1000);
      return send(
        200,
        ok({
          videos: [
            {
              id: POST_ID,
              title: 'Áo thun cotton #aothun',
              cover_image_url: 'https://p16-sign.tiktokcdn.com/c1.jpeg',
              share_url: `https://www.tiktok.com/@shoptu/video/${POST_ID}`,
              create_time: now - 86400,
              duration: 40,
              view_count: 1000,
              like_count: 100,
              comment_count: 10,
              share_count: 5,
            },
            {
              id: '7300000000000000002',
              title: 'Video cũ',
              create_time: now - 60 * 86400,
              duration: 15,
              view_count: 50,
              like_count: 1,
              comment_count: 0,
              share_count: 0,
            },
          ],
          cursor: 0,
          has_more: false,
        }),
      );
    }
    send(404, err('not_found', `unknown ${req.method} ${path}`));
  }
}

describe('Sprint 27 (e2e): TikTok Center and posting', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let publisher: TiktokPublishService;
  const tiktok = new FakeTiktok();
  const redis = new Redis(REDIS_URL);
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  let accountId = '';
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const T = '/api/v1/tiktok';
  const C = '/api/v1/content';
  const item = { a: '', b: '', c: '', d: '', e: '', text: '', short: '' };

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
  const video = async (title: string, sec = 40) => {
    const id = await create({ title, kind: 'video', language: 'vi', platform: 'tiktok' });
    await upload(id, `${title}.mp4`, mp4(1080, 1920, sec));
    return id;
  };
  const post = (body: object, t = token) =>
    http
      .post(`${T}/posts`)
      .set(as(t))
      .send({ accountIds: [accountId], consent: true, ...body });
  const one = async (id: string) =>
    ((await http.get(`${T}/posts`).set(as()).expect(200)).body as { id: string }[]).find(
      (p) => p.id === id,
    ) as unknown as Record<string, unknown>;
  const dueNow = () =>
    db`UPDATE tiktok.posts SET next_attempt_at = now() - interval '1 second'
       WHERE status IN ('scheduled', 'uploading', 'processing')
         AND scheduled_at <= now() + interval '1 minute'`;
  const run = async () => {
    await dueNow();
    await publisher.runOnce();
  };
  const setApp = (body: object = {}) =>
    http
      .put(`${T}/app`)
      .set(as())
      .send({ clientKey: CLIENT_KEY, clientSecretName: 'tiktok.client_secret', ...body })
      .expect(200);

  beforeAll(async () => {
    await resetDatabase();
    await tiktok.start();
    app = await startApp({
      TIKTOK_AUTH_URL: tiktok.url,
      TIKTOK_API_URL: tiktok.url,
      TIKTOK_RETRY_BASE_MS: '1',
      TIKTOK_PUBLISHER_ENABLED: 'false',
      YOUTUBE_UPLOADER_ENABLED: 'false',
    });
    publisher = app.get(TiktokPublishService);
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
      .send({ email: 's27.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'member' })
        .expect(200)
    ).body.token;

    item.a = await video('Áo thun');
    item.b = await video('Quần jean');
    item.c = await video('Váy hoa');
    item.d = await video('Mũ lưỡi trai');
    item.e = await video('Giày da');
    item.short = await video('Quá ngắn', 2);
    item.text = await create({
      title: 'Bài chữ',
      kind: 'text',
      language: 'vi',
      platform: 'facebook',
      body: 'Không phải video.',
    });
    for (const id of Object.values(item)) await approve(id);
  });

  afterAll(async () => {
    await app.close();
    await tiktok.stop();
    await redis.quit();
    await db.end();
  });

  it('keeps the TikTok Center to tiktok.read and its settings to tiktok.manage', async () => {
    await http.get(T).set(as(memberToken)).expect(403);
    const s0 = (await http.get(T).set(as()).expect(200)).body;
    expect(s0).toMatchObject({ app: null, accounts: [] });
    expect(s0.redirectUri).toMatch(/\/tiktok\/callback$/);
    expect(
      (await http.post(`${T}/oauth/start`).set(as()).send({ services: ['publish'] }).expect(409))
        .body.error.code,
    ).toBe('TIKTOK_APP_MISSING');
    await http
      .put(`${T}/app`)
      .set(as())
      .send({ clientKey: 'bad key!', clientSecretName: 'tiktok.client_secret' })
      .expect(400);
    await http
      .put(`${T}/app`)
      .set(as(memberToken))
      .send({ clientKey: CLIENT_KEY, clientSecretName: 'tiktok.client_secret' })
      .expect(403);
    expect((await setApp()).body.app).toMatchObject({
      clientKey: CLIENT_KEY,
      secretFound: false,
      audited: false,
    });
    expect(
      (await http.post(`${T}/oauth/start`).set(as()).send({ services: ['publish'] }).expect(409))
        .body.error.code,
    ).toBe('TIKTOK_SECRET_MISSING');
    await http
      .post('/api/v1/secrets')
      .set(as())
      .send({ name: 'tiktok.client_secret', value: CLIENT_SECRET })
      .expect(201);
    await http
      .post(`${T}/oauth/start`)
      .set(as())
      .send({ services: ['comments'] })
      .expect(400);
  });

  it('signs in through TikTok with a one-time state and a PKCE challenge in hex', async () => {
    const { url } = (
      await http
        .post(`${T}/oauth/start`)
        .set(as())
        .send({ services: ['publish', 'draft', 'insights'] })
        .expect(200)
    ).body;
    const u = new URL(url);
    expect(u.pathname).toBe('/v2/auth/authorize/');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_key: CLIENT_KEY,
      response_type: 'code',
      scope: ALL_SCOPES,
      code_challenge_method: 'S256',
    });
    expect(u.searchParams.get('code_challenge')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/tiktok\/callback$/);
    tiktok.challenge = u.searchParams.get('code_challenge')!;
    const state = u.searchParams.get('state')!;
    // Another person cannot finish this sign-in.
    await http
      .post(`${T}/oauth/callback`)
      .set(as(memberToken))
      .send({ code: 'good-code', state })
      .expect(403);
    const s = (
      await http.post(`${T}/oauth/callback`).set(as()).send({ code: 'good-code', state }).expect(200)
    ).body;
    await http.post(`${T}/oauth/callback`).set(as()).send({ code: 'good-code', state }).expect(400);
    expect(s.accounts).toHaveLength(1);
    const a = s.accounts[0];
    accountId = a.id;
    expect(a).toMatchObject({
      openId: OPEN_ID,
      displayName: 'Shop Tú',
      username: 'shoptu',
      status: 'active',
      enabled: true,
      followers: 5000,
      likes: 88000,
      videoCount: 31,
      postsToday: 0,
      features: [
        { key: 'profile', ready: true },
        { key: 'direct', ready: true },
        { key: 'draft', ready: true },
        { key: 'insights', ready: true },
      ],
    });
    expect(a.creator).toMatchObject({
      privacyOptions: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
      duetDisabled: true,
      maxDurationSec: 600,
    });

    // The account's videos and the 30-day report.
    const videos = (await http.get(`${T}/videos`).set(as()).expect(200)).body;
    expect(videos).toHaveLength(2);
    expect(videos[0]).toMatchObject({ videoId: POST_ID, views: 1000, accountName: 'Shop Tú' });
    const report = (await http.get(`${T}/report?days=30`).set(as()).expect(200)).body;
    expect(report).toMatchObject({ days: 30, videos: 1, views: 1000, likes: 100, engagementPct: 11.5 });

    // The refresh token is sealed; no token, code or secret is in the call log.
    const [row] = await db`SELECT refresh_token_sealed FROM tiktok.accounts`;
    expect(row!.refresh_token_sealed).toMatch(/^v1\./);
    const calls = JSON.stringify(await db`SELECT * FROM integration.api_calls`);
    for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, 'good-code'])
      expect(calls).not.toContain(secret);
    const log = (await http.get(`${T}/calls`).set(as()).expect(200)).body as { path: string }[];
    expect(log.map((c) => c.path)).toContain('/v2/video/list/');
  });

  it('follows TikTok rules before anything is sent', async () => {
    await post({ itemId: item.a, mode: 'direct', privacy: 'SELF_ONLY' }, memberToken).expect(403);
    // Direct Post asks who may see it, with no default; and the music consent is required.
    await post({ itemId: item.a, mode: 'direct' }).expect(400);
    await post({ itemId: item.a, mode: 'direct', privacy: 'SELF_ONLY', consent: false }).expect(400);
    // A paid partnership cannot be "only me".
    await post({ itemId: item.a, mode: 'direct', privacy: 'SELF_ONLY', brandedContent: true }).expect(
      400,
    );
    expect(
      (await post({ itemId: item.text, mode: 'draft' }).expect(400)).body.error.code,
    ).toBe('TIKTOK_NOT_VIDEO');
    expect(
      (await post({ itemId: item.short, mode: 'draft' }).expect(400)).body.error.code,
    ).toBe('TIKTOK_POLICY');
    // An app TikTok has not audited may only post as "only me".
    const r = await post({ itemId: item.a, mode: 'direct', privacy: 'PUBLIC_TO_EVERYONE' }).expect(
      400,
    );
    expect(r.body.error).toMatchObject({ code: 'TIKTOK_POLICY' });
    expect(r.body.error.message).toMatch(/Chỉ mình tôi/);
    expect(
      (
        await post({
          itemId: item.a,
          mode: 'direct',
          privacy: 'SELF_ONLY',
          at: new Date(Date.now() + 40 * 86_400_000).toISOString(),
        }).expect(400)
      ).body.error.code,
    ).toBe('TIKTOK_TOO_FAR');
  });

  it('posts as "only me" with an unaudited app: creator check, upload, status', async () => {
    const [p] = (
      await post({
        itemId: item.a,
        mode: 'direct',
        privacy: 'SELF_ONLY',
        title: 'Áo thun cotton #aothun',
        allowComment: true,
        allowDuet: true,
        aigc: true,
      }).expect(201)
    ).body;
    expect(p).toMatchObject({ status: 'scheduled', mode: 'direct', privacy: 'SELF_ONLY' });
    expect(p.warnings.join(' ')).toMatch(/Duet/);
    // The same version goes to the same account once.
    expect(
      (await post({ itemId: item.a, mode: 'direct', privacy: 'SELF_ONLY' }).expect(409)).body.error
        .code,
    ).toBe('TIKTOK_DUPLICATE');

    await run();
    const init = tiktok.of('POST', /\/video\/init\/$/).pop()!;
    expect(init.json).toMatchObject({
      post_info: {
        title: 'Áo thun cotton #aothun',
        privacy_level: 'SELF_ONLY',
        disable_comment: false,
        disable_duet: true,
        disable_stitch: true,
        is_aigc: true,
        brand_content_toggle: false,
      },
      source_info: { source: 'FILE_UPLOAD', total_chunk_count: 1 },
    });
    // TikTok was asked what the creator may post right before.
    const order = tiktok.hits.map((h) => h.path);
    expect(order.lastIndexOf('/v2/post/publish/creator_info/query/')).toBeLessThan(
      order.lastIndexOf('/v2/post/publish/video/init/'),
    );
    expect(tiktok.of('PUT', /^\/upload\/$/)).toHaveLength(1);
    expect(await one(p.id)).toMatchObject({ status: 'processing' });

    tiktok.processed = true;
    await run();
    const done = await one(p.id);
    expect(done).toMatchObject({ status: 'published', postId: null, url: null });
    expect((done.warnings as string[]).join(' ')).toMatch(/Chỉ mình tôi/);
    // Without a public address the item is not marked published.
    expect((await http.get(`${C}/items/${item.a}`).set(as()).expect(200)).body.status).toBe(
      'approved',
    );
  });

  it('posts publicly once the app is audited, and marks the item published', async () => {
    await setApp({ audited: true });
    const [p] = (
      await post({ itemId: item.b, mode: 'direct', privacy: 'PUBLIC_TO_EVERYONE', brandOrganic: true }).expect(201)
    ).body;
    await run();
    const d = await one(p.id);
    expect(d).toMatchObject({
      status: 'published',
      postId: POST_ID,
      url: `https://www.tiktok.com/@shoptu/video/${POST_ID}`,
    });
    const it = (await http.get(`${C}/items/${item.b}`).set(as()).expect(200)).body;
    expect(it).toMatchObject({ status: 'published', publishedUrl: d.url });
    expect(tiktok.of('POST', /\/video\/init\/$/).pop()!.json).toMatchObject({
      post_info: { brand_organic_toggle: true, privacy_level: 'PUBLIC_TO_EVERYONE' },
    });
    expect(
      (await db`SELECT action FROM security.audit_logs WHERE action = 'tiktok.post_published'`)
        .length,
    ).toBe(2);
  });

  it('sends a video to the TikTok inbox as a draft', async () => {
    const [p] = (await post({ itemId: item.c, mode: 'draft', title: 'bỏ qua' }).expect(201)).body;
    expect(p).toMatchObject({ mode: 'draft', privacy: null, title: '' });
    await run();
    const init = tiktok.of('POST', /\/inbox\/video\/init\/$/).pop()!;
    expect(init.json!.post_info).toBeUndefined();
    const d = await one(p.id);
    expect(d).toMatchObject({ status: 'in_inbox' });
    expect((d.warnings as string[]).join(' ')).toMatch(/hộp thư TikTok/);
  });

  it('holds a later post until its time, and it can be cancelled', async () => {
    const [p] = (
      await post({
        itemId: item.d,
        mode: 'draft',
        at: new Date(Date.now() + 2 * 3600_000).toISOString(),
      }).expect(201)
    ).body;
    const inits = tiktok.of('POST', /init\/$/).length;
    await run();
    expect(tiktok.of('POST', /init\/$/)).toHaveLength(inits);
    expect(await one(p.id)).toMatchObject({ status: 'scheduled' });
    expect((await http.post(`${T}/posts/${p.id}/cancel`).set(as()).expect(200)).body.status).toBe(
      'cancelled',
    );
  });

  it('keeps going after a cut connection, and starts over when TikTok gives a post up', async () => {
    const [p] = (await post({ itemId: item.d, mode: 'direct', privacy: 'FOLLOWER_OF_CREATOR' }).expect(201)).body;
    tiktok.fail['PUT /upload/'] = 'drop';
    await run();
    const cut = await one(p.id);
    expect(cut).toMatchObject({ status: 'uploading', errorCode: 'TIKTOK_NETWORK' });
    const inits = tiktok.of('POST', /init\/$/).length;
    await run();
    // The same publish id goes on: no second post.
    expect(tiktok.of('POST', /init\/$/)).toHaveLength(inits);
    expect(await one(p.id)).toMatchObject({ status: 'published' });

    // TikTok refuses the file: the post fails with TikTok's reason; a retry starts a new post.
    const [q] = (await post({ itemId: item.e, mode: 'direct', privacy: 'SELF_ONLY' }).expect(201)).body;
    tiktok.failNext = 'frame_rate_check_failed';
    await run();
    const f = await one(q.id);
    expect(f).toMatchObject({ status: 'failed', errorCode: 'TIKTOK_FAILED' });
    expect(f.errorMessage).toMatch(/khung hình/);
    expect((await http.post(`${T}/posts/${q.id}/retry`).set(as()).expect(200)).body.status).toBe(
      'scheduled',
    );
    const before = tiktok.of('POST', /init\/$/).length;
    await run();
    expect(tiktok.of('POST', /init\/$/)).toHaveLength(before + 1);
    expect(await one(q.id)).toMatchObject({ status: 'published' });
  });

  it('waits when TikTok limits calls, and refreshes a token that stopped working', async () => {
    // Let the post of item.e go back to the queue under another account state: make a new item.
    const id = await video('Túi xách');
    await approve(id);
    const [p] = (await post({ itemId: id, mode: 'draft' }).expect(201)).body;
    tiktok.fail['POST /v2/post/publish/inbox/video/init/'] = {
      status: 429,
      body: err('rate_limit_exceeded', 'Too many requests'),
    };
    await run();
    expect(await one(p.id)).toMatchObject({ status: 'scheduled', errorCode: 'TIKTOK_RATE_LIMITED' });
    expect(await redis.get(`tiktok:block:${tenantId}:${accountId}`)).toBeTruthy();
    await redis.del(`tiktok:block:${tenantId}:${accountId}`);

    // The access token is revoked at TikTok: MARIS refreshes once and keeps the new refresh token.
    tiktok.access = 'act.changed';
    await run();
    expect(await one(p.id)).toMatchObject({ status: 'in_inbox' });
    const refreshes = tiktok.hits.filter(
      (h) => h.path === '/v2/oauth/token/' && h.params['grant_type'] === 'refresh_token',
    );
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    const [row] = await db`SELECT refresh_token_sealed FROM tiktok.accounts`;
    expect(row!.refresh_token_sealed).not.toContain(REFRESH_2);

    // A refused refresh token marks the account for reconnecting.
    tiktok.revoked = true;
    tiktok.access = 'act.gone';
    await expect(http.post(`${T}/sync`).set(as())).resolves.toBeTruthy();
    const s = (await http.get(T).set(as()).expect(200)).body;
    expect(s.accounts[0]).toMatchObject({ status: 'invalid' });
    expect(s.accounts[0].features.every((f: { ready: boolean }) => !f.ready)).toBe(true);
    tiktok.revoked = false;
  });

  it('turns accounts off and disconnects them, revoking at TikTok', async () => {
    await http.patch(`${T}/accounts/${accountId}`).set(as(memberToken)).send({ enabled: false }).expect(403);
    expect(
      (await http.patch(`${T}/accounts/${accountId}`).set(as()).send({ enabled: false }).expect(200))
        .body.enabled,
    ).toBe(false);
    const s = (await http.delete(`${T}/accounts/${accountId}`).set(as()).expect(200)).body;
    expect(s.accounts).toHaveLength(0);
    expect(tiktok.of('POST', /\/v2\/oauth\/revoke\/$/)).toHaveLength(1);
    const [row] = await db`SELECT status, refresh_token_sealed FROM tiktok.accounts`;
    expect(row).toMatchObject({ status: 'removed', refresh_token_sealed: null });
  });
});
