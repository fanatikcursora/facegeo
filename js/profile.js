/* ============================================================================
 * profile.js — замеры по фото в профиль.
 *
 * На боковом ракурсе автоматические точки неточны, поэтому здесь 12 точек,
 * которые ставятся автоматически как черновик и поправляются мышью/пальцем.
 * Все углы не зависят от наклона головы и масштаба фото.
 * E-линия переводится в мм через высоту нижней трети, снятую с анфаса.
 * ========================================================================== */
(function () {
  const G = FR.geo;

  /* lm — точка MediaPipe для черновой расстановки.
   * f  — среднее положение точки в системе «кончик носа → ментон»: [вдоль, назад] в долях
   *      расстояния prn–me. Снято авторазметкой со 102 профилей Face Research Lab London Set.
   *      По нему точки расставляются после трёх касаний, если автоматика не сработала. */
  const POINTS = [
    { id: 'g',   code: 'G',   name: 'Глабелла',        hint: 'самая выступающая точка лба между бровями', lm: 9,   f: [-0.66, 0.54] },
    { id: 'n',   code: 'N',   name: 'Переносица',      hint: 'самая глубокая точка между лбом и носом',   lm: 168, f: [-0.33, 0.43] },
    { id: 'prn', code: 'Prn', name: 'Кончик носа',     hint: 'самая выступающая вперёд точка носа',       lm: 1,   f: [0, 0] },
    { id: 'cm',  code: 'Cm',  name: 'Колумелла',       hint: 'середина перемычки между кончиком и основанием носа', lm: 19, f: [0.15, 0.07] },
    { id: 'sn',  code: 'Sn',  name: 'Основание носа',  hint: 'где нос переходит в верхнюю губу',          lm: 2,   f: [0.22, 0.13] },
    { id: 'ls',  code: 'Ls',  name: 'Верхняя губа',    hint: 'самая выступающая точка верхней губы',      lm: 0,   f: [0.38, 0.06] },
    { id: 'li',  code: 'Li',  name: 'Нижняя губа',     hint: 'самая выступающая точка нижней губы',       lm: 17,  f: [0.56, 0.03] },
    { id: 'sl',  code: 'Sl',  name: 'Складка',         hint: 'самая глубокая точка между губой и подбородком', lm: 18, f: [0.72, 0.07] },
    { id: 'pg',  code: 'Pg',  name: 'Погонион',        hint: 'самая выступающая вперёд точка подбородка', lm: 199, f: [0.87, -0.01] },
    { id: 'me',  code: 'Me',  name: 'Ментон',          hint: 'самая нижняя точка подбородка',             lm: 152, f: [1, 0] },
    { id: 'go',  code: 'Go',  name: 'Угол челюсти',    hint: 'где челюсть поворачивает вверх к уху',      lm: null, f: [1, 0.91] },
    { id: 'tr',  code: 'Tr',  name: 'Ветвь челюсти',   hint: 'задний край челюсти под мочкой уха',        lm: null, f: [0.5, 1.18] }
  ];

  /* Расстановка по трём касаниям: кончик носа, низ подбородка, угол челюсти.
   * Остальные точки ставятся по средним пропорциям, повёрнутым и масштабированным под
   * эти три. Угол челюсти задаёт, в какую сторону смотрит лицо. */
  function fitTemplate(prn, me, go) {
    const L = G.d2(prn, me) || 1;
    const e1 = [(me[0] - prn[0]) / L, (me[1] - prn[1]) / L];
    let e2 = [-e1[1], e1[0]];
    if ((go[0] - prn[0]) * e2[0] + (go[1] - prn[1]) * e2[1] < 0) e2 = [-e2[0], -e2[1]];
    const at = (f) => [prn[0] + (e1[0] * f[0] + e2[0] * f[1]) * L, prn[1] + (e1[1] * f[0] + e2[1] * f[1]) * L];
    const pts = {};
    for (const p of POINTS) pts[p.id] = at(p.f);
    const goAvg = pts.go;
    pts.prn = prn.slice(); pts.me = me.slice(); pts.go = go.slice();
    // ветвь челюсти сдвигается вместе с углом челюсти
    pts.tr = [pts.tr[0] + go[0] - goAvg[0], pts.tr[1] + go[1] - goAvg[1]];
    return pts;
  }

  /* Какие точки нужны каждому замеру: если хоть одна из них не подтверждена, замер не считается */
  const METRIC_POINTS = {
    gonial: ['tr', 'go', 'me'],
    nasofrontal: ['g', 'n', 'prn'],
    nasolabial: ['cm', 'sn', 'ls'],
    mentolabial: ['li', 'sl', 'pg'],
    convexity: ['g', 'sn', 'pg'],
    eLineUpper: ['prn', 'pg', 'ls'],
    eLineLower: ['prn', 'pg', 'li']
  };

  /* Пределы, за которыми у живого человека значений не бывает: если замер вышел за них,
   * точки стоят неправильно, и такой замер в оценку не идёт. */
  const LIMITS = {
    gonial: [95, 150], nasofrontal: [100, 175], nasolabial: [60, 155], mentolabial: [70, 175],
    convexity: [140, 185], eLineUpper: [-20, 12], eLineLower: [-18, 14]
  };
  function implausible(v) {
    return Object.keys(LIMITS).filter((k) => v[k] !== undefined && (v[k] < LIMITS[k][0] || v[k] > LIMITS[k][1]));
  }

  function fromLandmarks(lms, W, H) {
    const P = lms.map((l) => [l.x * W, l.y * H]);
    const pts = {};
    for (const p of POINTS) if (p.lm !== null) pts[p.id] = P[p.lm].slice();
    pts.cm = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2]; // колумелла — между кончиком и основанием носа
    // ближняя к камере сторона — у которой точка возле уха ближе (z меньше)
    const left = lms[234].z < lms[454].z;
    const ear = left ? 234 : 454;
    const chain = left ? [132, 58, 172, 136, 150] : [361, 288, 397, 365, 379];
    let best = chain[0], bd = -1;
    for (const i of chain) {
      const d = Math.abs(G.pointLine2(P[i], P[ear], P[152]));
      if (d > bd) { bd = d; best = i; }
    }
    pts.go = P[best].slice();
    pts.tr = [P[ear][0], (P[ear][1] + P[best][1]) / 2 * 0.4 + P[ear][1] * 0.6];
    return pts;
  }

  /* Насколько снимок действительно боковой: 0 — анфас, 1 — чистый профиль */
  function sideness(lms) {
    const dx = lms[454].x - lms[234].x, dz = lms[454].z - lms[234].z;
    return Math.abs(Math.atan2(dz, dx)) / (Math.PI / 2);
  }

  function compute(pts, lowerThirdMm) {
    const v = {};
    v.gonial = G.angle2(pts.tr, pts.go, pts.me);
    v.nasofrontal = G.angle2(pts.g, pts.n, pts.prn);
    v.nasolabial = G.angle2(pts.cm, pts.sn, pts.ls);
    // Точка p впереди линии a→b, если по горизонтали она ближе к носу, чем линия на той же
    // высоте. Куда смотрит лицо, показывает кончик носа относительно ветви челюсти.
    const facingSign = Math.sign(pts.prn[0] - pts.tr[0]) || -1;
    const ahead = (p, a, b) => {
      const dy = b[1] - a[1];
      if (Math.abs(dy) < 1e-6) return false;
      const xLine = a[0] + (b[0] - a[0]) * (p[1] - a[1]) / dy;
      return facingSign * (p[0] - xLine) > 0;
    };
    // Губо-подбородочный угол: обычно складка вдавлена (меньше 180°); если складки нет
    // и контур выпуклый — больше 180°.
    const ml = G.angle2(pts.li, pts.sl, pts.pg);
    v.mentolabial = ahead(pts.sl, pts.li, pts.pg) ? 360 - ml : ml;
    // Выпуклость профиля: меньше 180° — подбородок позади линии «глабелла → основание носа»
    // (выпуклый профиль), больше 180° — впереди неё (вогнутый профиль).
    const cx = G.angle2(pts.g, pts.sn, pts.pg);
    v.convexity = ahead(pts.pg, pts.g, pts.sn) ? 360 - cx : cx;

    // E-линия: кончик носа → погонион. Плюс — губа впереди линии.
    const facing = Math.sign(pts.prn[0] - pts.tr[0]) || -1;
    const m = G.mid(pts.prn, pts.pg);
    const ref = Math.sign(G.pointLine2([m[0] + facing * 50, m[1]], pts.prn, pts.pg)) || 1;
    const scale = lowerThirdMm ? lowerThirdMm / G.d2(pts.sn, pts.me) : 70 / G.d2(pts.sn, pts.me);
    v.eLineUpper = ref * G.pointLine2(pts.ls, pts.prn, pts.pg) * scale;
    v.eLineLower = ref * G.pointLine2(pts.li, pts.prn, pts.pg) * scale;
    return v;
  }

  /* unsure — точки, которые ждут ручной установки: рисуются фиолетовыми с пунктирным кольцом */
  function draw(ctx, img, pts, active, unsure) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const s = Math.max(1, W / 520);
    const line = (ids, color, dash) => {
      ctx.beginPath(); ctx.setLineDash(dash ? [5 * s, 4 * s] : []);
      ids.forEach((id, i) => (i ? ctx.lineTo(pts[id][0], pts[id][1]) : ctx.moveTo(pts[id][0], pts[id][1])));
      ctx.strokeStyle = color; ctx.lineWidth = 1.6 * s; ctx.stroke();
    };
    line(['g', 'n', 'prn'], '#4dabf7');
    line(['cm', 'sn', 'ls'], '#51cf66');
    line(['li', 'sl', 'pg'], '#da77f2');
    line(['tr', 'go', 'me'], '#ff922b');
    line(['g', 'sn', 'pg'], '#ffffff', true);
    line(['prn', 'pg'], '#ffd43b', true);
    ctx.setLineDash([]);
    ctx.font = `${11 * s}px system-ui, sans-serif`;
    // подписи соседних точек разводим по разные стороны от контура, чтобы не слипались
    const front = Math.sign(pts.prn[0] - pts.tr[0]) || -1;
    const outside = { cm: 1, ls: 1, sl: 1, me: 1 };
    for (const p of POINTS) {
      const [x, y] = pts[p.id];
      const side = outside[p.id] ? front : -front;
      ctx.textAlign = side > 0 ? 'left' : 'right';
      const tx = x + side * 8 * s, ty = y + 4 * s;
      const waiting = unsure && unsure.has(p.id);
      if (waiting) {
        ctx.beginPath(); ctx.arc(x, y, 11 * s, 0, 7);
        ctx.setLineDash([3 * s, 3 * s]); ctx.lineWidth = 1.6 * s; ctx.strokeStyle = '#e599f7'; ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(x, y, (p.id === active ? 6 : 4) * s, 0, 7);
      ctx.fillStyle = p.id === active ? '#ffd43b' : waiting ? '#cc5de8' : '#ff3b3b'; ctx.fill();
      ctx.lineWidth = 1.2 * s; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 3 * s; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(p.code, tx, ty);
      ctx.fillStyle = '#fff'; ctx.fillText(p.code, tx, ty);
    }
  }

  FR.profile = { POINTS, METRIC_POINTS, fitTemplate, implausible, fromLandmarks, sideness, compute, draw };
})();
