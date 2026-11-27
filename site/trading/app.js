"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const app = $("#app");
  const state = { data: null, inst: "NDX", tf: "1d", show: "counted", chart: null };
  try {
    const saved = JSON.parse(localStorage.getItem("signalbot") || "{}");
    Object.assign(state, { inst: saved.inst || state.inst, tf: saved.tf || state.tf, show: saved.show || state.show });
  } catch (e) { /* ingen lagring */ }
  const save = () => { try { localStorage.setItem("signalbot", JSON.stringify({ inst: state.inst, tf: state.tf, show: state.show })); } catch (e) { /* */ } };

  const nf = (x, d = 1) => x == null ? "–" : Number(x).toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x, d = 0) => x == null ? "–" : nf(x * 100, d) + " %";
  const sgn = (x, d = 2) => x == null ? "–" : (x > 0 ? "+" : "") + nf(x, d);
  const cls = (x) => x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const dirTxt = (d) => d > 0 ? '<span class="buy">Long</span>' : '<span class="sell">Short</span>';
  const RES = { tp: "Mål nått", sl: "Stoppad", time: "Tidsstopp", open: "Öppen" };

  const sthlm = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const sthlmHour = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  const sthlmDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", day: "numeric", month: "short" });
  const fmtTime = (t) => typeof t === "number" ? sthlm.format(new Date(t * 1000)) : new Date(t + "T12:00:00Z").toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

  const inst = () => state.data.instruments.find((i) => i.id === state.inst) || state.data.instruments[0];
  const frame = () => { const i = inst(); return i.timeframes.find((t) => t.tf === state.tf) || i.timeframes[0]; };

  function tabs() {
    const d = state.data;
    $("#instTabs").innerHTML = d.instruments.map((i) => `<button role="tab" data-inst="${i.id}" class="${i.id === inst().id ? "on" : ""}">${esc(i.name)}</button>`).join("");
    $("#tfTabs").innerHTML = inst().timeframes.map((t) => `<button role="tab" data-tf="${t.tf}" class="${t.tf === frame().tf ? "on" : ""}">${esc(t.tf_name)}</button>`).join("");
  }

  function overview() {
    return `<div class="overview">${state.data.instruments.map((i) => {
      const d = i.timeframes[0];
      return `<div class="ov ${i.id === inst().id ? "on" : ""}" data-inst="${i.id}">
        <div class="head"><span class="name">${esc(i.name)}</span>
          <span class="px">${nf(d.close)} <span class="small ${cls(d.change_pct)}">${sgn(d.change_pct)} %</span></span></div>
        <div class="row">${i.timeframes.map((t) => `<div class="cell v-${t.verdict}" data-inst="${i.id}" data-tf="${t.tf}">
          <span>${esc(t.tf_name)}</span><b>${t.verdict}</b><span>${t.verdict === "AVVAKTA" ? "" : t.strength + " %"}</span></div>`).join("")}</div>
      </div>`;
    }).join("")}</div>`;
  }

  function verdictCard(f) {
    const p = f.plan;
    const counted = f.strategies.filter((s) => s.ok);
    const votes = counted.filter((s) => s.state).map((s) => `${dirTxt(s.state)} ${esc(s.name)}`).join("<br>") || "Ingen av strategierna har en öppen signal.";
    const trend = f.trend > 0 ? '<span class="buy">Upptrend</span>' : f.trend < 0 ? '<span class="sell">Nedtrend</span>' : "Ingen tydlig trend";
    return `<div class="verdict v-${f.verdict}">
        <div class="small">Samlad signal · ${esc(inst().name)} · ${esc(f.tf_name.toLowerCase())}</div>
        <div class="big">${f.verdict}</div>
        <div class="meter" title="Styrka"><i style="width:${f.strength}%"></i></div>
        <div class="small">Styrka ${f.strength} % · stängning ${fmtTime(f.last_time)}</div>
      </div>
      ${p ? `<h2>Handelsplan (${p.dir > 0 ? "long" : "short"})</h2>
      <div class="kv">
        <span class="lbl">Inträde</span><span>${nf(p.entry)}</span><span></span>
        <span class="lbl">Stoploss</span><span class="sell">${nf(p.sl)}</span><span class="muted small">−${nf(p.risk_pct, 2)} %</span>
        <span class="lbl">TP1 (1R)</span><span class="buy">${nf(p.tp1)}</span><span class="muted small">${nf(p.risk_pct, 2)} %</span>
        <span class="lbl">TP2 (2R)</span><span class="buy">${nf(p.tp2)}</span><span class="muted small">${nf(p.risk_pct * 2, 2)} %</span>
        <span class="lbl">TP3 (3R)</span><span class="buy">${nf(p.tp3)}</span><span class="muted small">${nf(p.risk_pct * 3, 2)} %</span>
      </div>
      <p class="muted small">Stoploss 2 × ATR från senaste stängning. Flytta gärna stoppet till inträdet när TP1 nås.</p>` : `<p class="muted small">Ingen tydlig övervikt åt något håll. Strategierna är oense eller har inga öppna signaler.</p>`}
      <h2 style="margin-top:14px">Röster</h2>
      <p class="small" style="margin-top:0">${votes}</p>
      <h2>Läge</h2>
      <div class="kv">
        <span class="lbl">Trend (EMA 50/200)</span><span>${trend}</span><span></span>
        <span class="lbl">RSI 14</span><span>${nf(f.ind.rsi14)}</span><span class="muted small">${f.ind.rsi14 > 70 ? "överköpt" : f.ind.rsi14 < 30 ? "översåld" : ""}</span>
        <span class="lbl">ADX</span><span>${nf(f.ind.adx)}</span><span class="muted small">${f.ind.adx > 25 ? "stark trend" : f.ind.adx < 18 ? "sidledes" : ""}</span>
        <span class="lbl">ATR 14</span><span>${nf(f.ind.atr)}</span><span class="muted small">${nf(f.ind.atr_pct, 2)} %</span>
        <span class="lbl">MACD</span><span class="${cls(f.ind.macd - f.ind.macd_sig)}">${nf(f.ind.macd, 2)}</span><span class="muted small">sig ${nf(f.ind.macd_sig, 2)}</span>
      </div>`;
  }

  function strategyTable(f) {
    const row = (s) => {
      const h = s.hist, w = s.wf.used, a = s.wf;
      return `<tr class="${s.ok ? "" : "off"} click" data-strat="${s.id}">
        <td class="l"><b>${esc(s.name)}</b><div class="rule">${esc(s.rule)}</div></td>
        <td>${s.state ? dirTxt(s.state) : "–"}</td>
        <td>${nf(s.sl_mult)} ATR / ${nf(s.tp_r)}R</td>
        <td>${h.n}</td><td>${pct(h.win)}</td><td class="${cls(h.avg_r)}">${sgn(h.avg_r)}</td>
        <td>${a.used_folds}/${f.wf.folds}</td><td>${w.n}</td><td>${pct(w.win)}</td><td class="${cls(w.avg_r)}">${sgn(w.avg_r)}</td><td>${w.pf == null ? "–" : nf(w.pf, 2)}</td>
        <td>${s.ok ? `<span class="tag v-KÖP">Används</span>` : `<span class="tag v-AVVAKTA">Används ej</span>`}</td>
      </tr>`;
    };
    return `<div class="panel"><h2>Strategier</h2>
      <p class="muted small" style="margin-top:-4px">Stoploss och mål väljs på hela historiken fram till nu. En strategi används bara om den tjänat pengar där (efter ett avdrag för få affärer). Walk-forward visar hur strategin gick i de perioder boten själv valde att använda den. Klicka på en rad för att se dess affärer i grafen.</p>
      <div class="tablewrap"><table>
        <thead><tr><th class="l" rowspan="2">Strategi</th><th rowspan="2">Nu</th><th rowspan="2">SL / TP</th><th colspan="3" style="text-align:center">Hela historiken</th><th colspan="5" style="text-align:center">Walk-forward (som live)</th><th rowspan="2"></th></tr>
        <tr><th>Affärer</th><th>Vinst</th><th>Snitt R</th><th>Perioder</th><th>Affärer</th><th>Vinst</th><th>Snitt R</th><th>PF</th></tr></thead>
        <tbody>${f.strategies.map(row).join("")}</tbody></table></div></div>`;
  }

  function profitPanel(f) {
    const rp = state.data.risk_pct;
    const rows = [];
    state.data.instruments.forEach((i) => i.timeframes.forEach((t) => rows.push({ i, t, w: t.wf })));
    const yrs = (w) => w.years >= 1 ? nf(w.years, 1) + " år" : Math.round(w.years * 12) + " mån";
    const verdict = (w) => w.n < 60 ? "För få affärer" : (w.pf || 0) >= 1.3 && w.avg_r >= 0.15 ? "Lönsam" : (w.pf || 0) > 1.05 ? "Svag" : "Inte lönsam";
    const vcls = (v) => v === "Lönsam" ? "v-KÖP" : v === "Inte lönsam" ? "v-SÄLJ" : "v-AVVAKTA";
    const w = f.wf;
    return `<div class="panel"><h2>Är den lönsam?</h2>
      <p class="muted small" style="margin-top:-4px">Walk-forward: boten väljer stoploss, mål och vilka strategier som ska användas <b>bara på data före</b> varje period och handlar sedan perioden (${w.folds} perioder i följd), precis som om den körts live. Avgift för spread dras. Pengar räknat med ${nf(rp, 0)} % av kontot i risk per affär, utan ränta på ränta.</p>
      <div class="tablewrap"><table>
        <thead><tr><th class="l">Instrument</th><th class="l">Tidsram</th><th>Testat</th><th>Affärer</th><th>Vinst</th><th>Snitt R</th><th>PF</th><th>Resultat</th><th>Per år</th><th>Max nedgång</th><th>Köp &amp; behåll</th><th></th></tr></thead>
        <tbody>${rows.map(({ i, t, w }) => { const v = verdict(w); return `<tr class="click ${i.id === inst().id && t.tf === f.tf ? "sel" : ""}" data-inst="${i.id}" data-tf="${t.tf}">
          <td class="l">${esc(i.name)}</td><td class="l">${esc(t.tf_name)}</td><td>${yrs(w)}</td><td>${w.n}</td><td>${pct(w.win)}</td>
          <td class="${cls(w.avg_r)}">${sgn(w.avg_r)}</td><td>${w.pf == null ? "–" : nf(w.pf, 2)}</td>
          <td class="${cls(w.ret_pct)}">${sgn(w.ret_pct, 1)} %</td><td class="${cls(w.ret_pct_year)}">${sgn(w.ret_pct_year, 1)} %</td>
          <td class="neg">−${nf(w.dd_pct, 1)} %</td><td class="${cls(w.bh_pct)}">${sgn(w.bh_pct, 1)} %</td>
          <td><span class="tag ${vcls(v)}">${v}</span></td></tr>`; }).join("")}</tbody></table></div>
      <h2 style="margin-top:16px">Resultatkurva · ${esc(inst().name)} · ${esc(f.tf_name.toLowerCase())} <span class="muted small">${fmtTime(w.from)} – ${fmtTime(w.to)}</span></h2>
      <div id="equity"></div>
      <p class="muted small">Summa R efter varje stängd affär. Long: ${w.long.n} affärer, snitt ${sgn(w.long.avg_r)}R. Short: ${w.short.n} affärer, snitt ${sgn(w.short.avg_r)}R.</p>
      <p class="small"><b>Att tänka på:</b> köp &amp; behåll har ofta gett mer i ren avkastning (särskilt Nasdaq på lång sikt), men med mycket större nedgångar. Boten riskerar ${nf(rp, 0)} % per affär och ligger ofta utanför marknaden. Timdata finns bara för knappt två år, så resultaten för 4 timmar och timme bygger på en kort period. Ränta för att ligga över natten (CFD) och slippage vid stora rörelser är inte medräknat.</p>
    </div>`;
  }

  function drawEquity(f) {
    const el = $("#equity");
    if (!el || !window.LightweightCharts || !f.wf.curve.length) return;
    if (state.eq) { state.eq.remove(); state.eq = null; }
    const intraday = typeof f.wf.curve[0][0] === "number";
    const ch = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: css("--panel") }, textColor: css("--muted") },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border"), timeVisible: intraday },
      localization: { locale: "sv-SE", priceFormatter: (v) => nf(v, 1) + "R", timeFormatter: intraday ? (t) => sthlm.format(new Date(t * 1000)) : undefined },
      handleScroll: false, handleScale: false,
    });
    state.eq = ch;
    const last = f.wf.curve[f.wf.curve.length - 1][1];
    const s = ch.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2, priceLineVisible: false,
      topLineColor: css("--buy"), topFillColor1: css("--buy") + "33", topFillColor2: css("--buy") + "05",
      bottomLineColor: css("--sell"), bottomFillColor1: css("--sell") + "05", bottomFillColor2: css("--sell") + "33" });
    // flera affärer kan stänga samma bar: behåll den sista
    const pts = new Map();
    f.wf.curve.forEach(([t, v]) => pts.set(t, v));
    s.setData([...pts].map(([time, value]) => ({ time, value })));
    ch.timeScale().fitContent();
    return last;
  }

  function activeTable(f) {
    if (!f.active.length) return "";
    return `<div class="panel"><h2>Öppna signaler</h2><div class="tablewrap"><table>
      <thead><tr><th class="l">Strategi</th><th>Riktning</th><th>Sedan</th><th>Inträde</th><th>Stoploss</th><th>Mål</th><th>R nu</th><th></th></tr></thead>
      <tbody>${f.active.map((a) => `<tr class="${a.counts ? "" : "off"}"><td class="l">${esc(a.name)}</td><td>${dirTxt(a.dir)}</td><td>${fmtTime(a.since)}</td>
        <td>${nf(a.entry)}</td><td class="sell">${nf(a.sl)}</td><td class="buy">${nf(a.tp)}</td><td class="${cls(a.r_now)}">${sgn(a.r_now)}</td>
        <td>${a.counts ? "" : '<span class="small muted">räknas ej</span>'}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  function recentTable(f) {
    const rows = [];
    f.strategies.forEach((s) => s.recent.forEach((t) => rows.push({ ...t, name: s.name, ok: s.ok })));
    const key = (t) => typeof t.time === "number" ? t.time : Date.parse(t.time) / 1000;
    rows.sort((a, b) => key(b) - key(a));
    return `<div class="panel"><h2>Senaste affärerna i backtestet</h2><div class="tablewrap"><table>
      <thead><tr><th class="l">Signal</th><th class="l">Strategi</th><th>Riktning</th><th>Inträde</th><th>Utgång</th><th>Resultat</th><th>R</th></tr></thead>
      <tbody>${rows.slice(0, 15).map((t) => `<tr class="${t.ok ? "" : "off"}"><td class="l">${fmtTime(t.time)}</td><td class="l">${esc(t.name)}</td><td>${dirTxt(t.dir)}</td>
        <td>${nf(t.entry)}</td><td>${t.exit == null ? "–" : nf(t.exit)}</td><td>${RES[t.result]}</td><td class="${cls(t.r)}">${sgn(t.r)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  function chartPanel(f) {
    const opts = [["counted", "Strategier som räknas"], ["all", "Alla strategier"], ["none", "Inga signaler"]]
      .concat(f.strategies.map((s) => [s.id, s.name]));
    return `<div class="panel">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <h2 style="margin:0">${esc(inst().name)} · ${esc(f.tf_name.toLowerCase())} <span class="muted small">${esc(inst().symbol)}</span></h2>
        <label class="small muted">Visa <select id="show">${opts.map(([v, t]) => `<option value="${v}" ${v === state.show ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      </div>
      <div id="chart"></div>
      <div class="legend"><span><i style="background:var(--ema20)"></i>EMA 20</span><span><i style="background:var(--ema50)"></i>EMA 50</span><span><i style="background:var(--ema200)"></i>EMA 200</span><span>▲ long · ▼ short (✓ mål, ✗ stopp, ⏱ tidsstopp, • öppen)</span></div>
    </div>`;
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawChart(f) {
    const el = $("#chart");
    if (!el || !window.LightweightCharts) return;
    if (state.chart) { state.chart.remove(); state.chart = null; }
    const intraday = typeof f.candles[0][0] === "number";
    const chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: css("--panel") }, textColor: css("--muted") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: {
        borderColor: css("--border"), timeVisible: intraday, secondsVisible: false,
        tickMarkFormatter: intraday ? (t, type) => (type >= 3 ? sthlmHour : sthlmDay).format(new Date(t * 1000)) : undefined,
      },
      localization: { locale: "sv-SE", timeFormatter: intraday ? (t) => sthlm.format(new Date(t * 1000)) : undefined },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    state.chart = chart;
    const cs = chart.addCandlestickSeries({
      upColor: css("--buy"), downColor: css("--sell"), wickUpColor: css("--buy"), wickDownColor: css("--sell"), borderVisible: false,
    });
    cs.setData(f.candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
    [["ema20", "--ema20"], ["ema50", "--ema50"], ["ema200", "--ema200"]].forEach(([k, c]) => {
      const s = chart.addLineSeries({ color: css(c), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(f.candles.map((cd, i) => ({ time: cd[0], value: f.lines[k][i] })).filter((p) => p.value != null));
    });
    const ok = new Set(f.strategies.filter((s) => s.ok).map((s) => s.id));
    const short = Object.fromEntries(f.strategies.map((s) => [s.id, s.name.split(/[ /]/)[0]]));
    const keep = (m) => state.show === "all" || (state.show === "counted" ? ok.has(m.strategy) : m.strategy === state.show);
    const icon = { tp: "✓", sl: "✗", time: "⏱", open: "•" };
    const key = (t) => typeof t === "number" ? t : Date.parse(t) / 1000;
    const marks = state.show === "none" ? [] : f.markers.filter(keep).sort((a, b) => key(a.time) - key(b.time)).map((m) => ({
      time: m.time, position: m.dir > 0 ? "belowBar" : "aboveBar", shape: m.dir > 0 ? "arrowUp" : "arrowDown",
      color: m.dir > 0 ? css("--buy") : css("--sell"), text: `${short[m.strategy]} ${icon[m.result]}`,
    }));
    cs.setMarkers(marks);
    const p = f.plan;
    if (p) {
      const line = (price, color, title) => cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title });
      line(p.sl, css("--sell"), "SL");
      line(p.tp1, css("--buy"), "TP1");
      line(p.tp2, css("--buy"), "TP2");
      line(p.tp3, css("--buy"), "TP3");
    }
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, f.candles.length - 160), to: f.candles.length + 3 });
  }

  function howItWorks() {
    return `<div class="panel"><details><summary>Så fungerar boten</summary>
      <ol>
        <li><b>Data:</b> dagsdata (upp till 15 år) och timdata (2 år) från Yahoo Finance. 4-timmarsstaplar byggs av timdatan. Nasdaq 100 = indexet ${esc(state.data.instruments.find((i) => i.id === "NDX")?.symbol || "^NDX")}, guld = terminen ${esc(state.data.instruments.find((i) => i.id === "GOLD")?.symbol || "GC=F")}. Priset hos din mäklare (CFD/US100, XAUUSD) kan skilja något.</li>
        <li><b>Strategier:</b> fem regelbaserade strategier, både long och short: trendföljning, utbrott, rekyl i trend, MACD-vändning och översåld/överköpt.</li>
        <li><b>Backtest:</b> för varje instrument, tidsram och strategi väljs stoploss (1,5/2/3 × ATR) och mål (1/1,5/2/3 R). Strategier som inte tjänat pengar används inte.</li>
        <li><b>Walk-forward:</b> samma val görs om och om igen med bara den data som fanns vid varje tidpunkt, och nästa period handlas. Det är det ärliga måttet på om boten är lönsam.</li>
        <li><b>Samlad signal:</b> strategierna som används röstar med sin öppna signal, viktat efter hur säkert de tjänat pengar. Övervikt på minst 25 % ger KÖP eller SÄLJ.</li>
        <li><b>Notiser:</b> boten körs varje timme på vardagar och kan skicka nya signaler till Telegram eller Discord.</li>
      </ol></details></div>`;
  }

  function render() {
    const d = state.data;
    if (!d.instruments.length) { app.innerHTML = '<p class="notice">Ingen data ännu.</p>'; return; }
    state.inst = inst().id; state.tf = frame().tf;
    const f = frame();
    tabs();
    app.innerHTML = `${d.demo ? '<p class="notice"><b>Demo:</b> datan är syntetisk (testkörning utan nätverk). Riktiga kurser hämtas när GitHub Actions kör boten.</p>' : ""}
      <p class="muted small" style="margin-top:0">Uppdaterad ${new Date(d.updated).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" })}</p>
      ${overview()}
      <div class="grid2">
        <div>${chartPanel(f)}${activeTable(f)}</div>
        <div class="panel">${verdictCard(f)}</div>
      </div>
      ${profitPanel(f)}${strategyTable(f)}${recentTable(f)}${howItWorks()}`;
    drawChart(f);
    drawEquity(f);
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-inst],[data-tf],[data-strat]");
    if (!b) return;
    if (b.dataset.strat) { state.show = b.dataset.strat; save(); render(); $("#chart")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (b.dataset.inst) state.inst = b.dataset.inst;
    if (b.dataset.tf) state.tf = b.dataset.tf;
    save(); render();
  });
  document.addEventListener("change", (e) => { if (e.target.id === "show") { state.show = e.target.value; save(); drawChart(frame()); } });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => state.data && render());

  fetch("data/signals.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => { state.data = d; render(); })
    .catch(() => { app.innerHTML = '<p class="notice">Signalerna är inte framräknade än. Kör <code>python scripts/trading/build.py</code> eller arbetsflödet i GitHub Actions.</p>'; });
})();
