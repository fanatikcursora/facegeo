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

  async function getLandmarker() {
    if (landmarker) return landmarker;
    status('Загружаю модель лица (один раз, ~10 МБ)…');
    const { vision, fileset } = await loadMediaPipe();
    landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 1, outputFaceBlendshapes: true
    });
    return landmarker;
  }

  /* Модель сегментации нужна только для профиля: по ней строится контур лица */
  async function getSegmenter() {
    if (segmenter) return segmenter;
    status('Загружаю модель контура (один раз, ~16 МБ)…');
    const { vision, fileset } = await loadMediaPipe();
    segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_URL, delegate: 'CPU' },
      runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false
    });
    return segmenter;
  }

  /* Обрезает фото профиля до головы, чтобы точки было удобно двигать */
  function cropToFace(mark, pc) {
    if (mark.mode === 'manual') return Object.assign(mark, { canvas: pc });
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
    return { pts, mode: mark.mode, canvas: c };
  }

  /* Черновая разметка профиля: контур → сетка лица → шаблон */
  async function markProfile(pc) {
    try {
      const auto = FR.profileAuto.detect(await getSegmenter(), pc);
      if (auto) return { pts: auto.pts, mode: 'contour' };
    } catch (e) { console.warn('Контур профиля не построен:', e); }
    const pd = detect(pc);
    if (pd && FR.profile.sideness(pd.lms) > 0.45) return { pts: FR.profile.fromLandmarks(pd.lms, pc.width, pc.height), mode: 'mesh' };
    return { pts: FR.profile.template(pc.width, pc.height, false), mode: 'manual' };
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
    const skin = FR.skin.analyze(fc, m.viz.P, m.ipdImg);
    const jawDef = FR.skin.jawDefinition(fc, m.viz.P, m.ipdImg);
    const values = Object.assign({}, m.values, skin ? skin.values : {});
    if (jawDef !== null) values.jawDef = jawDef;
    // Если масштаб по радужке снят плохо, миллиметрам верить нельзя — костную массу не считаем.
    if (values.ipdMm < 54 || values.ipdMm > 72) {
      for (const id of ['bizygMm', 'bigonialMm', 'chinWidthMm', 'faceHeightMm']) delete values[id];
    }
    return { canvas: fc, m, skin, values };
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
        // jawConfirmed — человек сам поставил угол челюсти (по контуру его не видно)
        state.profile = { canvas: mark.canvas, pts: mark.pts, mode: mark.mode, confirmed: mark.mode !== 'manual', jawConfirmed: false };
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
    if (state.profile && state.profile.confirmed) {
      const pv = FR.profile.compute(state.profile.pts, state.frontal.m.lowerThirdMm);
      if (!state.profile.jawConfirmed) delete pv.gonial;
      Object.assign(values, pv);
    }
    return FR.scoring.total(values, state.gender);
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
    $('#overall').textContent = `Итог ${(res.overall * 100).toFixed(0)}% — на ${Math.abs(res.z).toFixed(1)} σ ${res.z >= 0 ? 'выше' : 'ниже'} среднего человека. По этим замерам лицо лучше, чем у ${pctText} людей из калибровочной выборки.`;

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
  }

  function renderReport() {
    const { canvas, m } = state.frontal;
    $('#report').hidden = false;

    // предупреждения
    const warns = m.warnings.slice();
    if (!state.skin) warns.push('Кожу оценить не удалось: слишком мало чистой кожи в кадре.');
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
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* -------------------------------------------------- редактор точек профиля */
  let activePoint = null;
  function redrawProfile() {
    const pc = $('#profileCanvas');
    FR.profile.draw(pc.getContext('2d'), state.profile.canvas, state.profile.pts, activePoint);
  }

  function setupProfileEditor() {
    const pc = $('#profileCanvas');
    pc.width = state.profile.canvas.width; pc.height = state.profile.canvas.height;
    $('#profileHint').textContent = state.profile.mode === 'manual'
      ? 'Автоматически разметить профиль не получилось. Перетащите точки на свои места. Если лицо смотрит вправо — нажмите «Отразить».'
      : 'Точки расставлены автоматически по контуру лица. Проверьте их и перетащите, если стоят не там: от этого зависят все углы. Угол челюсти (Go) и ветвь (Tr) по контуру не видны — они стоят в среднем положении, поставьте их сами.';
    $('#flip').hidden = state.profile.mode !== 'manual';
    $('#confirmProfile').hidden = state.profile.confirmed;
    profileStateText();
    $('#pointList').innerHTML = FR.profile.POINTS.map((p) => `<li><b>${p.code}</b> — ${esc(p.name)}: ${esc(p.hint)}</li>`).join('');
    redrawProfile();
  }

  function profileStateText() {
    const p = state.profile;
    $('#profileState').textContent = !p.confirmed
      ? 'Профиль пока не учитывается в оценке: расставьте точки и нажмите кнопку.'
      : p.jawConfirmed
        ? 'Профиль учтён полностью, включая гониальный угол.'
        : 'Профиль учтён, кроме гониального угла: чтобы учесть его, поставьте точки Go и Tr на место.';
  }

  function initProfileEvents() {
    const pc = $('#profileCanvas');
    const pos = (e) => {
      const r = pc.getBoundingClientRect();
      return [(e.clientX - r.left) * pc.width / r.width, (e.clientY - r.top) * pc.height / r.height];
    };
    pc.addEventListener('pointerdown', (e) => {
      if (!state.profile) return;
      const p = pos(e), r = pc.getBoundingClientRect();
      const reach = 22 * pc.width / r.width;
      let best = null, bd = reach;
      for (const pt of FR.profile.POINTS) {
        const d = FR.geo.d2(p, state.profile.pts[pt.id]);
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
      if (activePoint === 'go' || activePoint === 'tr') state.profile.jawConfirmed = true;
      activePoint = null; redrawProfile(); profileStateText(); renderScores();
    };
    pc.addEventListener('pointerup', end);
    pc.addEventListener('pointercancel', end);

    $('#confirmProfile').addEventListener('click', () => {
      if (!state.profile) return;
      state.profile.confirmed = true; state.profile.jawConfirmed = true;
      $('#confirmProfile').hidden = true;
      profileStateText(); renderScores();
    });

    $('#flip').addEventListener('click', () => {
      if (!state.profile) return;
      const W = state.profile.canvas.width;
      for (const id in state.profile.pts) state.profile.pts[id][0] = W - state.profile.pts[id][0];
      redrawProfile(); renderScores();
    });
  }

  /* ---------------------------------------------------------------- загрузка */
  function bindUpload(kind) {
    const input = $(`#${kind}File`), box = $(`#${kind}Drop`), img = $(`#${kind}Preview`);
    const set = (file) => {
      if (!file || !file.type.startsWith('image/')) return;
      state.files[kind] = file;
      img.src = URL.createObjectURL(file); img.hidden = false;
      box.classList.add('has');
      $('#go').disabled = !state.files.frontal;
    };
    input.addEventListener('change', () => set(input.files[0]));
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); set(e.dataTransfer.files[0]); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindUpload('frontal'); bindUpload('profile');
    initProfileEvents();
    document.querySelectorAll('input[name=gender]').forEach((r) => r.addEventListener('change', () => {
      state.gender = r.value;
      if (state.frontal) renderScores();
    }));
    $('#go').addEventListener('click', () => analyze(state.files.frontal, state.files.profile));
  });

  // для отладки из консоли: FR.app.analyze(blobАнфас, blobПрофиль)
  FR.app = { analyze, state, getLandmarker, getSegmenter, toCanvas, detect, measureFrontal, markProfile };
})();
