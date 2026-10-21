// Usage: ALICE_WEBHOOK_URL=https://example.vercel.app/api node scripts/smoke-live.mjs
// Runs against the real webhook. Requires no API keys locally.
const url = process.env.ALICE_WEBHOOK_URL;
if (!url || !/^https:\/\//.test(url)) {
  console.error('Set ALICE_WEBHOOK_URL to your HTTPS webhook endpoint');
  process.exit(2);
}
const cases = [
  ['greeting', '', false],
  ['direct Gemini', 'Что такое стул?', false],
  ['Serper plus Gemini', 'Найди новости по самому крупному радиотелескопу', true],
  ['reset', 'начни новую тему', false]
];
let failures = 0;
for (const [name, command, search] of cases) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '1.0',
        session: { new: !command, message_id: 0, session_id: 'smoke-test', user_id: 'smoke-test' },
        request: { command, original_utterance: command, type: 'SimpleUtterance' },
        state: { session: {} }
      }),
      signal: controller.signal
    });
    const data = await response.json();
    const elapsed = Math.round(performance.now() - start);
    const answer = data?.response?.text || '';
    const fallback = /Не успела подготовить ответ|Не удалось получить актуальные данные|Не получилось получить ответ/.test(answer);
    const ok = response.ok && !!answer && !fallback && answer.length <= 1024;
    console.log(JSON.stringify({ name, search, ok, httpStatus: response.status, elapsedMs: elapsed, answerChars: answer.length, answer: answer.slice(0, 220) }));
    if (!ok) failures++;
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ name, ok: false, elapsedMs: Math.round(performance.now() - start), error: error.name }));
  } finally {
    clearTimeout(timer);
  }
}
if (failures) process.exitCode = 1;
