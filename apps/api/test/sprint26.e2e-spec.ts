import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { YoutubePublishService } from '../src/google/youtube-publish.service';
import { admin, REDIS_URL, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner26@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ kênh',
  tenantName: 'Shop YouTube',
};
const CLIENT_ID = '123456789012-abcdefghijklmnop0123456789.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-26';
const REFRESH = 'refresh-token-26';
const ACCESS = 'ya29.access-26';
const CH1 = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH2 = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const VIDEO_ID = 'vid_000001A';
const READ = 'https://www.googleapis.com/auth/youtube.readonly';
const UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';

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
const png = (w: number, h: number) => {
  const b = Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000080600000000', 'hex');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

interface Hit {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  raw: Buffer;
}

/** A stand-in for accounts.google.com, oauth2.googleapis.com and www.googleapis.com. */
class FakeGoogle {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  fail: Record<string, { status: number; body: unknown } | 'drop'> = {};
  /** Received bytes of each upload session. */
  sessions = new Map<string, { size: number; got: number; meta: unknown; done: boolean }>();
  cutNextUpload = false;
  processed = false;
  revoked = false;
  thumbnailForbidden = false;
  scope = `openid email profile ${READ} ${UPLOAD}`;
  challenge = '';

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
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    // The first upload is cut off half-way: read half the body, then drop the connection.
    const session = params['upload_id'];
    if (req.method === 'PUT' && session && this.cutNextUpload && !req.headers['content-range']) {
      this.cutNextUpload = false;
      const socket = req.socket;
      const s = this.sessions.get(session)!;
      let got = 0;
      for await (const c of req) {
        got += (c as Buffer).length;
        if (got >= s.size / 2) break;
      }
      s.got = Math.floor(s.size / 2);
      this.hits.push({ method: 'PUT', path, params, headers: req.headers, raw: Buffer.alloc(0) });
      return socket.destroy();
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    if ((req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
      Object.assign(params, Object.fromEntries(new URLSearchParams(raw.toString())));
    this.hits.push({ method: req.method!, path, params, headers: req.headers, raw });
    const f = this.fail[`${req.method} ${path}`];
    if (f === 'drop') return req.socket.destroy();
    if (f) return send(f.status, f.body);

    // ---- oauth2.googleapis.com
    if (path === '/token') {
      if (params['client_secret'] !== CLIENT_SECRET)
        return send(401, { error: 'invalid_client', error_description: 'Unauthorized' });
      if (params['grant_type'] === 'authorization_code') {
        if (params['code'] !== 'good-code') return send(400, { error: 'invalid_grant' });
        const challenge = createHash('sha256')
          .update(params['code_verifier'] ?? '')
          .digest('base64url');
        if (challenge !== this.challenge)
          return send(400, { error: 'invalid_grant', error_description: 'PKCE' });
        return send(200, {
          access_token: ACCESS,
          expires_in: 3599,
          refresh_token: REFRESH,
          scope: this.scope,
          token_type: 'Bearer',
        });
      }
      if (params['grant_type'] === 'refresh_token') {
        if (this.revoked || params['refresh_token'] !== REFRESH)
          return send(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
        return send(200, { access_token: ACCESS, expires_in: 3599, scope: this.scope });
      }
    }
    if (path === '/revoke') return send(200, {});

    // ---- www.googleapis.com, with the access token
    if (req.headers.authorization !== `Bearer ${ACCESS}` || this.revoked)
      return send(401, {
        error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
      });
    if (path === '/oauth2/v3/userinfo')
      return send(200, { sub: '110022003300', email: 'kenh@example.com', name: 'Kênh Tú' });
    if (path === '/youtube/v3/channels')
      return send(200, {
        items: [
          {
            id: CH1,
            snippet: {
              title: 'Tú Review',
              customUrl: '@tureview',
              thumbnails: { medium: { url: 'https://yt3.ggpht.com/a.jpg' } },
            },
            statistics: { subscriberCount: '1200', videoCount: '45', viewCount: '99000' },
            status: { longUploadsStatus: 'allowed' },
          },
          { id: CH2, snippet: { title: 'Tú Shorts' }, statistics: {}, status: {} },
        ],
      });
    if (req.method === 'POST' && path === '/upload/youtube/v3/videos') {
      if (params['uploadType'] !== 'resumable')
        return send(400, { error: { code: 400, message: 'type' } });
      const id = `s${this.sessions.size + 1}`;
      this.sessions.set(id, {
        size: Number(req.headers['x-upload-content-length']),
        got: 0,
        meta: JSON.parse(raw.toString()),
        done: false,
      });
      return send(200, null, {
        location: `${this.url}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`,
      });
    }
    if (req.method === 'PUT' && path === '/upload/youtube/v3/videos' && session) {
      const s = this.sessions.get(session);
      if (!s) return send(404, { error: { code: 404, message: 'session' } });
      const range = req.headers['content-range'] ?? '';
      const video = {
        id: VIDEO_ID,
        status: {
          uploadStatus: 'uploaded',
          privacyStatus: (s.meta as { status: { privacyStatus: string } }).status.privacyStatus,
        },
      };
      if (/^bytes \*\//.test(range)) {
        if (s.done) return send(200, video);
        return send(308, null, s.got ? { range: `bytes=0-${s.got - 1}` } : {});
      }
      const from = /^bytes (\d+)-/.exec(range);
      const start = from ? Number(from[1]) : 0;
      if (start !== s.got) return send(400, { error: { code: 400, message: 'bad offset' } });
      s.got += raw.length;
      if (s.got !== s.size) return send(308, null, { range: `bytes=0-${s.got - 1}` });
      s.done = true;
      return send(201, video);
    }
    if (req.method === 'POST' && path === '/upload/youtube/v3/thumbnails/set') {
      if (this.thumbnailForbidden)
        return send(403, {
          error: {
            code: 403,
            message:
              'The authenticated user doesnt have permissions to upload and set custom video thumbnails.',
            errors: [{ reason: 'forbidden' }],
          },
        });
      return send(200, { items: [{ default: { url: 'https://i.ytimg.com/x.jpg' } }] });
    }
    if (req.method === 'GET' && path === '/youtube/v3/videos')
      return send(200, {
        items: [
          {
            id: params['id'],
            status: {
              uploadStatus: this.processed ? 'processed' : 'uploaded',
              privacyStatus: 'private',
            },
          },
        ],
      });
    send(404, { error: { code: 404, message: `unknown ${req.method} ${path}` } });
  }
}

describe('Sprint 26 (e2e): Google Center and YouTube uploads', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let uploader: YoutubePublishService;
  const google = new FakeGoogle();
  const redis = new Redis(REDIS_URL);
  const db = admin();
  let token: string;
  let tenantId: string;
  let memberToken: string;
  const as = (t = token) => ({ Authorization: `Bearer ${t}`, 'X-Tenant-Id': tenantId });
  const G = '/api/v1/google';
  const C = '/api/v1/content';
  const ch = { one: '', two: '' };
  const item = { wide: '', tall: '', second: '', third: '', thumb: '', text: '' };

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
  const base = { madeForKids: false, title: 'Review áo thun', description: 'Áo cotton 100%.' };
  const schedule = (body: object, t = token) =>
    http
      .post(`${G}/youtube/uploads`)
      .set(as(t))
      .send({ ...base, ...body });
  const one = async (id: string) =>
    ((await http.get(`${G}/youtube/uploads`).set(as()).expect(200)).body as { id: string }[]).find(
      (u) => u.id === id,
    ) as unknown as Record<string, unknown>;
  const dueNow = () =>
    db`UPDATE google.youtube_uploads SET next_attempt_at = now() - interval '1 second'
       WHERE status IN ('scheduled', 'uploading', 'processing')`;
  const setApp = (body: object = {}) =>
    http
      .put(`${G}/app`)
      .set(as())
      .send({ clientId: CLIENT_ID, clientSecretName: 'google.client_secret', ...body })
      .expect(200);

  beforeAll(async () => {
    await resetDatabase();
    await google.start();
    app = await startApp({
      GOOGLE_ACCOUNTS_URL: google.url,
      GOOGLE_OAUTH_URL: google.url,
      GOOGLE_API_URL: google.url,
      GOOGLE_RETRY_BASE_MS: '1',
      YOUTUBE_UPLOADER_ENABLED: 'false',
    });
    uploader = app.get(YoutubePublishService);
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
      .send({ email: 's26.member@example.com', roleId: roles.find((r) => r.key === 'member')!.id })
      .expect(201);
    memberToken = (
      await http
        .post('/api/v1/invitations/accept')
        .send({ token: inv.body.token, password: 'mat-khau-thanh-vien-1', displayName: 'member' })
        .expect(200)
    ).body.token;

    item.wide = await create({
      title: 'Review ngang',
      kind: 'video',
      language: 'vi',
      platform: 'youtube',
    });
    await upload(item.wide, 'review.mp4', mp4(1920, 1080, 120));
    item.tall = await create({
      title: 'Short dọc',
      kind: 'video',
      language: 'vi',
      platform: 'youtube',
    });
    await upload(item.tall, 'short.mp4', mp4(1080, 1920, 40));
    item.second = await create({
      title: 'Video thứ hai',
      kind: 'video',
      language: 'vi',
      platform: 'youtube',
    });
    await upload(item.second, 'hai.mp4', mp4(1920, 1080, 60));
    item.third = await create({
      title: 'Video thứ ba',
      kind: 'video',
      language: 'vi',
      platform: 'youtube',
    });
    await upload(item.third, 'ba.mp4', mp4(1920, 1080, 60));
    item.thumb = await create({
      title: 'Ảnh bìa',
      kind: 'image',
      language: 'vi',
      platform: 'youtube',
    });
    await upload(item.thumb, 'bia.png', png(1280, 720));
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
    await google.stop();
    await redis.quit();
    await db.end();
  });

  it('keeps the Google Center to google.read and its settings to google.manage', async () => {
    await http.get(G).set(as(memberToken)).expect(403);
    const s0 = (await http.get(G).set(as()).expect(200)).body;
    expect(s0).toMatchObject({ app: null, connections: [], channels: [] });
    expect(s0.redirectUri).toMatch(/\/google\/callback$/);
    expect(s0.quota).toMatchObject({ service: 'youtube', used: 0, quota: 10000, state: 'ok' });
    expect(
      (
        await http
          .post(`${G}/oauth/start`)
          .set(as())
          .send({ services: ['youtube'] })
          .expect(409)
      ).body.error.code,
    ).toBe('GOOGLE_APP_MISSING');
    await http
      .put(`${G}/app`)
      .set(as())
      .send({ clientId: 'not-a-client', clientSecretName: 'google.client_secret' })
      .expect(400);
    const s1 = (await setApp()).body;
    expect(s1.app).toMatchObject({
      clientId: CLIENT_ID,
      secretFound: false,
      youtubeAudited: false,
    });
    expect(
      (
        await http
          .post(`${G}/oauth/start`)
          .set(as())
          .send({ services: ['youtube'] })
          .expect(409)
      ).body.error.code,
    ).toBe('GOOGLE_SECRET_MISSING');
    await http
      .post('/api/v1/secrets')
      .set(as())
      .send({ name: 'google.client_secret', value: CLIENT_SECRET })
      .expect(201);
    await http
      .post(`${G}/oauth/start`)
      .set(as(memberToken))
      .send({ services: ['youtube'] })
      .expect(403);
    await http
      .post(`${G}/oauth/start`)
      .set(as())
      .send({ services: ['gmail'] })
      .expect(400);
  });

  it('signs in through Google with PKCE and a one-time state, asking for YouTube only', async () => {
    const { url } = (
      await http
        .post(`${G}/oauth/start`)
        .set(as())
        .send({ services: ['youtube'] })
        .expect(200)
    ).body;
    const u = new URL(url);
    expect(u.pathname).toBe('/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      access_type: 'offline',
      include_granted_scopes: 'true',
      code_challenge_method: 'S256',
      scope: `openid email profile ${READ} ${UPLOAD}`,
    });
    expect(u.searchParams.get('redirect_uri')).toMatch(/\/google\/callback$/);
    google.challenge = u.searchParams.get('code_challenge')!;
    const state = u.searchParams.get('state')!;
    await http
      .post(`${G}/oauth/callback`)
      .set(as())
      .send({ code: 'good-code', state: state.replace(/.$/, state.endsWith('A') ? 'B' : 'A') })
      .expect(400);
    const s = (
      await http
        .post(`${G}/oauth/callback`)
        .set(as())
        .send({ code: 'good-code', state })
        .expect(200)
    ).body;
    // The state works once.
    await http.post(`${G}/oauth/callback`).set(as()).send({ code: 'good-code', state }).expect(400);
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0]).toMatchObject({
      email: 'kenh@example.com',
      name: 'Kênh Tú',
      status: 'active',
      features: [
        { key: 'youtube_read', ready: true },
        { key: 'youtube_upload', ready: true },
      ],
    });
    expect(s.channels.map((c: { channelId: string }) => c.channelId).sort()).toEqual([CH1, CH2]);
    const c1 = s.channels.find((c: { channelId: string }) => c.channelId === CH1);
    expect(c1).toMatchObject({
      title: 'Tú Review',
      customUrl: '@tureview',
      subscribers: 1200,
      enabled: true,
      longUploads: 'allowed',
    });
    ch.one = c1.id;
    ch.two = s.channels.find((c: { channelId: string }) => c.channelId === CH2).id;

    // The refresh token is sealed; no token or secret is in the call log.
    const [row] = await db`SELECT refresh_token_sealed FROM google.connections`;
    expect(row!.refresh_token_sealed).toMatch(/^v1\./);
    expect(row!.refresh_token_sealed).not.toContain(REFRESH);
    const calls = JSON.stringify(await db`SELECT * FROM integration.api_calls`);
    for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, 'good-code'])
      expect(calls).not.toContain(secret);
    const log = (await http.get(`${G}/calls`).set(as()).expect(200)).body as {
      path: string;
      units: number;
    }[];
    expect(log.find((c) => c.path === '/youtube/v3/channels')!.units).toBe(1);
    expect(
      (await db`SELECT action FROM security.audit_logs WHERE action = 'google.connected'`).length,
    ).toBe(1);
  });

  it('turns channels on and off, for google.manage only', async () => {
    await http
      .patch(`${G}/channels/${ch.two}`)
      .set(as(memberToken))
      .send({ enabled: false })
      .expect(403);
    const r = (
      await http.patch(`${G}/channels/${ch.two}`).set(as()).send({ enabled: false }).expect(200)
    ).body;
    expect(r).toMatchObject({ enabled: false, connectionEmail: 'kenh@example.com' });
    expect(
      (await schedule({ itemId: item.wide, channelIds: [ch.two] }).expect(409)).body.error.code,
    ).toBe('YOUTUBE_CHANNEL_OFF');
  });

  it('checks the item, the metadata and the format before anything goes to YouTube', async () => {
    await schedule({ itemId: item.wide, channelIds: [ch.one] }, memberToken).expect(403);
    expect(
      (await schedule({ itemId: item.text, channelIds: [ch.one] }).expect(400)).body.error.code,
    ).toBe('YOUTUBE_NOT_VIDEO');
    expect(
      (await schedule({ itemId: item.wide, channelIds: [ch.one], format: 'short' }).expect(400))
        .body.error.code,
    ).toBe('YOUTUBE_SHORT');
    expect(
      (await schedule({ itemId: item.wide, channelIds: [ch.one], title: 'Giảm <50%>' }).expect(400))
        .body.error.code,
    ).toBe('YOUTUBE_METADATA');
    // Made for kids is required (YouTube's and the law's question).
    await http
      .post(`${G}/youtube/uploads`)
      .set(as())
      .send({ itemId: item.wide, channelIds: [ch.one], title: 'x' })
      .expect(400);
    // An unaudited project cannot schedule a public video: YouTube would keep it private.
    expect(
      (
        await schedule({
          itemId: item.wide,
          channelIds: [ch.one],
          at: new Date(Date.now() + 2 * 86400_000).toISOString(),
        }).expect(409)
      ).body.error.code,
    ).toBe('YOUTUBE_NOT_AUDITED');
    expect(
      (
        await schedule({
          itemId: item.wide,
          channelIds: [ch.one],
          thumbnailItemId: item.text,
        }).expect(400)
      ).body.error.code,
    ).toBe('YOUTUBE_THUMBNAIL');
    // A quota too small for one upload.
    await setApp({ youtubeQuota: 1000 });
    expect(
      (await schedule({ itemId: item.wide, channelIds: [ch.one] }).expect(409)).body.error.code,
    ).toBe('GOOGLE_QUOTA');
    await setApp();
    expect(await db`SELECT 1 FROM google.youtube_uploads`).toHaveLength(0);
    expect(google.of('POST', /^\/upload\//)).toHaveLength(0);
  });

  it('uploads with a resumable session, goes on after a cut, sets the thumbnail and waits for processing', async () => {
    const [u] = (
      await schedule({
        itemId: item.wide,
        channelIds: [ch.one],
        tags: ['áo thun', 'review'],
        categoryId: '26',
        syntheticMedia: true,
        thumbnailItemId: item.thumb,
      }).expect(201)
    ).body;
    expect(u).toMatchObject({
      status: 'scheduled',
      privacy: 'public',
      channelTitle: 'Tú Review',
      format: 'video',
      syntheticMedia: true,
    });
    // Not audited: MARIS says the video will stay private.
    expect(u.warnings.join(' ')).toMatch(/chưa được YouTube xét duyệt/);
    expect(
      (await schedule({ itemId: item.wide, channelIds: [ch.one] }).expect(409)).body.error.code,
    ).toBe('YOUTUBE_DUPLICATE');

    google.cutNextUpload = true;
    expect(await uploader.runOnce()).toBe(1);
    const [init] = google.of('POST', /^\/upload\/youtube\/v3\/videos$/);
    expect(init!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(init!.headers['x-upload-content-type']).toBe('video/mp4');
    const meta = JSON.parse(init!.raw.toString());
    expect(meta).toEqual({
      snippet: {
        title: 'Review áo thun',
        description: 'Áo cotton 100%.',
        tags: ['áo thun', 'review'],
        categoryId: '26',
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: true,
      },
    });
    let now = await one(u.id);
    expect(now).toMatchObject({ status: 'uploading', errorCode: 'GOOGLE_NETWORK', attempts: 1 });
    const [st] = await db`SELECT stage FROM google.youtube_uploads WHERE id = ${u.id}`;
    // The session address is sealed in the database.
    expect(JSON.stringify(st!.stage)).not.toContain('upload_id');

    await dueNow();
    expect(await uploader.runOnce()).toBe(1);
    // It asked the session how much arrived and sent only the rest; no second session.
    expect(google.of('POST', /^\/upload\/youtube\/v3\/videos$/)).toHaveLength(1);
    const puts = google.of('PUT', /^\/upload\/youtube\/v3\/videos$/);
    const size = google.sessions.get('s1')!.size;
    expect(puts.map((p) => p.headers['content-range'])).toEqual([
      undefined,
      `bytes */${size}`,
      `bytes ${size / 2}-${size - 1}/${size}`,
    ]);
    expect(google.of('POST', /thumbnails\/set$/)).toHaveLength(1);
    expect(google.of('POST', /thumbnails\/set$/)[0]!.params['videoId']).toBe(VIDEO_ID);
    now = await one(u.id);
    expect(now).toMatchObject({ status: 'processing', videoId: VIDEO_ID });

    google.processed = true;
    await dueNow();
    expect(await uploader.runOnce()).toBe(1);
    now = await one(u.id);
    expect(now).toMatchObject({
      status: 'published',
      videoId: VIDEO_ID,
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      youtubePrivacy: 'private',
    });
    const item1 = (await http.get(`${C}/items/${item.wide}`).set(as()).expect(200)).body;
    expect(item1).toMatchObject({
      status: 'published',
      publishedUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });
    // Units: the upload (1600), the thumbnail (50), status reads and the channel list.
    const q = (await http.get(G).set(as()).expect(200)).body.quota;
    expect(q.used).toBeGreaterThanOrEqual(1652);
    expect(q.used).toBeLessThan(1700);
    const actions = (
      await db`SELECT action FROM security.audit_logs WHERE target_id = ${u.id}`
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'google.youtube_scheduled',
        'google.youtube_uploaded',
        'google.youtube_published',
      ]),
    );
  });

  it('schedules a public video with publishAt once the project is audited, and Shorts from vertical videos', async () => {
    await setApp({ youtubeAudited: true });
    const at = new Date(Date.now() + 3 * 86400_000);
    at.setUTCSeconds(0, 0);
    const [u] = (
      await schedule({
        itemId: item.tall,
        channelIds: [ch.one],
        format: 'short',
        at: at.toISOString(),
        thumbnailItemId: item.thumb,
      }).expect(201)
    ).body;
    expect(u).toMatchObject({ format: 'short', publishAt: at.toISOString(), warnings: [] });
    google.thumbnailForbidden = true;
    await uploader.runOnce();
    const init = google.of('POST', /^\/upload\/youtube\/v3\/videos$/).at(-1)!;
    expect(JSON.parse(init.raw.toString()).status).toEqual({
      privacyStatus: 'private',
      publishAt: at.toISOString(),
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    });
    await dueNow();
    await uploader.runOnce();
    const now = await one(u.id);
    expect(now).toMatchObject({
      status: 'published',
      url: `https://www.youtube.com/shorts/${VIDEO_ID}`,
    });
    // Scheduled at YouTube: private until then is expected, so no warning about it. A refused
    // thumbnail is only a warning: the video is there.
    expect(now.warnings).toHaveLength(1);
    expect((now.warnings as string[])[0]).toMatch(/không nhận ảnh bìa/);

    // Unlisted videos cannot be scheduled.
    expect(
      (
        await schedule({
          itemId: item.second,
          channelIds: [ch.one],
          privacy: 'unlisted',
          at: at.toISOString(),
        }).expect(400)
      ).body.error.code,
    ).toBe('YOUTUBE_SCHEDULE_PRIVACY');
  });

  it('waits for the next quota day when Google says the quota is used up', async () => {
    google.fail['POST /upload/youtube/v3/videos'] = {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'The request cannot be completed because you have exceeded your quota.',
          errors: [{ reason: 'quotaExceeded' }],
        },
      },
    };
    const [u] = (await schedule({ itemId: item.second, channelIds: [ch.one] }).expect(201)).body;
    await uploader.runOnce();
    const [row] =
      await db`SELECT status, attempts, next_attempt_at FROM google.youtube_uploads WHERE id = ${u.id}`;
    expect(row).toMatchObject({ status: 'scheduled', attempts: 0 });
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    const q = (await http.get(G).set(as()).expect(200)).body.quota;
    expect(q.state).toBe('blocked');
    // Nothing else goes to YouTube while Google's stop lasts.
    const before = google.hits.length;
    await http.post(`${G}/sync`).set(as()).expect(429);
    expect(google.hits.length).toBe(before);
    delete google.fail['POST /upload/youtube/v3/videos'];
    await redis.del(`google:block:${tenantId}:youtube`);
    expect(
      (await http.post(`${G}/youtube/uploads/${u.id}/cancel`).set(as()).expect(200)).body.status,
    ).toBe('cancelled');
  });

  it('marks the account for reconnecting when Google revokes it, then disconnects', async () => {
    google.revoked = true;
    expect((await http.post(`${G}/sync`).set(as()).expect(409)).body.error.code).toBe(
      'GOOGLE_TOKEN_INVALID',
    );
    let s = (await http.get(G).set(as()).expect(200)).body;
    expect(s.connections[0]).toMatchObject({ status: 'invalid' });
    expect(s.connections[0].features.every((f: { ready: boolean }) => !f.ready)).toBe(true);
    expect(
      (await schedule({ itemId: item.third, channelIds: [ch.one] }).expect(409)).body.error.code,
    ).toBe('GOOGLE_NOT_CONNECTED');

    await http.delete(`${G}/connections/${s.connections[0].id}`).set(as(memberToken)).expect(403);
    s = (await http.delete(`${G}/connections/${s.connections[0].id}`).set(as()).expect(200)).body;
    expect(s.connections).toEqual([]);
    expect(s.channels).toEqual([]);
    expect(google.of('POST', /^\/revoke$/)).toHaveLength(1);
    const [row] = await db`SELECT status, refresh_token_sealed FROM google.connections`;
    expect(row).toMatchObject({ status: 'removed', refresh_token_sealed: null });
    expect(await db`SELECT 1 FROM google.channels WHERE enabled`).toHaveLength(0);
  });
});
