import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heartbeatSchema, workerJobInputSchemas } from '@maris/contracts';
import { normalizeServer } from './config';
import { cpuPercent, parseNvidiaSmi, Sampler } from './metrics';

const noFiles = {
  download: () => Promise.reject(new Error('không có tệp')),
  upload: () => Promise.reject(new Error('không gửi tệp')),
  downloadTo: () => Promise.reject(new Error('không có tệp')),
  uploadFile: () => Promise.reject(new Error('không gửi tệp')),
};

test('parses nvidia-smi output, keeping unreadable values as null', () => {
  const gpus = parseNvidiaSmi(
    '0, NVIDIA GeForce RTX 4090, 37, 2048, 24564, 61\r\n1, Tesla T4, [N/A], 0, 15360, [N/A]\n\n',
  );
  assert.deepEqual(gpus, [
    {
      index: 0,
      name: 'NVIDIA GeForce RTX 4090',
      utilPct: 37,
      memUsedMb: 2048,
      memTotalMb: 24564,
      tempC: 61,
    },
    { index: 1, name: 'Tesla T4', utilPct: null, memUsedMb: 0, memTotalMb: 15360, tempC: null },
  ]);
  assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed'), []);
});

test('works out CPU use from two readings', () => {
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50);
  assert.equal(cpuPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 }), null);
});

test('accepts https anywhere and http only on this machine or the local network', () => {
  assert.equal(normalizeServer('https://maris.example.com'), 'https://maris.example.com/api/v1');
  assert.equal(normalizeServer('http://localhost:4000/api/v1/'), 'http://localhost:4000/api/v1');
  assert.equal(normalizeServer('http://192.168.1.20:4000'), 'http://192.168.1.20:4000/api/v1');
  assert.throws(() => normalizeServer('http://maris.example.com'), /https/);
  assert.throws(() => normalizeServer('ftp://x'), /https/);
  assert.throws(() => normalizeServer('https://u:p@maris.example.com'), /mật khẩu/);
  assert.equal(
    normalizeServer('http://maris.example.com', true),
    'http://maris.example.com/api/v1',
  );
});

test('a sample from this machine is accepted by the server schema', async () => {
  const s = new Sampler();
  await new Promise((r) => setTimeout(r, 100));
  const sample = await s.sample();
  assert.ok(heartbeatSchema.safeParse(sample).success);
  assert.ok((sample.ramTotalMb ?? 0) > 0);
});

test('the test job counts, reports progress, fails on request and stops when told', async () => {
  const { HANDLERS, JobError } = await import('./jobs');
  const reports: (number | undefined)[] = [];
  const ctx = (signal: AbortSignal) => ({
    signal,
    server: 'http://127.0.0.1:9',
    timeoutSec: 60,
    report: (p?: number) => reports.push(p),
    ...noFiles,
  });
  assert.deepEqual(await HANDLERS['test.wait']({ seconds: 1 }, ctx(new AbortController().signal)), {
    waitedSec: 1,
  });
  assert.deepEqual(reports, [100]);
  await assert.rejects(
    HANDLERS['test.wait']({ seconds: 1, fail: true }, ctx(new AbortController().signal)),
    (e: unknown) => e instanceof JobError && e.code === 'TEST_FAILURE',
  );
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  await assert.rejects(
    HANDLERS['test.wait']({ seconds: 30 }, ctx(c.signal)),
    (e: unknown) => e instanceof JobError && e.code === 'CANCELLED',
  );
  await assert.rejects(HANDLERS['test.wait']({ seconds: 1, command: 'whoami' }, ctx(c.signal)));
});

test('the machine check reports this machine and never fails when MARIS or a GPU is missing', async () => {
  const { HANDLERS, capabilities } = await import('./jobs');
  const r = (await HANDLERS.diagnostics(
    {},
    {
      signal: new AbortController().signal,
      server: 'http://127.0.0.1:9',
      timeoutSec: 60,
      report: () => {},
      ...noFiles,
    },
  )) as { hostname: string; ram: { totalMb: number }; latencyMs: number | null; gpus: unknown[] };
  assert.equal(typeof r.hostname, 'string');
  assert.ok(r.ram.totalMb > 0);
  assert.equal(r.latencyMs, null);
  assert.ok(Array.isArray(r.gpus));
  const caps = await capabilities({ allowCode: false });
  assert.ok(caps.includes('diagnostics') && caps.includes('test.wait'));
  assert.ok(!caps.includes('code.run'), 'code runs only when the owner adds --allow-code');
});

