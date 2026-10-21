import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.js';

function run(command, session = {}) {
  const req = { method: 'POST', body: { request: { command }, state: { session } } };
  const res = { status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
  return handler(req, res).then(() => ({ code: res.code, ...res.value }));
}

test('greeting without external requests', async () => {
  const result = await run('');
  assert.equal(result.code, 200);
  assert.match(result.response.text, /Привет/);
});

test('reset conversation without external requests', async () => {
  const result = await run('начни новую тему', { history: [{ role: 'user', text: 'старый вопрос' }] });
  assert.deepEqual(result.session_state.history, []);
});

test('continue pending answer without external requests', async () => {
  const result = await run('продолжай', { pending: 'Оставшаяся часть ответа.' });
  assert.equal(result.response.text, 'Оставшаяся часть ответа.');
  assert.equal(result.session_state.pending, '');
});
