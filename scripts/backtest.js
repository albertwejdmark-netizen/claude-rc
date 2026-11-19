/* Backtest av long-signalerna på all kursdata i site/data.
   Kör: node scripts/backtest.js   (efter python scripts/fetch_data.py)

   Varje kombination av filter utvärderas. Kombinationer väljs på data FÖRE
   SPLIT och kontrolleras sedan på data EFTER (som de aldrig "sett"), för att
   undvika att välja inställningar som bara råkade passa historiken.
   Vinst = TP1 nås före stoploss. R = resultat i antal risker (TP1 eller -1;
   efter 60 dagar utan utfall stängs affären på stängningskursen). */
const fs = require("fs");
const path = require("path");
const SR = require("../site/engine.js");

const DATA = path.join(__dirname, "..", "site", "data");
const SPLIT = process.env.SPLIT || "2025-01-01";
const MAX_BARS = 60;
const MIN_N = +(process.env.MIN_N || 250);

const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
let market = null;
if (index.market && fs.existsSync(path.join(DATA, index.market))) {
  market = SR.marketRegime(JSON.parse(fs.readFileSync(path.join(DATA, index.market), "utf8")).candles);
}

const base = { ...SR.DEFAULTS };
const SL = ["level", "atr1.5", "atr2", "atr3"];
const TP = ["levels", "r"];

/* 1. Samla alla kandidatsignaler (utan filter) med utfall för varje SL/TP-variant */
const t0 = Date.now();
const cands = [];
for (const item of index.stocks) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, item.file), "utf8"));
  const all = d.candles.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (all.length < 300) continue;
  const ctx = SR.prepare(all, base.k, market);
  for (let t = 260; t < all.length; t++) {
    const c = SR.candidateAt(ctx, t, base);
    if (!c) continue;
    const outs = {};
    for (const sl of SL) for (const tp of TP) {
      const pl = SR.plan(c.entry, c.lv, c.a, c.tol, { ...base, slMode: sl, tpMode: tp }, c.level);
      if (!pl) continue;
      const o = SR.outcome(all, { ...c, ...pl }, MAX_BARS);
      outs[sl + "|" + tp] = { rr: pl.rr, res: o.res, r: o.res === "win" ? pl.rr : o.r };
    }
    cands.push({ sym: item.symbol, t: c.t, date: c.date, kind: c.kind, f: c.f, outs });
  }
}
cands.sort((a, b) => (a.sym === b.sym ? a.t - b.t : a.sym < b.sym ? -1 : 1));
console.log(`${index.stocks.length} aktier, ${cands.length} kandidatsignaler, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`Träning: före ${SPLIT}   Kontroll: från ${SPLIT}\n`);

/* 2. Utvärdera en inställning */
function evaluate(o) {
  const key = o.slMode + "|" + o.tpMode;
  const m = { tr: { n: 0, w: 0, r: 0 }, te: { n: 0, w: 0, r: 0 } };
  let lastSym = null, lastT = -1e9;
  for (const c of cands) {
    if (c.sym !== lastSym) { lastSym = c.sym; lastT = -1e9; }
    if (!SR.passes(c, o)) continue;
    const out = c.outs[key];
    if (!out || out.rr < o.minRR) continue;
    if (c.t - lastT < o.k) continue;
    lastT = c.t;
    if (out.res === "open") continue;
    const b = c.date < SPLIT ? m.tr : m.te;
    b.n++; b.r += out.r; if (out.res === "win") b.w++;
  }
  for (const b of [m.tr, m.te]) { b.wr = b.n ? b.w / b.n : 0; b.avg = b.n ? b.r / b.n : 0; }
  return m;
}

const pctS = x => (100 * x).toFixed(0).padStart(3) + "%";
const rS = x => (x >= 0 ? "+" : "") + x.toFixed(2);
const desc = o => Object.keys(SR.DEFAULTS).filter(k => !["L", "k", "tolF", "minT", "maxN"].includes(k))
  .map(k => `${k}=${o[k]}`).join(" ");
function line(label, m) {
  return `${label.padEnd(44)} träning n=${String(m.tr.n).padStart(5)} vinst ${pctS(m.tr.wr)} snitt ${rS(m.tr.avg)}R | kontroll n=${String(m.te.n).padStart(4)} vinst ${pctS(m.te.wr)} snitt ${rS(m.te.avg)}R`;
}

/* 3. Nuvarande standard och effekten av varje filter för sig */
const baseM = evaluate(base);
console.log("== Nuvarande standardinställningar ==");
console.log(line("standard", baseM));
console.log(line("utan filter (trend=none, minRR=0)", evaluate({ ...base, ...SR.PRESETS.classic, trend: "none", minRR: 0 })));
console.log("\n== Färdiga strategier på hemsidan ==");
for (const [name, p] of Object.entries(SR.PRESETS)) console.log(line(name, evaluate({ ...base, ...p })));

const GRID = {
  types: ["both", "breakout", "bounce"],
  trend: ["none", "sma50", "sma50_200", "rising"],
  minVol: [0, 1.3, 1.8],
  minClosePos: [0, 0.5, 0.75],
  minRespect: [0, 0.6, 0.75],
  market: [false, true],
  maxRsi: [0, 70],
  slMode: SL,
  tpMode: TP,
  minRR: [0, 1, 1.5],
};
console.log("\n== Ett filter i taget (övrigt som standard) ==");
for (const [k, vals] of Object.entries(GRID)) for (const v of vals) {
  if (v === base[k]) continue;
  console.log(line(`${k}=${v}`, evaluate({ ...base, [k]: v })));
}

/* 4. Alla kombinationer */
const keys = Object.keys(GRID);
const results = [];
(function rec(i, o) {
  if (i === keys.length) {
    if (o.tpMode === "r" && o.minRR > 1) return;
    const m = evaluate(o);
    if (m.tr.n >= MIN_N) results.push({ o: { ...o }, m });
    return;
  }
  for (const v of GRID[keys[i]]) { o[keys[i]] = v; rec(i + 1, o); }
})(0, { ...base });
console.log(`\n${results.length} kombinationer med minst ${MIN_N} signaler i träningsdatan`);

function top(title, filter, score, n = 15) {
  console.log(`\n== ${title} ==`);
  results.filter(filter).sort((a, b) => score(b) - score(a)).slice(0, n)
    .forEach((x, i) => { console.log(line(`#${i + 1}`, x.m)); console.log("    " + desc(x.o)); });
}
top("Högst vinstchans (träning), med positivt snitt-R", x => x.m.tr.avg > 0.05, x => x.m.tr.wr);
top("Högst snitt-R (träning)", () => true, x => x.m.tr.avg);
// Robust: bra på båda delarna. Poäng = sämsta av träning/kontroll.
top("Bäst på BÅDE träning och kontroll (vinstchans, snitt-R > 0)",
  x => x.m.tr.avg > 0.05 && x.m.te.avg > 0.05 && x.m.te.n >= MIN_N / 4,
  x => Math.min(x.m.tr.wr, x.m.te.wr));
top("Bäst på BÅDE träning och kontroll (snitt-R)",
  x => x.m.te.n >= MIN_N / 4,
  x => Math.min(x.m.tr.avg, x.m.te.avg));
console.log(`\nKlart på ${((Date.now() - t0) / 1000).toFixed(1)} s`);
