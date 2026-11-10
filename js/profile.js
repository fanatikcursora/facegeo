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

  /* lm — точка MediaPipe для черновой расстановки; t — место в шаблоне (доли кадра, лицо смотрит влево) */
  const POINTS = [
    { id: 'g',   code: 'G',   name: 'Глабелла',        hint: 'самая выступающая точка лба между бровями', lm: 9,   t: [0.30, 0.27] },
    { id: 'n',   code: 'N',   name: 'Переносица',      hint: 'самая глубокая точка между лбом и носом',   lm: 168, t: [0.33, 0.35] },
    { id: 'prn', code: 'Prn', name: 'Кончик носа',     hint: 'самая выступающая вперёд точка носа',       lm: 1,   t: [0.20, 0.49] },
    { id: 'cm',  code: 'Cm',  name: 'Колумелла',       hint: 'середина перемычки между кончиком и основанием носа', lm: 19, t: [0.25, 0.525] },
    { id: 'sn',  code: 'Sn',  name: 'Основание носа',  hint: 'где нос переходит в верхнюю губу',          lm: 2,   t: [0.29, 0.545] },
    { id: 'ls',  code: 'Ls',  name: 'Верхняя губа',    hint: 'самая выступающая точка верхней губы',      lm: 0,   t: [0.26, 0.61] },
    { id: 'li',  code: 'Li',  name: 'Нижняя губа',     hint: 'самая выступающая точка нижней губы',       lm: 17,  t: [0.27, 0.665] },
    { id: 'sl',  code: 'Sl',  name: 'Складка',         hint: 'самая глубокая точка между губой и подбородком', lm: 18, t: [0.30, 0.705] },
    { id: 'pg',  code: 'Pg',  name: 'Погонион',        hint: 'самая выступающая вперёд точка подбородка', lm: 199, t: [0.28, 0.765] },
    { id: 'me',  code: 'Me',  name: 'Ментон',          hint: 'самая нижняя точка подбородка',             lm: 152, t: [0.33, 0.81] },
    { id: 'go',  code: 'Go',  name: 'Угол челюсти',    hint: 'где челюсть поворачивает вверх к уху',      lm: null, t: [0.60, 0.72] },
    { id: 'tr',  code: 'Tr',  name: 'Ветвь челюсти',   hint: 'задний край челюсти под мочкой уха',        lm: null, t: [0.63, 0.52] }
  ];

  function template(W, H, facingRight) {
    const pts = {};
    for (const p of POINTS) pts[p.id] = [(facingRight ? 1 - p.t[0] : p.t[0]) * W, p.t[1] * H];
    return pts;
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
    v.mentolabial = G.angle2(pts.li, pts.sl, pts.pg);
    v.convexity = G.angle2(pts.g, pts.sn, pts.pg);

    // E-линия: кончик носа → погонион. Плюс — губа впереди линии.
    const facing = Math.sign(pts.prn[0] - pts.tr[0]) || -1;
    const m = G.mid(pts.prn, pts.pg);
    const ref = Math.sign(G.pointLine2([m[0] + facing * 50, m[1]], pts.prn, pts.pg)) || 1;
    const scale = lowerThirdMm ? lowerThirdMm / G.d2(pts.sn, pts.me) : 70 / G.d2(pts.sn, pts.me);
    v.eLineUpper = ref * G.pointLine2(pts.ls, pts.prn, pts.pg) * scale;
    v.eLineLower = ref * G.pointLine2(pts.li, pts.prn, pts.pg) * scale;
    return v;
  }

  function draw(ctx, img, pts, active) {
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
      ctx.beginPath(); ctx.arc(x, y, (p.id === active ? 6 : 4) * s, 0, 7);
      ctx.fillStyle = p.id === active ? '#ffd43b' : '#ff3b3b'; ctx.fill();
      ctx.lineWidth = 1.2 * s; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 3 * s; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(p.code, tx, ty);
      ctx.fillStyle = '#fff'; ctx.fillText(p.code, tx, ty);
    }
  }

  FR.profile = { POINTS, template, fromLandmarks, sideness, compute, draw };
})();
