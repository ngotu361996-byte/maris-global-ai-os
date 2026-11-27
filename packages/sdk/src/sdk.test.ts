import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTOR_TEMPLATES,
  PLUGIN_SAMPLES,
  SKILL_TEMPLATES,
  WORKFLOW_TEMPLATES,
} from '@maris/contracts';
import {
  assertChecksum,
  checkPlugin,
  definePlugin,
  generatePublisherKeys,
  keyFingerprint,
  parsePlugin,
  PluginFileError,
  signPlugin,
  verifyPluginSignature,
} from './index';

const sample = PLUGIN_SAMPLES[0]!.manifest;

test('pack adds a stable checksum', () => {
  const a = definePlugin(sample);
  const b = definePlugin(JSON.parse(JSON.stringify(a)));
  assert.match(a.checksum!, /^[0-9a-f]{64}$/);
  assert.equal(a.checksum, b.checksum);
  assert.equal(assertChecksum(parsePlugin(a)), a.checksum);
});

test('a changed file fails the checksum', () => {
  const a = definePlugin(sample);
  const changed = parsePlugin({ ...a, description: 'đã sửa' });
  assert.throws(() => assertChecksum(changed), PluginFileError);
});

test('a signature verifies with its key and not with another, nor after a change', () => {
  const keys = generatePublisherKeys();
  const other = generatePublisherKeys();
  const signed = signPlugin(sample, keys.privateKey, 'maris.test');
  const parsed = parsePlugin(JSON.parse(JSON.stringify(signed)));
  assert.equal(verifyPluginSignature(parsed, keys.publicKey), true);
  assert.equal(verifyPluginSignature(parsed, other.publicKey), false);
  const tampered = parsePlugin({ ...parsed, timeoutSec: 600 });
  assert.equal(verifyPluginSignature(tampered, keys.publicKey), false);
  assert.match(keyFingerprint(keys.publicKey), /^[0-9a-f]{16}$/);
});

test('check refuses a plugin that does not ask for the permissions it needs', () => {
  assert.throws(
    () => checkPlugin({ ...sample, permissions: ['workflow.run'] }),
    /chưa xin quyền mà các phần bên trong cần: ai.generate_text/,
  );
  assert.throws(() => checkPlugin({ ...sample, tests: [] }), /ít nhất một bài kiểm tra/);
  const r = checkPlugin(definePlugin(sample));
  assert.equal(r.compatible, true);
  assert.deepEqual(r.parts, { skills: 1, connectors: 0, workflows: 1 });
});

test('sample plugins do not reuse the keys of built-in templates', () => {
  const taken = new Set([
    ...SKILL_TEMPLATES.map((t) => `skill:${t.key}`),
    ...WORKFLOW_TEMPLATES.map((t) => `workflow:${t.key}`),
    ...CONNECTOR_TEMPLATES.map((t) => `connector:${t.key}`),
  ]);
  for (const s of PLUGIN_SAMPLES) {
    const m = definePlugin(s.manifest);
    const keys = [
      ...m.contents.skills.map((x) => `skill:${x.key}`),
      ...m.contents.workflows.map((x) => `workflow:${x.key}`),
      ...m.contents.connectors.map((x) => `connector:${x.key}`),
    ];
    assert.deepEqual(
      keys.filter((k) => taken.has(k)),
      [],
    );
  }
});
