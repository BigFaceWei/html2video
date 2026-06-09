import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

test('health endpoint returns ok', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});