test('the sandbox runs code with no network, no capabilities, an unprivileged user and limits', async () => {
  const { sandboxArgs, sandboxPayload } = await import('./sandbox');
  const args = sandboxArgs('maris-sandbox-x', 'python');
  const pair = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm') && args.includes('--read-only'));
  assert.equal(pair('--network'), 'none');
  assert.equal(pair('--memory'), '256m');
  assert.equal(pair('--memory-swap'), '256m');
  assert.equal(pair('--pids-limit'), '64');
  assert.equal(pair('--cap-drop'), 'ALL');
  assert.equal(pair('--security-opt'), 'no-new-privileges');
  assert.equal(pair('--user'), '65534:65534');
  assert.ok(!args.some((a) => a.startsWith('-v') || a === '--volume' || a === '--mount'));
  assert.ok(!args.includes('--privileged'));
  // The code itself never goes on the command line.
  const code = 'print("secret-marker")';
  assert.ok(!sandboxArgs('n', 'node').some((a) => a.includes('secret-marker')));
  assert.equal(sandboxPayload(code, 'in').toString(), `${code.length}\n${code}in`);
  assert.equal(sandboxPayload('é', '').toString(), '2\né');
});

test('code runs in Docker, gets its stdin, has no network and is stopped at its time limit', async (t) => {
  const { dockerAvailable, runSandbox } = await import('./sandbox');
  if (!(await dockerAvailable())) return t.skip('Docker không chạy trên máy này');
  const signal = new AbortController().signal;
  const py = await runSandbox(
    {
      language: 'python',
      code: 'import sys, os\nprint(sys.stdin.read().upper())\nprint(os.getuid())\nsys.exit(3)',
      stdin: 'xin chào',
    },
    { signal, timeoutMs: 60_000 },
  );
  assert.equal(py.stdout, 'XIN CHÀO\n65534\n');
  assert.equal(py.exitCode, 3);
  const node = await runSandbox(
    {
      language: 'node',
      code: [
        "const input = require('fs').readFileSync(0, 'utf8');",
        "require('net').connect(80, '1.1.1.1').on('error', (e) => { console.log(input, e.code); });",
      ].join('\n'),
      stdin: '42',
    },
    { signal, timeoutMs: 60_000 },
  );
  assert.match(node.stdout, /^42 (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)/);
  assert.equal(node.exitCode, 0);
  const write = await runSandbox(
    { language: 'python', code: "open('/etc/x','w')", stdin: '' },
    { signal, timeoutMs: 60_000 },
  );
  assert.notEqual(write.exitCode, 0);
  assert.match(write.stderr, /Read-only|Permission denied/);
  const big = await runSandbox(
    { language: 'python', code: "print('x' * 100000)", stdin: '' },
    { signal, timeoutMs: 60_000 },
  );
  assert.equal(big.stdout.length, 32 * 1024);
  assert.ok(big.stdoutTruncated);
  const slow = await runSandbox(
    { language: 'python', code: 'while True: pass', stdin: '' },
    { signal, timeoutMs: 3000 },
  );
  assert.ok(slow.timedOut);
  assert.equal(slow.exitCode, null);
});

