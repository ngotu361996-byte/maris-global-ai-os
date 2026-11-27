import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heartbeatSchema } from '@maris/contracts';
import { normalizeServer } from './config';
import { cpuPercent, parseNvidiaSmi, Sampler } from './metrics';

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
