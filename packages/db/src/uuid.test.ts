import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from './uuid';

test('uuidv7 has version 7 and RFC variant', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidv7 sorts by time', () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  assert.ok(a < b);
});
