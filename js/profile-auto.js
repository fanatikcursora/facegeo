/* ============================================================================
 * profile-auto.js — автоматическая разметка профиля по силуэту.
 *
 * Сетка лица MediaPipe на чистом профиле почти никогда не срабатывает, поэтому
 * точки ищутся по контуру:
 *   1. Сегментация (MediaPipe selfie multiclass): фон / волосы / кожа тела /
 *      кожа лица / одежда. Сначала по всему кадру, потом ещё раз по вырезанной
 *      голове — так контур получается точнее.
 *   2. Передний контур лица: в каждой строке — первая точка человека со стороны,
 *      куда смотрит лицо. Положение уточняется по перепаду цвета на самом фото.
 *   3. Точки — это выступы и впадины контура сверху вниз: лоб, переносица,
 *      кончик носа, основание носа, губы, складка, подбородок.
 *   4. Угол челюсти и ветвь по силуэту не видны: они ставятся по средним
 *      пропорциям лица и ждут ручной правки.
 * Результат — черновик: его можно поправить мышью.
 * ========================================================================== */
(function () {
  const G = FR.geo;
  const BG = 0, HAIR = 1, BODY = 2, FACE = 3;
  const WORK = 512; // сторона рабочего квадрата с головой

  function segment(segmenter, canvas) {
    const res = segmenter.segment(canvas);
    const m = res.categoryMask;
    const out = { w: m.width, h: m.height, d: new Uint8Array(m.getAsUint8Array()) };
    if (res.close) res.close();
    return out;
  }

  function faceBox(seg) {
    let x0 = seg.w, y0 = seg.h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < seg.h; y++) for (let x = 0; x < seg.w; x++) {
      if (seg.d[y * seg.w + x] !== FACE) continue;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return n > 30 ? { x0, y0, x1, y1, n } : null;
  }

  /* Точка контура между a и b, дальше всего отстоящая от хорды a→b */
  function elbow(pts, a, b) {
    let best = a, bd = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(G.pointLine2(pts[i], pts[a], pts[b]));
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  }

  /* Причина последнего отказа — видна в консоли: FR.profileAuto.lastFail */
  function fail(reason) { FR.profileAuto.lastFail = reason; return null; }

  function detect(segmenter, canvas) {
    /* ---- 1. где голова ---- */
    const s1 = segment(segmenter, canvas);
    const b1 = faceBox(s1);
    if (!b1) return fail('на фото не найдена кожа лица');
    const kx = canvas.width / s1.w, ky = canvas.height / s1.h;
    const fw = (b1.x1 - b1.x0 + 1) * kx, fh = (b1.y1 - b1.y0 + 1) * ky;
    const side = Math.max(fw, fh) * 1.7;
    const cx = (b1.x0 + b1.x1 + 1) / 2 * kx, cy = (b1.y0 + b1.y1 + 1) / 2 * ky;
    const crop = { x: cx - side / 2, y: cy - side / 2, s: side };

    const work = document.createElement('canvas'); work.width = WORK; work.height = WORK;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.fillStyle = '#808080'; wctx.fillRect(0, 0, WORK, WORK);
    wctx.drawImage(canvas, crop.x, crop.y, crop.s, crop.s, 0, 0, WORK, WORK);

    /* ---- 2. сегментация головы крупным планом ---- */
    const s2 = segment(segmenter, work);
    const mk = s2.w / WORK;
    const cls = (x, y) => {
      const mx = Math.min(s2.w - 1, Math.max(0, Math.floor(x * mk)));
      const my = Math.min(s2.h - 1, Math.max(0, Math.floor(y * mk)));
      return s2.d[my * s2.w + mx];
    };

    // куда смотрит лицо: кожа лица впереди волос и шеи
    let fx = 0, fn = 0, ox = 0, on = 0;
    for (let y = 0; y < s2.h; y++) for (let x = 0; x < s2.w; x++) {
      const c = s2.d[y * s2.w + x];
      if (c === FACE) { fx += x; fn++; } else if (c === HAIR || c === BODY) { ox += x; on++; }
    }
    if (fn < 200) return fail('лицо слишком мелкое');
    const dir = on > 50 ? Math.sign(fx / fn - ox / on) || -1 : -1; // +1 — смотрит вправо
    const facingRight = dir > 0;

    /* ---- 3. передний контур ---- */
    const px = wctx.getImageData(0, 0, WORK, WORK).data;
    const lumGrad = (x, y) => { // перепад цвета по горизонтали, усреднённый по 3 строкам
      let g = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(WORK - 1, Math.max(0, y + dy));
        const a = (yy * WORK + Math.min(WORK - 1, x + 1)) * 4, b = (yy * WORK + Math.max(0, x - 1)) * 4;
        g += Math.abs(px[a] - px[b]) + Math.abs(px[a + 1] - px[b + 1]) + Math.abs(px[a + 2] - px[b + 2]);
      }
      return g;
    };
    const rows = []; // { y, x, c } — по одной точке на строку
    const start = facingRight ? WORK - 1 : 0, step = facingRight ? -1 : 1;
    for (let y = 0; y < WORK; y++) {
      let x = start, c = BG;
      for (; x >= 0 && x < WORK; x += step) { c = cls(x, y); if (c !== BG) break; }
      if (c === BG) { rows.push(null); continue; }
      // уточнение по фото: ищем самый резкий перепад рядом с границей маски
      const R = Math.ceil(2 / mk);
      let bx = x, bg = -1;
      for (let xx = Math.max(1, x - R); xx <= Math.min(WORK - 2, x + R); xx++) {
        const g = lumGrad(xx, y);
        if (g > bg) { bg = g; bx = xx; }
      }
      rows.push({ y, x: bx, c });
    }
    // сглаживание: медиана по 5 строкам
    const sm = rows.map((r, i) => {
      if (!r) return null;
      const v = [];
      for (let k = -2; k <= 2; k++) if (rows[i + k]) v.push(rows[i + k].x);
      v.sort((a, b) => a - b);
      return { y: r.y, x: v[v.length >> 1], c: r.c };
    });

    // строки лица: первая и последняя, где спереди — кожа лица
    let yTop = -1, yBot = -1;
    for (let y = 0; y < WORK; y++) if (sm[y] && sm[y].c === FACE) { if (yTop < 0) yTop = y; yBot = y; }
    if (yTop < 0 || yBot - yTop < 60) return fail('передний контур лица не найден');

    const f = (y) => (sm[y] ? dir * sm[y].x : -Infinity); // больше — точка выступает сильнее вперёд
    const clampY = (y) => Math.max(0, Math.min(WORK - 1, Math.round(y)));
    const argmax = (a, b) => { let by = clampY(a), bv = -Infinity; for (let y = clampY(a); y <= clampY(b); y++) if (f(y) > bv) { bv = f(y); by = y; } return by; };
    const P = (y) => [sm[y].x, y];
    const elbowY = (ya, yb) => {
      const pts = [];
      for (let y = ya; y <= yb; y++) if (sm[y]) pts.push(P(y));
      if (pts.length < 3) return ya;
      return pts[elbow(pts, 0, pts.length - 1)][1];
    };

    /* ---- 4. точки по выступам и впадинам ---- */
    const span = yBot - yTop;
    let prn = argmax(yTop + span * 0.25, yBot - span * 0.25);
    { // кончик носа обычно даёт плоскую площадку из нескольких строк — берём её середину
      let b = prn;
      while (sm[b + 1] && f(b + 1) >= f(prn)) b++;
      prn = Math.round((prn + b) / 2);
    }
    const D = yBot - prn; // кончик носа → низ подбородка: единица длины для окон поиска
    if (D < 30) return fail('кончик носа не найден');
    // Переносица — самая глубокая впадина под прямой «лоб → кончик носа».
    // Просто «самая задняя точка» не годится: покатый лоб у линии волос уходит ещё дальше назад.
    const yA = clampY(Math.max(yTop + span * 0.03, prn - 0.85 * D));
    const depth = (y, ya, yb) => { // насколько точка контура позади хорды ya→yb (плюс — позади)
      const t = (y - ya) / (yb - ya);
      return (f(ya) + (f(yb) - f(ya)) * t) - f(y);
    };
    let n = yA, nd = -Infinity;
    for (let y = clampY(prn - 0.8 * D); y <= clampY(prn - 0.25 * D); y++) {
      if (y <= yA || !sm[y]) continue;
      const d = depth(y, yA, prn);
      if (d > nd) { nd = d; n = y; }
    }
    // Глабелла — точка лба, сильнее всего выступающая над прямой «верх лба → переносица».
    let g = clampY(n - 0.2 * D), gd = -Infinity;
    for (let y = yA + 1; y < n - 0.05 * D; y++) {
      if (!sm[y]) continue;
      const d = -depth(y, yA, n);
      if (d > gd) { gd = d; g = y; }
    }
    if (g >= n) g = clampY(n - 0.2 * D);
    /* Ниже кончика носа контур идёт волной: впадина у основания носа → верхняя губа →
     * смыкание губ → нижняя губа → складка → подбородок → резкий уход назад, к шее. */
    let yEnd = Math.min(WORK - 1, Math.round(yBot + 0.2 * D));
    while (yEnd > prn && !sm[yEnd]) yEnd--;

    // Ментон — низ подбородка: строка перед самым большим скачком контура назад (дальше шея).
    let me = -1, jump = 4;
    for (let y = clampY(prn + 0.5 * D); y < yEnd; y++) {
      if (!sm[y] || !sm[y + 1]) continue;
      const d = f(y) - f(y + 1);
      if (d > jump) { jump = d; me = y; }
    }
    if (me < 0) me = Math.min(yBot, yEnd);
    const H = me - prn; // кончик носа → ментон

    // Выступы и впадины по порядку сверху вниз. Порог h отсекает рябь: выступ засчитан,
    // когда контур отошёл от него назад больше чем на h. Плато берём по середине.
    const wave = (h) => {
      const out = [];
      let lookMax = false, mx = -Infinity, mxA = prn, mxB = prn, mn = f(prn), mnA = prn, mnB = prn;
      for (let y = prn + 1; y <= me; y++) {
        if (!sm[y]) continue;
        const v = f(y);
        if (v > mx) { mx = v; mxA = y; mxB = y; } else if (v === mx) mxB = y;
        if (v < mn) { mn = v; mnA = y; mnB = y; } else if (v === mn) mnB = y;
        if (lookMax) {
          if (v < mx - h) { out.push({ y: Math.round((mxA + mxB) / 2), max: true }); mn = v; mnA = y; mnB = y; lookMax = false; }
        } else if (v > mn + h) { out.push({ y: Math.round((mnA + mnB) / 2), max: false }); mx = v; mxA = y; mxB = y; lookMax = true; }
      }
      return out;
    };
    // Губы — два выступа в средней части отрезка «нос → подбородок». Берём самый мелкий
    // порог, при котором их ровно два; если губы сливаются в один выступ — делим его пополам.
    const inLips = (p) => p.max && p.y > prn + 0.18 * H && p.y < prn + 0.64 * H;
    let ls, li;
    for (const h of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5]) {
      const lips = wave(h).filter(inLips);
      if (lips.length === 2) { ls = lips[0].y; li = lips[1].y; break; }
      if (lips.length < 2) {
        const c = lips.length ? lips[0].y : clampY(prn + 0.42 * H);
        ls = clampY(c - 0.07 * H); li = clampY(c + 0.07 * H);
        break;
      }
    }
    if (ls === undefined) return fail('губы на контуре не различимы');

    // Основание носа — самая глубокая точка под прямой «кончик носа → верхняя губа»:
    // там нижняя поверхность носа переходит в губу.
    const deepest = (ya, yb, sign) => { // sign +1: глубже всего позади хорды; −1: дальше всего впереди
      let best = clampY((ya + yb) / 2), bd = -Infinity;
      for (let y = ya + 1; y < yb; y++) {
        if (!sm[y]) continue;
        const d = sign * depth(y, ya, yb);
        if (d > bd) { bd = d; best = y; }
      }
      return best;
    };
    const sn = deepest(prn, ls, 1);
    // Колумелла — точка нижней поверхности носа на полпути (по горизонтали) от излома под кончиком до основания.
    const tipBreak = elbowY(prn, sn);
    const midX = (sm[tipBreak].x + sm[sn].x) / 2;
    let cm = Math.max(prn + 1, sn - 1), cd = Infinity;
    for (let y = Math.max(prn + 1, tipBreak); y < sn; y++) {
      if (!sm[y]) continue;
      const d = Math.abs(sm[y].x - midX);
      if (d < cd) { cd = d; cm = y; }
    }
    // Погонион — точка подбородка, сильнее всего выступающая над прямой «нижняя губа → ментон».
    // (Просто «самая передняя точка» не годится: у скошенного подбородка выступа вперёд нет.)
    const pg = deepest(li, me, -1);
    // Складка — самая глубокая точка между нижней губой и погонионом.
    const sl = deepest(li, pg, 1);

    const order = [g, n, prn, cm, sn, ls, li, sl, pg, me];
    for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1] || !sm[order[i]]) return fail('точки контура идут не по порядку: ' + order.join(','));

    /* ---- 5. угол челюсти ----
     * По силуэту его не видно (он внутри контура), а граница «лицо/шея» у модели
     * неточная. Поэтому: ставим точку по средним пропорциям лица и сдвигаем к излому
     * границы «кожа лица / шея», только если он рядом. Это заготовка под ручную правку. */
    const nP = P(n), meP = P(me);
    const L = G.d2(nP, meP);                                  // переносица → ментон
    const u = [(meP[0] - nP[0]) / L, (meP[1] - nP[1]) / L];   // вниз вдоль лица
    let v = [u[1], -u[0]];                                    // поперёк лица
    if (v[0] * dir > 0) v = [-v[0], -v[1]];                   // …в сторону затылка
    const at = (a, b) => [nP[0] + u[0] * L * a + v[0] * L * b, nP[1] + u[1] * L * a + v[1] * L * b];
    let go = at(0.80, 0.62);
    const jaw = [];
    for (let mx = Math.floor(meP[0] * mk); mx >= 0 && mx < s2.w; mx -= dir) {
      let low = -1;
      for (let my = s2.h - 1; my >= 0; my--) if (s2.d[my * s2.w + mx] === FACE) { low = my; break; }
      if (low < 0) { if (jaw.length > 8) break; continue; }
      if (Math.abs((mx + 0.5) / mk - meP[0]) > L) break;
      jaw.push([(mx + 0.5) / mk, (low + 1) / mk]);
    }
    if (jaw.length > 12) {
      const e = jaw[elbow(jaw, 0, jaw.length - 1)];
      if (G.d2(e, go) < 0.12 * L) go = e;
    }
    const tr = [go[0] - u[0] * L * 0.40 + v[0] * L * 0.07, go[1] - u[1] * L * 0.40 + v[1] * L * 0.07];

    /* ---- 6. обратно в координаты фото ---- */
    const k = crop.s / WORK;
    const out = (p) => [crop.x + p[0] * k, crop.y + p[1] * k];
        const pts = {
      g: out(P(g)), n: out(P(n)), prn: out(P(prn)), cm: out(P(cm)), sn: out(P(sn)),
      ls: out(P(ls)), li: out(P(li)), sl: out(P(sl)), pg: out(P(pg)), me: out(P(me)),
      go: out(go), tr: out(tr)
    };
    return { pts, facingRight, contour: sm.filter(Boolean).map((r) => out([r.x, r.y])) };
  }

  FR.profileAuto = { detect };
})();
