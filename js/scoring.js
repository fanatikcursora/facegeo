/* ============================================================================
 * scoring.js — из замеров в баллы.
 *
 *   замер → балл 0..1   (1 внутри идеала; 0.5 при отклонении на tol; 0.2 при 2×tol)
 *   категория           = взвешенное среднее баллов своих замеров
 *   overall             = (1 − failo) × взвешенное среднее категорий
 *                         + failo × среднее худших замеров
 *   t                   = −ln(1 − overall + eps)
 *   PSL                 = center + spread × (t − mean) / sd
 *                         где mean и sd — среднее и разброс t в выборке реальных
 *                         лиц (см. config.js), т.е. PSL показывает, насколько
 *                         лицо выше или ниже среднего человека
 * ========================================================================== */
(function () {
  const C = FR.config;

  /* Число или { m: .., f: .. } → число для нужного пола */
  const pick = (x, gender) => (typeof x === 'number' ? x : x[gender]);

  function scoreMetric(def, value, gender) {
    const [lo, hi] = def.ideal[gender];
    const tol = pick(def.tol, gender);
    const d = value < lo ? lo - value : value > hi ? value - hi : 0;
    // 1 в идеале, 0.5 при отклонении на tol, 0.2 при 2×tol, 0.1 при 3×tol.
    // Спад плавный, чтобы один промах точки не обнулял замер.
    const score = 1 / (1 + (d / tol) * (d / tol));
    return { score, dir: value < lo ? -1 : value > hi ? 1 : 0 };
  }

  function tierFor(psl, gender) {
    for (const t of C.tiers) if (psl >= t.min) return t[gender];
    return C.tiers[C.tiers.length - 1][gender];
  }

  function total(values, gender) {
    const rows = [];
    for (const def of C.metrics) {
      const value = values[def.id];
      if (value === undefined || value === null || !isFinite(value)) continue;
      const s = scoreMetric(def, value, gender);
      rows.push({ def, value, score: s.score, dir: s.dir, w: pick(def.w, gender) });
    }

    const cats = [];
    let wSum = 0, acc = 0;
    for (const c of C.categories) {
      const mine = rows.filter((r) => r.def.cat === c.id && r.w > 0);
      if (!mine.length) continue;
      const w = mine.reduce((s, r) => s + r.w, 0);
      const score = mine.reduce((s, r) => s + r.score * r.w, 0) / w;
      const cw = pick(c.w, gender);
      cats.push({ id: c.id, name: c.name, w: cw, score, rows: rows.filter((r) => r.def.cat === c.id) });
      wSum += cw; acc += cw * score;
    }
    const mean = wSum ? acc / wSum : 0;

    const counted = rows.filter((r) => r.w >= 0.8).sort((a, b) => a.score - b.score);
    const worst = counted.slice(0, C.psl.failoCount);
    const best = counted.slice(-3).reverse();
    const worstMean = worst.length ? worst.reduce((s, r) => s + r.score, 0) / worst.length : mean;

    const overall = (1 - C.psl.failoShare) * mean + C.psl.failoShare * worstMean;
    const hasProfile = cats.some((c) => c.id === 'profile');
    const cal = (hasProfile ? C.psl.calibrationProfile : C.psl.calibration)[gender];
    const t = -Math.log(1 - overall + C.psl.eps);
    const z = (t - cal.mean) / cal.sd;
    const psl = Math.max(0, Math.min(C.psl.max, C.psl.center + C.psl.spread * z));
    return { rows, cats, mean, overall, z, psl, tier: tierFor(psl, gender), worst, best };
  }

  FR.scoring = { scoreMetric, total, tierFor };
})();
