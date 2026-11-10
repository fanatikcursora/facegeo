/* ============================================================================
 * ai.js — ИИ-оценка через Google Gemini (по кнопке).
 *
 * Сайт отправляет посреднику (worker/, Cloudflare) уменьшенное фото анфас,
 * фото профиля, если оно размечено, и все свои замеры. Посредник спрашивает Gemini
 * и возвращает его балл, категории и короткий разбор. Без нажатия кнопки
 * ничего никуда не уходит. Пока адрес посредника не задан, блок не показывается.
 * ========================================================================== */
(function () {
  FR.ai = {
    // Адрес посредника после развёртывания: https://facegeo-ai.<ваш-поддомен>.workers.dev/rate
    endpoint: ''
  };

  const CATS = [
    ['harmony', 'Гармония'], ['dimorphism', 'Диморфизм'], ['angularity', 'Ангулярность'],
    ['features', 'Фичи (глаза, нос, губы)'], ['bone', 'Костная масса'], ['skin', 'Кожа']
  ];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const scoreClass = (s) => (s >= 8 ? 'good' : s >= 5 ? 'mid' : 'bad');

  function status(text, isError) {
    const el = $('#aiStatus');
    el.textContent = text || '';
    el.className = isError ? 'status error' : 'status';
  }

  /* Уменьшенная копия фото в JPEG/base64: Gemini хватает 768 пикселей по большой стороне */
  function jpegB64(canvas, maxSide) {
    const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  /* Что насчитал сайт — Gemini получает это как подсказку */
  function sitePayload(res, gender) {
    const st = FR.app.state;
    const fmt = (r) => r.value.toFixed(r.def.dec) + (r.def.unit || '');
    const ideal = (r) => r.def.ideal[gender].join('–') + (r.def.unit || '');
    return {
      psl: res.psl,
      tier: res.tier,
      categories: res.cats.map((c) => ({ name: c.name, score: +(c.score * 10).toFixed(1) })),
      metrics: res.rows.map((r) => ({ name: r.def.name, value: fmt(r), ideal: ideal(r), score: r.w > 0 ? +(r.score * 10).toFixed(1) : null })),
      warnings: st.frontal.m.warnings
    };
  }

  function reset() {
    const box = $('#aiBox');
    if (!box) return;
    box.hidden = !FR.ai.endpoint || !FR.app.state.frontal;
    $('#aiResult').hidden = true;
    $('#aiGo').disabled = false;
    status('');
  }

  function render(out, res, gender) {
    const tier = FR.scoring.tierFor(out.psl, gender);
    $('#aiPsl').textContent = out.psl.toFixed(2);
    $('#aiTier').textContent = tier;
    $('#aiCompare').textContent = `По замерам сайта: ${res.psl.toFixed(2)} (${res.tier}). ИИ смотрит на лицо целиком, поэтому оценки могут расходиться.`;
    $('#aiCats').innerHTML = CATS.filter(([k]) => out.categories[k] !== null && out.categories[k] !== undefined).map(([k, name]) => `
      <div class="cat">
        <span class="cat-name">${esc(name)}</span>
        <span class="bar"><i class="${scoreClass(out.categories[k])}" style="width:${(out.categories[k] * 10).toFixed(0)}%"></i></span>
        <span class="cat-num">${out.categories[k].toFixed(1)}</span>
      </div>`).join('');
    $('#aiSummary').textContent = out.summary;
    $('#aiPlus').innerHTML = out.strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">—</li>';
    $('#aiMinus').innerHTML = out.weaknesses.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="muted">—</li>';
    $('#aiMeta').textContent = (out.photoIssues.length ? 'Что мешает оценке: ' + out.photoIssues.join('; ') + '. ' : '')
      + `Модель: ${out.model}. Одно и то же фото может получить немного разные оценки.`;
    $('#aiResult').hidden = false;
  }

  async function run() {
    const st = FR.app.state;
    if (!FR.ai.endpoint || !st.frontal) return;
    const gender = st.gender;
    const res = FR.app.computeResult();
    const body = {
      frontal: jpegB64(st.frontal.canvas, 768),
      profile: st.profile && st.profile.confirmed && st.profile.pts ? jpegB64(st.profile.canvas, 768) : undefined,
      gender,
      kind: st.frontal.kind,
      site: sitePayload(res, gender)
    };
    $('#aiGo').disabled = true;
    status('Gemini смотрит на фото… обычно 5–20 секунд.');
    try {
      const r = await fetch(FR.ai.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let out = null;
      try { out = await r.json(); } catch (e) { /* не JSON */ }
      if (!r.ok || !out) { status((out && out.message) || `Сервер ИИ-оценки ответил ошибкой ${r.status}.`, true); return; }
      if (!out.ok) { status('ИИ не стал оценивать это фото' + (out.reason ? ': ' + out.reason : '.'), true); return; }
      if (typeof out.psl !== 'number') { status('ИИ вернул ответ без балла. Попробуйте ещё раз.', true); return; }
      status('');
      render(out, res, gender);
    } catch (e) {
      console.warn('ИИ-оценка:', e);
      status('Не удалось связаться с сервером ИИ-оценки. Проверьте интернет и попробуйте ещё раз.', true);
    } finally {
      $('#aiGo').disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('#aiGo');
    if (btn) btn.addEventListener('click', run);
  });

  FR.ai.reset = reset;
  FR.ai.run = run;
})();
