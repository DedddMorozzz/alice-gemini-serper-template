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

test('search timeout falls back to grounded Serper results', async () => {
  const oldFetch = globalThis.fetch;
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldSerper = process.env.SERPER_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.SERPER_API_KEY = 'test-serper';
  globalThis.fetch = async (url) => {
    if (String(url).includes('google.serper.dev')) {
      return { ok: true, json: async () => ({ organic: [{ title: 'Радиотелескоп FAST', snippet: 'Опубликовано исследование наблюдений', link: 'https://example.org/fast' }] }) };
    }
    const err = new Error('timed out');
    err.name = 'AbortError';
    throw err;
  };
  try {
    const result = await run('Найди новости о радиотелескопе');
    assert.equal(result.code, 200);
    assert.match(result.response.text, /Радиотелескоп FAST/);
    assert.doesNotMatch(result.response.text, /Не успела подготовить ответ/);
    assert.equal(result.session_state.history.at(-1).role, 'model');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldGemini;
    if (oldSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = oldSerper;
  }
});
