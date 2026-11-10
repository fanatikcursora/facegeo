// Проверка посредника без Cloudflare и без ключа: node worker/test.mjs
import assert from 'node:assert/strict';
import worker, { parseGemini, rateLimited } from './src/index.js';

const env = { GEMINI_API_KEY: 'k', ALLOWED_ORIGINS: 'https://site.test', MODELS: 'model-a,model-b' };
const img = 'A'.repeat(400);
const call = (body, origin = 'https://site.test', ip = '1.1.1.1') => worker.fetch(new Request('https://w.test/rate', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body)
}), env);
const gem = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
const answer = (o) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] }, finishReason: 'STOP' }] });
const good = { ok: true, reason: '', psl: 9.5, categories: { harmony: 7, dimorphism: 6, angularity: 5, features: 6, bone: 5, skin: 12 }, summary: 's', strengths: ['a', 'b', 'c', 'd'], weaknesses: [], photoIssues: [] };
let calls = [];
const mock = (...responses) => { calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] }); return responses.shift(); }; };
let n = 0; const ok = (name) => console.log('✓', name, ++n);

// 1. обычный ответ: балл и категории обрезаются до шкалы, лишние пункты отбрасываются
mock(gem(answer(good)));
let r = await call({ frontal: img, gender: 'm', site: { psl: 4.1, tier: 'MMTN', metrics: [{ name: 'x', value: 1, ideal: '1–2', score: 9 }] } }, 'https://site.test', 'ip1');
let j = await r.json();
assert.equal(r.status, 200); assert.equal(j.psl, 8); assert.equal(j.categories.skin, 10); assert.equal(j.strengths.length, 3); assert.equal(j.model, 'model-a');
assert.equal(calls[0].key, 'k'); assert.ok(calls[0].url.includes('model-a:generateContent'));
assert.equal(calls[0].body.contents[0].parts.filter((p) => p.inlineData).length, 1);
assert.ok(calls[0].body.contents[0].parts[0].text.includes('PSL 4.10'));
ok('обычный ответ и обрезка значений');

// 2. профиль уходит вторым фото
mock(gem(answer(good)));
await call({ frontal: img, profile: img, gender: 'f' }, 'https://site.test', 'ip2');
assert.equal(calls[0].body.contents[0].parts.filter((p) => p.inlineData).length, 2);
ok('профиль — второе фото');

// 3. лимит первой модели → вторая
mock(gem('quota', 429), gem(answer(good)));
r = await call({ frontal: img }, 'https://site.test', 'ip3'); j = await r.json();
assert.equal(r.status, 200); assert.equal(j.model, 'model-b'); assert.equal(calls.length, 2);
ok('лимит → запасная модель');

// 4. схему не приняли → тот же запрос без схемы
mock(gem('Invalid JSON payload: Unknown name "responseSchema"', 400), gem(answer(good)));
r = await call({ frontal: img }, 'https://site.test', 'ip4'); j = await r.json();
assert.equal(r.status, 200); assert.ok(calls[0].body.generationConfig.responseSchema); assert.ok(!calls[1].body.generationConfig.responseSchema);
ok('без схемы, если её не приняли');

// 5. обе модели в лимите → 429 с понятным текстом
mock(gem('q', 429), gem('q', 429));
r = await call({ frontal: img }, 'https://site.test', 'ip5'); j = await r.json();
assert.equal(r.status, 429); assert.equal(j.error, 'quota');
ok('лимит у всех моделей');

// 6. отказ по безопасности → ok:false
mock(gem({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }));
r = await call({ frontal: img }, 'https://site.test', 'ip6'); j = await r.json();
assert.equal(r.status, 200); assert.equal(j.ok, false);
ok('отказ Gemini');

// 7. чужой сайт и запрос без фото не проходят, в Gemini ничего не уходит
mock();
r = await call({ frontal: img }, 'https://evil.test', 'ip7'); assert.equal(r.status, 403);
r = await call({ gender: 'm' }, 'https://site.test', 'ip7'); assert.equal(r.status, 400);
assert.equal(calls.length, 0);
ok('чужой сайт и пустой запрос');

// 8. ограничение частоты: 12 за 10 минут с адреса
const t = 1e12; for (let i = 0; i < 12; i++) assert.equal(rateLimited('z', t + i), false);
assert.equal(rateLimited('z', t + 10), true); assert.equal(rateLimited('z', t + 11 * 60 * 1000), false);
ok('ограничение частоты');

// 9. JSON, обёрнутый в текст, тоже читается
assert.equal(parseGemini({ candidates: [{ content: { parts: [{ text: 'Вот: ' + JSON.stringify(good) + ' готово' }] } }] }).psl, 8);
ok('JSON внутри текста');

// 10. перегрузка (503): та же модель ещё раз, и успех
mock(gem('overloaded', 503), gem(answer(good)));
r = await call({ frontal: img }, 'https://site.test', 'ip10'); j = await r.json();
assert.equal(r.status, 200); assert.equal(j.model, 'model-a'); assert.equal(calls.length, 2);
ok('перегрузка → повтор той же модели');

// 11. перегрузка у обеих моделей (по два раза) → 503 с понятным текстом
mock(gem('o', 503), gem('o', 503), gem('o', 503), gem('o', 503));
r = await call({ frontal: img }, 'https://site.test', 'ip11'); j = await r.json();
assert.equal(r.status, 503); assert.equal(j.error, 'overloaded'); assert.equal(calls.length, 4);
ok('перегрузка у всех моделей');

console.log(`все проверки пройдены: ${n}`);
