// Live repeated checks. Avoid printing full answers or secrets.
const url = process.env.ALICE_WEBHOOK_URL;
if (!url || !url.startsWith('https://')) throw new Error('ALICE_WEBHOOK_URL is required');
const scenarios = [
  ['direct', 'Что такое стул?'],
  ['search', 'Найди новости по самому крупному радиотелескопу']
];
const records = [];
for (let round = 1; round <= 5; round++) {
  for (const [scenario, command] of scenarios) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0',
          session: { new: true, message_id: 0, session_id: 'load-smoke', user_id: 'load-smoke' },
          request: { command, original_utterance: command, type: 'SimpleUtterance' },
          state: { session: {} }
        }),
        signal: controller.signal
      });
      const body = await response.json();
      const answer = String(body?.response?.text || '');
      const fallback = /Не успела подготовить ответ|Не удалось получить актуальные данные|Не получилось получить ответ/.test(answer);
      const ok = response.ok && !fallback && answer.length > 0 && answer.length <= 1024;
      const fallbackType = !fallback ? null : /Не удалось получить актуальные данные/.test(answer) ? "search_unavailable" : /Не успела подготовить ответ/.test(answer) ? "gemini_timeout" : "model_error";
      const record = { round, scenario, ok, ms: Math.round(performance.now() - start), chars: answer.length, fallback, fallbackType };
      records.push(record);
      console.log(JSON.stringify(record));
    } catch (error) {
      const record = { round, scenario, ok: false, ms: Math.round(performance.now() - start), error: error.name };
      records.push(record);
      console.log(JSON.stringify(record));
    } finally {
      clearTimeout(timer);
    }
  }
}
for (const [scenario] of scenarios) {
  const values = records.filter(x => x.scenario === scenario);
  const times = values.map(x => x.ms).sort((a,b) => a-b);
  console.log('SUMMARY ' + JSON.stringify({
    scenario, requests: values.length, successes: values.filter(x=>x.ok).length,
    failures: values.filter(x=>!x.ok).length, averageMs: Math.round(times.reduce((a,b)=>a+b,0)/times.length),
    minMs: times[0], maxMs: times.at(-1)
  }));
}
if (records.some(x=>!x.ok)) process.exitCode = 1;