test('image jobs make each size, place the logo, strip location data and refuse SVG', async () => {
  const { loadSharp, renderImage } = await import('./image');
  const { HANDLERS, capabilities, JobError } = await import('./jobs');
  const sharp = await loadSharp();
  assert.ok(sharp, 'sharp loads on this machine');
  assert.ok((await capabilities({ allowCode: false })).includes('media.image'));

  // A 3000×2000 photo, rotated by its EXIF tag, with a GPS-like comment; and a red square logo.
  const photo = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#2050a0' },
  })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { ImageDescription: 'GPS 10.77,106.70' } } })
    .toBuffer();
  const logo = await sharp({
    create: { width: 200, height: 200, channels: 4, background: '#ff0000ff' },
  })
    .png()
    .toBuffer();
  const input = workerJobInputSchemas['media.image'].parse({
    assetId: '00000000-0000-7000-8000-000000000001',
    logoAssetId: '00000000-0000-7000-8000-000000000002',
    presets: ['feed_square', 'story', 'original'],
    logo: { position: 'top-left', sizePct: 10, opacity: 0.5, marginPct: 0 },
    format: 'png',
  });

  const square = await renderImage(sharp, photo, logo, 'feed_square', input);
  assert.deepEqual([square.width, square.height, square.ext], [1080, 1080, 'png']);
  const m = await sharp(square.data).metadata();
  assert.deepEqual([m.width, m.height, m.orientation, m.exif], [1080, 1080, undefined, undefined]);
  // The logo is 108 px wide at the top left, half transparent over the blue photo.
  const { data, info } = await sharp(square.data).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const near = (a: number[], b: number[], d: number) => a.every((v, i) => Math.abs(v - b[i]!) <= d);
  // Half red over #2050a0 is about (144, 40, 80).
  assert.ok(near(px(50, 50), [144, 40, 80], 6), `logo pixel ${px(50, 50)}`);
  assert.ok(near(px(200, 200), [32, 80, 160], 3), `photo pixel ${px(200, 200)}`);

  // The photo is upright (portrait) at its own size when "original" is chosen.
  const original = await renderImage(sharp, photo, null, 'original', { ...input, format: 'jpeg' });
  assert.deepEqual([original.width, original.height, original.ext], [2000, 3000, 'jpg']);
  const fitted = await renderImage(sharp, photo, null, 'landscape', {
    ...input,
    fit: 'contain',
    background: '#00ff00',
    format: 'webp',
  });
  assert.deepEqual([fitted.width, fitted.height, fitted.ext], [1920, 1080, 'webp']);
  assert.equal((await sharp(fitted.data).metadata()).format, 'webp');

  // Auto-level widens a dull image's tones around its own brightness and leaves a full range alone.
  const halves = await sharp({
    create: { width: 300, height: 200, channels: 3, background: '#7a7a7a' },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 150, height: 200, channels: 3, background: '#9a9a9a' },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const levelled = await renderImage(sharp, halves, null, 'original', {
    ...input,
    autoLevel: true,
  });
  const [lv] = (await sharp(levelled.data).stats()).channels;
  assert.ok(
    lv!.max - lv!.min > 32 + 8 && Math.abs((lv!.max + lv!.min) / 2 - 138) <= 2,
    `${lv!.min}-${lv!.max}`,
  );
  const full = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#000' } })
    .composite([
      {
        input: Buffer.from([255, 255, 255]),
        raw: { width: 1, height: 1, channels: 3 },
        left: 1,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const same = await renderImage(sharp, full, null, 'original', { ...input, autoLevel: true });
  assert.deepEqual(
    [...(await sharp(same.data).removeAlpha().raw().toBuffer())],
    [0, 0, 0, 255, 255, 255],
  );

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await assert.rejects(renderImage(sharp, svg, null, 'thumbnail', input), /không hỗ trợ/);

  // The handler fetches only the job's files and sends one image per size.
  const fetched: string[] = [];
  const sent: string[] = [];
  const result = (await HANDLERS['media.image'](
    { ...input, presets: ['thumbnail', 'feed_portrait'] },
    {
      signal: new AbortController().signal,
      server: 'http://127.0.0.1:9',
      timeoutSec: 600,
      report: () => {},
      ...noFiles,
      download: async (id) => {
        fetched.push(id);
        return id === input.assetId ? photo : logo;
      },
      upload: async (preset, name) => {
        sent.push(name);
        return { itemId: `item-${preset}` };
      },
    },
  )) as { outputs: { preset: string; itemId: string; width: number; height: number }[] };
  assert.deepEqual(fetched, [input.assetId, input.logoAssetId]);
  assert.deepEqual(sent, ['thumbnail-1280x720.png', 'feed_portrait-1080x1350.png']);
  assert.deepEqual(
    result.outputs.map((o) => [o.preset, o.itemId, o.width, o.height]),
    [
      ['thumbnail', 'item-thumbnail', 1280, 720],
      ['feed_portrait', 'item-feed_portrait', 1080, 1350],
    ],
  );
  await assert.rejects(
    HANDLERS['media.image'](
      { ...input, logoAssetId: null },
      {
        signal: new AbortController().signal,
        server: 'http://127.0.0.1:9',
        timeoutSec: 600,
        report: () => {},
        ...noFiles,
        download: async () => svg,
        upload: async () => ({ itemId: 'x' }),
      },
    ),
    (e: unknown) => e instanceof JobError && e.code === 'MEDIA_IMAGE_INVALID',
  );
});

test('video arguments crop or fit each size, place the logo and mix or replace the sound', async () => {
  const { videoArgs, cutRange, parseProbe, progressSec, coverArgs } = await import('./video');
  const input = workerJobInputSchemas['media.video'].parse({
    assetId: '00000000-0000-4000-8000-000000000001',
    logoAssetId: '00000000-0000-4000-8000-000000000002',
    voiceItemId: '00000000-0000-4000-8000-000000000003',
    voiceVersion: 1,
    presets: ['story', 'landscape', 'story'],
    logo: { position: 'top-left', sizePct: 20, opacity: 0.5 },
    startSec: 2,
    endSec: 12,
    denoise: true,
    sharpen: true,
  });
  assert.deepEqual(input.presets, ['story', 'landscape']);
  const probe = { durationSec: 30, width: 1920, height: 1080, hasAudio: true };
  const cut = cutRange(input, probe.durationSec, 3600);
  assert.deepEqual(cut, { start: 2, length: 10 });
  const plan = videoArgs({
    source: 'in.mp4',
    logo: 'logo.png',
    voice: 'voice.mp3',
    out: 'out.mp4',
    preset: 'story',
    probe,
    cut: cut as { start: number; length: number },
    input,
  });
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
  assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(graph, /hqdn3d/);
  assert.match(graph, /unsharp/);
  assert.match(
    graph,
    /\[1:v\]scale=216:768:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.5\[logo\]/,
  );
  assert.match(graph, /overlay=32:32/);
  assert.match(graph, /\[0:a\]volume=0.25\[orig\]/);
  assert.match(graph, /amix=inputs=2:duration=first/);
  assert.deepEqual(plan.args.slice(5, 11), ['-ss', '2', '-t', '10', '-i', 'in.mp4']);
  assert.ok(plan.args.includes('-map_metadata'));

  // Fit whole on a background, no logo, voice instead of the original sound.
  const fit = videoArgs({
    source: 'in.mp4',
    logo: null,
    voice: 'voice.mp3',
    out: 'out.mp4',
    preset: 'feed_square',
    probe,
    cut: { start: 0, length: 30 },
    input: { ...input, fit: 'contain', background: '#ffffff', voiceMix: 'replace', denoise: false },
  });
  const g2 = fit.args[fit.args.indexOf('-filter_complex') + 1]!;
  assert.match(g2, /pad=1080:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0xffffff/);
  assert.match(g2, /\[1:a\]apad\[a\]/);
  assert.doesNotMatch(g2, /0:a/);
  assert.doesNotMatch(g2, /hqdn3d/);

  // A silent video with no voice-over has no sound track.
  const silent = videoArgs({
    source: 'in.mp4',
    logo: null,
    voice: null,
    out: 'out.mp4',
    preset: 'original',
    probe: { durationSec: 5, width: 4000, height: 3001, hasAudio: false },
    cut: { start: 0, length: 5 },
    input,
  });
  assert.ok(silent.args.includes('-an'));
  assert.deepEqual([silent.width, silent.height], [3840, 2880]);

  assert.match(
    String(cutRange({ startSec: 40, endSec: null }, 30, 3600)),
    /sau khi video kết thúc/,
  );
  assert.match(String(cutRange({ startSec: 0, endSec: null }, 7200, 3600)), /dài hơn 60 phút/);
  assert.deepEqual(cutRange({ startSec: 5, endSec: 90 }, 30, 3600), { start: 5, length: 25 });

  // A phone video recorded upright is shown portrait.
  const turned = parseProbe(
    JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
      ],
      format: { duration: '12.5' },
    }),
  );
  assert.deepEqual(turned, { durationSec: 12.5, width: 1080, height: 1920, hasAudio: false });
  assert.throws(() => parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }] })), /hình/);
  assert.equal(progressSec('frame=10\nout_time_us=2500000\nout_time_ms=3000000\n'), 3);
  assert.equal(progressSec('frame=1\n'), null);
  assert.deepEqual(coverArgs('o.mp4', 99, 10, 'c.jpg').slice(5, 7), ['-ss', '9.9']);
});

