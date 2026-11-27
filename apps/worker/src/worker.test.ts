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
