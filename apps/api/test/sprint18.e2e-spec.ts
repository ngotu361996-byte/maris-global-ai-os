import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner18@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ cửa hàng',
  tenantName: 'Công ty Hình ảnh',
};

// The start of a PNG whose header says 1080×1080 (the size the quality checks read); a different
// tail gives each upload its own content hash.
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000004380000043808060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082';
const png = (tag: string) => Buffer.concat([Buffer.from(PNG_HEX, 'hex'), Buffer.from(tag)]);

const beat = (capabilities: string[]) => ({
  cpuPct: 10,
  ramUsedMb: 4000,
  ramTotalMb: 16000,
  diskUsedGb: 100,
  diskTotalGb: 500,
  gpus: [],
  cpuTempC: null,
  capabilities,
});

describe('Sprint 18 (e2e): image processing on a Media Worker', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const as = () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId });
  const C = '/api/v1/content';
  const agent = (key: string) => ({ 'X-Maris-Device': key });
  const upload = (
    path: string,
    name: string,
    data: Buffer,
    headers: Record<string, string> = as(),
  ) =>
    http
      .post(path)
      .set(headers)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(name))
      .send(data);
  const claim = async (key: string) =>
    (await http.post('/api/v1/agent/jobs/claim').set(agent(key)).send({}).expect(200)).body.job;
  const ids = { photo: '', logo: '', banned: '', text: '', job: '' };
  const MEDIA = { id: '', key: '' };
  const PC = { id: '', key: '' };

  async function device(name: string, kind: string, caps: string[]) {
    const c = (await http.post('/api/v1/devices').set(as()).send({ name, kind }).expect(201)).body;
    const p = (
      await http
        .post('/api/v1/agent/pair')
        .send({ pairing: c.pairing, info: { hostname: name } })
        .expect(200)
    ).body;
    await http.post('/api/v1/agent/heartbeat').set(agent(p.token)).send(beat(caps)).expect(200);
    return { id: c.device.id as string, key: p.token as string };
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    ids.photo = (
      await upload(`${C}/assets/upload?rightsStatus=owned&title=Áo thun trắng`, 'ao.png', png('a'))
    ).body.id;
    ids.logo = (
      await upload(`${C}/assets/upload?rightsStatus=owned`, 'logo.png', png('b'))
    ).body.id;
    ids.banned = (
      await upload(`${C}/assets/upload?rightsStatus=restricted`, 'x.png', png('c'))
    ).body.id;
    ids.text = (
      await http
        .post(`${C}/assets`)
        .set(as())
        .send({ title: 'Ghi chú', kind: 'text', body: 'Nội dung' })
        .expect(201)
    ).body.id;
    Object.assign(MEDIA, await device('MEDIA-01', 'media_worker', ['diagnostics', 'media.image']));
    Object.assign(PC, await device('PC-02', 'staff_pc', ['diagnostics']));
  });

  afterAll(async () => {
    await app.close();
  });

  it('queues an image job only from the library, for a usable image and logo', async () => {
    const run = (id: string, body: object) =>
      http.post(`${C}/assets/${id}/process-image`).set(as()).send(body);
    const presets = ['feed_square'];
    expect((await run(ids.text, { presets }).expect(400)).body.error.code).toBe('MEDIA_NOT_IMAGE');
    expect((await run(ids.banned, { presets }).expect(400)).body.error.code).toBe(
      'MEDIA_RIGHTS_RESTRICTED',
    );
    expect(
      (await run(ids.photo, { presets, logoAssetId: ids.photo }).expect(400)).body.error.code,
    ).toBe('MEDIA_LOGO_INVALID');
    expect(
      (await run(ids.photo, { presets, logoAssetId: ids.banned }).expect(400)).body.error.code,
    ).toBe('MEDIA_RIGHTS_RESTRICTED');
    await run(ids.photo, { presets: [] }).expect(400);
    await run(ids.photo, { presets: ['poster'] }).expect(400);
    await run(ids.photo, { presets, logo: { sizePct: 90 } }).expect(400);

    // Not from the jobs screen, where the image's rights are not checked.
    const direct = await http
      .post('/api/v1/worker-jobs')
      .set(as())
      .send({ kind: 'media.image', input: { assetId: ids.photo, presets } })
      .expect(400);
    expect(direct.body.error.code).toBe('JOB_KIND_INTERNAL');

    const job = (
      await run(ids.photo, {
        presets: ['feed_square', 'thumbnail', 'feed_square'],
        logoAssetId: ids.logo,
        logo: { position: 'top-left', opacity: 0.8 },
        format: 'png',
      }).expect(202)
    ).body;
    ids.job = job.id;
    expect(job).toMatchObject({
      status: 'queued',
      presets: ['feed_square', 'thumbnail'],
      logoAssetId: ids.logo,
      createdByName: 'Chủ cửa hàng',
      outputs: [],
    });
    const list = (await http.get(`${C}/assets/${ids.photo}/media-jobs`).set(as()).expect(200)).body;
    expect(list.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect(list.workers).toEqual([{ id: MEDIA.id, name: 'MEDIA-01', online: true }]);
  });

  it('gives the job only to a worker that can process images, with only its own files', async () => {
    expect(await claim(PC.key)).toBeNull();
    const job = await claim(MEDIA.key);
    expect(job).toMatchObject({
      id: ids.job,
      kind: 'media.image',
      input: { assetId: ids.photo, logoAssetId: ids.logo, presets: ['feed_square', 'thumbnail'] },
    });

    const file = (assetId: string, key?: string) => {
      const r = http.get(`/api/v1/agent/jobs/${ids.job}/files/${assetId}`);
      return key ? r.set(agent(key)) : r;
    };
    const got = await file(ids.photo, MEDIA.key).buffer(true).expect(200);
    expect(Buffer.compare(got.body as Buffer, png('a'))).toBe(0);
    expect(got.headers['content-security-policy']).toContain('sandbox');
    await file(ids.logo, MEDIA.key).expect(200);
    await file(ids.text, MEDIA.key).expect(404);
    await file(ids.banned, MEDIA.key).expect(404);
    expect((await file(ids.photo, PC.key).expect(403)).body.error.code).toBe(
      'JOB_NOT_RUNNING_HERE',
    );
    await file(ids.photo).expect(401);
  });

  it('saves each output once as a new image item traced to the image, logo and job', async () => {
    const out = (preset: string, data: Buffer, key = MEDIA.key) =>
      upload(
        `/api/v1/agent/jobs/${ids.job}/outputs?preset=${preset}`,
        `${preset}.png`,
        data,
        agent(key),
      );
    expect((await out('story', png('d')).expect(400)).body.error.code).toBe(
      'MEDIA_PRESET_NOT_IN_JOB',
    );
    expect((await out('feed_square', Buffer.from('<svg/>')).expect(415)).body.error.code).toBe(
      'FILE_TYPE_NOT_ALLOWED',
    );
    expect(
      (await out('feed_square', Buffer.from('%PDF-1.4 tài liệu')).expect(415)).body.error.code,
    ).toBe('MEDIA_OUTPUT_NOT_IMAGE');
    await out('feed_square', png('e'), PC.key).expect(403);

    const square = (await out('feed_square', png('e')).expect(201)).body;
    expect(square.duplicate).toBe(false);
    // A resend (e.g. after a lost answer) returns the same item.
    expect((await out('feed_square', png('e2')).expect(201)).body).toEqual({
      itemId: square.itemId,
      duplicate: true,
    });
    const thumb = (await out('thumbnail', png('f')).expect(201)).body;
    expect(thumb.itemId).not.toBe(square.itemId);

    const item = (await http.get(`${C}/items/${square.itemId}`).set(as()).expect(200)).body;
    expect(item).toMatchObject({
      title: 'Áo thun trắng · Vuông 1:1',
      kind: 'image',
      status: 'draft',
      currentVersion: 1,
      tags: ['media-worker', 'feed_square'],
      approvalBlockers: [],
    });
    expect(item.versions[0]).toMatchObject({
      version: 1,
      workerJobId: ids.job,
      file: { name: 'feed_square.png', mime: 'image/png' },
    });
    expect(item.versions[0].note).toContain('Media Worker MEDIA-01');
    expect(item.versions[0].sources.map((s: { id: string }) => s.id)).toEqual([
      ids.photo,
      ids.logo,
    ]);
    // The new item is approved like any other content.
    await http.post(`${C}/items/${square.itemId}/submit`).set(as()).expect(200);
    await http.post(`${C}/items/${square.itemId}/approve`).set(as()).send({}).expect(200);

    await http
      .post(`/api/v1/agent/jobs/${ids.job}/finish`)
      .set(agent(MEDIA.key))
      .send({ status: 'completed', result: { outputs: [] } })
      .expect(200);
    expect((await out('thumbnail', png('g')).expect(403)).body.error.code).toBe(
      'JOB_NOT_RUNNING_HERE',
    );
    await http
      .get(`/api/v1/agent/jobs/${ids.job}/files/${ids.photo}`)
      .set(agent(MEDIA.key))
      .expect(403);

    const list = (await http.get(`${C}/assets/${ids.photo}/media-jobs`).set(as()).expect(200)).body;
    expect(list.jobs[0]).toMatchObject({ status: 'completed', deviceName: 'MEDIA-01' });
    expect(list.jobs[0].outputs).toEqual([
      {
        preset: 'feed_square',
        kind: 'image',
        itemId: square.itemId,
        title: 'Áo thun trắng · Vuông 1:1',
        status: 'approved',
      },
      {
        preset: 'thumbnail',
        kind: 'image',
        itemId: thumb.itemId,
        title: 'Áo thun trắng · Thumbnail',
        status: 'draft',
      },
    ]);

    const sql = admin();
    const audit = await sql`SELECT action, actor_user_id, metadata FROM security.audit_logs
      WHERE action LIKE 'content.media.%' ORDER BY created_at`;
    await sql.end();
    expect(audit.map((a) => a.action)).toEqual([
      'content.media.requested',
      'content.media.output_saved',
      'content.media.output_saved',
    ]);
    expect(audit[1]!.metadata).toMatchObject({
      jobId: ids.job,
      deviceId: MEDIA.id,
      preset: 'feed_square',
    });
    expect(audit[1]!.actor_user_id).toBeTruthy();
  });

  it('cannot retry an image job from the jobs screen, and cancels it from the library', async () => {
    const retry = await http
      .post(`/api/v1/worker-jobs/${ids.job}/retry`)
      .set(as())
      .send({})
      .expect(400);
    expect(retry.body.error.code).toBe('JOB_KIND_INTERNAL');

    const job = (
      await http
        .post(`${C}/assets/${ids.photo}/process-image`)
        .set(as())
        .send({ presets: ['story'], targetDeviceId: MEDIA.id })
        .expect(202)
    ).body;
    const cancelled = (await http.post(`${C}/media-jobs/${job.id}/cancel`).set(as()).expect(200))
      .body;
    expect(cancelled).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(await claim(MEDIA.key)).toBeNull();

    const other = (
      await http
        .post('/api/v1/worker-jobs')
        .set(as())
        .send({ kind: 'test.wait', input: { seconds: 1 } })
        .expect(201)
    ).body;
    await http.post(`${C}/media-jobs/${other.id}/cancel`).set(as()).expect(404);
  });
});
