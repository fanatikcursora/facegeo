/* ============================================================================
 * skin.js — анализ кожи по пикселям.
 *
 *   1. Вырезаем лицо и приводим к одному масштабу (между зрачками 160 px),
 *      чтобы пороги в пикселях значили одно и то же на любом фото.
 *   2. Маска кожи: овал лица минус глаза, брови, губы, ноздри, минус всё,
 *      что по цвету не похоже на кожу (волосы, борода, очки, глубокие тени).
 *   3. Переводим в Lab: L — яркость, a* — краснота.
 *   4. Вычитаем сглаженную версию (убирает освещение и общий тон) — остаются
 *      локальные отклонения. Красные и тёмные «островки» нужного размера —
 *      это высыпания, постакне и пятна.
 *   5. Считаем: долю площади дефектов, неровность тона, мелкую текстуру.
 * ========================================================================== */
(function () {
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const EYE_R = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  const BROW_L = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
  const BROW_R = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
  const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  const TARGET_IPD = 160;

  function rgb2lab(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function scaled(pts, kx, ky) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    return pts.map((p) => [cx + (p[0] - cx) * kx, cy + (p[1] - cy) * (ky || kx)]);
  }

  function poly(ctx, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath(); ctx.fill();
  }

  /* Среднее по квадрату радиуса r, только по пикселям маски (через интегральные суммы) */
  function maskedBlur(src, mask, w, h, r) {
    const W1 = w + 1;
    const S = new Float64Array(W1 * (h + 1)), N = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0, rn = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i]) { rs += src[i]; rn += 1; }
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
        N[(y + 1) * W1 + x + 1] = N[y * W1 + x + 1] + rn;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r) + 1;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r) + 1;
        const n = N[y1 * W1 + x1] - N[y0 * W1 + x1] - N[y1 * W1 + x0] + N[y0 * W1 + x0];
        const s = S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
        out[y * w + x] = n > 0 ? s / n : src[y * w + x];
      }
    }
    return out;
  }

  /* Сжимает маску на r пикселей: пиксель остаётся, только если весь квадрат вокруг него — кожа */
  function erode(mask, w, h, r) {
    const W1 = w + 1, N = new Int32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rn = 0;
      for (let x = 0; x < w; x++) {
        rn += mask[y * w + x];
        N[(y + 1) * W1 + x + 1] = N[y * W1 + x + 1] + rn;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        if (!mask[y * w + x]) continue;
        const x0 = x - r, x1 = x + r + 1, y0 = y - r, y1 = y + r + 1;
        const n = N[y1 * W1 + x1] - N[y0 * W1 + x1] - N[y1 * W1 + x0] + N[y0 * W1 + x0];
        if (n === (2 * r + 1) * (2 * r + 1)) out[y * w + x] = 1;
      }
    }
    return out;
  }

  function median(arr) {
    const a = Float32Array.from(arr).sort();
    return a.length ? a[a.length >> 1] : 0;
  }

  function maskedValues(src, mask) {
    const out = [];
    for (let i = 0; i < src.length; i++) if (mask[i]) out.push(src[i]);
    return out;
  }

  function std(vals) {
    if (!vals.length) return 0;
    let m = 0; for (const v of vals) m += v; m /= vals.length;
    let s = 0; for (const v of vals) s += (v - m) * (v - m);
    return Math.sqrt(s / vals.length);
  }

  function analyze(srcCanvas, P, ipdImg) {
    const k = Math.min(2, TARGET_IPD / ipdImg);
    const ov = OVAL.map((i) => P[i]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ov) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(srcCanvas.width, Math.ceil(x1)); y1 = Math.min(srcCanvas.height, Math.ceil(y1));
    const w = Math.max(8, Math.round((x1 - x0) * k)), h = Math.max(8, Math.round((y1 - y0) * k));
    const T = (i) => [(P[i][0] - x0) * k, (P[i][1] - y0) * k];
    const ipd = ipdImg * k;

    const face = document.createElement('canvas'); face.width = w; face.height = h;
    const fctx = face.getContext('2d', { willReadFrequently: true });
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(srcCanvas, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);

    /* --- маска --- */
    const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
    mctx.fillStyle = '#fff';
    poly(mctx, scaled(OVAL.map(T), 0.9, 0.93));
    mctx.globalCompositeOperation = 'destination-out';
    // глаза с запасом вниз: мешки и тёмные круги — не высыпания
    const eyeHole = (idx) => {
      const p = scaled(idx.map(T), 1.7, 3.4);
      const shift = ipd * 0.05;
      poly(mctx, p.map((q) => [q[0], q[1] + shift]));
    };
    eyeHole(EYE_L); eyeHole(EYE_R);
    poly(mctx, scaled(BROW_L.map(T), 1.25, 1.9)); poly(mctx, scaled(BROW_R.map(T), 1.25, 1.9));
    poly(mctx, scaled(LIPS.map(T), 1.2, 1.35));
    // низ носа целиком: ноздри, крылья и складка у крыльев дают тени
    const nl = T(129), nr = T(358), nb = T(2), nt = T(1);
    mctx.beginPath();
    mctx.ellipse((nl[0] + nr[0]) / 2, (nb[1] + nt[1]) / 2, Math.abs(nr[0] - nl[0]) * 0.66, ipd * 0.2, 0, 0, 7);
    mctx.fill();

    const md = mctx.getImageData(0, 0, w, h).data;
    const px = fctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const mask = new Uint8Array(n);
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgb2lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
      mask[i] = md[i * 4 + 3] > 128 ? 1 : 0;
    }

    /* --- отсекаем не-кожу по цвету --- */
    const Lr = median(maskedValues(L, mask)), Ar = median(maskedValues(A, mask)), Br = median(maskedValues(B, mask));
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      if (L[i] < Lr - 30 || L[i] > Lr + 32 || Math.hypot(A[i] - Ar, B[i] - Br) > 21) mask[i] = 0;
    }
    let skinPx = 0; for (let i = 0; i < n; i++) skinPx += mask[i];
    if (skinPx < 1500) return null;

    /* --- локальные отклонения --- */
    const R = Math.round(ipd * 0.12);
    const Llow = maskedBlur(L, mask, w, h, R), Alow = maskedBlur(A, mask, w, h, R);
    const Lhp = new Float32Array(n), Ahp = new Float32Array(n);
    for (let i = 0; i < n; i++) { Lhp[i] = L[i] - Llow[i]; Ahp[i] = A[i] - Alow[i]; }
    // Пороги абсолютные (в единицах Lab), а не относительно шума: иначе на гладкой
    // коже порог падает и «дефектов» находится больше, чем на плохой.
    const tA = 5.0, tL = 10.0;

    // Дефекты ищем не у самого края маски: там тени от волос, носа и век.
    const inner = erode(mask, w, h, 4);
    const cand = new Uint8Array(n); // 1 — красное, 2 — тёмное
    for (let i = 0; i < n; i++) {
      if (!inner[i]) continue;
      if (Ahp[i] > tA && Lhp[i] < tL) cand[i] = 1;
      else if (Lhp[i] < -tL) cand[i] = 2;
    }

    /* --- связные области --- */
    const minArea = 5, maxArea = Math.pow(ipd * 0.11, 2);
    const seen = new Uint8Array(n), stack = new Int32Array(n);
    const spots = [];
    // Лицо делим по основанию носа: верх (лоб, скулы, нос) и низ (зона бороды).
    const splitY = nb[1];
    let skinUp = 0, skinLow = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { if (((i / w) | 0) < splitY) skinUp++; else skinLow++; }
    let redArea = 0, darkUp = 0, darkLow = 0;
    const spotMask = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (!cand[s] || seen[s]) continue;
      let sp = 0; stack[sp++] = s; seen[s] = 1;
      const items = [];
      let red = 0, bx0 = w, by0 = h, bx1 = 0, by1 = 0;
      while (sp) {
        const i = stack[--sp]; items.push(i);
        const x = i % w, y = (i / w) | 0;
        if (cand[i] === 1) red++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (x > 0 && cand[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && cand[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && cand[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && cand[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
      }
      const area = items.length, bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      const aspect = Math.max(bw, bh) / Math.min(bw, bh);
      if (area < minArea || area > maxArea) continue;
      if (aspect > 3.5 || area / (bw * bh) < 0.3) continue; // тонкие линии — волосы, морщины
      const isRed = red * 2 >= area, cy = (by0 + by1) / 2;
      spots.push({ x: (bx0 + bx1) / 2, y: cy, r: Math.max(bw, bh) / 2 + 2, red: isRed, low: cy >= splitY });
      if (isRed) redArea += area; else if (cy < splitY) darkUp += area; else darkLow += area;
      for (const i of items) spotMask[i] = 1;
    }

    // Щетина даёт россыпь тёмных точек внизу лица. Если внизу их намного больше,
    // чем наверху, — это волосы, а не кожа: тёмные точки тогда берём только сверху.
    const pct = (a, b) => (b > 0 ? a / b * 100 : 0);
    const darkUpPct = pct(darkUp, skinUp), darkLowPct = pct(darkLow, skinLow);
    const stubble = skinLow > 300 && skinUp > 800 && darkLowPct > 1.5 * darkUpPct + 0.15;
    const redPct = pct(redArea, skinPx);
    const spotPct = redPct + (stubble ? darkUpPct : pct(darkUp + darkLow, skinPx));

    /* --- неровность тона и текстура --- */
    const redness = std(maskedValues(Alow, mask));
    const Lfine = maskedBlur(L, mask, w, h, 2);
    const texUp = [], texLow = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i] || spotMask[i]) continue;
      (((i / w) | 0) < splitY ? texUp : texLow).push(L[i] - Lfine[i]);
    }
    // Текстуру берём только с верхней части лица (лоб, скулы, нос): внизу её
    // портит даже лёгкая щетина, и замер перестаёт говорить о коже.
    const textureUp = std(texUp), textureAll = std(texUp.concat(texLow));
    const texture = textureUp;

    /* --- картинка для отчёта: что анализировалось и что найдено --- */
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(face, 0, 0);
    const od = octx.getImageData(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      if (!mask[i]) { od.data[i * 4] *= 0.35; od.data[i * 4 + 1] *= 0.35; od.data[i * 4 + 2] *= 0.35; }
    }
    octx.putImageData(od, 0, 0);
    octx.lineWidth = 1.5;
    const counted = spots.filter((s) => s.red || !(stubble && s.low));
    for (const s of counted) {
      octx.beginPath(); octx.arc(s.x, s.y, s.r, 0, 7);
      octx.strokeStyle = s.red ? '#ff3b3b' : '#3b9bff'; octx.stroke();
    }

    return {
      values: { spotPct, redness, texture },
      redCount: counted.filter((s) => s.red).length,
      darkCount: counted.filter((s) => !s.red).length,
      stubble,
      parts: { redPct, darkUpPct, darkLowPct, textureUp, textureAll },
      canvas: out,
      upscaled: k > 1.05
    };
  }

  /* --------------------------------------------------------------------------
   * Чёткость линии челюсти — по пикселям, а не по точкам.
   * Сетка лица сглаживает контур, поэтому «сухую» челюсть от мягкой по одной
   * геометрии не отличить. Зато у чёткой челюсти под ней тень на шее.
   * Меряем, насколько кожа сразу под контуром темнее кожи сразу над ним (в %).
   * ------------------------------------------------------------------------ */
  const JAW_LINE = [150, 149, 176, 148, 152, 377, 400, 378, 379];
  function jawDefinition(srcCanvas, P, ipdImg) {
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const W = srcCanvas.width, H = srcCanvas.height;
    const r = Math.max(2, Math.round(ipdImg * 0.03));
    const lum = (x, y) => {
      const x0 = Math.round(x - r), y0 = Math.round(y - r), s = 2 * r + 1;
      if (x0 < 0 || y0 < 0 || x0 + s > W || y0 + s > H) return null;
      const d = ctx.getImageData(x0, y0, s, s).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    };
    const c = P[13]; // центр рта: от него «наружу» — это вниз к шее
    const drops = [];
    for (const i of JAW_LINE) {
      const dx = P[i][0] - c[0], dy = P[i][1] - c[1], l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      const inside = lum(P[i][0] - ux * ipdImg * 0.10, P[i][1] - uy * ipdImg * 0.10);
      const outside = lum(P[i][0] + ux * ipdImg * 0.10, P[i][1] + uy * ipdImg * 0.10);
      if (inside === null || outside === null || inside < 1) continue;
      drops.push((inside - outside) / inside * 100);
    }
    if (drops.length < 5) return null;
    drops.sort((a, b) => a - b);
    return drops[drops.length >> 1];
  }

  FR.skin = { analyze, jawDefinition };
})();
