import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner20@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Người duyệt',
  tenantName: 'Công ty Kiểm định',
};

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

describe('Sprint 20 (e2e): automatic quality checks before review', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const as = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });
  const C = '/api/v1/content';
  const create = (body: object) =>
    http
      .post(`${C}/items`)
      .set(as())
      .send(body)
      .expect(201)
      .then((r) => r.body.id as string);
  const detail = async (id: string) =>
    (await http.get(`${C}/items/${id}`).set(as()).expect(200)).body;
  const uploadVersion = (id: string, name: string, data: Buffer) =>
    http
      .post(`${C}/items/${id}/versions/upload`)
      .set(as())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(name))
      .send(data);
  const ids = { claims: '', draft: '', clean: '', tags: '', photo: '', reel: '' };

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('checks a text and lets a warning through to the reviewer, who sees it', async () => {
    ids.claims = await create({
      title: 'Bài quảng cáo',
      kind: 'ad',
      language: 'vi',
      platform: 'facebook',
      body: 'Áo thun tốt nhất thị trường, cam kết hoàn tiền nếu không vừa ý. Đặt ngay hôm nay!',
    });
    const d = await detail(ids.claims);
    expect(d.qa).toMatchObject({ status: 'warning', version: 1 });
    expect(d.qa.checks.map((c: { code: string }) => c.code)).toEqual([
      'QA_RISKY_CLAIM',
      'QA_RISKY_CLAIM',
    ]);
    expect(d.qa.checks[0].message).toContain('tốt nhất');
    expect(d.approvalBlockers).toEqual([]);
    await http.post(`${C}/items/${ids.claims}/submit`).set(as()).expect(200);
    await http.post(`${C}/items/${ids.claims}/approve`).set(as()).send({}).expect(200);

    const sql = admin();
    const audit = await sql`SELECT action, metadata FROM security.audit_logs
      WHERE target_id = ${ids.claims} AND action IN ('content.item.submitted', 'content.item.approved')
      ORDER BY created_at`;
    await sql.end();
    expect(audit.map((a) => a.metadata.qa)).toEqual([
      { status: 'warning', codes: ['QA_RISKY_CLAIM'] },
      { status: 'warning', codes: ['QA_RISKY_CLAIM'] },
    ]);
  });

  it('does not send a version with errors for review, and a fixed version passes', async () => {
    ids.draft = await create({
      title: 'Bài nháp',
      kind: 'text',
      language: 'vi',
      platform: 'instagram',
      body: 'Áo thun mới về, giá chỉ [giá] nghìn. Liên hệ {{link}}',
    });
    const r = await http.post(`${C}/items/${ids.draft}/submit`).set(as()).expect(409);
    expect(r.body.error.code).toBe('CONTENT_QA_FAILED');
    expect(r.body.error.message).toContain('[giá]');
    expect((await detail(ids.draft)).approvalBlockers[0]).toContain('kiểm định: còn chỗ chưa điền');

    await http
      .post(`${C}/items/${ids.draft}/versions`)
      .set(as())
      .send({ body: 'Áo thun mới về, giá chỉ 199 nghìn. Nhắn tin cho shop để đặt nhé. #aothun' })
      .expect(201);
    expect((await detail(ids.draft)).qa).toEqual({ status: 'pass', version: 2, checks: [] });
    await http.post(`${C}/items/${ids.draft}/submit`).set(as()).expect(200);

    const tags = Array.from({ length: 31 }, (_, i) => `#the${i}`).join(' ');
    ids.tags = await create({
      title: 'Nhiều hashtag',
      kind: 'text',
      language: 'vi',
      platform: 'instagram',
      body: `Áo thun mùa hè cho cả nhà ${tags}`,
    });
    expect((await detail(ids.tags)).qa.checks[0]).toMatchObject({
      code: 'QA_HASHTAGS_TOO_MANY',
      level: 'error',
    });
    // The same text for the website has no hashtag limit.
    await http.patch(`${C}/items/${ids.tags}`).set(as()).send({ platform: 'website' }).expect(200);
    expect((await detail(ids.tags)).qa.status).toBe('pass');
  });

  it('reads the size and length of image and video files and checks them for the platform', async () => {
    ids.photo = await create({
      title: 'Ảnh nhỏ',
      kind: 'image',
      language: 'vi',
      platform: 'instagram',
    });
    await uploadVersion(ids.photo, 'nho.png', png(200, 200)).expect(201);
    let d = await detail(ids.photo);
    expect(d.versions[0].media).toEqual({ width: 200, height: 200, durationSec: null });
    expect(d.qa.checks).toEqual([
      {
        code: 'QA_TOO_SMALL',
        level: 'error',
        message: 'Ảnh 200×200 quá nhỏ (cạnh ngắn dưới 320 px)',
      },
    ]);
    expect(
      (await http.post(`${C}/items/${ids.photo}/submit`).set(as()).expect(409)).body.error.code,
    ).toBe('CONTENT_QA_FAILED');
    await uploadVersion(ids.photo, 'dep.png', png(1080, 1350)).expect(201);
    expect((await detail(ids.photo)).qa.status).toBe('pass');

    ids.reel = await create({
      title: 'Video TikTok',
      kind: 'video',
      language: 'vi',
      platform: 'tiktok',
    });
    await uploadVersion(ids.reel, 'ngang.mp4', mp4(1920, 1080, 30)).expect(201);
    d = await detail(ids.reel);
    expect(d.versions[0].media).toEqual({ width: 1920, height: 1080, durationSec: 30 });
    expect(d.qa).toMatchObject({
      status: 'warning',
      checks: [{ code: 'QA_RATIO', level: 'warning' }],
    });
    await uploadVersion(ids.reel, 'dai.mp4', mp4(1080, 1920, 700)).expect(201);
    expect((await detail(ids.reel)).qa.checks).toEqual([
      expect.objectContaining({ code: 'QA_TOO_LONG', level: 'error' }),
    ]);
    // A video whose index is at the end: its size is unknown, which does not block.
    await uploadVersion(
      ids.reel,
      'dien-thoai.mp4',
      Buffer.concat([mp4(1, 1, 1).subarray(0, 24), Buffer.from('mdat')]),
    ).expect(201);
    d = await detail(ids.reel);
    expect(d.qa.status).toBe('pass');
    expect(d.qa.checks.map((c: { level: string }) => c.level)).toEqual(['info', 'info']);
  });

  it('shows the check result of each item in the list', async () => {
    const list = (await http.get(`${C}/items`).set(as()).expect(200)).body as {
      id: string;
      qaStatus: string | null;
    }[];
    const status = Object.fromEntries(list.map((i) => [i.id, i.qaStatus]));
    expect(status).toEqual({
      [ids.claims]: 'warning',
      [ids.draft]: 'pass',
      [ids.tags]: 'pass',
      [ids.photo]: 'pass',
      [ids.reel]: 'pass',
    });
    const empty = await create({ title: 'Chưa viết', kind: 'text', language: 'vi' });
    expect(
      (
        (await http.get(`${C}/items`).set(as()).expect(200)).body as {
          id: string;
          qaStatus: unknown;
        }[]
      ).find((i) => i.id === empty)!.qaStatus,
    ).toBeNull();
  });
});
