/* ============================================================================
 * FaceGeo AI — сервер-посредник между сайтом и Google Gemini (Cloudflare Worker).
 *
 * Зачем он нужен: ключ Gemini нельзя положить на сайт — GitHub Pages отдаёт все
 * файлы всем, и ключ сразу украдут. Здесь ключ хранится как секрет Cloudflare.
 *
 * Что делает:
 *   POST /rate  { frontal, profile?, gender, kind, site }  →  { psl, categories, … }
 *     frontal / profile — JPEG в base64 (без префикса data:)
 *     site — что насчитал сам сайт: балл, тир, категории и все замеры с нормами
 *   Сайт сам ничего не хранит, и посредник тоже: фото уходит в Gemini и забывается.
 *
 * Настройки (wrangler.toml, раздел [vars]) и секрет:
 *   GEMINI_API_KEY   — секрет: npx wrangler secret put GEMINI_API_KEY
 *   ALLOWED_ORIGINS  — с каких сайтов можно звать посредника, через запятую
 *   MODELS           — модели Gemini по порядку: при лимите или ошибке берётся следующая
 * ========================================================================== */

const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_BODY = 4 * 1024 * 1024; // 4 МБ на запрос с двумя фото хватает с запасом
const RATE = { windowMs: 10 * 60 * 1000, max: 6 }; // не больше 6 оценок за 10 минут с одного адреса

const SYSTEM = `Ты оцениваешь внешность лица по фото для сайта в духе луксмаксинга.
Шкала PSL от 0 до 8: средний взрослый человек — около 4.0; 5.25 и выше — редкость (Chadlite/Stacylite),
6 и выше — единицы из тысяч, 7 и выше почти не встречается. Ниже 2 — сильные недостатки.
Оценивай честно и спокойно, без грубости, насмешек и сексуального подтекста.

Тебе дают фото анфас (иногда ещё профиль) и замеры, которые сайт снял по 478 точкам лица:
пропорции, углы, ширины в миллиметрах, кожу; у каждого замера указаны норма и балл сайта.
Замеры точные по геометрии, но не видят причёску, выражение, ухоженность, качество кожи вживую,
общее впечатление. Ты смотришь на фото сам и учитываешь замеры как подсказку. Не копируй балл сайта:
дай свою оценку. Если фото снято вплотную, снизу, с фильтром, с поворотом головы — учти это и скажи.

Категории (каждая 0–10): гармония (как черты сочетаются), диморфизм (насколько черты типичны для пола),
ангулярность (углы челюсти и линии лица), фичи (глаза, брови, нос, губы), костная масса (видна ли
костная основа: скулы, челюсть, подбородок), кожа.

Откажись оценивать (ok = false и причина в reason), если: на фото нет человеческого лица или лиц
несколько; это явно ребёнок или подросток младше 16 лет; лицо почти не видно. Иначе ok = true.
Пиши по-русски, коротко и по делу.`;

// Схема ответа (подмножество OpenAPI, которое понимает Gemini)
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    ok: { type: 'BOOLEAN', description: 'false, если оценивать нельзя' },
    reason: { type: 'STRING', description: 'почему нельзя оценить; пусто, если ok = true' },
    psl: { type: 'NUMBER', description: 'балл PSL от 0 до 8 с одним-двумя знаками после запятой' },
    categories: {
      type: 'OBJECT',
      properties: {
        harmony: { type: 'NUMBER' }, dimorphism: { type: 'NUMBER' }, angularity: { type: 'NUMBER' },
        features: { type: 'NUMBER' }, bone: { type: 'NUMBER' }, skin: { type: 'NUMBER' }
      },
      required: ['harmony', 'dimorphism', 'angularity', 'features', 'bone', 'skin']
    },
    summary: { type: 'STRING', description: '2–3 предложения: общее впечатление и что сильнее всего влияет на балл' },
    strengths: { type: 'ARRAY', items: { type: 'STRING' }, description: 'до 3 сильных сторон' },
    weaknesses: { type: 'ARRAY', items: { type: 'STRING' }, description: 'до 3 слабых сторон' },
    photoIssues: { type: 'ARRAY', items: { type: 'STRING' }, description: 'что в самом фото мешает точной оценке' }
  },
  required: ['ok', 'psl', 'categories', 'summary', 'strengths', 'weaknesses']
};

/* ----------------------------------------------------------- вспомогательное */
const hits = new Map(); // адрес → времена запросов (живёт, пока жив экземпляр воркера)
function rateLimited(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // не даём таблице расти бесконечно
  return false;
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: ok ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    } : { Vary: 'Origin' }
  };
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

const isB64 = (s) => typeof s === 'string' && s.length > 100 && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 2000));

/* Текст с замерами сайта для Gemini: компактная таблица */
function describeSite(site, gender, kind) {
  const lines = [];
  lines.push(`Пол: ${gender === 'f' ? 'женский' : 'мужской'}. Тип изображения по мнению сайта: ${kind === 'drawing' ? 'рисунок' : kind === 'gray' ? 'чёрно-белое фото' : 'цветное фото'}.`);
  if (site && typeof site === 'object') {
    if (typeof site.psl === 'number') lines.push(`Балл сайта по замерам: PSL ${site.psl.toFixed(2)} (${site.tier || ''}).`);
    if (Array.isArray(site.categories)) lines.push('Категории сайта (0–10): ' + site.categories.slice(0, 10).map((c) => `${String(c.name).slice(0, 40)} ${Number(c.score).toFixed(1)}`).join('; ') + '.');
    if (Array.isArray(site.metrics)) {
      lines.push('Замеры (значение | норма | балл сайта 0–10):');
      for (const m of site.metrics.slice(0, 60)) {
        lines.push(`- ${String(m.name).slice(0, 60)}: ${String(m.value).slice(0, 16)} | ${String(m.ideal).slice(0, 24)} | ${m.score == null ? '—' : Number(m.score).toFixed(1)}`);
      }
    }
    if (Array.isArray(site.warnings) && site.warnings.length) lines.push('Предупреждения сайта о качестве фото: ' + site.warnings.slice(0, 8).map((w) => String(w).slice(0, 160)).join(' | '));
  }
  return lines.join('\n');
}

