/* Beräkningsmotor för stöd/motstånd, signaler, stoploss och take profit.
   Används både av hemsidan (index.html) och av backtestet (scripts/backtest.js). */
(function (root) {
  "use strict";
  const E = {};

  /* Färdiga strategier. Siffrorna i kommentarerna kommer från backtestet
     (scripts/backtest.js) på 122 amerikanska aktier: inställningarna valdes på
     data före 2025 och kontrollerades på data från 2025 (kontrollsiffror nedan).
     Vinst = TP1 nås före stoploss. */
  E.PRESETS = {
    // Kontroll: 55 % vinst, +0,15 R per affär
    breakout: { types: "breakout", trend: "none", minVol: 1.8, minClosePos: 0.75, minRespect: 0.6,
                market: false, maxRsi: 0, minRR: 0, slMode: "atr3", tpMode: "r" },
    // Kontroll: 61 % vinst, +0,06 R per affär
    bounce:   { types: "bounce", trend: "sma50", minVol: 0, minClosePos: 0.5, minRespect: 0.6,
                market: false, maxRsi: 70, minRR: 0, slMode: "atr3", tpMode: "levels" },
    // Ursprungliga reglerna. Kontroll: 38 % vinst, +0,08 R per affär
    classic:  { types: "both", trend: "sma50", minVol: 0, minClosePos: 0, minRespect: 0,
                market: false, maxRsi: 0, minRR: 1, slMode: "level", tpMode: "levels" },
  };

  E.DEFAULTS = Object.assign({
    L: 252, k: 5, tolF: 0.6, minT: 2, maxN: 4,
    // types: both | breakout | bounce          trend: none | sma50 | sma50_200 | rising
    // minVol: relativ volym vid utbrott        minClosePos: stängning i dagens spann (0–1)
    // minRespect: nivåns respektandel (0–1)    market: S&P 500 över SMA 200
    // maxRsi: högsta RSI(14), 0 = av          slMode: level | atrX    tpMode: levels | r
  }, E.PRESETS.breakout);

  /* ---------- Förberedelser per aktie ---------- */
  E.prepare = function (all, k, market) {
    const n = all.length;
    const atrA = new Array(n).fill(NaN), sma = new Array(n).fill(NaN), sma200 = new Array(n).fill(NaN);
    const rvol = new Array(n).fill(1), rvolRaw = new Array(n).fill(NaN), rsi = new Array(n).fill(NaN);
    const tr = [0];
    for (let i = 1; i < n; i++) {
      const h = all[i][2], l = all[i][3], pc = all[i-1][4];
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let trSum = 0, cSum = 0, c2Sum = 0, vSum = 0, gain = 0, loss = 0;
    for (let i = 0; i < n; i++) {
      if (i >= 1) { trSum += tr[i]; if (i > 14) trSum -= tr[i-14]; }
      if (i >= 14) atrA[i] = trSum / 14;
      cSum += all[i][4]; if (i >= 50) cSum -= all[i-50][4];
      if (i >= 49) sma[i] = cSum / 50;
      c2Sum += all[i][4]; if (i >= 200) c2Sum -= all[i-200][4];
      if (i >= 199) sma200[i] = c2Sum / 200;
      // relativ volym mot snittet av de 50 föregående dagarna
      const prevAvg = i > 0 ? vSum / Math.min(i, 50) : 0;
      if (prevAvg > 0 && all[i][5]) {
        rvolRaw[i] = all[i][5] / prevAvg;
        rvol[i] = Math.min(2.5, Math.max(0.4, rvolRaw[i]));
      }
      vSum += all[i][5] || 0; if (i >= 50) vSum -= all[i-50][5] || 0;
      // RSI(14), Wilder
      if (i >= 1) {
        const ch = all[i][4] - all[i-1][4];
        const g = Math.max(ch, 0), ls = Math.max(-ch, 0);
        if (i <= 14) { gain += g / 14; loss += ls / 14; }
        else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + ls) / 14; }
        if (i >= 14) rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    }
    const pivots = E.findPivots(all, k);
    const major = new Set(E.findPivots(all, k * 3).map(p => p.kind + p.i));
    pivots.forEach(p => { p.major = major.has(p.kind + p.i); p.rvol = rvol[p.i]; });
    return { all, atrA, sma, sma200, rvolRaw, rsi, pivots, k, market: market || null };
  };

  // Marknadsläge: datum -> true om SPY stänger över sitt 200-dagars snitt
  E.marketRegime = function (spy) {
    const m = new Map(); let s = 0;
    for (let i = 0; i < spy.length; i++) {
      s += spy[i][4]; if (i >= 200) s -= spy[i-200][4];
      if (i >= 199) m.set(spy[i][0], spy[i][4] > s / 200);
    }
    return m;
  };

  E.findPivots = function (c, k) {
    const piv = [];
    for (let i = k; i < c.length - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (c[j][2] > c[i][2]) isHigh = false;
        if (c[j][3] < c[i][3]) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) piv.push({ i, price: c[i][2], kind: "high" });
      if (isLow) piv.push({ i, price: c[i][3], kind: "low" });
    }
    return piv;
  };

  /* ---------- Stöd & motstånd ---------- */
  E.levelsAt = function (ctx, t, o) {
    const { all, atrA, pivots, k } = ctx;
    const start = Math.max(0, t - o.L + 1);
    const pts = pivots.filter(p => p.i >= start && p.i <= t - k);
    const a = isFinite(atrA[t]) ? atrA[t] : all[t][4] * 0.02, close = all[t][4];
    const tol = Math.max(a * o.tolF, close * 0.002);
    const span = Math.max(1, t - start);
    const weight = p => (0.4 + 0.6 * (p.i - start) / span) * Math.sqrt(p.rvol) * (p.major ? 1.5 : 1);

    const sorted = [...pts].sort((x, y) => x.price - y.price);
    const clusters = [];
    for (const p of sorted) {
      const cl = clusters[clusters.length-1], w = weight(p);
      if (cl && p.price - cl.mean <= tol) { cl.pts.push(p); cl.w += w; cl.ps += w * p.price; cl.mean = cl.ps / cl.w; }
      else clusters.push({ pts: [p], w, ps: w * p.price, mean: p.price });
    }
    const merged = [];
    for (const cl of clusters) {
      const prev = merged[merged.length-1];
      if (prev && cl.mean - prev.mean <= tol * 0.75) { prev.pts.push(...cl.pts); prev.w += cl.w; prev.ps += cl.ps; prev.mean = prev.ps / prev.w; }
      else merged.push(cl);
    }

    const levels = merged.filter(cl => cl.pts.length >= o.minT).map(cl => {
      const price = cl.mean, lo = price - tol / 2, hi = price + tol / 2;
      let respect = 0, broke = 0, lastTest = -1;
      for (let i = Math.max(start, 1); i <= t; i++) {
        const h = all[i][2], l = all[i][3], c = all[i][4], pc = all[i-1][4];
        if (h < lo || l > hi) continue;
        lastTest = i;
        if (pc > hi) { if (c >= lo) respect++; else broke++; }
        else if (pc < lo) { if (c <= hi) respect++; else broke++; }
      }
      const respectRatio = (respect + 1) / (respect + broke + 2);
      const highs = cl.pts.filter(p => p.kind === "high").length, lows = cl.pts.filter(p => p.kind === "low").length;
      const flip = highs > 0 && lows > 0;
      const lastPivot = Math.max(...cl.pts.map(p => p.i));
      const score = cl.w * (0.5 + respectRatio) * (flip ? 1.25 : 1);
      return { price, lo, hi, touches: cl.pts.length, highs, lows, flip, respect, broke, respectRatio,
               score, lastDate: all[Math.max(lastPivot, lastTest)][0], major: cl.pts.some(p => p.major) };
    });
    return { levels, tol, a, start, pts };
  };

  /* ---------- Stoploss & take profit ---------- */
  E.plan = function (entry, lv, a, tol, o, supportLevel) {
    let stop;
    if (o.slMode === "level") {
      const sp = supportLevel != null ? supportLevel : [...lv].reverse().find(x => x < entry - 0.25 * a);
      stop = sp != null ? sp - tol : entry - 2 * a;
    } else {
      stop = entry - parseFloat(o.slMode.slice(3)) * a;
    }
    const risk = entry - stop;
    if (!(risk > 0)) return null;
    let tps;
    if (o.tpMode === "r") tps = [1, 2, 3].map(r => ({ price: entry + r * risk, src: r + "R" }));
    else {
      tps = lv.filter(x => x > entry + 0.5 * a).slice(0, 3).map(x => ({ price: x, src: "Motstånd" }));
      let r = Math.max(2, Math.ceil(((tps.length ? tps[tps.length-1].price : entry) - entry) / risk) + 1);
      while (tps.length < 3) { tps.push({ price: entry + r * risk, src: r + "R (inget motstånd)" }); r++; }
    }
    return { entry, stop, risk, tps, rr: (tps[0].price - entry) / risk };
  };

  /* ---------- Signaler (long) ----------
     Utbrott: stängning över ett motstånd med minst ¼ ATR marginal.
     Studs:   dagens lägsta når stödzonen, stängning över stödet och grön dag.
     Nivåerna tas från dagen före, så signalen bygger bara på det man visste då. */
  E.candidateAt = function (ctx, t, o) {
    if (t < 60) return null;
    const { all, sma, sma200, rvolRaw, rsi } = ctx;
    const LV = E.levelsAt(ctx, t - 1, o);
    if (!LV.levels.length) return null;
    const [date, O, H, Lo, C] = all[t], P = all[t-1][4], a = LV.a, tol = LV.tol;
    const levels = [...LV.levels].sort((x, y) => x.price - y.price);
    let kind = null, lvl = null;
    const ups = levels.filter(l => P <= l.price && C > l.price + 0.25 * a);
    if (ups.length) { kind = "Utbrott"; lvl = ups[ups.length-1]; }
    else {
      const below = levels.filter(l => l.price < C), sp = below[below.length-1];
      if (sp && Lo <= sp.price + tol && C > O && C - sp.price <= a) { kind = "Studs på stöd"; lvl = sp; }
    }
    if (!kind) return null;
    return {
      kind, level: lvl.price, levelInfo: lvl, t, date, entry: C, a, tol, side: "long",
      lv: levels.map(l => l.price),
      f: {
        close: C, sma50: sma[t], sma200: sma200[t],
        slope50: isFinite(sma[t-10]) ? sma[t] / sma[t-10] - 1 : NaN,
        rsi: rsi[t], rvol: rvolRaw[t],
        closePos: H > Lo ? (C - Lo) / (H - Lo) : 1,
        market: ctx.market ? ctx.market.get(date) : undefined,
        respect: lvl.respectRatio, touches: lvl.touches, flip: lvl.flip,
      },
    };
  };

  E.passes = function (c, o) {
    const f = c.f;
    if (o.types === "breakout" && c.kind !== "Utbrott") return false;
    if (o.types === "bounce" && c.kind === "Utbrott") return false;
    if (o.trend !== "none" && isFinite(f.sma50)) {
      if (f.close < f.sma50) return false;
      if (o.trend === "sma50_200" && isFinite(f.sma200) && f.sma50 < f.sma200) return false;
      if (o.trend === "rising" && !(f.slope50 > 0)) return false;
    }
    if (o.minVol && c.kind === "Utbrott" && !(f.rvol >= o.minVol)) return false;
    if (o.minClosePos && f.closePos < o.minClosePos) return false;
    if (o.minRespect && f.respect < o.minRespect) return false;
    if (o.market && f.market === false) return false;
    if (o.maxRsi && f.rsi > o.maxRsi) return false;
    return true;
  };

  E.signalAt = function (ctx, t, o) {
    const c = E.candidateAt(ctx, t, o);
    if (!c || !E.passes(c, o)) return null;
    const pl = E.plan(c.entry, c.lv, c.a, c.tol, o, c.level);
    if (!pl || pl.rr < o.minRR) return null;
    return Object.assign(c, pl);
  };

  // Följ upp en signal: vilka TP nåddes innan stoploss? (maxBars = tidsgräns, valfri)
  E.outcome = function (all, s, maxBars) {
    let hit = 0;
    const end = maxBars ? Math.min(all.length - 1, s.t + maxBars) : all.length - 1;
    for (let j = s.t + 1; j <= end; j++) {
      const h = all[j][2], l = all[j][3];
      if (l <= s.stop) return { res: hit ? "win" : "loss", tp: hit, r: hit ? s.rr : -1, date: all[j][0], stopped: true };
      while (hit < 3 && h >= s.tps[hit].price) hit++;
      if (hit === 3) return { res: "win", tp: 3, r: s.rr, date: all[j][0] };
    }
    if (hit) return { res: "win", tp: hit, r: s.rr, running: true };
    if (maxBars && end === s.t + maxBars) return { res: "timeout", tp: 0, r: (all[end][4] - s.entry) / s.risk, date: all[end][0] };
    return { res: "open", tp: 0, r: 0 };
  };

  E.signalsInRange = function (ctx, from, to, o) {
    const out = []; let lastT = -1e9;
    for (let t = Math.max(from, 60); t <= to; t++) {
      const s = E.signalAt(ctx, t, o);
      if (!s || t - lastT < ctx.k) continue; // undvik upprepningar
      lastT = t;
      s.out = E.outcome(ctx.all, s);
      out.push(s);
    }
    return out;
  };

  E.classicPivots = function (all, base) {
    if (base === "off" || all.length < 2) return null;
    let rows;
    if (base === "day") rows = [all[all.length-1]];
    else {
      const key = base === "week"
        ? d => { const x = new Date(d); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); }
        : d => d.slice(0, 7);
      const curKey = key(all[all.length-1][0]);
      let prevKey = null;
      for (let i = all.length - 1; i >= 0; i--) { const kk = key(all[i][0]); if (kk !== curKey) { prevKey = kk; break; } }
      if (!prevKey) return null;
      rows = all.filter(r => key(r[0]) === prevKey);
    }
    const H = Math.max(...rows.map(r => r[2])), L = Math.min(...rows.map(r => r[3])), C = rows[rows.length-1][4];
    const P = (H + L + C) / 3;
    return [["R3", H + 2 * (P - L)], ["R2", P + (H - L)], ["R1", 2 * P - L], ["P", P],
            ["S1", 2 * P - H], ["S2", P - (H - L)], ["S3", L - 2 * (H - P)]];
  };

  root.SR = E;
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
