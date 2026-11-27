import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner16@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ cửa hàng',
  tenantName: 'Công ty Nội dung',
};

// A tiny but valid PNG and an MP4 header: the server detects types from the bytes.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);
const MP4 = Buffer.concat([
  Buffer.from('0000001c667479706d703432000000006d7034316d70343269736f6d', 'hex'),
  Buffer.alloc(200_000, 7),
]);

describe('Sprint 16 (e2e): content libraries', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const as = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });
  const C = '/api/v1/content';
  const upload = (path: string, name: string, data: Buffer) =>
    http
      .post(path)
      .set(as())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(name))
      .send(data);
  const ids = { video: '', image: '', product: '', unknown: '', item: '' };

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

  it('stores uploaded originals with their detected type, hash, source and rights, and refuses duplicates', async () => {
    const folder = (
      await http
        .post(`${C}/folders`)
        .set(as())
        .send({ library: 'source', name: 'Áo thun hè' })
        .expect(201)
    ).body;
    await http
      .post(`${C}/folders`)
      .set(as())
      .send({ library: 'source', name: 'áo THUN hè' })
      .expect(409);

    const v = (
      await upload(
        `${C}/assets/upload?folderId=${folder.id}&rightsStatus=owned&tags=ao%20thun,Review,review`,
        'quay-san-pham.mp4',
        MP4,
      ).expect(201)
    ).body;
    ids.video = v.id;
    expect(v).toMatchObject({
      title: 'quay-san-pham',
      kind: 'video',
      folderId: folder.id,
      source: 'upload',
      rightsStatus: 'owned',
      usable: true,
      tags: ['ao thun', 'review'],
      file: {
        name: 'quay-san-pham.mp4',
        mime: 'video/mp4',
        sizeBytes: MP4.length,
        sha256: createHash('sha256').update(MP4).digest('hex'),
      },
      createdByName: 'Chủ cửa hàng',
    });

    // Same bytes under another name: refused, pointing at the original.
    const dup = await upload(`${C}/assets/upload`, 'ban-sao.mp4', MP4).expect(409);
    expect(dup.body.error.code).toBe('CONTENT_DUPLICATE');
    expect(dup.body.error.message).toContain('quay-san-pham');

    // The browser's claim does not matter; HTML or an executable named .png is refused.
    const html = await upload(
      `${C}/assets/upload`,
      'trang.png',
      Buffer.from('<html><script>alert(1)</script>'),
    ).expect(415);
    expect(html.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    await http
      .post(`${C}/assets/upload`)
      .set(as())
      .set('Content-Type', 'application/json')
      .send({})
      .expect(400);

    const img = (
      await upload(`${C}/assets/upload?rightsStatus=unknown`, 'anh-mau.png', PNG).expect(201)
    ).body;
    ids.image = img.id;
    expect(img).toMatchObject({ kind: 'image', usable: false, rightsStatus: 'unknown' });

    // Downloads: media may be inline but is always sandboxed; the bytes are the original.
    const file = await http
      .get(`${C}/assets/${img.id}/file?inline=1`)
      .set(as())
      .buffer(true)
      .expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

    const list = (await http.get(`${C}/folders?library=source`).set(as()).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ name: 'Áo thun hè', count: 1 })]);
    await http.delete(`${C}/folders/${folder.id}`).set(as()).expect(409);
  });

  it('keeps product facts as written, lets an approver verify them, and never changes an original', async () => {
    const p = (
      await http
        .post(`${C}/assets`)
        .set(as())
        .send({
          title: 'Áo thun cotton MARIS',
          kind: 'product',
          product: {
            name: 'Áo thun cotton MARIS',
            sku: 'AT-01',
            price: 199000,
            currency: 'VND',
            specs: [{ key: 'Chất liệu', value: 'Cotton 100%' }],
          },
          rightsStatus: 'owned',
        })
        .expect(201)
    ).body;
    ids.product = p.id;
    expect(p).toMatchObject({ kind: 'product', verifiedAt: null, usable: true });
    await http
      .post(`${C}/assets`)
      .set(as())
      .send({ title: 'Bản sao', kind: 'product', product: p.product, rightsStatus: 'owned' })
      .expect(409);
    await http.post(`${C}/assets`).set(as()).send({ title: 'Trống', kind: 'text' }).expect(400);

    const v = (await http.post(`${C}/assets/${p.id}/verify`).set(as()).expect(200)).body;
    expect(v.verifiedByName).toBe('Chủ cửa hàng');
    await http.post(`${C}/assets/${ids.video}/verify`).set(as()).expect(400);

    // Only description, folder, tags and rights can change; the API ignores anything else...
    const upd = (
      await http
        .patch(`${C}/assets/${p.id}`)
        .set(as())
        .send({ description: 'Hàng chủ lực mùa hè', tags: ['hè'], body: 'đổi nội dung' })
        .expect(200)
    ).body;
    expect(upd).toMatchObject({ description: 'Hàng chủ lực mùa hè', tags: ['hè'], body: null });
    // ...and the database refuses it even when asked directly.
    const sql = admin();
    await expect(sql`UPDATE content.assets SET body = 'x' WHERE id = ${ids.video}`).rejects.toThrow(
      /cannot be changed/,
    );
    await sql.end();

    const found = (await http.get(`${C}/assets?q=cotton`).set(as()).expect(200)).body;
    expect(found.map((a: { id: string }) => a.id)).toEqual([p.id]);
    expect((await http.get(`${C}/assets?tag=review`).set(as()).expect(200)).body).toHaveLength(1);
    expect((await http.get(`${C}/assets?q=%25`).set(as()).expect(200)).body).toHaveLength(0);
  });

  it('versions finished content, traces its sources and blocks approval on sources without rights', async () => {
    const item = (
      await http
        .post(`${C}/items`)
        .set(as())
        .send({
          title: 'Bài Facebook áo thun hè',
          kind: 'text',
          platform: 'facebook',
          language: 'vi',
          market: 'VN',
          body: 'Áo thun cotton 100%, mát cả mùa hè.',
          sourceAssetIds: [ids.product, ids.image],
          note: 'Bản đầu',
        })
        .expect(201)
    ).body;
    ids.item = item.id;
    expect(item).toMatchObject({ status: 'draft', currentVersion: 1 });
    expect(item.versions[0]).toMatchObject({
      version: 1,
      body: 'Áo thun cotton 100%, mát cả mùa hè.',
      note: 'Bản đầu',
      sources: expect.arrayContaining([
        expect.objectContaining({ id: ids.image, usable: false }),
        expect.objectContaining({ id: ids.product, usable: true }),
      ]),
    });
    expect(item.approvalBlockers).toEqual(['nguồn “anh-mau” chưa rõ quyền sử dụng']);

    await http.post(`${C}/items/${item.id}/approve`).set(as()).send({}).expect(409); // not in review
    await http.post(`${C}/items/${item.id}/submit`).set(as()).expect(200);
    const blocked = await http.post(`${C}/items/${item.id}/approve`).set(as()).send({}).expect(409);
    expect(blocked.body.error.code).toBe('CONTENT_RIGHTS_BLOCKED');

    // Rights confirmed, but only until yesterday: still blocked.
    await http
      .patch(`${C}/assets/${ids.image}`)
      .set(as())
      .send({
        rightsStatus: 'licensed',
        rightsExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .expect(200);
    const expired = await http.post(`${C}/items/${item.id}/approve`).set(as()).send({}).expect(409);
    expect(expired.body.error.message).toContain('đã hết hạn');
    await http
      .patch(`${C}/assets/${ids.image}`)
      .set(as())
      .send({ rightsExpiresAt: null })
      .expect(200);

    // A new version while in review sends it back to draft; v1 stays as it was.
    const v2 = (
      await http
        .post(`${C}/items/${item.id}/versions`)
        .set(as())
        .send({
          body: 'Áo thun cotton 100%. Mát, thấm hút, giá 199.000đ.',
          sourceAssetIds: [ids.product, ids.image],
        })
        .expect(201)
    ).body;
    expect(v2).toMatchObject({ status: 'draft', currentVersion: 2 });
    expect(v2.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(v2.versions[1].body).toBe('Áo thun cotton 100%, mát cả mùa hè.');

    await http.post(`${C}/items/${item.id}/submit`).set(as()).expect(200);
    const ok = (
      await http.post(`${C}/items/${item.id}/approve`).set(as()).send({ note: 'Được' }).expect(200)
    ).body;
    expect(ok).toMatchObject({
      status: 'approved',
      reviewedByName: 'Chủ cửa hàng',
      reviewNote: 'Được',
      approvalBlockers: [],
    });

    const pub = (
      await http
        .post(`${C}/items/${item.id}/publish`)
        .set(as())
        .send({ url: 'https://facebook.com/maris/posts/1' })
        .expect(200)
    ).body;
    expect(pub).toMatchObject({
      status: 'published',
      publishedUrl: 'https://facebook.com/maris/posts/1',
    });
    const locked = await http
      .post(`${C}/items/${item.id}/versions`)
      .set(as())
      .send({ body: 'sửa sau khi đăng' })
      .expect(409);
    expect(locked.body.error.code).toBe('CONTENT_STATE');

    // Lineage both ways: the asset knows which items use it.
    const used = (await http.get(`${C}/items?sourceAssetId=${ids.product}`).set(as()).expect(200))
      .body;
    expect(used.map((i: { id: string }) => i.id)).toEqual([item.id]);
    expect((await http.get(`${C}/assets/${ids.product}`).set(as()).expect(200)).body.usedBy).toBe(
      1,
    );
  });

  it('adds file versions to finished items and serves each version as stored', async () => {
    const item = (
      await http
        .post(`${C}/items`)
        .set(as())
        .send({ title: 'Reels áo thun 9:16', kind: 'video', platform: 'facebook' })
        .expect(201)
    ).body;
    expect(item).toMatchObject({ currentVersion: 0, approvalBlockers: ['chưa có phiên bản'] });
    await http.post(`${C}/items/${item.id}/submit`).set(as()).expect(409);
    const withFile = (
      await upload(
        `${C}/items/${item.id}/versions/upload?sourceAssetIds=${ids.video}&note=Bản%20dựng%201`,
        'reels.mp4',
        MP4,
      ).expect(201)
    ).body;
    expect(withFile.versions[0]).toMatchObject({
      version: 1,
      file: { mime: 'video/mp4', sizeBytes: MP4.length },
      note: 'Bản dựng 1',
    });
    const f = await http
      .get(`${C}/items/${item.id}/versions/1/file`)
      .set(as())
      .buffer(true)
      .expect(200);
    expect(f.headers['content-disposition']).toMatch(/^attachment/);
    expect((f.body as Buffer).length).toBe(MP4.length);
    await upload(`${C}/items/${item.id}/versions/upload?sourceAssetIds=nope`, 'x.mp4', MP4).expect(
      400,
    );
    await http.get(`${C}/items/${item.id}/versions/9/file`).set(as()).expect(404);
  });

  it('needs content permissions and audits every change', async () => {
    const sql = admin();
    await sql`DELETE FROM identity.role_permissions WHERE permission_key = 'content.approve'`;
    try {
      const it = (
        await http
          .post(`${C}/items`)
          .set(as())
          .send({ title: 'Thử quyền', kind: 'text', body: 'x' })
          .expect(201)
      ).body;
      await http.post(`${C}/items/${it.id}/submit`).set(as()).expect(200);
      const r = await http.post(`${C}/items/${it.id}/approve`).set(as()).send({}).expect(403);
      expect(r.body.error.code).toBe('PERMISSION_DENIED');
      await http.post(`${C}/assets/${ids.product}/verify`).set(as()).expect(403);
    } finally {
      await sql`INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
        SELECT tenant_id, id, 'content.approve' FROM identity.roles WHERE builtin AND key IN ('owner', 'administrator')`;
    }
    const roles =
      await sql`SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS perms
      FROM identity.roles r JOIN identity.role_permissions rp ON rp.role_id = r.id
      WHERE rp.permission_key LIKE 'content.%' GROUP BY r.key`;
    const perms = Object.fromEntries(roles.map((r) => [r.key, r.perms]));
    expect(perms).toEqual({
      owner: ['content.approve', 'content.manage', 'content.read'],
      administrator: ['content.approve', 'content.manage', 'content.read'],
      manager: ['content.manage', 'content.read'],
      member: ['content.read'],
    });
    const audit = await sql`SELECT action FROM security.audit_logs WHERE action LIKE 'content.%'`;
    await sql.end();
    const actions = new Set(audit.map((a) => a.action));
    for (const a of [
      'content.folder.created',
      'content.asset.created',
      'content.asset.updated',
      'content.asset.verified',
      'content.item.created',
      'content.item.version_added',
      'content.item.submitted',
      'content.item.approved',
      'content.item.published',
    ])
      expect(actions.has(a)).toBe(true);
    await http.get(`${C}/assets`).expect(401);
  });
});
