/* Räknar fram signalöversikten i förväg för hemsidans färdiga strategier, så att
   webbläsaren slipper ladda ner kursdatan för alla ~500 aktier.
   Resultat: site/data/signals.json. Körs efter fetch_data.py i GitHub Actions. */
const fs = require("fs");
const path = require("path");
const SR = require("../site/engine.js");

const DATA = path.join(__dirname, "..", "site", "data");
const DAYS = 21; // signaler från senaste månaden (handelsdagar)

const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
let market = null;
if (index.market && fs.existsSync(path.join(DATA, index.market))) {
  market = SR.marketRegime(JSON.parse(fs.readFileSync(path.join(DATA, index.market), "utf8")).candles);
}

const out = { generated: index.updated, days: DAYS, presets: {} };
for (const name of Object.keys(SR.PRESETS)) out.presets[name] = [];

for (const item of index.stocks) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, item.file), "utf8"));
  const all = d.candles.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const T = all.length - 1;
  if (T < 80) continue;
  for (const [name, preset] of Object.entries(SR.PRESETS)) {
    const o = { ...SR.DEFAULTS, ...preset };
    const ctx = SR.prepare(all, o.k, market);
    const sigs = SR.signalsInRange(ctx, Math.max(1, T - DAYS + 1 - o.k), T, o).filter(s => T - s.t < DAYS);
    if (!sigs.length) continue;
    const s = sigs[sigs.length - 1];
    out.presets[name].push({
      symbol: item.symbol, name: item.name, sector: item.sector, close: all[T][4], daysAgo: T - s.t,
      date: s.date, kind: s.kind, entry: s.entry, stop: s.stop, tps: s.tps.map(tp => tp.price), rr: s.rr, out: s.out,
    });
  }
}
fs.writeFileSync(path.join(DATA, "signals.json"), JSON.stringify(out));
for (const [k, v] of Object.entries(out.presets)) console.log(`${k}: ${v.length} aktier med signal senaste ${DAYS} dagarna`);
