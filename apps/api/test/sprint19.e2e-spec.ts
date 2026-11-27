import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeAi } from './fake-ai';
import { admin, resetDatabase, startApp } from './helpers';

const OWNER = {
  email: 'owner19@example.com',
  password: 'mat-khau-rat-dai-123',
  displayName: 'Chủ kênh',
  tenantName: 'Công ty Video',
};

// The first bytes of an MP4 file; a different tail gives each upload its own content hash.
const mp4 = (tag: string) =>
  Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex'), Buffer.from(tag)]);
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082';
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

describe('Sprint 19 (e2e): AI voice-over and video processing on a Media Worker', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let tenantId: string;
  const fake = new FakeAi();
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
  const ids = { script: '', english: '', photo: '', video: '', banned: '', logo: '' };
  const voices: string[] = [];
  let jobId = '';
  const VIDEO = { id: '', key: '' };
  const IMG = { id: '', key: '' };

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
  const item = (title: string, body?: string, language = 'vi') =>
    http
      .post(`${C}/items`)
      .set(as())
      .send({ title, kind: 'text', language, ...(body ? { body } : {}) })
      .expect(201)
      .then((r) => r.body.id as string);

  beforeAll(async () => {
    await resetDatabase();
    await fake.start();
    app = await startApp({ AI_ALLOW_PRIVATE_URLS: 'true', AI_RETRY_BASE_MS: '5' });
    http = request(app.getHttpServer());
    token = (await http.post('/api/v1/auth/bootstrap').send(OWNER).expect(201)).body.token;
    tenantId = (await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).body
      .memberships[0].tenantId;
    const secretRef = (
      await http
        .post('/api/v1/secrets')
        .set(as())
        .send({ name: 'fake.api_key', value: 'sk-fake-key-19' })
        .expect(201)
    ).body.reference;
    await http
      .post('/api/v1/ai/providers')
      .set(as())
      .send({
        name: 'A',
        kind: 'openai',
        baseUrl: `${fake.baseUrl}/a`,
        secretRef,
        defaultModel: 'A-model',
      })
      .expect(201);
    ids.script = await item('Kịch bản áo thun', 'Áo thun trắng, vải cotton, giá 199 nghìn.');
    ids.english = await item('T-shirt script', 'White cotton T-shirt.', 'en');
    ids.video = (
      await upload(`${C}/assets/upload?rightsStatus=owned&title=Quay áo thun`, 'ao.mp4', mp4('a'))
    ).body.id;
    ids.banned = (
      await upload(`${C}/assets/upload?rightsStatus=restricted`, 'x.mp4', mp4('b'))
    ).body.id;
    ids.photo = (await upload(`${C}/assets/upload?rightsStatus=owned`, 'a.png', png('a'))).body.id;
    ids.logo = (await upload(`${C}/assets/upload?rightsStatus=owned`, 'l.png', png('b'))).body.id;
    Object.assign(VIDEO, await device('MEDIA-02', 'media_worker', ['diagnostics', 'media.video']));
    Object.assign(IMG, await device('MEDIA-01', 'media_worker', ['diagnostics', 'media.image']));
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  it('reads a text aloud as a new audio item, taking turns between female and male voices', async () => {
    const speak = (id: string, body: object = {}) =>
      http.post(`${C}/items/${id}/voiceover`).set(as()).send(body);
    const first = (await speak(ids.script).expect(201)).body;
    expect(first).toMatchObject({ voice: 'nova', speed: 1, chars: 41 });
    const second = (await speak(ids.script).expect(201)).body;
    expect(second.voice).toBe('ash');
    voices.push(first.itemId, second.itemId);

    const call = fake.requests.filter((r) => r.path.endsWith('/audio/speech'));
    expect(call).toHaveLength(2);
    expect(call[0]!.headers.authorization).toBe('Bearer sk-fake-key-19');
    expect(call[0]!.body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: 'Áo thun trắng, vải cotton, giá 199 nghìn.',
      speed: 1,
      response_format: 'mp3',
    });
    expect(call[0]!.body.instructions).toContain('tiếng Việt');

    const audio = (await http.get(`${C}/items/${first.itemId}`).set(as()).expect(200)).body;
    expect(audio).toMatchObject({
      kind: 'audio',
      language: 'vi',
      status: 'draft',
      variantOf: ids.script,
      tags: ['ai-voice', 'nova'],
    });
    expect(audio.title).toBe('Kịch bản áo thun · Giọng đọc Nova');
    expect(audio.versions[0].file).toMatchObject({ mime: 'audio/mpeg' });
    expect(audio.versions[0].note).toContain('Nova');

    // English, a chosen voice, faster, with its own style.
    const en = (
      await speak(ids.english, {
        voice: 'onyx',
        speed: 1.5,
        style: 'Calm and warm',
        title: 'EN',
      }).expect(201)
    ).body;
    expect(en).toMatchObject({ voice: 'onyx', speed: 1.5, title: 'EN' });
    expect(fake.requests.at(-1)!.body.instructions).toBe(
      'Calm and warm Speak at a faster pace than usual.',
    );

    // What cannot be read.
    expect((await speak(voices[0]!).expect(400)).body.error.code).toBe('VOICE_NOT_TEXT');
    expect((await speak(await item('Trống')).expect(400)).body.error.code).toBe('VOICE_NO_TEXT');
    const long = await item('Dài', 'a'.repeat(4097));
    expect((await speak(long).expect(400)).body.error.code).toBe('VOICE_TEXT_TOO_LONG');
    await speak(ids.script, { voice: 'robot' }).expect(400);
    await speak(ids.script, { speed: 3 }).expect(400);

    // A provider error is reported and recorded, and makes no item.
    fake.modes.a = '500';
    expect((await speak(ids.script).expect(502)).body.error.code).toBe('VOICE_PROVIDER_ERROR');
    fake.modes.a = 'ok';

    const sql = admin();
    const calls = await sql`SELECT outcome, content_item_id, cost_usd, model FROM ai.provider_calls
      ORDER BY created_at`;
    const audit = await sql`SELECT action FROM security.audit_logs
      WHERE action = 'content.voiceover.created'`;
    await sql.end();
    expect(calls.map((c) => c.outcome)).toEqual(['ok', 'ok', 'ok', 'error']);
    expect(calls[0]).toMatchObject({ content_item_id: ids.script, model: 'gpt-4o-mini-tts' });
    expect(Number(calls[0]!.cost_usd)).toBeCloseTo(41 * 15e-6, 6);
    expect(audit).toHaveLength(3);
  });

  it('queues a video job only from the library, for a usable video, logo and voice-over', async () => {
    const run = (id: string, body: object) =>
      http.post(`${C}/assets/${id}/process-video`).set(as()).send(body);
    const presets = ['story'];
    expect((await run(ids.photo, { presets }).expect(400)).body.error.code).toBe('MEDIA_NOT_VIDEO');
    expect((await run(ids.banned, { presets }).expect(400)).body.error.code).toBe(
      'MEDIA_RIGHTS_RESTRICTED',
    );
    expect(
      (await run(ids.video, { presets, logoAssetId: ids.video }).expect(400)).body.error.code,
    ).toBe('MEDIA_NOT_IMAGE');
    expect(
      (await run(ids.video, { presets, voiceItemId: ids.script }).expect(400)).body.error.code,
    ).toBe('MEDIA_VOICE_INVALID');
    await run(ids.video, { presets: ['thumbnail'] }).expect(400);
    await run(ids.video, { presets, startSec: 10, endSec: 5 }).expect(400);
    await run(ids.video, { presets, voiceVersion: 1 }).expect(400);
    const direct = await http
      .post('/api/v1/worker-jobs')
      .set(as())
      .send({ kind: 'media.video', input: { assetId: ids.video, presets } })
      .expect(400);
    expect(direct.body.error.code).toBe('JOB_KIND_INTERNAL');

    const job = (
      await run(ids.video, {
        presets: ['story', 'feed_square'],
        logoAssetId: ids.logo,
        voiceItemId: voices[0],
        startSec: 2,
        endSec: 20,
        denoise: true,
        coverAtSec: 1,
      }).expect(202)
    ).body;
    jobId = job.id;
    expect(job).toMatchObject({
      kind: 'media.video',
      status: 'queued',
      presets: ['story', 'feed_square'],
      logoAssetId: ids.logo,
      voiceItemId: voices[0],
      outputs: [],
    });
    const list = (await http.get(`${C}/assets/${ids.video}/media-jobs`).set(as()).expect(200)).body;
    expect(list.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect(list.workers).toEqual([{ id: VIDEO.id, name: 'MEDIA-02', online: true }]);
    // The image page of a photo does not show video jobs.
    expect(
      (await http.get(`${C}/assets/${ids.photo}/media-jobs`).set(as()).expect(200)).body.jobs,
    ).toEqual([]);
  });

  it('gives the job to a worker with FFmpeg, with only its video, logo and voice-over', async () => {
    expect(await claim(IMG.key)).toBeNull();
    const job = await claim(VIDEO.key);
    expect(job).toMatchObject({
      id: jobId,
      kind: 'media.video',
      timeoutSec: 3600,
      input: { assetId: ids.video, voiceItemId: voices[0], voiceVersion: 1, startSec: 2 },
    });
    const get = (path: string, key = VIDEO.key) =>
      http.get(`/api/v1/agent/jobs/${jobId}/${path}`).set(agent(key));
    const video = await get(`files/${ids.video}`).buffer(true).expect(200);
    expect(Buffer.compare(video.body as Buffer, mp4('a'))).toBe(0);
    await get(`files/${ids.logo}`).expect(200);
    await get(`files/${ids.photo}`).expect(404);
    const voice = await get(`items/${voices[0]}`).buffer(true).expect(200);
    expect(voice.headers['content-type']).toBe('audio/mpeg');
    expect((voice.body as Buffer).toString('latin1')).toContain('nova');
    await get(`items/${voices[1]}`).expect(404);
    await get(`items/${ids.script}`).expect(404);
    expect((await get(`items/${voices[0]}`, IMG.key).expect(403)).body.error.code).toBe(
      'JOB_NOT_RUNNING_HERE',
    );
  });

  it('saves each video and the cover once, as new items traced to the video, logo and voice', async () => {
    const out = (preset: string, name: string, data: Buffer) =>
      upload(`/api/v1/agent/jobs/${jobId}/outputs?preset=${preset}`, name, data, agent(VIDEO.key));
    expect((await out('landscape', 'l.mp4', mp4('c')).expect(400)).body.error.code).toBe(
      'MEDIA_PRESET_NOT_IN_JOB',
    );
    expect((await out('story', 's.png', png('c')).expect(415)).body.error.code).toBe(
      'MEDIA_OUTPUT_NOT_VIDEO',
    );
    expect((await out('cover', 'c.mp4', mp4('d')).expect(415)).body.error.code).toBe(
      'MEDIA_OUTPUT_NOT_IMAGE',
    );
    const story = (await out('story', 'story-1080x1920.mp4', mp4('e')).expect(201)).body;
    expect(story.duplicate).toBe(false);
    expect((await out('story', 'story-1080x1920.mp4', mp4('e2')).expect(201)).body).toEqual({
      itemId: story.itemId,
      duplicate: true,
    });
    const cover = (await out('cover', 'story-cover.jpg', png('f')).expect(201)).body;

    const v = (await http.get(`${C}/items/${story.itemId}`).set(as()).expect(200)).body;
    expect(v).toMatchObject({
      title: 'Quay áo thun · Video Dọc 9:16',
      kind: 'video',
      status: 'draft',
      tags: ['media-worker', 'story'],
    });
    expect(v.versions[0]).toMatchObject({ workerJobId: jobId, file: { mime: 'video/mp4' } });
    expect(v.versions[0].note).toContain('cắt 0:02–0:20');
    expect(v.versions[0].note).toContain('giọng đọc “Kịch bản áo thun · Giọng đọc Nova”');
    expect(v.versions[0].note).toContain('giảm nhiễu');
    expect(v.versions[0].sources.map((s: { id: string }) => s.id)).toEqual([ids.video, ids.logo]);
    const c = (await http.get(`${C}/items/${cover.itemId}`).set(as()).expect(200)).body;
    expect(c).toMatchObject({ title: 'Quay áo thun · Ảnh bìa', kind: 'image' });

    const list = (await http.get(`${C}/assets/${ids.video}/media-jobs`).set(as()).expect(200)).body;
    expect(list.jobs[0].outputs).toEqual([
      { preset: 'story', kind: 'video', itemId: story.itemId, title: v.title, status: 'draft' },
      { preset: 'cover', kind: 'image', itemId: cover.itemId, title: c.title, status: 'draft' },
    ]);

    // A cover is only taken when the job asked for one.
    const plain = (
      await http
        .post(`${C}/assets/${ids.video}/process-video`)
        .set(as())
        .send({ presets: ['landscape'], targetDeviceId: VIDEO.id })
        .expect(202)
    ).body;
    await http
      .post(`/api/v1/agent/jobs/${jobId}/finish`)
      .set(agent(VIDEO.key))
      .send({ status: 'completed', result: { outputs: [] } })
      .expect(200);
    expect((await claim(VIDEO.key)).id).toBe(plain.id);
    expect(
      (
        await upload(
          `/api/v1/agent/jobs/${plain.id}/outputs?preset=cover`,
          'c.jpg',
          png('g'),
          agent(VIDEO.key),
        ).expect(400)
      ).body.error.code,
    ).toBe('MEDIA_PRESET_NOT_IN_JOB');
    const cancelled = (await http.post(`${C}/media-jobs/${plain.id}/cancel`).set(as()).expect(200))
      .body;
    expect(cancelled).toMatchObject({ id: plain.id, kind: 'media.video', cancelRequested: true });
  });
});
