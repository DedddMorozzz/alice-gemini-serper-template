import assert from 'node:assert/strict';

const url = process.env.ALICE_WEBHOOK_URL;
if (!url?.startsWith('https://')) throw new Error('ALICE_WEBHOOK_URL is required');

let state = {};
let messageId = 0;
let fullAnswer = '';
let chunks = [];
const filler = 'Объясни подробно историю развития радиосвязи от первых опытов до современных цифровых систем, с примерами и основными этапами.';

async function ask(command) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        version: '1.0',
        session: { new: messageId === 0, message_id: messageId++, session_id: 'continuation-test', user_id: 'continuation-test' },
        request: { type: 'SimpleUtterance', command, original_utterance: command },
        state: { session: state }
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.response && typeof body.response.text === 'string');
    assert.ok(body.response.text.length <= 1024);
    assert.ok(body.session_state);
    state = body.session_state;
    console.log(JSON.stringify({ command: command.slice(0, 32), ms: Math.round(performance.now() - started), chars: body.response.text.length, pending: state.pending?.length ?? 0, preview: body.response.text.slice(0, 130) }));
    return body.response.text;
  } finally {
    clearTimeout(timer);
  }
}

const first = await ask(filler);
assert.doesNotMatch(first, /Не успела подготовить ответ|Не получилось получить ответ/);
chunks.push(first);
if (state.pending) {
  let previous = state.pending.length;
  for (let i = 0; i < 10 && state.pending; i++) {
    const part = await ask('продолжай');
    chunks.push(part);
    assert.ok((state.pending?.length ?? 0) < previous, 'pending should shrink');
    previous = state.pending?.length ?? 0;
  }
  assert.equal(state.pending, '', 'all continuation parts delivered');
  assert.equal(chunks.filter(x => x.includes('Скажи «продолжай»')).length, chunks.length - 1);
  console.log('CONTINUATION_OK ' + JSON.stringify({ chunks: chunks.length, chars: chunks.reduce((n,x)=>n+x.length,0) }));
} else {
  console.log('CONTINUATION_NOT_TRIGGERED ' + JSON.stringify({ chars: first.length, reason: 'Model generated answer under split threshold' }));
}
await ask('начни новую тему');
assert.equal(state.pending, '');
assert.deepEqual(state.history, []);
console.log('RESET_OK');
