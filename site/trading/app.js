"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const app = $("#app");
  const state = { data: null, inst: "NDX", tf: "1d", show: "mtf", chart: null };
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
  const RES = { tp: "Mål nått", sl: "Stoppad", be: "Stopp på inträdet", time: "Tidsstopp", open: "Öppen" };

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

  const ARW = (t) => t > 0 ? '<span class="buy">▲</span>' : t < 0 ? '<span class="sell">▼</span>' : '<span class="muted">–</span>';

  function overview() {
    return `<div class="overview">${state.data.instruments.map((i) => {
      const c = i.combined, q = i.quote || { price: i.timeframes[0].close, change_pct: i.timeframes[0].change_pct, symbol: "" };
      return `<div class="ov ${i.id === inst().id ? "on" : ""}" data-inst="${i.id}">
        <div class="head"><span class="name">${esc(i.name)}</span>
          <span class="px" title="Senaste kurs (${esc(q.symbol)}), ändring mot förra handelsdagens stängning">${nf(q.price)} <span class="small ${cls(q.change_pct)}">${sgn(q.change_pct)} %</span></span></div>
        <div class="combo v-${c.verdict}"><span>Alla tidsramar</span><b>${c.verdict}${c.verdict === "AVVAKTA" ? "" : " " + c.strength + " %"}</b>
          <span class="small">${c.buy} köp · ${c.sell} sälj · ${c.wait} avvakta</span></div>
        <div class="row">${i.timeframes.map((t) => `<div class="cell v-${t.verdict} ${t.notify_ok ? "live" : ""}" data-inst="${i.id}" data-tf="${t.tf}" title="${esc(t.tf_name)}: ${t.verdict}${t.notify_ok ? ", skickar notiser" : ""}">
          <span>${esc(t.tf_short)} ${ARW(t.trend)}</span><b>${t.verdict === "AVVAKTA" ? "–" : t.verdict}</b></div>`).join("")}</div>
      </div>`;
    }).join("")}</div>
    <p class="muted small" style="margin:-6px 0 14px">▲▼ = trend på tidsramen. Tidsramar med prick skickar notiser (de har tjänat pengar i testet med filter för högre tidsramar).</p>`;
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
      <h2 style="margin-top:14px">Högre tidsramar</h2>
      <p class="small" style="margin-top:0">${f.mtf.higher.length ? f.mtf.higher.map((h, k) => `${esc(h)} ${ARW(f.mtf.trends[k])}`).join(" &nbsp; ") + `<br><span class="muted">Tillåter nu: ${f.mtf.long_ok ? '<span class="buy">long</span>' : ""}${f.mtf.long_ok && f.mtf.short_ok ? " och " : ""}${f.mtf.short_ok ? '<span class="sell">short</span>' : ""}${!f.mtf.long_ok && !f.mtf.short_ok ? "inget (trenderna är oense)" : ""}</span>` : "Högsta tidsramen, inget filter."}
      <br><span class="tag ${f.notify_ok ? "v-KÖP" : "v-AVVAKTA"}">${f.notify_ok ? "Skickar notiser" : "Skickar inga notiser"}</span></p>
      <h2>Röster</h2>
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

  const setting = (p) => `${nf(p.sl_mult)} ATR / ${nf(p.tp_r)}R${p.be ? " · BE" : ""}${p.mode === "strict" ? " · strikt" : p.mode === "loose" ? "" : ""}`;

  function strategyTable(f) {
    const row = (s) => {
      const h = s.hist, w = s.wf.used, m = s.wf_mtf.used;
      return `<tr class="${s.ok || s.ok_mtf ? "" : "off"} click" data-strat="${s.id}">
        <td class="l"><b>${esc(s.name)}</b><div class="rule">${esc(s.rule)}</div></td>
        <td>${s.state ? dirTxt(s.state) : "–"}</td>
        <td>${setting(s.mtf_params)}</td>
        <td>${h.n}</td><td class="${cls(h.avg_r)}">${sgn(h.avg_r)}</td>
        <td>${w.n}</td><td class="${cls(w.avg_r)}">${sgn(w.avg_r)}</td>
        <td>${m.n}</td><td>${pct(m.win)}</td><td class="${cls(m.avg_r)}">${sgn(m.avg_r)}</td><td>${m.pf == null ? "–" : nf(m.pf, 2)}</td>
        <td>${s.ok_mtf ? `<span class="tag v-KÖP">Används</span>` : `<span class="tag v-AVVAKTA">Används ej</span>`}</td>
      </tr>`;
    };
    return `<div class="panel"><h2>Strategier · ${esc(f.tf_name.toLowerCase())}</h2>
      <p class="muted small" style="margin-top:-4px">Stoploss och mål väljs på historiken fram till nu. En strategi används bara om den tjänat pengar där. Walk-forward visar hur strategin gick i perioderna där boten själv valde att använda den, utan och med filtret för högre tidsramar. Notiserna använder kolumnen Med filter. Inställning = stoploss / mål med filter. BE = stoppet flyttas till inträdet efter +1R. Strikt = båda högre tidsramarna måste gå åt samma håll. Klicka på en rad för att se strategins affärer i grafen.</p>
      <div class="tablewrap"><table>
        <thead><tr><th class="l" rowspan="2">Strategi</th><th rowspan="2">Nu</th><th rowspan="2">Inställning</th><th colspan="2" style="text-align:center">Historiken</th><th colspan="2" style="text-align:center">Utan filter</th><th colspan="4" style="text-align:center">Med filter (som live)</th><th rowspan="2"></th></tr>
        <tr><th>Affärer</th><th>Snitt R</th><th>Affärer</th><th>Snitt R</th><th>Affärer</th><th>Vinst</th><th>Snitt R</th><th>PF</th></tr></thead>
        <tbody>${f.strategies.map(row).join("")}</tbody></table></div></div>`;
  }

  function profitPanel(f) {
    const rp = state.data.risk_pct, rule = state.data.notify_rule;
    const rows = [];
    state.data.instruments.forEach((i) => i.timeframes.forEach((t) => rows.push({ i, t })));
    const span = (w) => w.years >= 1 ? nf(w.years, 1) + " år" : w.years >= 0.15 ? Math.round(w.years * 12) + " mån" : Math.round(w.years * 365) + " dagar";
    const verdict = (t) => { const w = t.wf_mtf; return t.notify_ok ? "Lönsam" : w.n < rule.min_trades ? "För få affärer" : (w.avg_r || 0) > 0 && (w.pf || 0) > 1.05 ? "Osäker" : "Inte lönsam"; };
    const vcls = (v) => v === "Lönsam" ? "v-KÖP" : v === "Inte lönsam" ? "v-SÄLJ" : "v-AVVAKTA";
    const w = f.wf_mtf;
    return `<div class="panel"><h2>Är den lönsam?</h2>
      <p class="muted small" style="margin-top:-4px">Walk-forward: boten väljer stoploss, mål och strategier <b>bara på data före</b> varje period och handlar sedan perioden, precis som live. <b>Med filter</b> = signalen tas bara när de ${state.data.mtf_higher} närmast högre tidsramarna inte pekar åt andra hållet och minst en håller med. Spread och slippage dras (${esc(String(inst().cost_pts).replace(".", ","))} punkter per affär för ${esc(inst().name)}). Pengar räknat med ${nf(rp, 0)} % av kontot i risk per affär.
      Notiser skickas bara där testet med filter har minst ${rule.min_trades} affärer, vinstfaktor (PF) minst ${nf(rule.min_pf, 1)} och t-värde minst ${nf(rule.min_t, 1)}. Ett t-värde under 2 betyder att resultatet lika gärna kan vara tur. <b>Max öppna</b> = flest affärer öppna samtidigt (alla strategier). Med ${nf(rp, 0)} % per affär kan risken då vara flera procent på en gång, så sänk risken per affär om det är för mycket.</p>
      <div class="tablewrap"><table>
        <thead><tr><th class="l" rowspan="2">Instrument</th><th class="l" rowspan="2">Tidsram</th><th rowspan="2">Testat</th><th colspan="3" style="text-align:center">Utan filter</th><th colspan="8" style="text-align:center">Med filter för högre tidsramar</th><th rowspan="2"></th></tr>
        <tr><th>Affärer</th><th>Snitt R</th><th>PF</th><th>Affärer</th><th>Vinst</th><th>Snitt R</th><th>PF</th><th>t</th><th>Resultat</th><th>Max nedgång</th><th>Max öppna</th></tr></thead>
        <tbody>${rows.map(({ i, t }) => { const u = t.wf, m = t.wf_mtf, v = verdict(t); return `<tr class="click ${i.id === inst().id && t.tf === f.tf ? "sel" : ""}" data-inst="${i.id}" data-tf="${t.tf}">
          <td class="l">${esc(i.name)}</td><td class="l">${esc(t.tf_name)}</td><td>${span(m)}</td>
          <td>${u.n}</td><td class="${cls(u.avg_r)}">${sgn(u.avg_r)}</td><td>${u.pf == null ? "–" : nf(u.pf, 2)}</td>
          <td>${m.n}</td><td>${pct(m.win)}</td><td class="${cls(m.avg_r)}">${sgn(m.avg_r)}</td><td>${m.pf == null ? "–" : nf(m.pf, 2)}</td>
          <td class="${(m.t || 0) >= rule.min_t ? "pos" : ""}">${m.t == null ? "–" : nf(m.t, 1)}</td>
          <td class="${cls(m.ret_pct)}">${sgn(m.ret_pct, 1)} %</td><td class="neg">−${nf(m.dd_pct, 1)} %</td><td>${m.max_open ?? "–"}</td>
          <td><span class="tag ${vcls(v)}">${v}</span></td></tr>`; }).join("")}</tbody></table></div>
      <h2 style="margin-top:16px">Resultatkurva · ${esc(inst().name)} · ${esc(f.tf_name.toLowerCase())} <span class="muted small">${fmtTime(w.from)} – ${fmtTime(w.to)}</span></h2>
      <div id="equity"></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Med filter</span><span><i style="background:var(--muted)"></i>Utan filter</span></div>
      <p class="muted small">Summa R efter varje stängd affär. Med filter: long ${w.long.n} affärer (snitt ${sgn(w.long.avg_r)}R), short ${w.short.n} affärer (snitt ${sgn(w.short.avg_r)}R). Köp &amp; behåll under samma tid: ${sgn(w.bh_pct, 1)} %.</p>
      <p class="small"><b>Att tänka på:</b> Yahoo har bara 30 dagars 1-minutersdata, 60 dagars data för 5–30 minuter och 2 års timdata. Resultaten för korta tidsramar bygger därför på några veckor och kan ändras snabbt. Ränta för att ligga över natten (CFD) och slippage vid nyheter är inte medräknat.</p>
    </div>`;
  }

  function drawEquity(f) {
    const el = $("#equity");
    if (!el || !window.LightweightCharts) return;
    if (state.eq) { state.eq.remove(); state.eq = null; }
    const curves = [f.wf.curve, f.wf_mtf.curve];
    const any = curves.find((c) => c.length);
    if (!any) { el.innerHTML = '<p class="muted small">Inga affärer i testet.</p>'; return; }
    const intraday = typeof any[0][0] === "number";
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
    // flera affärer kan stänga samma bar: behåll den sista
    const pts = (c) => { const m = new Map(); c.forEach(([t, v]) => m.set(t, v)); return [...m].map(([time, value]) => ({ time, value })); };
    const raw = ch.addLineSeries({ color: css("--muted"), lineWidth: 1.5, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true });
    raw.setData(pts(f.wf.curve));
    const s = ch.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2, priceLineVisible: false,
      topLineColor: css("--accent"), topFillColor1: css("--accent") + "33", topFillColor2: css("--accent") + "05",
      bottomLineColor: css("--sell"), bottomFillColor1: css("--sell") + "05", bottomFillColor2: css("--sell") + "33" });
    s.setData(pts(f.wf_mtf.curve));
    ch.timeScale().fitContent();
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
      <tbody>${rows.slice(0, 15).map((t) => `<tr class="${t.ok ? "" : "off"}"><td class="l">${fmtTime(t.time)}</td><td class="l">${esc(t.name)}${t.mtf ? "" : ' <span class="muted small">(mot högre tidsram)</span>'}</td><td>${dirTxt(t.dir)}</td>
        <td>${nf(t.entry)}</td><td>${t.exit == null ? "–" : nf(t.exit)}</td><td>${RES[t.result]}</td><td class="${cls(t.r)}">${sgn(t.r)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  function chartPanel(f) {
    const opts = [["mtf", "Signaler som klarar filtret"], ["counted", "Strategier som används"], ["all", "Alla strategier"], ["none", "Inga signaler"]]
      .concat(f.strategies.map((s) => [s.id, s.name]));
    return `<div class="panel">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <h2 style="margin:0">${esc(inst().name)} · ${esc(f.tf_name.toLowerCase())} <span class="muted small">${esc(f.symbol || "")}</span></h2>
        <label class="small muted">Visa <select id="show">${opts.map(([v, t]) => `<option value="${v}" ${v === state.show ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      </div>
      <div id="chart"></div>
      <div class="legend"><span><i style="background:var(--ema20)"></i>EMA 20</span><span><i style="background:var(--ema50)"></i>EMA 50</span><span><i style="background:var(--ema200)"></i>EMA 200</span><span>▲ long · ▼ short (✓ mål, ✗ stopp, = stopp på inträdet, ⏱ tidsstopp, • öppen)</span></div>
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
    const okMtf = new Set(f.strategies.filter((s) => s.ok_mtf).map((s) => s.id));
    const keep = (m) => state.show === "all" || (state.show === "counted" ? ok.has(m.strategy)
      : state.show === "mtf" ? (okMtf.has(m.strategy) && m.mtf) : m.strategy === state.show);
    const icon = { tp: "✓", sl: "✗", be: "=", time: "⏱", open: "•" };
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
    const keepRange = state.keepRange && state.keepRange.key === `${state.inst}|${f.tf}` ? state.keepRange : null;
    if (keepRange && keepRange.range) {
      // live-uppdatering: behåll zoomen, men flytta fram om man tittade på sista baren
      const shift = f.candles.length - keepRange.len;
      const r = keepRange.range;
      chart.timeScale().setVisibleLogicalRange(r.to >= keepRange.len - 1 ? { from: r.from + shift, to: r.to + shift } : r);
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, f.candles.length - 160), to: f.candles.length + 3 });
    }
    state.keepRange = null;
  }

  function howItWorks() {
    const sym = (id) => { const i = state.data.instruments.find((x) => x.id === id); return i ? Object.entries(i.symbols).map(([k, v]) => `${k}: ${v}`).join(", ") : ""; };
    return `<div class="panel"><details><summary>Så fungerar boten</summary>
      <ol>
        <li><b>Data:</b> Yahoo Finance på sju tidsramar: dag, 4 timmar, timme, 30, 15, 5 och 1 minut (4 h byggs av timdata, 30 och 15 min av 5-minutersdata). Nasdaq 100: dagsdata från indexet, kortare tidsramar från terminen NQ=F som handlas nästan dygnet runt. Guld: terminen GC=F. Priset hos din mäklare (US100, XAUUSD) kan skilja något. Källor: Nasdaq (${esc(sym("NDX"))}), guld (${esc(sym("GOLD"))}).</li>
        <li><b>Strategier:</b> fem regelbaserade strategier, både long och short: trendföljning, utbrott, rekyl i trend, MACD-vändning och översåld/överköpt.</li>
        <li><b>Kombination av tidsramar:</b> en signal tas bara när de två närmast högre tidsramarna inte är i motsatt trend och minst en av dem går åt samma håll. Exempel: en köpsignal på 5 minuter kräver att 15 och 30 minuter inte är i nedtrend.</li>
        <li><b>Backtestets regler:</b> inträde på nästa bars öppning. Når en bar både stopp och mål räknas det som stopp. Öppnar kursen bortom stoppet (gap över natten eller helgen) räknas utgången på öppningskursen, inte på stoppet. Spread och slippage dras på varje affär.</li>
        <li><b>Walk-forward:</b> stopp, mål, break-even, filterläge och strategier väljs om och om igen med bara den data som fanns vid varje tidpunkt, och nästa period handlas. Det visar om kombinationen faktiskt hade fungerat.</li>
        <li><b>Notiser:</b> skickas bara för tidsramar som klarat testet med filter (tillräckligt många affärer, vinstfaktor och t-värde), och bara för signaler som klarar filtret när de kommer. Varje notis visar trenden på alla tidsramar.</li>
        <li><b>Samlad signal:</b> per tidsram röstar strategierna som används med sin öppna signal. "Alla tidsramar" är snittet av de sju.</li>
      </ol></details></div>`;
  }

  function render() {
    const d = state.data;
    if (!d.instruments.length) { app.innerHTML = '<p class="notice">Ingen data ännu.</p>'; return; }
    state.inst = inst().id; state.tf = frame().tf;
    const f = frame();
    tabs();
    app.innerHTML = `${d.demo ? '<p class="notice"><b>Demo:</b> datan är syntetisk (testkörning utan nätverk). Riktiga kurser hämtas när GitHub Actions kör boten.</p>' : ""}
      <p class="muted small status" style="margin-top:0"><span id="live" class="livedot ${state.live ? "on" : ""}"></span><span id="age"></span></p>
      ${overview()}
      <div class="grid2">
        <div>${chartPanel(f)}${activeTable(f)}</div>
        <div class="panel">${verdictCard(f)}</div>
      </div>
      ${profitPanel(f)}${strategyTable(f)}${recentTable(f)}${howItWorks()}`;
    drawChart(f);
    drawEquity(f);
    showAge();
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

  // ---------------------------------------------------------------- live-uppdatering
  // Boten lägger färska signaler på grenen trading-data i GitHub (var 5:e minut). Sidan hämtar
  // dem varje minut och ritar om när något är nytt. Utan live-adress används sidans egen fil,
  // som också uppdateras varje minut om boten körs lokalt med --loop.
  const POLL_MS = 60 * 1000;
  let liveUrl = null;

  function showAge() {
    const el = $("#age"); if (!el || !state.data) return;
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(state.data.updated)) / 60000));
    const when = new Date(state.data.updated).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" });
    const ago = mins < 1 ? "nyss" : mins < 60 ? `för ${mins} min sedan` : mins < 1440 ? `för ${Math.round(mins / 60)} h sedan` : `${when}`;
    el.textContent = `${state.live ? "Live" : "Uppdaterad"} · signaler ${ago} (${when}) · kollar efter nya varje minut`;
    $("#live")?.classList.toggle("stale", mins > 20);
  }

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  async function load(first) {
    let d = null, src = null;
    if (liveUrl) {
      try { d = await getJson(liveUrl); src = "live"; } catch (e) { /* faller tillbaka på sidans egen fil */ }
    }
    try {
      const own = await getJson("data/signals.json");
      if (!d || Date.parse(own.updated) > Date.parse(d.updated)) { d = own; src = "own"; }
    } catch (e) { if (!d && first) throw e; }
    if (!d) return;
    if (state.data && d.updated === state.data.updated) { showAge(); return; }
    const isUpdate = !!state.data;
    if (isUpdate && state.chart) {
      // spara zoom och scroll så att uppdateringen inte flyttar sidan
      const f = frame();
      state.keepRange = { key: `${state.inst}|${f.tf}`, range: state.chart.timeScale().getVisibleLogicalRange(), len: f.candles.length };
    }
    const y = window.scrollY;
    // live = data från boten via GitHub, eller sidans egen fil som uppdaterats medan sidan var öppen
    state.data = d; state.live = state.live || src === "live" || (src === "own" && isUpdate);
    render();
    if (isUpdate) window.scrollTo(0, y);
  }

  (async () => {
    try { liveUrl = (await getJson("data/live.json")).url || null; } catch (e) { liveUrl = null; }
    try { await load(true); } catch (e) {
      app.innerHTML = '<p class="notice">Signalerna är inte framräknade än. Kör <code>python scripts/trading/build.py</code> eller arbetsflödet i GitHub Actions.</p>';
      return;
    }
    setInterval(() => { if (!document.hidden) load(false).catch(() => {}); }, POLL_MS);
    setInterval(showAge, 15000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false).catch(() => {}); });
  })();
})();
