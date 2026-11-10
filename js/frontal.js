/* ============================================================================
 * frontal.js — замеры по фото анфас.
 *
 * Вход: 478 точек MediaPipe Face Landmarker (x, y — доли кадра, z — глубина).
 * Шаги:
 *   1. «Фронтализация»: по самим точкам строим оси лица (вправо / вниз / вперёд)
 *      и пересчитываем координаты в них. Это убирает наклон и небольшой поворот
 *      головы, иначе вертикальные пропорции врут на несколько процентов.
 *   2. Масштаб: диаметр радужки = 11.7 мм → миллиметры на пиксель.
 *   3. Замеры: расстояния, отношения, углы.
 *
 * «L» — глаз/сторона СЛЕВА НА КАРТИНКЕ, «R» — справа на картинке.
 * ========================================================================== */
(function () {
  const G = FR.geo;

  /* Номера точек MediaPipe */
  const I = {
    foreheadTop: 10, glabella: 9, nasion: 168, noseTip: 1, subnasale: 2,
    lipTop: 0, stomionU: 13, stomionL: 14, lipBottom: 17, sublabiale: 18, menton: 152,
    mouthL: 61, mouthR: 291,
    eyeOutL: 33, eyeInL: 133, eyeInR: 362, eyeOutR: 263,
    lidPairsL: [[160, 144], [159, 145], [158, 153]],
    lidPairsR: [[385, 380], [386, 374], [387, 373]],
    lidTopL: 159, lidTopR: 386,
    browLowL: [53, 52, 65], browLowR: [283, 282, 295],
    browMidL: [105, 52], browMidR: [334, 282],
    browInL: [107, 55], browPeakL: [63, 53],
    browInR: [336, 285], browPeakR: [293, 283],
    cheekPairs: [[127, 356], [234, 454], [93, 323]],
    earL: 234, earR: 454,
    // угол челюсти в анфас — середина между двумя точками контура на уровне рта и нижней губы
    gonL: [58, 172], gonR: [288, 397],
    chinL: 176, chinR: 400,
    nosePairs: [[48, 278], [64, 294]],
    irisA: 468, irisB: 473
  };

  /* Парные точки: по ним строится ось «вправо» и считается симметрия */
  const PAIRS = [
    [33, 263], [133, 362], [159, 386], [145, 374], [70, 300], [105, 334], [107, 336],
    [48, 278], [61, 291], [234, 454], [127, 356], [93, 323], [58, 288], [172, 397],
    [136, 365], [176, 400]
  ];

  function irisDiameter(P, c) {
    // вокруг центра c идут 4 точки: c+1 и c+3 — по горизонтали, c+2 и c+4 — по вертикали
    return (G.d2(P[c + 1], P[c + 3]) + G.d2(P[c + 2], P[c + 4])) / 2;
  }

  function measure(lms, W, H, blend) {
    const P = lms.map((l) => [l.x * W, l.y * H, l.z * W]);

    // У точек радужки глубина ненадёжна — берём глубину уголков глаза.
    const eyeMidL = G.mid(P[I.eyeOutL], P[I.eyeInL]);
    const eyeMidR = G.mid(P[I.eyeOutR], P[I.eyeInR]);
    let iL = I.irisA, iR = I.irisB;
    if (G.d2(P[iL], eyeMidL) > G.d2(P[iL], eyeMidR)) { iL = I.irisB; iR = I.irisA; }
    const pupilLimg = [P[iL][0], P[iL][1], eyeMidL[2]];
    const pupilRimg = [P[iR][0], P[iR][1], eyeMidR[2]];

    /* ---- 1. Оси лица ---- */
    let xs = [0, 0, 0];
    for (const [l, r] of PAIRS) xs = G.add(xs, G.sub(P[r], P[l]));
    const X = G.norm(xs);
    const y0 = G.sub(P[I.menton], P[I.foreheadTop]);
    const Y = G.norm(G.sub(y0, G.mul(X, G.dot(y0, X))));
    const Z = G.cross(X, Y);
    const O = P[I.nasion];
    const toFace = (p) => { const d = G.sub(p, O); return [G.dot(d, X), G.dot(d, Y), G.dot(d, Z)]; };
    const F = P.map(toFace);
    const pupilL = toFace(pupilLimg), pupilR = toFace(pupilRimg);

    const pose = {
      yaw: G.deg(Math.atan2(X[2], X[0])),
      roll: G.deg(Math.atan2(X[1], X[0])),
      pitch: G.deg(Math.atan2(Y[2], Y[1]))
    };

    /* ---- 2. Масштаб ---- */
    const irisPx = (irisDiameter(P, iL) + irisDiameter(P, iR)) / 2;
    const mm = FR.config.irisMm / irisPx;

    /* ---- 3. Базовые отрезки ---- */
    const ipd = G.d2(pupilL, pupilR);
    const pupilY = (pupilL[1] + pupilR[1]) / 2;
    const midX = G.mean(PAIRS.map(([l, r]) => (F[l][0] + F[r][0]) / 2));

    let cheekPair = I.cheekPairs[0], bizyg = 0;
    for (const pr of I.cheekPairs) {
      const w = F[pr[1]][0] - F[pr[0]][0];
      if (w > bizyg) { bizyg = w; cheekPair = pr; }
    }
    const gonL = G.mid(F[I.gonL[0]], F[I.gonL[1]]);
    const gonR = G.mid(F[I.gonR[0]], F[I.gonR[1]]);
    const bigonial = gonR[0] - gonL[0];
    const chinW = F[I.chinR][0] - F[I.chinL][0];

    let nosePair = I.nosePairs[0], noseW = 0;
    for (const pr of I.nosePairs) {
      const w = F[pr[1]][0] - F[pr[0]][0];
      if (w > noseW) { noseW = w; nosePair = pr; }
    }
    const mouthW = G.d2(F[I.mouthL], F[I.mouthR]);
    const icd = G.d2(F[I.eyeInL], F[I.eyeInR]);

    const sn = F[I.subnasale], me = F[I.menton], gl = F[I.glabella];
    const stoY = (F[I.stomionU][1] + F[I.stomionL][1]) / 2;
    const lipTopY = F[I.lipTop][1];

    const v = {};

    /* ---- ГАРМОНИЯ ---- */
    v.midface = ipd / (lipTopY - pupilY);
    v.thirds = (me[1] - sn[1]) / (sn[1] - gl[1]);
    v.lowerSplit = (me[1] - stoY) / (stoY - sn[1]);
    v.chinPhiltrum = (me[1] - F[I.sublabiale][1]) / (lipTopY - sn[1]);
    v.esr = ipd / bizyg;
    v.faceWH = bizyg / (me[1] - F[I.nasion][1]);

    // Асимметрия: для каждой пары — смещение её середины от средней линии и разница высот.
    let asym = 0;
    for (const [l, r] of PAIRS) {
      asym += Math.hypot((F[l][0] + F[r][0]) / 2 - midX, (F[l][1] - F[r][1]) / 2);
    }
    asym /= PAIRS.length;
    const midlineDev = (Math.abs(F[I.noseTip][0] - midX) + Math.abs(me[0] - midX)) / 2;
    v.symmetry = (asym * 0.7 + midlineDev * 0.3) / ipd * 100;

    /* ---- ДИМОРФИЗМ ---- */
    const browY = G.mean([...I.browMidL, ...I.browMidR].map((i) => F[i][1]));
    v.fwhr = bizyg / (lipTopY - browY);
    v.jawCheek = bigonial / bizyg;
    const browLowY = (arr) => G.mean(arr.map((i) => F[i][1]));
    v.browGap = ((F[I.lidTopL][1] - browLowY(I.browLowL)) + (F[I.lidTopR][1] - browLowY(I.browLowR))) / 2 / ipd;
    const upperV = F[I.stomionU][1] - lipTopY;
    const lowerV = F[I.lipBottom][1] - F[I.stomionL][1];
    v.lipFullness = (upperV + lowerV) / mouthW;
    v.chinMouth = chinW / mouthW;

    /* ---- АНГУЛЯРНОСТЬ ---- */
    const jawVecL = G.sub(F[I.chinL], gonL);
    const jawVecR = G.sub(F[I.chinR], gonR);
    v.jawFrontal = G.angleVec2(jawVecL, jawVecR);
    v.gonionAngle = (G.angle2(F[I.earL], gonL, F[I.chinL]) + G.angle2(F[I.earR], gonR, F[I.chinR])) / 2;
    // чёткость линии челюсти (jawDef) считается по пикселям — см. skin.js

    /* ---- ФИЧИ ---- */
    const tilt = (outer, inner) => G.deg(Math.atan2(F[inner][1] - F[outer][1], Math.abs(F[inner][0] - F[outer][0])));
    v.canthalTilt = (tilt(I.eyeOutL, I.eyeInL) + tilt(I.eyeOutR, I.eyeInR)) / 2;
    const eyeH = (pairs) => Math.max(...pairs.map(([a, b]) => G.d2(F[a], F[b])));
    const aspL = G.d2(F[I.eyeOutL], F[I.eyeInL]) / eyeH(I.lidPairsL);
    const aspR = G.d2(F[I.eyeOutR], F[I.eyeInR]) / eyeH(I.lidPairsR);
    v.eyeAspect = (aspL + aspR) / 2;
    v.eyeSize = (G.d2(F[I.eyeOutL], F[I.eyeInL]) + G.d2(F[I.eyeOutR], F[I.eyeInR])) / 2 / ipd;
    const browPt = (pr) => G.mid(F[pr[0]], F[pr[1]]);
    const browTilt = (inn, peak) => {
      const a = browPt(inn), b = browPt(peak);
      return G.deg(Math.atan2(a[1] - b[1], Math.abs(a[0] - b[0])));
    };
    v.browTilt = (browTilt(I.browInL, I.browPeakL) + browTilt(I.browInR, I.browPeakR)) / 2;
    v.mouthNose = mouthW / noseW;
    v.noseIcd = noseW / icd;
    v.lipRatio = lowerV / Math.max(upperV, 1e-6);

    /* ---- КОСТНАЯ МАССА (мм) ---- */
    v.bizygMm = bizyg * mm;
    v.bigonialMm = bigonial * mm;
    v.chinWidthMm = chinW * mm;
    v.faceHeightMm = (me[1] - F[I.nasion][1]) * mm;
    v.ipdMm = ipd * mm;

    /* ---- Предупреждения о качестве снимка ---- */
    const warnings = [];
    if (Math.abs(pose.yaw) > 7) warnings.push(`Голова повёрнута вбок на ${Math.abs(pose.yaw).toFixed(0)}° — ширины и симметрия искажены. Смотрите прямо в камеру.`);
    if (Math.abs(pose.pitch) > 14) warnings.push(`Голова наклонена вперёд/назад (${pose.pitch.toFixed(0)}°) — вертикальные пропорции менее точны.`);
    const ipdImg = G.d2(P[iL], P[iR]);
    if (ipdImg < 110) warnings.push('Лицо на фото мелкое (между зрачками меньше 110 пикселей) — точность точек и анализа кожи низкая.');
    if (v.ipdMm < 54 || v.ipdMm > 72) warnings.push(`Межзрачковое вышло ${v.ipdMm.toFixed(0)} мм — вне нормы. Масштаб по радужке снят неточно, поэтому костная масса не оценивается.`);
    if (blend) {
      const b = (n) => blend[n] || 0;
      if (Math.max(b('mouthSmileLeft'), b('mouthSmileRight')) > 0.4) warnings.push('На фото улыбка — рот, губы и нижняя треть измерены с искажением. Нужно нейтральное лицо.');
      if (b('jawOpen') > 0.15) warnings.push('Рот приоткрыт — нижняя треть и подбородок завышены.');
      if (Math.max(b('browOuterUpLeft'), b('browOuterUpRight'), b('browInnerUp')) > 0.5) warnings.push('Брови подняты — посадка бровей измерена неточно.');
      if (Math.max(b('eyeSquintLeft'), b('eyeSquintRight')) > 0.55) warnings.push('Глаза прищурены — разрез глаз завышен.');
    }

    return {
      values: v, pose, mmPerPx: mm, warnings, ipdImg,
      lowerThirdMm: (me[1] - sn[1]) * mm,
      // данные для отрисовки поверх фото (координаты исходной картинки)
      viz: {
        P, pupilL: pupilLimg, pupilR: pupilRimg, cheekPair, nosePair, I,
        gonL: G.mid(P[I.gonL[0]], P[I.gonL[1]]), gonR: G.mid(P[I.gonR[0]], P[I.gonR[1]])
      }
    };
  }

  /* Рисует линии замеров поверх фото */
  function draw(ctx, m) {
    const { P, pupilL, pupilR, cheekPair, gonL, gonR, nosePair, I: K } = m.viz;
    const s = Math.max(1, ctx.canvas.width / 600);
    const line = (a, b, color, dash) => {
      ctx.beginPath(); ctx.setLineDash(dash ? [4 * s, 4 * s] : []);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = color; ctx.lineWidth = 1.6 * s; ctx.stroke();
    };
    const dot = (p, color) => { ctx.beginPath(); ctx.arc(p[0], p[1], 2.4 * s, 0, 7); ctx.fillStyle = color; ctx.fill(); };

    line(P[cheekPair[0]], P[cheekPair[1]], '#ffd43b');                 // скулы
    line(gonL, gonR, '#ff922b');                                        // челюсть
    line(gonL, P[K.chinL], '#ff922b'); line(gonR, P[K.chinR], '#ff922b');
    line(P[K.earL], gonL, '#ff922b', true); line(P[K.earR], gonR, '#ff922b', true);
    line(P[K.chinL], P[K.chinR], '#da77f2');                            // подбородок
    line(pupilL, pupilR, '#22b8cf');                                    // IPD
    const pm = FR.geo.mid(pupilL, pupilR);
    line(pm, P[K.lipTop], '#51cf66');                                   // высота мидфейса
    line(P[K.eyeOutL], P[K.eyeInL], '#f783ac'); line(P[K.eyeOutR], P[K.eyeInR], '#f783ac');
    line(P[nosePair[0]], P[nosePair[1]], '#4dabf7');                    // нос
    line(P[K.mouthL], P[K.mouthR], '#ff6b6b');                          // рот
    line(P[K.glabella], P[K.subnasale], '#ffffff', true);               // трети
    line(P[K.subnasale], P[K.menton], '#ffffff', true);
    [K.glabella, K.nasion, K.subnasale, K.lipTop, K.sublabiale, K.menton].forEach((i) => dot(P[i], '#ffffff'));
    [gonL, gonR, P[K.chinL], P[K.chinR]].forEach((p) => dot(p, '#ff922b'));
    dot(pupilL, '#22b8cf'); dot(pupilR, '#22b8cf');
  }

  FR.frontal = { measure, draw, I };
})();
