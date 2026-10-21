const url = process.env.ALICE_WEBHOOK_URL;
if (!url?.startsWith('https://')) throw new Error('ALICE_WEBHOOK_URL required');
let state = {};
let messageId = 0;
const checks = [
  { name: 'topic', command: 'Расскажи кратко о планете Марс', verify: x => x.response.text.length > 50 },
  { name: 'followup', command: 'А сколько длится там год?', verify: x => x.response.text.length > 30 },
  { name: 'reset', command: 'начни новую тему', verify: x => x.session_state.history.length === 0 && !x.session_state.pending },
  { name: 'newtopic', command: 'Расскажи кратко про фотосинтез', verify: x => x.response.text.length > 50 }
];
let failed = 0;
for (const check of checks) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        version: '1.0',
        session: { new: messageId === 0, message_id: messageId++, session_id: 'context-smoke', user_id: 'context-smoke' },
        request: { type: 'SimpleUtterance', command: check.command, original_utterance: check.command },
        state: { session: state }
      })
    });
    const data = await response.json();
    const answer = String(data?.response?.text || '');
    const fallback = /Не успела подготовить ответ|Не удалось получить актуальные данные|Не получилось получить ответ/.test(answer);
    const ok = response.ok && !fallback && answer.length <= 1024 && !!data.session_state && check.verify(data);
    state = data.session_state || {};
    const result = { name: check.name, ok, elapsedMs: Math.round(performance.now() - start), answerChars: answer.length, historyCount: state.history?.length ?? 0, pendingChars: state.pending?.length ?? 0, answerPreview: answer.slice(0, 120) };
    console.log(JSON.stringify(result));
    if (!ok) failed++;
  } catch (error) {
    failed++;
    console.log(JSON.stringify({ name: check.name, ok: false, error: error.name }));
  } finally { clearTimeout(timer); }
}
if (failed) process.exitCode = 1;