/* Ответ Gemini → наш формат. Текст ответа — JSON по схеме. */
function parseGemini(data) {
  const block = data && data.promptFeedback && data.promptFeedback.blockReason;
  if (block) return { error: 'blocked', detail: block };
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) return { error: 'empty' };
  if (cand.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/.test(cand.finishReason)) return { error: 'blocked', detail: cand.finishReason };
  const text = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  let out;
  try { out = JSON.parse(text); } catch (e) {
    const m = text.match(/\{[\s\S]*\}/); // на случай, если модель обернула JSON в текст
    if (!m) return { error: 'bad_json' };
    try { out = JSON.parse(m[0]); } catch (e2) { return { error: 'bad_json' }; }
  }
  const clamp = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
  const cats = out.categories || {};
  const strs = (a, n) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string').slice(0, n).map((s) => s.slice(0, 300)) : []);
  return {
    ok: out.ok !== false,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
    psl: clamp(out.psl, 0, 8),
    categories: Object.fromEntries(['harmony', 'dimorphism', 'angularity', 'features', 'bone', 'skin'].map((k) => [k, clamp(cats[k], 0, 10)])),
    summary: typeof out.summary === 'string' ? out.summary.slice(0, 1200) : '',
    strengths: strs(out.strengths, 3),
    weaknesses: strs(out.weaknesses, 3),
    photoIssues: strs(out.photoIssues, 4)
  };
}

async function callGemini(env, model, parts, withSchema) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: withSchema
      ? { responseMimeType: 'application/json', responseSchema: SCHEMA }
      : { responseMimeType: 'application/json' }
  };
  return fetch(API + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body)
  });
}

/* ------------------------------------------------------------------- запрос */
async function rate(request, env, cors) {
  if (!env.GEMINI_API_KEY) return json(500, { error: 'no_key', message: 'На сервере не задан ключ Gemini.' }, cors);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json(413, { error: 'too_big', message: 'Фото слишком большое.' }, cors);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (rateLimited(ip)) return json(429, { error: 'rate_limited', message: 'Слишком много оценок подряд. Попробуйте через 10 минут.' }, cors);

  let req;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { error: 'too_big', message: 'Фото слишком большое.' }, cors);
    req = JSON.parse(raw);
  } catch (e) { return json(400, { error: 'bad_request', message: 'Неверный запрос.' }, cors); }
  if (!isB64(req.frontal)) return json(400, { error: 'bad_request', message: 'Нет фото анфас.' }, cors);

  const gender = req.gender === 'f' ? 'f' : 'm';
  const parts = [
    { text: describeSite(req.site, gender, req.kind) + '\n\nФото анфас:' },
    { inlineData: { mimeType: 'image/jpeg', data: req.frontal } }
  ];
  if (isB64(req.profile)) {
    parts.push({ text: 'Фото в профиль:' });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: req.profile } });
  }
  parts.push({ text: 'Дай свою оценку строго в формате JSON по схеме.' });

  const models = String(env.MODELS || 'gemini-3.6-flash').split(',').map((s) => s.trim()).filter(Boolean);
  let last = { status: 502, error: 'upstream', message: 'Gemini не ответил.' };
  for (const model of models) {
    for (const withSchema of [true, false]) {
      let res;
      try { res = await callGemini(env, model, parts, withSchema); } catch (e) { last = { status: 502, error: 'upstream', message: 'Не удалось связаться с Gemini.' }; break; }
      if (res.ok) {
        const out = parseGemini(await res.json());
        if (out.error === 'blocked') return json(200, { ok: false, reason: 'Gemini отказался оценивать это фото.', model }, cors);
        if (out.error) { last = { status: 502, error: out.error, message: 'Gemini вернул ответ в неверном формате.' }; break; }
        return json(200, { ...out, model }, cors);
      }
      const detail = (await res.text()).slice(0, 300);
      if (res.status === 400 && withSchema && /schema|responseSchema|Unknown name/i.test(detail)) continue; // схему не приняли — пробуем без неё
      if (res.status === 429) last = { status: 429, error: 'quota', message: 'Бесплатный лимит Gemini на сейчас исчерпан. Попробуйте позже.' };
      else if (res.status === 400 && /API key|API_KEY/i.test(detail)) return json(500, { error: 'bad_key', message: 'Ключ Gemini на сервере неверный.' }, cors);
      else last = { status: 502, error: 'upstream_' + res.status, message: 'Gemini вернул ошибку ' + res.status + '.' };
      break; // эта модель не подошла — следующая по списку
    }
  }
  return json(last.status, { error: last.error, message: last.message }, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    if (url.pathname === '/health') return json(200, { ok: true, key: !!env.GEMINI_API_KEY }, cors.headers);
    if (url.pathname !== '/rate' || request.method !== 'POST') return json(404, { error: 'not_found' }, cors.headers);
    if (!cors.ok) return json(403, { error: 'forbidden_origin', message: 'Этот сайт не может пользоваться ИИ-оценкой.' }, cors.headers);
    return rate(request, env, cors.headers);
  }
};

// для проверки без Cloudflare
export { parseGemini, describeSite, rateLimited, SCHEMA };
