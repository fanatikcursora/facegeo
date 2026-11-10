// Запускает посредника локально, без Cloudflare: node worker/dev-server.mjs
//   Без переменной GEMINI_API_KEY отвечает подставным ответом Gemini — чтобы проверить сайт.
//   С ключом (GEMINI_API_KEY=... node worker/dev-server.mjs) ходит в настоящий Gemini.
// Слушает http://127.0.0.1:8788 (адрес для сайта: http://127.0.0.1:8788/rate).
import http from 'node:http';
import worker from './src/index.js';

const PORT = 8788;
const realKey = process.env.GEMINI_API_KEY || '';
const env = {
  GEMINI_API_KEY: realKey || 'mock-key',
  ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,https://fanatikcursora.github.io',
  MODELS: process.env.MODELS || 'gemini-3.6-flash,gemini-3.5-flash-lite'
};

if (!realKey) {
  // Подставной Gemini: отвечает правдоподобным JSON и пишет в консоль, что пришло
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const parts = body.contents[0].parts;
    const images = parts.filter((p) => p.inlineData).length;
    console.log(`[mock] ${String(url).split('/models/')[1]} — частей: ${parts.length}, фото: ${images}, схема: ${!!body.generationConfig.responseSchema}`);
    const answer = {
      ok: true, reason: '', psl: 4.4,
      categories: { harmony: 7.1, dimorphism: 6.4, angularity: 5.2, features: 6.8, bone: 5.9, skin: 6.5 },
      summary: 'Подставной ответ для проверки сайта: настоящий Gemini не вызывался.',
      strengths: ['Ровная кожа', 'Пропорциональный нос'],
      weaknesses: ['Мягкая линия челюсти'],
      photoIssues: ['Снято вблизи']
    };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const request = new Request('http://127.0.0.1:' + PORT + req.url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`посредник: http://127.0.0.1:${PORT}/rate (${realKey ? 'настоящий Gemini' : 'подставной Gemini'})`));
