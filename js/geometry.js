/* geometry.js — векторная математика. Точки — массивы [x, y] или [x, y, z]. */
(function () {
  const G = {};
  G.sub = (a, b) => [a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0)];
  G.add = (a, b) => [a[0] + b[0], a[1] + b[1], (a[2] || 0) + (b[2] || 0)];
  G.mul = (a, k) => [a[0] * k, a[1] * k, (a[2] || 0) * k];
  G.dot = (a, b) => a[0] * b[0] + a[1] * b[1] + (a[2] || 0) * (b[2] || 0);
  G.cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  G.len = (a) => Math.hypot(a[0], a[1], a[2] || 0);
  G.norm = (a) => { const l = G.len(a) || 1; return [a[0] / l, a[1] / l, (a[2] || 0) / l]; };
  G.mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((a[2] || 0) + (b[2] || 0)) / 2];
  G.deg = (r) => r * 180 / Math.PI;

  /* 2D-расстояние (z игнорируется) */
  G.d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /* Угол в вершине b между лучами b→a и b→c, градусы, 2D */
  G.angle2 = (a, b, c) => {
    const ux = a[0] - b[0], uy = a[1] - b[1];
    const vx = c[0] - b[0], vy = c[1] - b[1];
    const d = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
    return G.deg(Math.acos(Math.max(-1, Math.min(1, d))));
  };

  /* Угол между двумя 2D-направлениями, градусы */
  G.angleVec2 = (u, v) => {
    const d = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
    return G.deg(Math.acos(Math.max(-1, Math.min(1, d))));
  };

  /* Знаковое расстояние от точки p до прямой a→b (2D). Знак — по z векторного произведения. */
  G.pointLine2 = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / (Math.hypot(dx, dy) || 1);
  };

  G.mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);

  FR.geo = G;
})();
