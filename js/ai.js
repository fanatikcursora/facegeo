/* ============================================================================
 * ai.js — оценка через Google Gemini.
 *
 * Если задан адрес посредника (endpoint), рейт всегда ставит Gemini: при каждом
 * анализе сайт отправляет посреднику (worker/, Cloudflare) уменьшенное фото анфас,
 * фото профиля, если оно есть, и все свои замеры. Gemini смотрит на фото,
 * учитывает замеры и возвращает балл, категории и разбор. Балл по одним замерам
 * показывается отдельно. Если Gemini недоступен (кончился лимит, нет сети) —
 * рейта нет, сайт так и пишет.
 * Без адреса посредника сайт работает как раньше: рейт по замерам.
 * ========================================================================== */
(function () {
  FR.ai = {
    // Адрес посредника (Cloudflare Worker)
    endpoint: 'https://facegeo-ai.legitcufer.workers.dev/rate',
    /* Калибровка шкалы Gemini по калибровочной выборке (как у замеров):
     * PSL = 4.1 + 0.77 × (балл Gemini − mean) / sd. Пока null — показывается как есть. */
    calibration: null
  };

  const CATS = [
    ['harmony', 'Гармония'], ['dimorphism', 'Диморфизм'], ['angularity', 'Ангулярность'],
    ['features', 'Фичи (глаза, нос, губы)'], ['bone', 'Костная масса'], ['skin', 'Кожа']
  ];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const scoreClass = (s) => (s >= 8 ? 'good' : s >= 5 ? 'mid' : 'bad');
  const active = () => !!FR.ai.endpoint;
  let seq = 0;          // номер текущего запроса: ответы на старые запросы не показываем
  let lastGender = null;

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

  function calibrated(raw, gender) {
    const c = FR.ai.calibration && FR.ai.calibration[gender];
    if (!c) return raw;
    return Math.max(0, Math.min(8, 4.1 + 0.77 * (raw - c.mean) / c.sd));
  }

  /* Главная карточка: ждём / ошибка / результат */
  function showExtras(on) {
    for (const id of ['#aiSummary', '#aiLists', '#aiMeta']) $(id).hidden = !on;
  }
  function pending() {
    $('#psl').textContent = '…';
    $('#tier').textContent = '';
    $('#overall').className = 'muted';
    $('#overall').textContent = 'Gemini оценивает фото… обычно 10–20 секунд.';
    $('#cats').innerHTML = '';
    showExtras(false);
  }
  function failed(msg) {
    $('#psl').textContent = '—';
    $('#tier').textContent = '';
    $('#overall').className = 'status error';
    $('#overall').textContent = msg + ' Без ИИ рейт не ставится; замеры сайта — ниже.';
    $('#cats').innerHTML = '';
    showExtras(false);
  }
  function render(out, res, gender) {
    const psl = calibrated(out.psl, gender);
    $('#psl').textContent = psl.toFixed(2);
    $('#tier').textContent = FR.scoring.tierFor(psl, gender);
    $('#overall').className = 'muted';
    $('#overall').textContent = `Оценка Gemini: он смотрит на лицо целиком и учитывает замеры сайта. По одним замерам — ${res.psl.toFixed(2)} (${res.tier}).`;
    $('#cats').innerHTML = CATS.filter(([k]) => typeof out.categories[k] === 'number').map(([k, name]) => `
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
    showExtras(true);
  }

  /* Вызывается после каждого анализа */
  async function autoRate() {
    if (!active()) return;
    const st = FR.app.state;
    if (!st.frontal) return;
    const my = ++seq;
    const gender = st.gender;
    lastGender = gender;
    $('#genderNote').hidden = true;
    const res = FR.app.computeResult();
    const body = {
      frontal: jpegB64(st.frontal.canvas, 768),
      profile: st.profile && st.profile.canvas ? jpegB64(st.profile.canvas, 768) : undefined,
      gender,
      kind: st.frontal.kind,
      site: sitePayload(res, gender)
    };
    pending();
    let msg;
    try {
      const r = await fetch(FR.ai.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let out = null;
      try { out = await r.json(); } catch (e) { /* не JSON */ }
      if (my !== seq) return; // пока ждали, начали новый анализ
      if (!r.ok || !out) msg = (out && out.message) || `Сервер ИИ-оценки ответил ошибкой ${r.status}.`;
      else if (!out.ok) msg = 'ИИ не стал оценивать это фото' + (out.reason ? ': ' + out.reason : '.');
      else if (typeof out.psl !== 'number') msg = 'ИИ вернул ответ без балла. Попробуйте ещё раз.';
      else { render(out, res, gender); return; }
    } catch (e) {
      if (my !== seq) return;
      console.warn('ИИ-оценка:', e);
      msg = 'Не удалось связаться с сервером ИИ-оценки. Проверьте интернет и попробуйте ещё раз.';
    }
    failed(msg);
  }

  /* Показывает/прячет то, что относится к ИИ, после отрисовки отчёта */
  function reset() {
    $('#geoCard').hidden = !active() || !FR.app.state.frontal;
    if (!active()) showExtras(false);
  }

  /* Пол сменили после анализа: оценка Gemini была для прежнего пола */
  function genderChanged(g) {
    if (!active() || lastGender === null) return;
    $('#genderNote').hidden = g === lastGender;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const note = $('#aiConsent');
    if (note) note.hidden = !active();
  });

  FR.ai.autoRate = autoRate;
  FR.ai.reset = reset;
  FR.ai.genderChanged = genderChanged;
  FR.ai.active = active;
})();