test('video jobs run FFmpeg: cut, resize, logo, voice-over and a cover picture', async (t) => {
  const { findFfmpeg, probeVideo } = await import('./video');
  const ff = await findFfmpeg();
  if (!ff) return t.skip('FFmpeg is not installed on this machine');
  const { HANDLERS, JobError, capabilities } = await import('./jobs');
  const { loadSharp } = await import('./image');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, copyFileSync, writeFileSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.ok((await capabilities({ allowCode: false })).includes('media.video'));

  const dir = mkdtempSync(join(tmpdir(), 'maris-video-test-'));
  const src = join(dir, 'src.mp4');
  execFileSync(ff.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=25:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    src,
  ]);
  const voice = join(dir, 'voice.wav');
  execFileSync(ff.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1',
    voice,
  ]);
  const sharp = (await loadSharp())!;
  const logo = join(dir, 'logo.png');
  writeFileSync(
    logo,
    await sharp({ create: { width: 200, height: 100, channels: 4, background: '#ff000080' } })
      .png()
      .toBuffer(),
  );
  const input = {
    assetId: '00000000-0000-4000-8000-000000000001',
    logoAssetId: '00000000-0000-4000-8000-000000000002',
    voiceItemId: '00000000-0000-4000-8000-000000000003',
    voiceVersion: 1,
    presets: ['story', 'feed_square'],
    startSec: 1,
    endSec: 3,
    denoise: true,
    sharpen: true,
    coverAtSec: 0.5,
  };
  const got: string[] = [];
  const sent: { preset: string; name: string; file: string }[] = [];
  const kept = join(dir, 'kept');
  const result = (await HANDLERS['media.video'](input, {
    ...noFiles,
    signal: new AbortController().signal,
    server: 'http://127.0.0.1:9',
    timeoutSec: 600,
    report: () => {},
    downloadTo: async (what, dest) => {
      const id = 'assetId' in what ? what.assetId : what.itemId;
      got.push(id);
      copyFileSync(id === input.assetId ? src : id === input.logoAssetId ? logo : voice, dest);
      return statSync(dest).size;
    },
    uploadFile: async (preset, name, file) => {
      const copy = `${kept}-${name}`;
      copyFileSync(file, copy);
      sent.push({ preset, name, file: copy });
      return { itemId: `item-${preset}` };
    },
  })) as { outputs: { preset: string; width: number; height: number; durationSec?: number }[] };
  assert.deepEqual(got, [input.assetId, input.logoAssetId, input.voiceItemId]);
  assert.deepEqual(
    sent.map((s) => s.name),
    ['story-1080x1920.mp4', 'feed_square-1080x1080.mp4', 'story-cover.jpg'],
  );
  assert.deepEqual(
    result.outputs.map((o) => [o.preset, o.width, o.height]),
    [
      ['story', 1080, 1920],
      ['feed_square', 1080, 1080],
      ['cover', 1080, 1920],
    ],
  );
  const story = await probeVideo(ff.ffprobe, sent[0]!.file);
  assert.equal(story.width, 1080);
  assert.equal(story.height, 1920);
  assert.ok(story.hasAudio);
  assert.ok(Math.abs(story.durationSec - 2) < 0.2, `cut to 2 s, got ${story.durationSec}`);
  const cover = await sharp(sent[2]!.file).metadata();
  assert.equal(cover.format, 'jpeg');
  assert.equal(cover.width, 1080);

  // A start after the end of the video is refused before any work.
  await assert.rejects(
    HANDLERS['media.video'](
      {
        ...input,
        logoAssetId: null,
        voiceItemId: null,
        voiceVersion: null,
        startSec: 10,
        endSec: null,
      },
      {
        ...noFiles,
        signal: new AbortController().signal,
        server: 'http://127.0.0.1:9',
        timeoutSec: 600,
        report: () => {},
        downloadTo: async (_what, dest) => {
          copyFileSync(src, dest);
          return 1;
        },
      },
    ),
    (e: unknown) => e instanceof JobError && e.code === 'MEDIA_VIDEO_CUT_INVALID',
  );

  // A file that is not a video fails clearly.
  await assert.rejects(
    HANDLERS['media.video'](
      { ...input, logoAssetId: null, voiceItemId: null, voiceVersion: null },
      {
        ...noFiles,
        signal: new AbortController().signal,
        server: 'http://127.0.0.1:9',
        timeoutSec: 600,
        report: () => {},
        downloadTo: async (_what, dest) => {
          writeFileSync(dest, 'không phải video');
          return 1;
        },
      },
    ),
    (e: unknown) => e instanceof JobError && e.code === 'MEDIA_VIDEO_INVALID',
  );
});
