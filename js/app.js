/* app.js — интерфейс: загрузка фото, запуск модели, отрисовка отчёта. */
(function () {
  const MP_VER = '0.10.14';
  const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  const $ = (s) => document.querySelector(s);
  const state = { gender: 'm', files: { frontal: null, profile: null }, frontal: null, skin: null, profile: null };
  const SEG_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
  let landmarker = null, segmenter = null, mp = null;

  function status(text, isError) {
    const el = $('#status');
    el.textContent = text || '';
    el.className = isError ? 'status error' : 'status';
  }

  async function loadMediaPipe() {
    if (mp) return mp;
    const vision = await import(`${MP_URL}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    mp = { vision, fileset };
    return mp;
  }

  /* На телефонах две модели сразу могут не поместиться в память, поэтому в памяти держится
   * только одна. Если модель не запускается на процессоре (CPU), пробуем видеокарту (GPU). */
  async function createTask(make, label) {
    let lastErr;
    for (const delegate of ['CPU', 'GPU']) {
      try { return await make(delegate); } catch (e) { lastErr = e; console.warn(label + ' не запустилась (' + delegate + '):', e); }
    }
    throw lastErr;
  }
  function closeLandmarker() { if (landmarker) { try { landmarker.close(); } catch (e) { /* уже закрыта */ } landmarker = null; } }
  function closeSegmenter() { if (segmenter) { try { segmenter.close(); } catch (e) { /* уже закрыта */ } segmenter = null; } }

  async function getLandmarker() {
    if (landmarker) return landmarker;
    closeSegmenter();
    status('Загружаю модель лица (~10 МБ, потом берётся из кэша)…');
    const { vision, fileset } = await loadMediaPipe();
    landmarker = await createTask((delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'IMAGE', numFaces: 1, outputFaceBlendshapes: true
    }), 'Модель лица');
    return landmarker;
  }

  /* Модель сегментации нужна только для профиля: по ней строится контур лица */
  async function getSegmenter() {
    if (segmenter) return segmenter;
    closeLandmarker();
    status('Загружаю модель контура (~16 МБ, потом берётся из кэша)…');
    const { vision, fileset } = await loadMediaPipe();
    segmenter = await createTask((delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_URL, delegate },
      runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false
    }), 'Модель контура');
    return segmenter;
  }

  /* Обрезает фото профиля до головы, чтобы точки было удобно двигать */
  function cropToFace(mark, pc) {
    if (!mark.pts) return Object.assign(mark, { canvas: pc });
    const xs = Object.values(mark.pts).map((p) => p[0]), ys = Object.values(mark.pts).map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(w, h) * 0.35;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const x1 = Math.min(pc.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(pc.height, Math.ceil(Math.max(...ys) + pad));
    const c = document.createElement('canvas');
    c.width = x1 - x0; c.height = y1 - y0;
    c.getContext('2d').drawImage(pc, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    const pts = {};
    for (const id in mark.pts) pts[id] = [mark.pts[id][0] - x0, mark.pts[id][1] - y0];
    return Object.assign({}, mark, { pts, canvas: c });
  }

  /* Черновая разметка профиля: контур → сетка лица → три касания */
  async function markProfile(pc) {
    let reason;
    try {
      const auto = FR.profileAuto.detect(await getSegmenter(), pc);
      if (auto) return { pts: auto.pts, mode: 'contour', unsure: auto.unsure, foreheadHidden: auto.foreheadHidden, gUnderHair: auto.gUnderHair };
      reason = FR.profileAuto.lastFail || 'контур не распознан';
    } catch (e) {
      console.warn('Контур профиля не построен:', e);
      reason = 'модель контура не запустилась на этом устройстве (' + (e && e.message ? e.message : String(e)) + ')';
    }
    try {
      await getLandmarker();
      const pd = detect(pc);
      if (pd && FR.profile.sideness(pd.lms) > 0.45) return { pts: FR.profile.fromLandmarks(pd.lms, pc.width, pc.height), mode: 'mesh', unsure: ['go', 'tr'] };
    } catch (e) { console.warn('Сетка лица на профиле не построена:', e); }
    return { pts: null, mode: 'taps', reason };
  }

  async function toCanvas(source, maxSide) {
    const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
    const k = Math.min(1, (maxSide || 1600) / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  function detect(canvas) {
    const res = landmarker.detect(canvas);
    if (!res.faceLandmarks || !res.faceLandmarks.length) return null;
    const blend = {};
    if (res.faceBlendshapes && res.faceBlendshapes[0]) {
      for (const c of res.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
    }
    return { lms: res.faceLandmarks[0], blend };
  }

  /* ------------------------------------------------------------------ анализ */
  /* Всё, что считается по фото анфас: точки → замеры, кожа, чёткость челюсти */
  function measureFrontal(fc) {
    const fd = detect(fc);
    if (!fd) return null;
    const m = FR.frontal.measure(fd.lms, fc.width, fc.height, fd.blend);
    // Рисунок или чёрно-белое фото: по ним кожу не оценить, а по рисунку — ещё и размеры
    const look = FR.skin.colorStats(fc, m.viz.P);
    const kind = look.drawing ? 'drawing' : look.gray ? 'gray' : 'photo';
    const skin = kind === 'photo' ? FR.skin.analyze(fc, m.viz.P, m.ipdImg) : null;
    const jawDef = kind === 'drawing' ? null : FR.skin.jawDefinition(fc, m.viz.P, m.ipdImg);
    const values = Object.assign({}, m.values, skin ? skin.values : {});
    if (jawDef !== null) values.jawDef = jawDef;
    // на рисунке вместо кожи — штрихи на щеках: так рисуют морщины, мешки и высыпания
    if (kind === 'drawing') {
      const marks = FR.skin.drawingMarks(fc, m.viz.P, m.ipdImg);
      if (marks !== null) values.drawMarks = marks;
    }
    // Если масштаб по радужке снят плохо (или это рисунок), миллиметрам верить нельзя —
    // костную массу не считаем.
    if (kind === 'drawing' || values.ipdMm < 54 || values.ipdMm > 72) {
      for (const id of ['bizygMm', 'bigonialMm', 'chinWidthMm', 'faceHeightMm']) delete values[id];
    }
    // на рисунке щёки и скулы нарисованы условно — их выраженность по рисунку не меряем
    if (kind === 'drawing') delete values.cheekProm;
    return { canvas: fc, m, skin, values, kind };
  }

  async function analyze(frontalSrc, profileSrc) {
    try {
      $('#go').disabled = true;
      await getLandmarker();

      status('Ищу точки лица и считаю замеры…');
      const fc = await toCanvas(frontalSrc);
      const fr = measureFrontal(fc);
      if (!fr) { $('#report').hidden = true; status('На фото анфас лицо не найдено. Нужно чёткое фото лица прямо, при ровном свете.', true); return; }
      if (Math.abs(fr.m.pose.yaw) > 15) {
        $('#report').hidden = true;
        status(`Голова повёрнута вбок на ${Math.abs(fr.m.pose.yaw).toFixed(0)}° — это не анфас, замеры были бы неверными. Загрузите фото, где лицо смотрит прямо в камеру.`, true);
        return;
      }
      state.frontal = fr;
      state.skin = fr.skin;
      const m = fr.m;

      state.profile = null;
      if (profileSrc) {
        status('Размечаю профиль…');
        const pc = await toCanvas(profileSrc, 1200);
        const mark = cropToFace(await markProfile(pc), pc);
        // confirmed — точки стоят осмысленно и профиль можно считать;
        // unsure — точки, которые по фото не найти: замеры по ним ждут, пока человек их поставит
        state.profile = {
          full: pc, canvas: mark.canvas, pts: mark.pts, mode: mark.mode, reason: mark.reason || '',
          foreheadHidden: !!mark.foreheadHidden, gUnderHair: !!mark.gUnderHair,
          unsure: new Set(mark.unsure || []), taps: [], skipped: {},
          confirmed: mark.mode !== 'taps'
        };
      }
      status('');
      renderReport();
    } catch (e) {
      console.error(e);
      status('Ошибка: ' + (e && e.message ? e.message : e), true);
    } finally {
      $('#go').disabled = !state.files.frontal;
    }
  }

  function computeResult() {
    const values = Object.assign({}, state.frontal.values);
    const p = state.profile;
    if (p) p.skipped = {};
    if (p && p.confirmed && p.pts) {
      const pv = FR.profile.compute(p.pts, state.frontal.m.lowerThirdMm);
      for (const [metric, needs] of Object.entries(FR.profile.METRIC_POINTS)) {
        const missing = needs.filter((id) => p.unsure.has(id));
        if (missing.length) { p.skipped[metric] = { missing }; delete pv[metric]; }
      }
      for (const metric of FR.profile.implausible(pv)) { p.skipped[metric] = { implausible: true }; delete pv[metric]; }
      Object.assign(values, pv);
    }
    return FR.scoring.total(values, state.gender, { drawing: state.frontal.kind === 'drawing' });
  }

  /* ------------------------------------------------------------------ отчёт */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, dec) => v.toFixed(dec);
  const scoreClass = (s) => (s >= 0.8 ? 'good' : s >= 0.5 ? 'mid' : 'bad');

  /* Доля людей с меньшим z при нормальном распределении */
  function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function idealText(def, g) {
    const [lo, hi] = def.ideal[g];
    const u = def.unit || '';
    if (lo === 0 && def.cat !== 'profile') return `до ${hi}${u}`;
    return `${lo}–${hi}${u}`.replace('–-', '…-');
  }

  function rowNote(r) {
    if (r.dir === 0) return 'в идеале';
    return r.dir < 0 ? 'ниже идеала' : 'выше идеала';
  }

  function renderScores() {
    const res = computeResult();
    const g = state.gender;

    $('#psl').textContent = res.psl.toFixed(2);
    $('#tier').textContent = res.tier;
    const pct = normalCdf(res.z) * 100;
    const pctText = pct > 99.5 ? 'более 99%' : pct < 0.5 ? 'менее 1%' : `примерно ${pct.toFixed(0)}%`;
    $('#overall').textContent = `Итог ${(res.overall * 100).toFixed(0)}% — на ${Math.abs(res.z).toFixed(1)} σ ${res.z >= 0 ? 'выше' : 'ниже'} среднего человека. По этим замерам лицо лучше, чем у ${pctText} людей из калибровочной выборки.`
      + (res.imputed.length ? ` По этому фото не оценить: ${res.imputed.join(', ').toLowerCase()} — вместо них взято среднее по выборке.` : '');

    $('#cats').innerHTML = res.cats.map((c) => `
      <div class="cat">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="bar"><i class="${scoreClass(c.score)}" style="width:${(c.score * 100).toFixed(0)}%"></i></span>
        <span class="cat-num">${(c.score * 10).toFixed(1)}</span>
      </div>`).join('');

    const li = (r) => `<li><b>${esc(r.def.name)}</b> — ${fmt(r.value, r.def.dec)}${r.def.unit || ''} (${rowNote(r)}, идеал ${idealText(r.def, g)})</li>`;
    $('#worst').innerHTML = res.worst.map(li).join('');
    $('#best').innerHTML = res.best.map(li).join('');

    $('#tables').innerHTML = res.cats.map((c) => `
      <h3>${esc(c.name)} <span class="h-score">${(c.score * 10).toFixed(1)} / 10</span></h3>
      <table>
        <thead><tr><th>Замер</th><th>Значение</th><th>Идеал</th><th>Балл</th></tr></thead>
        <tbody>${c.rows.map((r) => `
          <tr>
            <td><div class="m-name">${esc(r.def.name)}</div><div class="m-desc">${esc(r.def.desc)}</div></td>
            <td class="num">${fmt(r.value, r.def.dec)}${r.def.unit || ''}</td>
            <td class="num">${idealText(r.def, g)}</td>
            <td class="num ${r.w > 0 ? scoreClass(r.score) : 'muted'}">${r.w > 0 ? (r.score * 10).toFixed(1) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('');
    if (state.profile) profileStateText();
  }

  function renderReport() {
    const { canvas, m } = state.frontal;
    $('#report').hidden = false;

    // предупреждения
    let warns = m.warnings.slice();
    const kind = state.frontal.kind;
    if (kind === 'drawing') {
      // про масштаб по радужке на рисунке говорить незачем: миллиметры и так не считаются
      warns = warns.filter((w) => !w.startsWith('Межзрачковое'));
      warns.unshift('Похоже, это рисунок, а не фото. Для рисунков своя шкала, подогнанная по мем-таблице тиров. Вместо кожи считаются нарисованные морщины и пятна; размеры в миллиметрах и тень под челюстью не считаются. Выражение лица и причёска не учитываются, поэтому рисунки, которые отличаются в основном ими, различаются плохо.');
    } else if (kind === 'gray') warns.push('Фото чёрно-белое: кожу по нему оценить нельзя, она не учитывается.');
    else if (!state.skin) warns.push('Кожу оценить не удалось: слишком мало чистой кожи в кадре.');
    else if (state.skin.upscaled) warns.push('Фото небольшое — мелкие высыпания могут быть не видны, оценка кожи завышена.');
    if (!state.profile) warns.push('Профиль не загружен — челюсть сбоку, нос и подбородок в профиль не оценены.');
    $('#warnings').innerHTML = warns.map((w) => `<li>${esc(w)}</li>`).join('');
    $('#warnbox').hidden = !warns.length;
    $('#pose').textContent = `Поворот головы: вбок ${m.pose.yaw.toFixed(0)}°, наклон ${m.pose.pitch.toFixed(0)}°, завал ${m.pose.roll.toFixed(0)}°. Масштаб: ${(m.mmPerPx).toFixed(3)} мм/пиксель.`;

    // анфас с линиями
    const fo = $('#frontalCanvas');
    fo.width = canvas.width; fo.height = canvas.height;
    const fctx = fo.getContext('2d');
    fctx.drawImage(canvas, 0, 0);
    FR.frontal.draw(fctx, m);

    // кожа
    $('#skinBox').hidden = !state.skin;
    if (state.skin) {
      const sc = $('#skinCanvas');
      sc.width = state.skin.canvas.width; sc.height = state.skin.canvas.height;
      sc.getContext('2d').drawImage(state.skin.canvas, 0, 0);
      $('#skinNote').textContent = `Найдено: красных очагов — ${state.skin.redCount}, тёмных точек и пятен — ${state.skin.darkCount}. Затемнённые зоны в расчёт не входят.`
        + (state.skin.stubble ? ' Внизу лица щетина: тёмные точки там не учитываются.' : '');
    }

    // профиль
    $('#profileBox').hidden = !state.profile;
    if (state.profile) setupProfileEditor();

    renderScores();
    if (FR.ai) FR.ai.reset();
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* -------------------------------------------------- редактор точек профиля */
  const TAP_STEPS = [
    'кончика носа',
    'самой нижней точки подбородка',
    'угла нижней челюсти — под ухом, где челюсть поворачивает вверх'
  ];
  const pointCode = (id) => (FR.profile.POINTS.find((p) => p.id === id) || { code: id }).code;
  const metricName = (id) => (FR.config.metrics.find((m) => m.id === id) || { name: id }).name;

  let activePoint = null;
  function redrawProfile() {
    const p = state.profile, pc = $('#profileCanvas'), ctx = pc.getContext('2d');
    if (p.pts) { FR.profile.draw(ctx, p.canvas, p.pts, activePoint, p.unsure); return; }
    ctx.drawImage(p.canvas, 0, 0, pc.width, pc.height);
    const s = Math.max(1, pc.width / 520);
    for (const t of p.taps) {
      ctx.beginPath(); ctx.arc(t[0], t[1], 6 * s, 0, 7);
      ctx.fillStyle = '#ffd43b'; ctx.fill(); ctx.lineWidth = 2 * s; ctx.strokeStyle = '#000'; ctx.stroke();
    }
  }

  function setupProfileEditor() {
    const p = state.profile;
    const pc = $('#profileCanvas');
    pc.width = p.canvas.width; pc.height = p.canvas.height;
    let hint;
    if (!p.pts) {
      hint = (p.reason ? 'Автоматически найти контур лица не получилось: ' + p.reason + '. ' : '')
        + 'Коснитесь на фото трёх мест по очереди — остальные точки встанут сами, потом их можно подвинуть.';
    } else if (p.mode === 'taps') {
      hint = 'Точки расставлены по средним пропорциям лица. Перетащите каждую на своё место (что где — в списке под фото) и нажмите «Точки на местах».';
    } else {
      hint = 'Точки расставлены автоматически по контуру лица. Проверьте их и перетащите, если стоят не там.';
      if (p.foreheadHidden) hint += ' Лоб закрыт волосами, поэтому G (середина лба между бровями) и N (переносицу) поставьте сами.';
      else if (p.gUnderHair) hint += ' Лоб под волосами: его линия восстановлена по коже под чёлкой — проверьте G и N.';
      hint += ' Угол челюсти (Go) и ветвь челюсти (Tr) по контуру не видны — поставьте их сами. Точки, которые ждут вас, отмечены фиолетовым.';
    }
    $('#profileHint').textContent = hint;
    $('#confirmProfile').hidden = p.confirmed || !p.pts;
    $('#pointList').innerHTML = FR.profile.POINTS.map((pt) => `<li><b>${pt.code}</b> — ${esc(pt.name)}: ${esc(pt.hint)}</li>`).join('');
    profileStateText();
    redrawProfile();
  }

  /* Что из профиля учтено, а что нет и почему */
  function profileStateText() {
    const p = state.profile, el = $('#profileState');
    if (!p.pts) { el.textContent = `Шаг ${p.taps.length + 1} из 3: коснитесь ${TAP_STEPS[p.taps.length]}.`; return; }
    if (!p.confirmed) { el.textContent = 'Профиль пока не учитывается в оценке: поставьте точки на места и нажмите «Точки на местах».'; return; }
    const byPoints = {}, bad = [];
    for (const [metric, why] of Object.entries(p.skipped || {})) {
      if (why.implausible) { bad.push(metric); continue; }
      const key = why.missing.map(pointCode).join(' и ');
      (byPoints[key] = byPoints[key] || []).push(metric);
    }
    const parts = Object.entries(byPoints).map(([pts, ms]) => `${ms.map(metricName).join(', ')} — поставьте ${pts}`);
    if (bad.length) parts.push(`${bad.map(metricName).join(', ')} — значение невозможное для человека, точки стоят не там`);
    el.textContent = parts.length ? 'Профиль учтён, кроме: ' + parts.join('; ') + '.' : 'Профиль учтён полностью.';
  }

  /* Три касания → остальные точки по средним пропорциям */
  function placeFromTaps() {
    const p = state.profile;
    const pts = FR.profile.fitTemplate(p.taps[0], p.taps[1], p.taps[2]);
    const m = cropToFace({ pts, mode: 'taps' }, p.full);
    p.canvas = m.canvas; p.pts = m.pts;
    p.unsure = new Set(); p.confirmed = false;
    setupProfileEditor();
    renderScores();
  }

  function initProfileEvents() {
    const pc = $('#profileCanvas');
    const pos = (e) => {
      const r = pc.getBoundingClientRect();
      return [(e.clientX - r.left) * pc.width / r.width, (e.clientY - r.top) * pc.height / r.height];
    };
    pc.addEventListener('pointerdown', (e) => {
      const p = state.profile;
      if (!p) return;
      const xy = pos(e);
      if (!p.pts) {
        p.taps.push(xy);
        if (p.taps.length === 3) placeFromTaps(); else { redrawProfile(); profileStateText(); }
        e.preventDefault();
        return;
      }
      const r = pc.getBoundingClientRect();
      const reach = 24 * pc.width / r.width;
      let best = null, bd = reach;
      for (const pt of FR.profile.POINTS) {
        const d = FR.geo.d2(xy, p.pts[pt.id]);
        if (d < bd) { bd = d; best = pt.id; }
      }
      if (best) { activePoint = best; pc.setPointerCapture(e.pointerId); redrawProfile(); e.preventDefault(); }
    });
    pc.addEventListener('pointermove', (e) => {
      if (!activePoint) return;
      state.profile.pts[activePoint] = pos(e);
      redrawProfile();
    });
    const end = () => {
      if (!activePoint) return;
      state.profile.unsure.delete(activePoint);
      activePoint = null;
      redrawProfile();
      renderScores();
    };
    pc.addEventListener('pointerup', end);
    pc.addEventListener('pointercancel', end);

    $('#confirmProfile').addEventListener('click', () => {
      const p = state.profile;
      if (!p || !p.pts) return;
      p.confirmed = true; p.unsure.clear();
      $('#confirmProfile').hidden = true;
      renderScores();
    });

    $('#redoProfile').addEventListener('click', () => {
      const p = state.profile;
      if (!p) return;
      Object.assign(p, { mode: 'taps', reason: '', pts: null, taps: [], canvas: p.full, confirmed: false, unsure: new Set(), foreheadHidden: false, gUnderHair: false });
      setupProfileEditor();
      renderScores();
    });
  }

  /* ---------------------------------------------------------------- загрузка */
  let pasteTarget = null; // куда вставлять из буфера: поле, с которым работали последним

  function setFile(kind, file) {
    if (!file || !file.type.startsWith('image/')) return;
    state.files[kind] = file;
    const img = $(`#${kind}Preview`);
    img.src = URL.createObjectURL(file); img.hidden = false;
    $(`#${kind}Drop`).classList.add('has');
    $('#go').disabled = !state.files.frontal;
    if ($('#status').classList.contains('error')) status('');
  }

  function bindUpload(kind) {
    const input = $(`#${kind}File`), box = $(`#${kind}Drop`);
    input.addEventListener('change', () => setFile(kind, input.files[0]));
    box.addEventListener('pointerdown', () => { pasteTarget = kind; });
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); setFile(kind, e.dataTransfer.files[0]); });
  }

  /* Кнопка «Вставить»: читает картинку из буфера обмена (браузер может спросить разрешение) */
  async function pasteFromClipboard(kind) {
    pasteTarget = kind;
    if (!navigator.clipboard || !navigator.clipboard.read) {
      status('Этот браузер не даёт сайту читать буфер обмена. На компьютере нажмите Ctrl+V, на телефоне выберите фото из галереи.', true);
      return;
    }
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        setFile(kind, new File([blob], 'из-буфера.' + type.split('/')[1], { type }));
        status('');
        return;
      }
      status('В буфере обмена нет картинки. Скопируйте фото (например, «Скопировать» в галерее) и нажмите ещё раз.', true);
    } catch (e) {
      console.warn('Буфер обмена:', e);
      status('Не удалось прочитать буфер обмена. Разрешите сайту доступ, когда браузер спросит, или нажмите Ctrl+V.', true);
    }
  }

  function initPaste() {
    document.querySelectorAll('.paste').forEach((btn) => btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); // кнопка внутри поля загрузки: не открывать выбор файла
      pasteFromClipboard(btn.dataset.kind);
    }));
    // Ctrl+V: картинка идёт в поле, с которым работали последним, иначе — в первое пустое
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const kind = pasteTarget || (state.files.frontal && !state.files.profile ? 'profile' : 'frontal');
      setFile(kind, item.getAsFile());
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Кнопка анализа подключается первой, а остальное — по отдельности: если браузер взял
    // страницу из кэша, а скрипты уже новые, части элементов может не быть, но анализ
    // всё равно должен работать.
    $('#go').addEventListener('click', () => analyze(state.files.frontal, state.files.profile));
    const parts = [
      () => { bindUpload('frontal'); bindUpload('profile'); },
      initPaste,
      initProfileEvents,
      () => document.querySelectorAll('input[name=gender]').forEach((r) => r.addEventListener('change', () => {
        state.gender = r.value;
        if (state.frontal) { renderScores(); if (FR.ai) FR.ai.reset(); }
      }))
    ];
    for (const init of parts) {
      try { init(); } catch (e) { console.warn('Часть страницы не подключилась (страница из кэша старее скриптов?):', e); }
    }
  });

  // для отладки из консоли: FR.app.analyze(blobАнфас, blobПрофиль)
  FR.app = { analyze, state, getLandmarker, getSegmenter, toCanvas, detect, measureFrontal, markProfile, setFile, computeResult };
})();
