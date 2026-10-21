import test from 'node:test';
import assert from 'node:assert/strict';
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory, splitSpokenAnswer } from '../api/index.js';

test('only explicit find keyword triggers Serper', () => {
  assert.equal(isSearchIntent('Найди вулкан Агунг'), true);
  assert.equal(isSearchIntent('Алиса, найди ответ'), true);
  assert.equal(isSearchIntent('Расскажи о вулканах'), false);
  assert.equal(isSearchIntent('найдите ответ'), false);
});
test('Alice response respects length and keeps state', () => {
  const r = aliceResponse('Привет', false, [{role:'user',text:'вопрос'}], 'остаток');
  assert.equal(r.response.text, 'Привет');
  assert.equal(r.session_state.pending, 'остаток');
  assert.equal(r.session_state.history.length, 1);
  assert.ok(fitAliceText('слово '.repeat(300)).length <= 1024);
});
test('long response can be continued without losing content', () => {
  const answer = 'Это длинное предложение с пояснением. '.repeat(55);
  let remainder = answer.replace(/\s+/g, ' ').trim();
  let reconstructed = '';
  for (let i=0; i<10 && remainder; i++) {
    const part = splitSpokenAnswer(remainder);
    assert.ok(part.spoken.length <= 1024);
    reconstructed += part.spoken.replace(/ Скажи «продолжай», чтобы услышать остальное\.$/, '').trim() + ' ';
    remainder = part.pending;
  }
  assert.equal(remainder, '');
  assert.equal(reconstructed.trim().replace(/\s+/g,' '), answer.trim().replace(/\s+/g,' '));
});
test('history filtering', () => {
  assert.deepEqual(safeHistory([{role:'user',text:'привет'}, {role:'invalid',text:'x'}]).map(x=>x.role), ['user']);
});
