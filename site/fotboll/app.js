'use strict';
/* Matchlabbet – all logik för sidan. Data byggs av scripts/fotboll/build.py. */

// ------------------------------------------------------------------ hjälpfunktioner
const TZ = 'Europe/Stockholm';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const comma = s => String(s).replace('.', ',');
const pct = (p, d = 0) => (p == null || isNaN(p)) ? '–' : comma((p * 100).toFixed(d)) + '\u00a0%';
const dec = (x, d = 2) => (x == null || isNaN(x)) ? '–' : comma(Number(x).toFixed(d));
const sgn = (x, d = 1) => (x == null || isNaN(x)) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + comma(Math.abs(x * 100).toFixed(d)) + '\u00a0%';
const lineTxt = L => comma(Number(L).toFixed(1));
const fmt = (d, o) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, ...o }).format(d);
const hm = iso => fmt(new Date(iso), { hour: '2-digit', minute: '2-digit' });
const dayKey = iso => fmt(new Date(iso), { year: 'numeric', month: '2-digit', day: '2-digit' });
const shortDate = ymd => fmt(new Date(ymd + 'T12:00Z'), { day: 'numeric', month: 'short' }).replace('.', '');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const longDateTime = iso => fmt(new Date(iso), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const started = f => new Date(f.ko).getTime() <= Date.now();

function dayName(key) {
  const today = dayKey(new Date().toISOString());
  const tomorrow = dayKey(new Date(Date.now() + 864e5).toISOString());
  if (key === today) return 'Idag';
  if (key === tomorrow) return 'Imorgon';
  return fmt(new Date(key + 'T12:00Z'), { weekday: 'long', day: 'numeric', month: 'long' });
}
function dayChip(key) {
  const n = dayName(key);
  return (n === 'Idag' || n === 'Imorgon') ? n : fmt(new Date(key + 'T12:00Z'), { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
}

function store(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function persist(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privat läge */ } }

// ------------------------------------------------------------------ tillstånd
const SRC = { avg: 0, max: 1, b365: 2, bw: 3 }; // samma ordning som oddslistorna i fixtures.json
const SRC_NAME = { avg: 'snittodds', max: 'bästa odds', b365: 'Bet365', bw: 'bwin' };
const S = {
  meta: null, fx: [], fxById: {}, teams: {}, leagues: {}, refs: {}, bt: null, files: {},
  set: Object.assign({ odds: 'max', bank: 1000 }, store('ml-settings', {})),
  slip: store('ml-slip', []), saved: store('ml-saved', []),
  ui: {
    day: 'all', lg: 'all', q: '', onlyValue: false,
    spel: { preset: 'varde', group: 'all', minP: 0.15, minO: 1.2, maxO: 5, minE: 0.03, real: true, day: 'all', lg: 'all', sort: 'e', asc: false },
    lag: { lg: 'all', set: 'oversikt', split: 'all', q: '', sort: 'ppg', asc: false },
    dom: { lg: 'all', minN: 5, sort: 'k', asc: false },
    gen: { n: 2, strat: 'varde', book: 'b365', minE: 0.02, minO: 1.2, maxO: 2.5, days: 'all', est: false, out: null, singles: [] },
    bt: { odds: 'max', grp: 'Alla', per: 1, cap: true },
    cmp: 'venue', stake: 100,
  },
};

async function getJSON(p) {
  const r = await fetch(p, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}

/** Matchfil för en liga (laddas när den behövs). */
function leagueFile(lg) {
  if (!S.files[lg]) {
    S.files[lg] = getJSON(`data/matches/${lg}.json`).then(d => d.rows.map(a => {
      const o = { lg };
      d.cols.forEach((c, i) => { o[c] = a[i]; });
      [o.hid, o.home] = d.teams[o.h];
      [o.aid, o.away] = d.teams[o.a];
      o.id = `${lg}-${o.date.replaceAll('-', '')}-${o.hid.split('--')[1]}-${o.aid.split('--')[1]}`;
      return o;
    })).catch(() => []);
  }
  return S.files[lg];
}

const lgName = lg => S.leagues[lg] ? `${S.leagues[lg].country} · ${S.leagues[lg].name}` : lg;
const lgShort = lg => S.leagues[lg] ? S.leagues[lg].name : lg;
const order = () => (S.meta?.order || Object.keys(S.leagues)).filter(l => S.leagues[l]);
/** Ordning i matchlistor: högsta divisionerna först. */
const listOrder = () => { const o = order(); return o.slice().sort((a, b) => (S.leagues[a].tier - S.leagues[b].tier) || (o.indexOf(a) - o.indexOf(b))); };

function leagueSelect(id, key, value, { withFixtures = false, filter = null } = {}) {
  const groups = {};
  for (const lg of order()) {
    const L = S.leagues[lg];
    if (withFixtures && !S.fx.some(f => f.lg === lg)) continue;
    if (filter && !filter(L)) continue;
    (groups[L.country] ||= []).push(lg);
  }
  let h = `<select id="${id}" data-k="${key}"><option value="all">Alla ligor</option>`;
  for (const [c, lgs] of Object.entries(groups)) {
    h += `<optgroup label="${esc(c)}">` + lgs.map(lg => `<option value="${lg}" ${lg === value ? 'selected' : ''}>${esc(S.leagues[lg].name)}</option>`).join('') + '</optgroup>';
  }
  return h + '</select>';
}

// ------------------------------------------------------------------ marknader
const CORNER_LINES = ['7.5', '8.5', '9.5', '10.5', '11.5'];
const CARD_LINES = ['2.5', '3.5', '4.5', '5.5'];
const GROUPS = [
  ['Resultat', ['1', 'X', '2', '1X', '12', 'X2']],
  ['Mål', ['O0.5', 'U0.5', 'O1.5', 'U1.5', 'O2.5', 'U2.5', 'O3.5', 'U3.5', 'O4.5', 'U4.5']],
  ['Båda lagen gör mål', ['BTTS:J', 'BTTS:N']],
  ['Lagmål', ['H:O0.5', 'H:O1.5', 'H:O2.5', 'A:O0.5', 'A:O1.5', 'A:O2.5', 'H:CS', 'A:CS']],
  ['Första halvlek', ['FH:O0.5', 'FH:O1.5']],
  ['Hörnor', CORNER_LINES.flatMap(l => ['C:O' + l, 'C:U' + l])],
  ['Kort', CARD_LINES.flatMap(l => ['K:O' + l, 'K:U' + l])],
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap(([g, ks]) => ks.map(k => [k, g])));

function label(key, f) {
  const H = f.home, A = f.away;
  const fixed = {
    '1': `${H} vinner`, 'X': 'Oavgjort', '2': `${A} vinner`,
    '1X': `${H} eller oavgjort`, '12': 'Inte oavgjort', 'X2': `${A} eller oavgjort`,
    'BTTS:J': 'Båda lagen gör mål', 'BTTS:N': 'Inte båda lagen gör mål',
    'H:CS': `${H} håller nollan`, 'A:CS': `${A} håller nollan`,
    'AH:H': `${H} ${ahTxt(f.ah?.line)} (asiatiskt)`, 'AH:A': `${A} ${ahTxt(-(f.ah?.line ?? 0))} (asiatiskt)`,
  };
  if (fixed[key]) return fixed[key];
  const m = key.match(/^(H:|A:|FH:|C:|K:)?([OU])(\d+\.5)$/);
  if (!m) return key;
  const L = lineTxt(m[3]), ou = m[2] === 'O' ? 'Över' : 'Under';
  switch (m[1]) {
    case 'H:': return m[3] === '0.5' ? `${H} gör mål` : `${H} över ${L} mål`;
    case 'A:': return m[3] === '0.5' ? `${A} gör mål` : `${A} över ${L} mål`;
    case 'FH:': return m[3] === '0.5' ? 'Mål i första halvlek' : `Över ${L} mål i första halvlek`;
    case 'C:': return `${ou} ${L} hörnor`;
    case 'K:': return `${ou} ${L} kort`;
    default: return `${ou} ${L} mål`;
  }
}
function ahTxt(l) { if (l == null) return ''; return (l > 0 ? '+' : l < 0 ? '−' : '') + comma(Math.abs(l)); }

/** Odds för ett spel med vald oddskälla. kind: real (från spelbolagen), calc (räknat från 1X2), est (uppskattat). */
function oddsOf(f, key, src = S.set.odds) {
  const i = SRC[src];
  // bara "bästa odds" får falla tillbaka på snittet; ett spelbolags odds får aldrig låtsas finnas
  const pick = arr => arr ? (arr[i] ?? (src === 'max' ? arr[0] : null)) : null;
  if (f.odds?.[key]) { const o = pick(f.odds[key]); if (o) return { o, kind: 'real' }; }
  if (['1X', '12', 'X2'].includes(key) && f.odds?.['1']) {
    // dubbelchans räknas från snittodds: bästa odds från olika spelbolag går inte att kombinera
    const [a, b] = key === '1X' ? ['1', 'X'] : key === '12' ? ['1', '2'] : ['X', '2'];
    const oa = f.odds[a]?.[0], ob = f.odds[b]?.[0];
    if (oa && ob) return { o: 1 / (1 / oa + 1 / ob), kind: 'calc' };
  }
  const p = f.p[key];
  if (p > 0.03 && p < 0.97) return { o: 0.93 / p, kind: 'est' };
  return null;
}
const fair = p => p > 0 ? 1 / p : null;

/** Alla spel för en match: {key, label, group, p, fair, o, kind, e}. */
function picks(f) {
  const out = [];
  for (const [g, keys] of GROUPS) {
    for (const k of keys) {
      const p = f.p[k];
      if (p == null) continue;
      const od = oddsOf(f, k);
      out.push({ f, key: k, group: g, p, fair: fair(p), o: od?.o ?? null, kind: od?.kind ?? null, e: od && od.kind !== 'est' ? p * od.o - 1 : null });
    }
  }
  if (f.ah) {
    const i = SRC[S.set.odds];
    for (const side of ['H', 'A']) {
      const s = f.ah[side];
      if (!s) continue;
      const o = s.odds[i] ?? (S.set.odds === 'max' ? s.odds[0] : null), e = s.ev[i] ?? (S.set.odds === 'max' ? s.ev[0] : null);
      if (o) out.push({ f, key: 'AH:' + side, group: 'Asiatiskt handikapp', p: s.pwin, fair: null, o, kind: 'real', e, ah: true });
    }
  }
  return out;
}

const VALUE_MAX_ODDS = 5; // över det är "bästa odds" ofta enstaka avvikande priser
function bestValue(f) {
  let best = null;
  for (const x of picks(f)) if (x.kind === 'real' && x.e != null && x.o <= VALUE_MAX_ODDS && (!best || x.e > best.e)) best = x;
  return best;
}

/** Avgör ett spel från slutresultatet. Returnerar true/false, eller null om data saknas. */
function settle(key, r) {
  if (r.hg == null || r.ag == null) return null;
  const T = r.hg + r.ag;
  switch (key) {
    case '1': return r.hg > r.ag;
    case 'X': return r.hg === r.ag;
    case '2': return r.hg < r.ag;
    case '1X': return r.hg >= r.ag;
    case '12': return r.hg !== r.ag;
    case 'X2': return r.hg <= r.ag;
    case 'BTTS:J': return r.hg > 0 && r.ag > 0;
    case 'BTTS:N': return !(r.hg > 0 && r.ag > 0);
    case 'H:CS': return r.ag === 0;
    case 'A:CS': return r.hg === 0;
  }
  const m = key.match(/^(H:|A:|FH:|C:|K:)?([OU])(\d+\.5)$/);
  if (!m) return null;
  let v;
  switch (m[1]) {
    case 'H:': v = r.hg; break;
    case 'A:': v = r.ag; break;
    case 'FH:': v = r.hthg == null ? null : r.hthg + r.htag; break;
    case 'C:': v = r.hc == null ? null : r.hc + r.ac; break;
    case 'K:': v = r.hy == null ? null : r.hy + r.ay + (r.hr || 0) + (r.ar || 0); break;
    default: v = T;
  }
  if (v == null) return null;
  return m[2] === 'O' ? v > +m[3] : v < +m[3];
}

/** Poisson med Dixon–Coles-justering (samma som i build.py) – används för att visa modellens egen bedömning. */
function dc(lh, la, rho = -0.06) {
  const n = 11, pois = l => { const p = [Math.exp(-l)]; for (let k = 1; k < n; k++) p.push(p[k - 1] * l / k); return p; };
  const ph = pois(lh), pa = pois(la);
  let s = 0, r = { '1': 0, 'X': 0, '2': 0, 'O2.5': 0, 'BTTS:J': 0 };
  const M = [];
  for (let i = 0; i < n; i++) {
    M.push([]);
    for (let j = 0; j < n; j++) {
      let v = ph[i] * pa[j];
      if (i === 0 && j === 0) v *= 1 - lh * la * rho;
      else if (i === 0 && j === 1) v *= 1 + lh * rho;
      else if (i === 1 && j === 0) v *= 1 + la * rho;
      else if (i === 1 && j === 1) v *= 1 - rho;
      v = Math.max(v, 0); M[i].push(v); s += v;
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = M[i][j] / s;
    r[i > j ? '1' : i === j ? 'X' : '2'] += v;
    if (i + j > 2.5) r['O2.5'] += v;
    if (i > 0 && j > 0) r['BTTS:J'] += v;
  }
  return r;
}

// ------------------------------------------------------------------ lappen
function inSlip(fid, key) { return S.slip.some(l => l.fid === fid && l.key === key); }
function toggleSlip(fid, key, src = S.set.odds) {
  const i = S.slip.findIndex(l => l.fid === fid && l.key === key);
  if (i >= 0) S.slip.splice(i, 1);
  else {
    const f = S.fxById[fid];
    if (!f) return;
    const od = oddsOf(f, key, src);
    S.slip.push({ fid, key, lg: f.lg, home: f.home, away: f.away, ko: f.ko, p: f.p[key], o: od ? +od.o.toFixed(2) : +(1 / f.p[key]).toFixed(2), kind: od?.kind || 'est', label: label(key, f) });
  }
  persist('ml-slip', S.slip);
  updateSlipCount();
  $$(`[data-add="${fid}|${key}"]`).forEach(b => { b.classList.toggle('on', inSlip(fid, key)); b.textContent = inSlip(fid, key) ? '✓' : '+'; });
}
function updateSlipCount() {
  const b = $('#slipCount');
  b.hidden = !S.slip.length;
  b.textContent = S.slip.length;
}
const addBtn = (fid, key, src = '') => key.startsWith('AH:') ? '' :
  `<button class="addbtn ${inSlip(fid, key) ? 'on' : ''}" data-add="${esc(fid)}|${esc(key)}" data-src="${src}" title="Lägg till på lappen" aria-label="Lägg till på lappen">${inSlip(fid, key) ? '✓' : '+'}</button>`;

// ------------------------------------------------------------------ små byggstenar
const formChips = letters => `<span class="form">${[...letters].map(x => `<span class="f ${x}" title="${x === 'V' ? 'Vinst' : x === 'O' ? 'Oavgjort' : 'Förlust'}">${x}</span>`).join('')}</span>`;

function bar(a, b, c) {
  const seg = (cls, p, n) => `<span class="${cls}" style="flex:${Math.max(p, 0.001)} 1 0" title="${n}: ${pct(p)}">${p >= 0.13 ? Math.round(p * 100) : ''}</span>`;
  return `<span class="bar" role="img" aria-label="1 ${pct(a)}, X ${pct(b)}, 2 ${pct(c)}">${seg('h', a, '1')}${seg('d', b, 'X')}${seg('a', c, '2')}</span>`;
}
const legend1x2 = () => `<span class="legend"><span><i style="background:var(--c-home)"></i>1 hemma</span><span><i style="background:var(--c-draw)"></i>X oavgjort</span><span><i style="background:var(--c-away)"></i>2 borta</span></span>`;

function oddsCell(x) {
  if (x.o == null) return '<span class="faint">–</span>';
  if (x.kind === 'real') return dec(x.o);
  const t = x.kind === 'calc' ? 'Räknat från 1X2-oddsen' : 'Uppskattat (rättvist odds minus 7 % marginal) – kolla ditt spelbolag';
  return `<span class="est" title="${t}">≈${dec(x.o)}</span>`;
}
function edgeCell(e, kind) {
  if (e == null) return kind === 'est' ? '<span class="faint" title="Saknar riktiga odds – jämför rättvist odds med ditt spelbolag">jämför</span>' : '<span class="faint">–</span>';
  return `<span class="edge ${e > 0 ? 'pos' : 'neg'}">${sgn(e)}</span>`;
}
const teamLink = (id, name) => S.teams[id] ? `<a href="#lag-${esc(id)}">${esc(name)}</a>` : esc(name);

function tile(k, v, s = '') { return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`; }

function sortRows(rows, key, asc, get) {
  const g = get || (r => r[key]);
  return rows.slice().sort((a, b) => {
    const x = g(a), y = g(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y, 'sv') : x - y;
    return asc ? c : -c;
  });
}
const th = (key, txt, st, cls = '', title = '') => `<th data-sort="${key}" class="${cls} ${st.sort === key ? 'sorted' + (st.asc ? ' asc' : '') : ''}" ${title ? `title="${esc(title)}"` : ''}>${txt}</th>`;

// ------------------------------------------------------------------ vy: kommande matcher
function mrow(f) {
  const ht = S.teams[f.hid], at = S.teams[f.aid];
  const live = started(f);
  const bv = bestValue(f);
  const o = ['1', 'X', '2'].map(k => {
    const od = oddsOf(f, k);
    const e = od && od.kind === 'real' ? f.p[k] * od.o - 1 : null;
    return `<span class="${e != null && e > 0.02 && od.o <= VALUE_MAX_ODDS ? 'val' : ''}" title="${k}: ${od ? dec(od.o) : '–'} · rättvist ${dec(fair(f.p[k]))}">${od ? dec(od.o) : '–'}</span>`;
  }).join('');
  return `<a class="mrow" href="#match-${esc(f.id)}">
    <span class="time ${live ? 'live' : ''}">${live ? 'Pågår' : hm(f.ko)}</span>
    <span class="teams"><span class="tm">${esc(f.home)}${ht?.pos ? `<small title="Tabellplats">${ht.pos}</small>` : ''}</span><span class="tm">${esc(f.away)}${at?.pos ? `<small title="Tabellplats">${at.pos}</small>` : ''}</span></span>
    ${bar(f.p['1'], f.p['X'], f.p['2'])}
    <span class="odds3" ${f.oddsProvider ? `title="Odds från ${esc(f.oddsProvider)}"` : ''}>${o}</span>
    <span class="kv"><span>Ö2,5 <b>${pct(f.p['O2.5'])}</b></span><span>BLGM <b>${pct(f.p['BTTS:J'])}</b></span></span>
    <span class="flag">${bv && bv.e > 0.02 ? `<span class="pill value" title="${esc(label(bv.key, f))}">${sgn(bv.e, 0)} värde</span>` : ''}</span>
  </a>`;
}

function fixtureGroups(list, { byDay = true } = {}) {
  const ord = listOrder();
  const days = {};
  for (const f of list) (days[byDay ? dayKey(f.ko) : 'x'] ||= []).push(f);
  let h = '';
  for (const [d, fs] of Object.entries(days).sort()) {
    h += `<div class="daygroup">${byDay ? `<h2 class="daytitle">${cap(dayName(d))}</h2>` : ''}`;
    const lgs = {};
    for (const f of fs) (lgs[f.lg] ||= []).push(f);
    for (const lg of Object.keys(lgs).sort((a, b) => ord.indexOf(a) - ord.indexOf(b))) {
      h += `<div class="lggroup"><div class="lghead"><a href="#liga-${lg}">${esc(lgName(lg))}</a><span class="faint">${lgs[lg].length} ${lgs[lg].length === 1 ? 'match' : 'matcher'}</span></div>${lgs[lg].map(mrow).join('')}</div>`;
    }
    h += '</div>';
  }
  return h;
}

function viewMatcher() {
  const u = S.ui;
  const days = [...new Set(S.fx.map(f => dayKey(f.ko)))].sort();
  if (u.day !== 'all' && !days.includes(u.day)) u.day = 'all';
  let list = S.fx.filter(f => (u.lg === 'all' || f.lg === u.lg) && (u.day === 'all' || dayKey(f.ko) === u.day));
  if (u.q) { const q = u.q.toLowerCase(); list = list.filter(f => `${f.home} ${f.away} ${lgName(f.lg)}`.toLowerCase().includes(q)); }
  if (u.onlyValue) list = list.filter(f => (bestValue(f)?.e ?? -1) > 0.02);
  const nl = new Set(S.fx.map(f => f.lg)).size;
  const nv = S.fx.filter(f => (bestValue(f)?.e ?? -1) > 0.02).length;
  return `<div class="stack">
    <div class="section-head"><div><h1>Kommande matcher</h1>
      <p class="lead">${S.fx.length} matcher i ${nl} ligor och cuper. Staplarna visar chansen till 1, X och 2, oddsen är ${SRC_NAME[S.set.odds]} (för Europacuperna och matcher längre fram: DraftKings). Grönt odds betyder att oddset är högre än vår bedömning, alltså spelvärde.</p></div></div>
    <div class="controls">
      <div class="chips" role="group" aria-label="Dag">
        <button class="chip ${u.day === 'all' ? 'on' : ''}" data-k="day" data-v="all">Alla dagar</button>
        ${days.map(d => `<button class="chip ${u.day === d ? 'on' : ''}" data-k="day" data-v="${d}">${dayChip(d)}</button>`).join('')}
      </div>
    </div>
    <div class="controls">
      <label class="field" for="fLg">Liga ${leagueSelect('fLg', 'lg', u.lg, { withFixtures: true })}</label>
      <label class="field" for="fQ">Sök lag <input type="search" id="fQ" data-k="q" value="${esc(u.q)}" placeholder="t.ex. Arsenal"></label>
      <label class="check" for="fVal"><input type="checkbox" id="fVal" data-k="onlyValue" ${u.onlyValue ? 'checked' : ''}> Bara matcher med spelvärde (${nv})</label>
    </div>
    ${legend1x2()}
    ${list.length ? fixtureGroups(list) : '<div class="panel">Inga matcher matchar filtret.</div>'}
  </div>`;
}

// ------------------------------------------------------------------ vy: match
const CMP = [
  ['ppg', 'Poäng per match', x => dec(x, 2), 1],
  ['gf', 'Gjorda mål per match', dec, 1],
  ['ga', 'Insläppta mål per match', dec, -1],
  ['xgf', 'xG för', dec, 1],
  ['xga', 'xG emot', dec, -1],
  ['o25', 'Över 2,5 mål', pct, 0],
  ['btts', 'Båda lagen gör mål', pct, 0],
  ['cs', 'Hållit nollan', pct, 1],
  ['fts', 'Inte gjort mål', pct, -1],
  ['fh05', 'Mål i första halvlek', pct, 0],
  ['poss', 'Bollinnehav', x => x == null ? '–' : dec(x, 0) + '\u00a0%', 0],
  ['stf', 'Skott på mål', x => dec(x, 1), 1],
  ['sta', 'Skott på mål emot', x => dec(x, 1), -1],
  ['cf', 'Hörnor för', x => dec(x, 1), 1],
  ['ca', 'Hörnor emot', x => dec(x, 1), -1],
  ['ct', 'Hörnor totalt', x => dec(x, 1), 0],
  ['kf', 'Kort, eget lag', x => dec(x, 1), 0],
  ['kt', 'Kort totalt', x => dec(x, 1), 0],
];

function compareTable(f) {
  const ht = S.teams[f.hid], at = S.teams[f.aid];
  if (!ht || !at) return '<p class="muted">Statistik saknas för ett av lagen.</p>';
  const venue = S.ui.cmp === 'venue';
  const a = venue ? ht.home : ht.all, b = venue ? at.away : at.all;
  const rows = CMP.filter(([k]) => a[k] != null || b[k] != null).map(([k, n, fm, dir]) => {
    const x = a[k], y = b[k];
    const bx = dir && x != null && y != null && (dir > 0 ? x > y : x < y);
    const by = dir && x != null && y != null && (dir > 0 ? y > x : y < x);
    return `<tr><td class="num ${bx ? 'better' : ''}">${fm(x)}</td><td class="mid">${n}</td><td class="${by ? 'better' : ''}">${fm(y)}</td></tr>`;
  }).join('');
  return `<div class="row between"><span class="small muted">${venue ? `${esc(f.home)} hemma (${a.n} m) mot ${esc(f.away)} borta (${b.n} m)` : `Alla matcher (${a.n} och ${b.n})`}</span>
    <span class="chips"><button class="chip ${venue ? 'on' : ''}" data-k="cmp" data-v="venue">Hemma/borta</button><button class="chip ${!venue ? 'on' : ''}" data-k="cmp" data-v="all">Alla matcher</button></span></div>
    <div class="tablewrap" style="margin-top:8px"><table class="cmp"><thead><tr><th class="num">${esc(f.home)}</th><th style="text-align:center">Denna säsong</th><th>${esc(f.away)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function marketsTable(f) {
  const all = picks(f);
  let h = '<div class="tablewrap"><table><thead><tr><th>Spel</th><th class="num">Chans</th><th class="num" title="1 delat med chansen">Rättvist odds</th><th class="num">Odds</th><th class="num" title="Chans × odds − 1">Värde</th><th></th></tr></thead><tbody>';
  let g = null;
  for (const x of all) {
    if (x.group !== g) { g = x.group; h += `<tr class="group-row"><td colspan="6">${g}</td></tr>`; }
    const pTxt = x.ah ? `<span title="Chans till hel vinst">${pct(x.p)}</span>` : pct(x.p);
    h += `<tr><td>${esc(label(x.key, f))}</td><td class="num">${pTxt}</td><td class="num">${x.fair ? dec(x.fair) : '–'}</td><td class="num">${oddsCell(x)}</td><td class="num">${edgeCell(x.e, x.kind)}</td><td>${addBtn(f.id, x.key)}</td></tr>`;
  }
  return h + '</tbody></table></div>';
}

function viewMatch(id) {
  const f = S.fxById[id];
  if (!f) return `<div class="panel stack"><h2>Matchen finns inte bland kommande matcher</h2><p class="muted">Den kan redan vara spelad. Resultatet syns på lagens sidor.</p><p><a href="#matcher">Till alla matcher</a></p></div>`;
  const L = S.leagues[f.lg], ht = S.teams[f.hid], at = S.teams[f.aid];
  const ref = f.refId && S.refs[f.refId];
  const mm = f.lamM ? dc(f.lamM[0], f.lamM[1]) : null;
  const mk = f.lamK ? dc(f.lamK[0], f.lamK[1]) : null;
  const side = (t, name, id) => `<div class="side"><h1>${teamLink(id, name)}</h1><div class="small muted">${t?.pos ? `Plats ${t.pos} av ${t.of}${t.lg !== f.lg ? ' i ' + esc(lgShort(t.lg)) : ''}` : ''}${t?.rating && t.lg === f.lg ? ` · styrka ${t.rating.rank} av ${t.rating.of}` : ''}</div><div style="margin-top:6px">${t ? formChips(t.form.map(x => x[6]).join('')) : ''}</div></div>`;
  const cs = f.cs.slice(0, 3).map(([s, p]) => `${s.replace('-', '–')} <span class="faint">${pct(p)}</span>`).join(' · ');
  setTimeout(() => fillH2H(f), 0);
  return `<div class="stack">
    <div class="panel stack">
      <div class="row between"><span class="eyebrow"><a href="#liga-${f.lg}">${esc(lgName(f.lg))}</a></span><span class="small muted">${cap(longDateTime(f.ko))}</span></div>
      <div class="matchhead">${side(ht, f.home, f.hid)}<div><div class="xg">${dec(f.lam[0], 1)} – ${dec(f.lam[1], 1)}</div><div class="small muted">förväntade mål</div></div>${side(at, f.away, f.aid)}</div>
      ${bar(f.p['1'], f.p['X'], f.p['2'])}
      <div class="row between">${legend1x2()}<span class="small muted">${f.neutral ? 'Neutral plan · ' : ''}Domare: ${ref ? `<a href="#domare-${esc(f.refId)}">${esc(f.ref)}</a>` : (f.ref ? esc(f.ref) : 'ej angiven i datan')}</span></div>
    </div>
    <div class="tiles">
      ${tile('Troligaste resultat', esc(f.cs[0][0].replace('-', '–')), cs)}
      ${tile('Över 2,5 mål', pct(f.p['O2.5']), `rättvist odds ${dec(fair(f.p['O2.5']))}`)}
      ${tile('Båda lagen gör mål', pct(f.p['BTTS:J']), `rättvist odds ${dec(fair(f.p['BTTS:J']))}`)}
      ${f.corners ? tile('Hörnor, förväntat', dec(f.corners.h + f.corners.a, 1), `${dec(f.corners.h, 1)} + ${dec(f.corners.a, 1)}`) : ''}
      ${f.cards ? tile('Kort, förväntat', dec(f.cards.h + f.cards.a, 1), f.ref && f.cards.rn ? `domarfaktor ${dec(f.cards.rf)}` : 'utan domarjustering') : ''}
    </div>
    <div class="matchgrid">
      <div class="panel" style="min-width:0"><h2>Alla spel</h2>${oddsNotice(f)}<p class="note" style="margin:-4px 0 10px">Chansen bygger på marknadens odds och lagens statistik. Rättvist odds = 1 / chans. Värde = chans × odds − 1 (${SRC_NAME[S.set.odds]}). Spel utan odds i datan visar ett uppskattat odds med ≈, jämför med ditt spelbolag.</p>${marketsTable(f)}</div>
      <div class="stack" style="min-width:0">
        <div class="panel"><h2>Lagen jämförda</h2>${compareTable(f)}</div>
        ${mm ? `<div class="panel"><h3>Statistikmodellen mot marknaden</h3>
          <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th></th><th class="num">Modell</th><th class="num">Marknad</th><th class="num">Används</th></tr></thead><tbody>
          ${['1', 'X', '2', 'O2.5', 'BTTS:J'].map(k => `<tr><td>${esc(label(k, f))}</td><td class="num">${pct(mm[k])}</td><td class="num">${mk ? pct(mk[k]) : '–'}</td><td class="num"><b>${pct(f.p[k])}</b></td></tr>`).join('')}
          </tbody></table></div>
          <p class="note">Modellen bygger bara på mål, xG och skott. Förväntade mål enligt modellen: ${dec(f.lamM[0])} – ${dec(f.lamM[1])}${f.lamK ? `, enligt oddsen: ${dec(f.lamK[0])} – ${dec(f.lamK[1])}` : ''}. Stora skillnader kan betyda skador, avstängningar eller rotation som modellen inte ser. <a href="#modell">Hur träffsäker är den?</a></p></div>` : ''}
        ${ref ? refMini(ref, f) : ''}
      </div>
    </div>
    <div class="grid2">
      ${[['h', ht, f.home], ['a', at, f.away]].map(([s, t, n]) => `<div class="panel"><h3>Senaste matcherna: ${esc(n)}</h3>${t ? formTable(t) : '<p class="muted">Saknas.</p>'}</div>`).join('')}
    </div>
    <div class="panel"><h3>Inbördes möten</h3><div id="h2h" class="muted">Laddar …</div></div>
  </div>`;
}

function oddsNotice(f) {
  if (!f.odds || !f.odds['1']) return '<p><span class="pill warn">Inga odds än</span> <span class="note">Chanserna bygger bara på statistikmodellen, som träffar sämre än oddsen. Oddsen brukar komma några dagar före matchen.</span></p>';
  if (f.oddsProvider) return `<p><span class="pill info">Odds från ${esc(f.oddsProvider)}</span> <span class="note">Bara ett spelbolag, så snitt och bästa odds finns inte för den här matchen.</span></p>`;
  return '';
}

function formTable(t) {
  return `<div class="tablewrap" style="margin-top:8px"><table><tbody>${t.form.slice().reverse().map(([d, v, opp, oid, gf, ga, r]) =>
    `<tr><td class="faint">${shortDate(d)}</td><td>${v === 'H' ? 'H' : 'B'}</td><td>${teamLink(oid, opp)}</td><td class="num"><b>${gf}–${ga}</b></td><td>${formChips(r)}</td></tr>`).join('')}</tbody></table></div>`;
}

function refMini(ref, f) {
  return `<div class="panel"><h3>Domare: <a href="#domare-${esc(ref.id)}">${esc(ref.name)}</a></h3>
    <div class="tiles" style="margin-top:8px">
      ${tile('Kort per match', dec(ref.k, 1), `${ref.n} matcher`)}
      ${tile('Över 4,5 kort', pct(ref.k45))}
      ${tile('Kortfaktor', dec(ref.kf), ref.kf > 1.05 ? 'delar ut fler kort än snittet' : ref.kf < 0.95 ? 'delar ut färre kort än snittet' : 'nära snittet')}
      ${tile('Hemmavinster', pct(ref.hw))}
    </div></div>`;
}

async function fillH2H(f) {
  const lgs = [...new Set([f.lg, S.teams[f.hid]?.lg, S.teams[f.aid]?.lg].filter(Boolean))];
  const rows = (await Promise.all(lgs.map(leagueFile))).flat().sort((a, b) => b.date.localeCompare(a.date));
  const el = $('#h2h');
  if (!el || location.hash.slice(1) !== 'match-' + f.id) return;
  const h2h = rows.filter(m => (m.hid === f.hid && m.aid === f.aid) || (m.hid === f.aid && m.aid === f.hid));
  if (!h2h.length) { el.textContent = 'Lagen har inte mötts i ligan de senaste säsongerna.'; return; }
  el.classList.remove('muted');
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Datum</th><th>Tävling</th><th>Match</th><th class="num">Resultat</th><th class="num">Halvtid</th><th class="num">Hörnor</th><th class="num">Kort</th></tr></thead><tbody>${h2h.map(m =>
    `<tr><td>${shortDate(m.date)} ${m.date.slice(0, 4)}</td><td class="small muted">${esc(lgShort(m.lg))}</td><td>${esc(m.home)} – ${esc(m.away)}</td><td class="num"><b>${m.hg}–${m.ag}</b></td><td class="num">${m.hthg != null ? `${m.hthg}–${m.htag}` : '–'}</td><td class="num">${m.hc != null ? m.hc + m.ac : '–'}</td><td class="num">${m.hy != null ? m.hy + m.ay + (m.hr || 0) + (m.ar || 0) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------------ vy: spelförslag
const PRESETS = {
  varde: { label: 'Värdespel', set: { group: 'all', minP: 0.15, minO: 1.2, maxO: VALUE_MAX_ODDS, minE: 0.03, real: true, sort: 'e', asc: false } },
  sakra: { label: 'Säkra spel', set: { group: 'all', minP: 0.75, minO: 1.15, maxO: 15, minE: -1, real: false, sort: 'p', asc: false } },
  mal: { label: 'Mål', set: { group: 'Mål', minP: 0.6, minO: 1.2, maxO: 15, minE: -1, real: false, sort: 'p', asc: false } },
  blgm: { label: 'Båda gör mål', set: { group: 'Båda lagen gör mål', minP: 0.55, minO: 1.2, maxO: 15, minE: -1, real: false, sort: 'p', asc: false } },
  horn: { label: 'Hörnor', set: { group: 'Hörnor', minP: 0.65, minO: 1.2, maxO: 15, minE: -1, real: false, sort: 'p', asc: false } },
  kort: { label: 'Kort', set: { group: 'Kort', minP: 0.65, minO: 1.2, maxO: 15, minE: -1, real: false, sort: 'p', asc: false } },
};

function btSummary(thr = 0.03) {
  const b = S.bt;
  if (!b) return '';
  const src = S.set.odds === 'avg' ? 'avg' : 'max';
  const parts = b.perioder.map(p => {
    const r = p.roi.find(x => x.odds === src && x.grupp === 'Alla' && x.maxodds === VALUE_MAX_ODDS && x.troskel === thr);
    return r ? `${p.namn.toLowerCase()} ${sgn(r.roi, 0)} på ${r.n} spel` : null;
  }).filter(Boolean);
  return parts.length ? `I backtestet gav alla spel med minst ${Math.round(thr * 100)} % värde och odds upp till ${VALUE_MAX_ODDS} mot ${src === 'avg' ? 'snittodds' : 'bästa odds'}: ${parts.join(', ')}. Ingen garanti, men det är där spel kan löna sig i längden.` : '';
}

function viewSpel() {
  const u = S.ui.spel;
  const days = [...new Set(S.fx.map(f => dayKey(f.ko)))].sort();
  let rows = [];
  for (const f of S.fx) {
    if (started(f)) continue;
    if (u.lg !== 'all' && f.lg !== u.lg) continue;
    if (u.day !== 'all' && dayKey(f.ko) !== u.day) continue;
    for (const x of picks(f)) {
      if (u.group !== 'all' && x.group !== u.group) continue;
      if (u.real && x.kind !== 'real') continue;
      if (x.p < u.minP) continue;
      if (x.o != null && (x.o < u.minO || x.o > u.maxO)) continue;
      if (u.minE > -1 && (x.e == null || x.e < u.minE)) continue;
      rows.push(x);
    }
  }
  const getters = { ko: x => x.f.ko, p: x => x.p, o: x => x.o, e: x => x.e, fair: x => x.fair, m: x => x.f.home };
  rows = sortRows(rows, u.sort, u.asc, getters[u.sort]);
  const total = rows.length;
  rows = rows.slice(0, 250);
  const groups = ['all', ...GROUPS.map(g => g[0]), 'Asiatiskt handikapp'];
  return `<div class="stack">
    <div><h1>Spelförslag</h1><p class="lead">Alla spel på kommande matcher, filtrerade och sorterade. ${u.preset === 'varde' ? esc(btSummary()) : 'Chansen är vår bedömning. Jämför rättvist odds med ditt spelbolag: är spelbolagets odds högre har spelet värde.'}</p></div>
    <div class="chips">${Object.entries(PRESETS).map(([k, p]) => `<button class="chip ${u.preset === k ? 'on' : ''}" data-preset="${k}">${p.label}</button>`).join('')}</div>
    <div class="controls">
      <label class="field" for="sGrp">Marknad <select id="sGrp" data-k="spel.group">${groups.map(g => `<option value="${g}" ${u.group === g ? 'selected' : ''}>${g === 'all' ? 'Alla marknader' : g}</option>`).join('')}</select></label>
      <label class="field" for="sMinP">Minsta chans (%) <input type="number" id="sMinP" data-k="spel.minP" data-scale="100" value="${Math.round(u.minP * 100)}" min="0" max="99"></label>
      <label class="field" for="sMinO">Odds från <input type="number" id="sMinO" data-k="spel.minO" step="0.05" value="${u.minO}"></label>
      <label class="field" for="sMaxO">Odds till <input type="number" id="sMaxO" data-k="spel.maxO" step="0.5" value="${u.maxO}"></label>
      <label class="field" for="sMinE">Minsta värde (%) <input type="number" id="sMinE" data-k="spel.minE" data-scale="100" value="${u.minE > -1 ? Math.round(u.minE * 100) : ''}" placeholder="av" step="1"></label>
      <label class="field" for="sDay">Dag <select id="sDay" data-k="spel.day"><option value="all">Alla dagar</option>${days.map(d => `<option value="${d}" ${u.day === d ? 'selected' : ''}>${dayChip(d)}</option>`).join('')}</select></label>
      <label class="field" for="sLg">Liga ${leagueSelect('sLg', 'spel.lg', u.lg, { withFixtures: true })}</label>
      <label class="check" for="sReal"><input type="checkbox" id="sReal" data-k="spel.real" ${u.real ? 'checked' : ''}> Bara spel med riktiga odds</label>
    </div>
    <div class="small muted">${total} spel${total > 250 ? ', visar de 250 första' : ''}. Odds: ${SRC_NAME[S.set.odds]} (byt i menyn).</div>
    ${rows.length ? `<div class="tablewrap"><table data-table="spel"><thead><tr>
      ${th('ko', 'Avspark', u)}${th('m', 'Match', u)}<th>Spel</th>${th('p', 'Chans', u, 'num')}${th('fair', 'Rättvist', u, 'num', '1 delat med chansen')}${th('o', 'Odds', u, 'num')}${th('e', 'Värde', u, 'num', 'Chans × odds − 1')}${u.preset === 'varde' ? '<th class="num" title="¼ Kelly av din spelkassa (ställs in under Lappar)">Insats</th>' : ''}<th></th>
    </tr></thead><tbody>${rows.map(x => `<tr>
      <td class="faint">${dayChip(dayKey(x.f.ko))} ${hm(x.f.ko)}</td>
      <td><a href="#match-${esc(x.f.id)}">${esc(x.f.home)} – ${esc(x.f.away)}</a><div class="small faint">${esc(lgName(x.f.lg))}</div></td>
      <td class="wrap">${esc(label(x.key, x.f))}</td>
      <td class="num">${pct(x.p)}</td><td class="num">${x.fair ? dec(x.fair) : '–'}</td><td class="num">${oddsCell(x)}</td><td class="num">${edgeCell(x.e, x.kind)}</td>
      ${u.preset === 'varde' ? `<td class="num">${x.kind === 'real' ? kellyStake(x.p, x.o) + ' kr' : '–'}</td>` : ''}
      <td>${addBtn(x.f.id, x.key)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="panel">Inga spel matchar filtret.${u.preset === 'varde' && S.set.odds !== 'max' ? ' Med snittodds finns nästan aldrig värde eftersom spelbolagens marginal redan är inräknad. Välj <button class="link" data-odds="max">bästa odds</button> för att se var enskilda spelbolag ligger över marknaden.' : ''}</div>`}
  </div>`;
}

// ------------------------------------------------------------------ vy: lappar
const KELLY = 0.25, KELLY_CAP = 0.03; // kvarts-Kelly, högst 3 % av kassan per lapp
const BOOKS = { b365: 'Bet365', bw: 'bwin', max: 'Bästa odds (bara singlar)' };

/** Föreslagen insats (kr) efter spelkassa och värde. 0 om spelet saknar värde. */
function kellyStake(p, o) {
  if (!p || !o || o <= 1) return 0;
  const e = p * o - 1;
  if (e <= 0) return 0;
  const frac = Math.min(KELLY_CAP, KELLY * e / (o - 1));
  const kr = S.set.bank * frac;
  return kr < 5 ? 0 : Math.round(kr / 5) * 5;
}

const STRATS = {
  varde: { label: 'Värdelapp (rekommenderas)', keys: ['1', 'X', '2', 'O2.5', 'U2.5'], value: true },
  chans: { label: 'Högst chans (förlorar i längden)', keys: ['1', '2', '1X', 'X2', 'O2.5', 'U2.5'], score: x => x.p },
  mal: { label: 'Mål', keys: ['O1.5', 'O2.5', 'BTTS:J', 'H:O0.5', 'A:O0.5', 'FH:O0.5', 'H:O1.5', 'A:O1.5'], score: x => x.p },
  horn: { label: 'Hörnor och kort', keys: [...CORNER_LINES.flatMap(l => ['C:O' + l, 'C:U' + l]), ...CARD_LINES.flatMap(l => ['K:O' + l, 'K:U' + l])], score: x => x.p, est: true },
};

function generate() {
  const g = S.ui.gen, st = STRATS[g.strat];
  const today = dayKey(new Date().toISOString());
  const lastDay = g.days === 'all' ? null : dayKey(new Date(Date.now() + (+g.days - 1) * 864e5).toISOString());
  const cands = [];
  for (const f of S.fx) {
    if (started(f)) continue;
    const d = dayKey(f.ko);
    if (lastDay && (d < today || d > lastDay)) continue;
    for (const key of st.keys) {
      const p = f.p[key];
      if (p == null) continue;
      const od = oddsOf(f, key, g.book);
      if (!od) continue;
      const x = { f, key, p, o: od.o, kind: od.kind, e: p * od.o - 1 };
      if (st.value) {
        // värde: bara riktiga odds hos det valda bolaget, minst 2 % värde, inga långa odds
        if (od.kind !== 'real' || x.e < g.minE || od.o > VALUE_MAX_ODDS || p < 0.2) continue;
        x.s = x.e;
      } else {
        if (od.kind === 'est' && !g.est && !st.est) continue;
        if (od.o < g.minO || od.o > g.maxO) continue;
        x.s = st.score(x);
      }
      if (x.s != null) cands.push(x);
    }
  }
  cands.sort((a, b) => b.s - a.s);
  g.singles = st.value ? cands.map(c => ({ fid: c.f.id, key: c.key })) : [];
  const usedFx = new Set(), slips = [];
  // bästa odds finns hos olika spelbolag och går inte att kombinera på en lapp
  for (let s = 0; s < (g.book === 'max' && st.value ? 0 : 3); s++) {
    const legs = [], fxs = new Set();
    for (const c of cands) {
      if (usedFx.has(c.f.id) || fxs.has(c.f.id)) continue;
      legs.push(c); fxs.add(c.f.id);
      if (legs.length >= g.n) break;
    }
    if (legs.length < (st.value ? 2 : g.n)) break;
    legs.forEach(c => usedFx.add(c.f.id));
    slips.push(legs);
  }
  g.out = slips.map(legs => legs.map(c => ({ fid: c.f.id, key: c.key })));
}

function slipStats(legs) {
  const odds = legs.reduce((a, l) => a * (l.o || 1), 1);
  const prob = legs.reduce((a, l) => a * (l.p || 0), 1);
  const same = new Set(legs.map(l => l.fid)).size < legs.length;
  return { odds, prob, ev: prob * odds - 1, same };
}

function strategyTable(compact = false) {
  const rows = S.bt?.lappar || [];
  if (!rows.length) return '';
  const cell = p => p && p.n ? `<td class="num">${p.n}</td><td class="num"><b class="${p.roi > 0 ? 'good' : 'bad'}">${sgn(p.roi, 0)}</b></td><td class="num">${p.clv != null ? `<span class="${p.clv > 0 ? 'good' : 'bad'}">${sgn(p.clv, 1)}</span>` : '–'}</td><td class="num">${pct(p.slogStangning)}</td>`
    : '<td class="num">0</td><td class="num">–</td><td class="num">–</td><td class="num">–</td>';
  const list = compact ? rows.filter(r => r.bolag !== 'bwin' || r.perioder.some(p => p.n >= 5)) : rows;
  return `<div class="tablewrap"><table><thead><tr><th>Strategi</th><th>Odds</th><th class="num">Lappar</th><th class="num">Resultat</th><th class="num" title="Oddset jämfört med marknadens rättvisa pris vid avspark">Stängningsvärde</th><th class="num">Slog stängning</th><th class="num">Lappar</th><th class="num">Resultat</th><th class="num">Stängningsvärde</th><th class="num">Slog stängning</th></tr>
    <tr><th></th><th></th><th colspan="4" class="num">${esc(rows[0].perioder[0].namn)}</th><th colspan="4" class="num">${esc(rows[0].perioder[1].namn)}</th></tr></thead>
    <tbody>${list.map(r => `<tr><td title="${esc(r.beskrivning)}">${esc(r.namn)}</td><td class="small muted">${esc(r.bolag)}</td>${cell(r.perioder[0])}${cell(r.perioder[1])}</tr>`).join('')}</tbody></table></div>`;
}

function viewLappar() {
  const g = S.ui.gen;
  if (!g.out) generate();
  const legs = S.slip;
  const st = slipStats(legs);
  const stake = S.ui.stake;
  const kelly = kellyStake(st.prob, st.odds);
  const slipHtml = legs.length ? `${legs.map((l, i) => `<div class="slip-leg">
      <div class="what"><b>${esc(l.label)}</b><span>${esc(l.home)} – ${esc(l.away)} · ${dayChip(dayKey(l.ko))} ${hm(l.ko)}</span></div>
      <div class="num"><div class="small muted">chans</div>${pct(l.p)}</div>
      <label class="field" for="lo${i}">${l.kind === 'real' ? 'odds' : 'ditt odds'}<input type="number" id="lo${i}" step="0.01" min="1.01" value="${l.o}" data-leg="${i}"></label>
      <button class="addbtn" data-del="${i}" title="Ta bort" aria-label="Ta bort">✕</button></div>`).join('')}
      <div class="slip-sum">
        ${tile('Totalodds', dec(st.odds))}
        ${tile('Chans att vinna', pct(st.prob, 1), st.same ? 'två spel på samma match – chansen är osäker' : '')}
        ${tile('Förväntat värde', `<span class="${st.ev > 0 ? 'good' : 'bad'}">${sgn(st.ev, 0)}</span>`, st.ev > 0 ? 'lönsam i längden om chanserna stämmer' : 'förlust i längden')}
        ${tile('Föreslagen insats', `${kelly} kr`, kelly ? `¼ Kelly av ${S.set.bank.toLocaleString('sv-SE')} kr` : 'inget värde – spela inte')}
        <div class="tile"><label class="k" for="stake">Din insats (kr)</label><input type="number" id="stake" value="${stake}" min="1" step="5" style="width:100%;margin-top:4px"></div>
        ${tile('Möjlig vinst', `${Math.round(stake * st.odds).toLocaleString('sv-SE')} kr`)}
      </div>
      <p class="note">Skriv in ditt spelbolags odds i rutorna. Värdet räknas om direkt. Ligger det under 0 har spelbolaget sänkt oddset sedan datan hämtades.</p>
      <div class="row" style="margin-top:8px"><button class="primary" id="saveSlip">Spara lappen</button><button id="clearSlip">Töm lappen</button></div>`
    : '<p class="muted">Lappen är tom. Använd ett förslag nedan, eller lägg till spel med + på <a href="#spel">Spelförslag</a> eller en matchsida.</p>';

  const legInfo = ({ fid, key }) => { const f = S.fxById[fid]; const od = f && oddsOf(f, key, g.book); return f && od ? { f, key, p: f.p[key], o: od.o, kind: od.kind } : null; };
  const gen = (g.out || []).map((legsKeys, i) => {
    const ls = legsKeys.map(legInfo).filter(Boolean);
    const s = slipStats(ls.map(l => ({ ...l, fid: l.f.id })));
    const k = kellyStake(s.prob, s.odds);
    return `<div class="panel sugg"><div class="row between"><h3>${ls.length === 2 ? 'Dubbel' : ls.length === 3 ? 'Trippel' : `${ls.length} spel`} ${i + 1}</h3><button data-use="${i}">Använd</button></div>
      <ol>${ls.map(l => `<li><b>${esc(label(l.key, l.f))}</b> <span class="muted">${pct(l.p)} · odds ${l.kind === 'real' ? dec(l.o) : `≈${dec(l.o)}`}${STRATS[g.strat].value ? ` · värde ${sgn(l.p * l.o - 1, 0)}` : ''}</span><br><a class="small" href="#match-${esc(l.f.id)}">${esc(l.f.home)} – ${esc(l.f.away)}</a> <span class="small faint">${dayChip(dayKey(l.f.ko))} ${hm(l.f.ko)}</span></li>`).join('')}</ol>
      <div class="small">Totalodds <b>${dec(s.odds)}</b> · chans <b>${pct(s.prob, 1)}</b> · värde <b class="${s.ev > 0 ? 'good' : 'bad'}">${sgn(s.ev, 0)}</b> · insats <b>${k} kr</b></div></div>`;
  }).join('');
  const singles = (g.singles || []).map(legInfo).filter(Boolean).slice(0, 12);
  const isValue = STRATS[g.strat].value;

  return `<div class="stack">
    <div><h1>Lappar</h1><p class="lead">Ingen strategi kan garantera vinst. Men det finns en sak som avgör om man går plus i längden: att spela när ditt spelbolags odds är högre än det rättvisa priset. Lappgeneratorn väljer bara sådana spel, och föreslår en insats efter din spelkassa så att en dålig period inte tömmer den.</p></div>
    <div class="controls">
      <label class="field" for="bank">Din spelkassa (kr) <input type="number" id="bank" value="${S.set.bank}" min="100" step="100" style="width:120px"></label>
      <span class="note">Insatserna föreslås som ¼ Kelly, högst ${Math.round(KELLY_CAP * 100)} % av kassan per lapp. Sparas bara i din webbläsare.</span>
    </div>
    <div class="grid2">
      <div class="panel"><h2>Din lapp</h2>${slipHtml}</div>
      <div class="panel stack"><h2>Lappgenerator</h2>
        <div class="controls">
          <label class="field" for="gS">Strategi <select id="gS" data-k="gen.strat">${Object.entries(STRATS).map(([k, s]) => `<option value="${k}" ${g.strat === k ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
          <label class="field" for="gB">Ditt spelbolag <select id="gB" data-k="gen.book">${Object.entries(BOOKS).map(([k, n]) => `<option value="${k}" ${g.book === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field" for="gN">Antal spel <select id="gN" data-k="gen.n" data-type="num">${(isValue ? [2, 3] : [2, 3, 4, 5, 6]).map(n => `<option ${g.n === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${isValue ? `<label class="field" for="gE2">Minsta värde (%) <input type="number" id="gE2" data-k="gen.minE" data-scale="100" value="${Math.round(g.minE * 100)}" min="0" step="1"></label>`
            : `<label class="field" for="gMin">Odds per spel från <input type="number" id="gMin" data-k="gen.minO" step="0.05" value="${g.minO}"></label>
          <label class="field" for="gMax">till <input type="number" id="gMax" data-k="gen.maxO" step="0.1" value="${g.maxO}"></label>`}
          <label class="field" for="gD">Period <select id="gD" data-k="gen.days"><option value="1" ${g.days === '1' ? 'selected' : ''}>Idag</option><option value="2" ${g.days === '2' ? 'selected' : ''}>Idag och imorgon</option><option value="all" ${g.days === 'all' ? 'selected' : ''}>Alla kommande</option></select></label>
          ${isValue ? '' : `<label class="check" for="gE"><input type="checkbox" id="gE" data-k="gen.est" ${g.est ? 'checked' : ''}> Ta med spel utan riktiga odds</label>`}
        </div>
        <p class="note">${isValue ? `Väljer 1X2 och över/under 2,5 där ${g.book === 'max' ? 'det bästa oddset' : BOOKS[g.book] + 's odds'} är minst ${Math.round(g.minE * 100)} % över marknadens rättvisa pris (chans minst 20 %, odds högst ${VALUE_MAX_ODDS}), ett spel per match. Hela lappen läggs hos samma bolag. Har du konto hos båda: jämför och ta det bolag som ger mest värde.`
          : g.strat === 'chans' ? 'Väljer de spel som oftast går in. Spelbolagens marginal gör att de här lapparna förlorar i längden, se tabellen nedan.'
          : g.strat === 'mal' ? 'Väljer målspel med högst chans. Oddsen för de flesta målspel saknas i datan, så värdet går inte att räkna. Jämför rättvist odds med ditt spelbolag.'
          : 'Hörnor och kort har inga odds i datan, oddsen är uppskattade. Kolla ditt spelbolag.'}</p>
      </div>
    </div>
    ${gen ? `<div class="grid3">${gen}</div>` : `<div class="panel muted">${isValue && g.book === 'max' ? 'Bästa odds kommer från olika spelbolag (Bet365, bwin, Betfred, BetVictor, Paddy Power, Sky Bet och Betfairs spelbörs) och kan inte kombineras på en lapp. Spela värdesinglarna nedan hos det bolag som har oddset. I backtestet var det den här strategin som slog stängningsoddset oftast.' : isValue ? `Just nu finns färre än två spel med minst ${Math.round(g.minE * 100)} % värde hos ${BOOKS[g.book]}. Det är normalt: värde finns oftast på några få spel per omgång, mest när oddsen för helgen kommer på fredagen och för veckomatcherna på tisdagen. Byt bolag, sänk minsta värde eller spela värdesinglarna nedan.` : 'Hittade inga förslag med de inställningarna. Prova ett bredare oddsintervall eller längre period.'}</div>`}
    ${isValue ? `<div class="panel"><h2>Värdesinglar ${g.book === 'max' ? 'med bästa odds' : 'hos ' + BOOKS[g.book]}</h2><p class="note">Singlar har lägre risk än lappar: värdet är detsamma per spel, men en förlust slår inte ut hela lappen. I backtestet var det singlarna som gav jämnast resultat.</p>
      ${singles.length ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Avspark</th><th>Match</th><th>Spel</th><th class="num">Chans</th><th class="num">Odds</th><th class="num">Värde</th><th class="num">Insats</th><th></th></tr></thead><tbody>${singles.map(l =>
        `<tr><td class="faint">${dayChip(dayKey(l.f.ko))} ${hm(l.f.ko)}</td><td><a href="#match-${esc(l.f.id)}">${esc(l.f.home)} – ${esc(l.f.away)}</a></td><td class="wrap">${esc(label(l.key, l.f))}</td><td class="num">${pct(l.p)}</td><td class="num">${dec(l.o)}</td><td class="num">${edgeCell(l.p * l.o - 1, 'real')}</td><td class="num"><b>${kellyStake(l.p, l.o)} kr</b></td><td>${addBtn(l.f.id, l.key, g.book)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted">Inga spel med värde ${g.book === 'max' ? 'mot bästa odds' : 'hos ' + BOOKS[g.book]} just nu.</p>`}</div>` : ''}
    <div class="panel"><h2>Din statistik</h2><div id="mystats" class="muted">Spara lappar för att se hur det går. Statistiken räknas när matcherna är spelade.</div></div>
    <div class="panel"><h2>Sparade lappar</h2><div id="saved">${savedHtml()}</div></div>
    <div class="panel"><h2>Så har strategierna gått</h2>
      <p class="note">Backtest i huvudligorna med oddsen före matchen hos ett och samma bolag. <b>Stängningsvärde</b> jämför oddset med marknadens rättvisa pris vid avspark. Det säger mer än vinst och förlust på några få lappar: den som i längden får bättre odds än stängningen går plus. Få lappar ger stor slump i resultatkolumnen.</p>
      ${strategyTable(true)}
    </div>
  </div>`;
}

function closingP(key, m) {
  const dv = a => { if (a.some(x => !x)) return null; const s = a.reduce((t, x) => t + 1 / x, 0); return a.map(x => 1 / x / s); };
  const p1 = m.cH ? dv([m.cH, m.cD, m.cA]) : null, pou = m.cO ? dv([m.cO, m.cU]) : null;
  const map = { '1': p1?.[0], 'X': p1?.[1], '2': p1?.[2], '1X': p1 && p1[0] + p1[1], '12': p1 && p1[0] + p1[2], 'X2': p1 && p1[1] + p1[2], 'O2.5': pou?.[0], 'U2.5': pou?.[1] };
  return map[key] ?? null;
}

function savedHtml(results = {}) {
  if (!S.saved.length) return '<p class="muted">Inga sparade lappar än. Sparade lappar rättas automatiskt när resultaten kommer in.</p>';
  return S.saved.slice().reverse().map((s, ri) => {
    const i = S.saved.length - 1 - ri;
    const st = slipStats(s.legs);
    const res = s.legs.map(l => results[l.fid + '|' + l.key]?.won);
    const lost = res.some(r => r === false), won = res.every(r => r === true);
    const status = lost ? ['lost', 'Förlorad'] : won ? ['won', `Vunnen, ${Math.round(s.stake * st.odds)} kr`] : ['open', 'Öppen'];
    return `<div class="slip-leg" style="grid-template-columns:minmax(0,1fr) auto auto">
      <div class="what"><b>${s.legs.length} spel · odds ${dec(st.odds)} · ${s.stake} kr</b>
      ${s.legs.map((l, j) => `<span>${res[j] === true ? '✓' : res[j] === false ? '✗' : '○'} ${esc(l.label)} <span class="faint">(${esc(l.home)} – ${esc(l.away)}, odds ${dec(l.o)})</span></span>`).join('')}
      <span class="faint">Sparad ${shortDate(s.saved.slice(0, 10))}</span></div>
      <span class="status ${status[0]}">${status[1]}</span>
      <button class="addbtn" data-delsaved="${i}" title="Ta bort" aria-label="Ta bort sparad lapp">✕</button></div>`;
  }).join('');
}

function myStatsHtml(results) {
  let n = 0, staked = 0, back = 0;
  const clv = [];
  for (const s of S.saved) {
    const res = s.legs.map(l => results[l.fid + '|' + l.key]);
    for (const r of res) if (r?.clv != null) clv.push(r.clv);
    const lost = res.some(r => r?.won === false), won = res.every(r => r?.won === true);
    if (!lost && !won) continue;
    n++;
    staked += s.stake;
    if (won) back += s.stake * slipStats(s.legs).odds;
  }
  if (!n && !clv.length) return '<p class="muted">Inga avgjorda lappar än.</p>';
  const net = back - staked;
  const beat = clv.length ? clv.filter(c => c > 0).length / clv.length : null;
  const avg = clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null;
  return `<div class="tiles">
    ${tile('Avgjorda lappar', n)}
    ${tile('Insatt', `${Math.round(staked).toLocaleString('sv-SE')} kr`)}
    ${tile('Resultat', `<span class="${net >= 0 ? 'good' : 'bad'}">${net >= 0 ? '+' : '−'}${Math.abs(Math.round(net)).toLocaleString('sv-SE')} kr</span>`, staked ? `${sgn(net / staked, 0)} av insatsen` : '')}
    ${tile('Stängningsvärde', avg != null ? `<span class="${avg > 0 ? 'good' : 'bad'}">${sgn(avg, 1)}</span>` : '–', clv.length ? `${clv.length} spel med stängningsodds` : 'kräver 1X2 eller över/under 2,5')}
    ${tile('Slog stängningsoddset', beat != null ? pct(beat) : '–')}
  </div>
  <p class="note">${avg == null ? '' : avg > 0 ? 'Dina odds har i snitt varit bättre än marknadens pris vid avspark. Det är det bästa tecknet på att du spelar med värde, även om resultatet svänger.' : 'Dina odds har i snitt varit sämre än marknadens pris vid avspark. Då förlorar man i längden. Spela tidigare (när oddsen kommer) och bara på spel med värde.'}</p>`;
}

async function settleSaved() {
  const need = new Set();
  for (const s of S.saved) for (const l of s.legs) if (new Date(l.ko).getTime() < Date.now() - 2 * 3600e3) need.add(l.lg);
  if (!need.size) return;
  const byId = {};
  for (const lg of need) for (const m of await leagueFile(lg)) byId[m.id] = m;
  const results = {};
  for (const s of S.saved) {
    for (const l of s.legs) {
      const m = byId[l.fid];
      if (!m) continue;
      const pc = closingP(l.key, m);
      results[l.fid + '|' + l.key] = { won: settle(l.key, m), clv: pc ? l.o * pc - 1 : null };
    }
  }
  const el = $('#saved');
  if (el) el.innerHTML = savedHtml(results);
  const ms = $('#mystats');
  if (ms) { ms.classList.remove('muted'); ms.innerHTML = myStatsHtml(results); }
}

// ------------------------------------------------------------------ vy: lag
const TEAM_SETS = {
  oversikt: { label: 'Översikt', cols: [['n', 'M'], ['ppg', 'Poäng/m'], ['gf', 'Gjorda/m'], ['ga', 'Insl./m'], ['xgf', 'xG för'], ['xga', 'xG emot'], ['form', 'Form'], ['rank', 'Styrka']] },
  mal: { label: 'Mål', cols: [['n', 'M'], ['gpm', 'Mål/m'], ['o15', 'Ö1,5'], ['o25', 'Ö2,5'], ['o35', 'Ö3,5'], ['btts', 'BLGM'], ['cs', 'Nolla'], ['fts', 'Ej mål'], ['fh05', 'Mål 1:a halvl.']] },
  spelstil: { label: 'Skott och bollinnehav', cols: [['n', 'M'], ['poss', 'Bollinnehav'], ['sf', 'Skott'], ['sa', 'Skott emot'], ['stf', 'På mål'], ['sta', 'På mål emot'], ['ff', 'Fouls'], ['fa', 'Fouls mot']] },
  hornkort: { label: 'Hörnor och kort', cols: [['n', 'M'], ['cf', 'Hörnor för'], ['ca', 'Hörnor emot'], ['ct', 'Hörnor tot.'], ['c95', 'Ö9,5 hörnor'], ['kf', 'Kort'], ['ka', 'Kort motst.'], ['kt', 'Kort tot.'], ['k45', 'Ö4,5 kort']] },
  spel: { label: 'Om du spelat varje match', cols: [['n', 'M'], ['roiW', 'Vinst'], ['roiD', 'Oavgjort'], ['roiL', 'Förlust'], ['roiO', 'Ö2,5'], ['roiU', 'U2,5']] },
};
const PCT_KEYS = new Set(['o15', 'o25', 'o35', 'btts', 'cs', 'fts', 'fh05', 'fh15', 'htw', 'c85', 'c95', 'c105', 'k35', 'k45']);
function statFmt(k, v) {
  if (v == null) return '–';
  if (k.startsWith('roi')) return `<span class="${v > 0 ? 'good' : 'bad'}">${sgn(v, 0)}</span>`;
  if (PCT_KEYS.has(k)) return pct(v);
  if (k === 'poss') return dec(v, 1) + '\u00a0%';
  if (k === 'n') return v;
  return dec(v, k === 'ppg' ? 2 : (['sf', 'sa', 'stf', 'sta', 'ff', 'fa', 'cf', 'ca', 'ct', 'kf', 'ka', 'kt'].includes(k) ? 1 : 2));
}
function teamVal(t, split, k) {
  const a = t[split] || {};
  if (k === 'gpm') return a.gf != null ? a.gf + a.ga : null;
  if (k === 'form') return t.form.slice(-5).reduce((s, x) => s + (x[6] === 'V' ? 3 : x[6] === 'O' ? 1 : 0), 0);
  if (k === 'rank') return t.rating ? t.rating.rank / t.rating.of : null;
  return a[k];
}

function viewLag() {
  const u = S.ui.lag, set = TEAM_SETS[u.set];
  let list = Object.values(S.teams).filter(t => u.lg === 'all' || t.lg === u.lg || (t.comps || []).includes(u.lg));
  if (u.q) { const q = u.q.toLowerCase(); list = list.filter(t => t.name.toLowerCase().includes(q)); }
  if (!set.cols.some(c => c[0] === u.sort) && u.sort !== 'name') { u.sort = set.cols[1][0]; u.asc = false; }
  list = sortRows(list, u.sort, u.asc, u.sort === 'name' ? t => t.name : t => teamVal(t, u.split, u.sort));
  const splits = [['all', 'Alla'], ['home', 'Hemma'], ['away', 'Borta'], ['last6', 'Senaste 6']];
  return `<div class="stack">
    <div><h1>Lag</h1><p class="lead">${Object.keys(S.teams).length} lag, statistik från innevarande säsong i lagets liga (för lag som bara finns i Europacuperna: cupmatcherna). Klicka på en kolumn för att sortera, eller på ett lag för allt om laget.</p></div>
    <div class="chips">${Object.entries(TEAM_SETS).map(([k, s]) => `<button class="chip ${u.set === k ? 'on' : ''}" data-k="lag.set" data-v="${k}">${s.label}</button>`).join('')}</div>
    <div class="controls">
      <label class="field" for="tLg">Liga ${leagueSelect('tLg', 'lag.lg', u.lg)}</label>
      <label class="field" for="tQ">Sök lag <input type="search" id="tQ" data-k="lag.q" value="${esc(u.q)}" placeholder="t.ex. Malmö"></label>
      <div class="chips">${splits.map(([k, n]) => `<button class="chip ${u.split === k ? 'on' : ''}" data-k="lag.split" data-v="${k}">${n}</button>`).join('')}</div>
    </div>
    ${u.set === 'spel' ? '<p class="note">Resultat per spelad krona om man spelat samma spel i varje match till snittodds. +20 % betyder 20 kr vinst per 100 kr insatt.</p>' : ''}
    <div class="tablewrap"><table data-table="lag"><thead><tr>${th('name', 'Lag', u)}<th>Liga</th>${set.cols.map(([k, n]) => th(k, n, u, k === 'form' ? '' : 'num')).join('')}</tr></thead>
    <tbody>${list.map(t => `<tr><td><a href="#lag-${esc(t.id)}">${esc(t.name)}</a></td><td class="small muted">${esc(lgShort(t.lg))}</td>${set.cols.map(([k]) =>
      k === 'form' ? `<td>${formChips(t.form.slice(-5).map(x => x[6]).join(''))}</td>` :
      k === 'rank' ? `<td class="num">${t.rating ? `${t.rating.rank} av ${t.rating.of}` : '–'}</td>` :
      `<td class="num">${statFmt(k, teamVal(t, u.split, k))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  </div>`;
}

const STREAKS = { obesegrade: 'obesegrade', vinster: 'raka vinster', utanVinst: 'utan vinst', forluster: 'raka förluster', gjortMal: 'gjort mål', slapptIn: 'släppt in mål', hallitNollan: 'hållit nollan', over25: 'över 2,5 mål', under25: 'under 2,5 mål', btts: 'båda lagen gjort mål', ejBtts: 'inte båda gjort mål' };
const TEAM_ROWS = [
  ['ppg', 'Poäng per match'], ['gf', 'Gjorda mål per match'], ['ga', 'Insläppta mål per match'], ['xgf', 'xG för'], ['xga', 'xG emot'],
  ['o15', 'Över 1,5 mål'], ['o25', 'Över 2,5 mål'], ['o35', 'Över 3,5 mål'], ['btts', 'Båda lagen gör mål'], ['cs', 'Hållit nollan'], ['fts', 'Inte gjort mål'],
  ['fh05', 'Mål i första halvlek'], ['htw', 'Ledning i halvtid'],
  ['poss', 'Bollinnehav'], ['sf', 'Skott'], ['sa', 'Skott emot'], ['stf', 'Skott på mål'], ['sta', 'Skott på mål emot'],
  ['cf', 'Hörnor för'], ['ca', 'Hörnor emot'], ['ct', 'Hörnor totalt'], ['c95', 'Över 9,5 hörnor'],
  ['kf', 'Kort, eget lag'], ['ka', 'Kort, motståndare'], ['kt', 'Kort totalt'], ['k45', 'Över 4,5 kort'], ['ff', 'Fouls'],
  ['roiW', 'Spel på vinst varje match'], ['roiO', 'Spel på över 2,5 varje match'], ['roiU', 'Spel på under 2,5 varje match'],
];

function viewTeam(id) {
  const t = S.teams[id];
  if (!t) return `<div class="panel"><h2>Laget hittades inte</h2><p><a href="#lag">Till alla lag</a></p></div>`;
  const a = t.all;
  const next = t.next.map(fid => S.fxById[fid]).filter(Boolean);
  const streaks = Object.entries(t.streaks || {}).sort((x, y) => y[1] - x[1]);
  setTimeout(() => fillTeamMatches(t), 0);
  const rows = TEAM_ROWS.filter(([k]) => ['all', 'home', 'away', 'last6'].some(s => t[s]?.[k] != null));
  return `<div class="stack">
    <div class="panel stack">
      <span class="eyebrow">${(t.comps || [t.lg]).map(c => `<a href="#liga-${c}">${esc(c === t.lg ? lgName(c) : lgShort(c))}</a>`).join(' · ')}</span>
      <div class="row between"><h1>${esc(t.name)}</h1><span>${formChips(t.form.map(x => x[6]).join(''))}</span></div>
      <div class="small muted">${t.pos ? `Plats ${t.pos} av ${t.of} med ${a.pts} poäng på ${a.n} matcher.` : ''} ${t.rating ? `Styrka ${t.rating.rank} av ${t.rating.of} enligt modellen: gör ${dec(t.rating.att)} och släpper in ${dec(t.rating.def)} mål mot ett snittlag.` : ''}</div>
      ${streaks.length ? `<div class="chips">${streaks.map(([k, n]) => `<span class="pill info">${n} matcher ${STREAKS[k] || k}</span>`).join('')}</div>` : ''}
    </div>
    ${next.length ? `<div><h2 style="margin-bottom:8px">Kommande matcher</h2>${fixtureGroups(next)}</div>` : ''}
    <div class="tiles">
      ${tile('Poäng per match', dec(a.ppg), `${a.w}–${a.d}–${a.l}`)}
      ${tile('Mål', `${a.gfT}–${a.gaT}`, `${dec(a.gf, 1)} – ${dec(a.ga, 1)} per match`)}
      ${a.xgf != null ? tile('xG per match', `${dec(a.xgf, 1)}–${dec(a.xga, 1)}`) : ''}
      ${tile('Över 2,5 mål', pct(a.o25))}
      ${tile('Båda lagen gör mål', pct(a.btts))}
      ${a.ct != null ? tile('Hörnor per match', dec(a.ct, 1), `${dec(a.cf, 1)} för, ${dec(a.ca, 1)} emot`) : ''}
      ${a.kt != null ? tile('Kort per match', dec(a.kt, 1), `${dec(a.kf, 1)} eget lag`) : ''}
      ${a.poss != null ? tile('Bollinnehav', dec(a.poss, 0) + '\u00a0%') : ''}
    </div>
    <div class="panel"><h2>Statistik</h2>
      <div class="tablewrap"><table><thead><tr><th></th><th class="num">Alla</th><th class="num">Hemma</th><th class="num">Borta</th><th class="num">Senaste 6</th></tr></thead>
      <tbody><tr><td class="muted">Matcher</td>${['all', 'home', 'away', 'last6'].map(s => `<td class="num">${t[s]?.n ?? 0}</td>`).join('')}</tr>
      ${rows.map(([k, n]) => `<tr><td>${n}</td>${['all', 'home', 'away', 'last6'].map(s => `<td class="num">${statFmt(k, t[s]?.[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">"Spel på …" visar vinst eller förlust per spelad krona om man spelat det i varje match till snittodds.</p>
    </div>
    <div class="panel"><h2>Matcher</h2><div id="teamMatches" class="muted">Laddar …</div></div>
  </div>`;
}

async function fillTeamMatches(t) {
  const files = await Promise.all((t.comps && t.comps.length ? [...new Set([t.lg, ...t.comps])] : [t.lg]).map(leagueFile));
  const el = $('#teamMatches');
  if (!el || location.hash.slice(1) !== 'lag-' + t.id) return;
  const ms = files.flat().filter(m => m.hid === t.id || m.aid === t.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);
  if (!ms.length) { el.textContent = 'Inga matcher hittades.'; return; }
  el.classList.remove('muted');
  let season = null;
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Datum</th><th>Tävling</th><th></th><th>Motstånd</th><th class="num">Resultat</th><th class="num">Halvtid</th><th class="num">xG</th><th class="num">Skott på mål</th><th class="num">Hörnor</th><th class="num">Kort</th><th class="num">Odds</th><th>Domare</th></tr></thead><tbody>${ms.map(m => {
    const home = m.hid === t.id;
    const gf = home ? m.hg : m.ag, ga = home ? m.ag : m.hg;
    const r = gf > ga ? 'V' : gf === ga ? 'O' : 'F';
    const pick = (h, a) => (h == null ? '–' : (home ? `${h}–${a}` : `${a}–${h}`));
    let head = '';
    if (m.lg === t.lg && m.season !== season) { season = m.season; head = `<tr class="group-row"><td colspan="12">Säsong ${esc(seasonLabel(season))}</td></tr>`; }
    return head + `<tr><td class="faint">${shortDate(m.date)}</td><td class="small muted">${esc(lgShort(m.lg))}</td><td>${home ? 'H' : 'B'}</td><td>${teamLink(home ? m.aid : m.hid, home ? m.away : m.home)}</td>
      <td class="num">${formChips(r)} <b>${gf}–${ga}</b></td><td class="num">${pick(m.hthg, m.htag)}</td>
      <td class="num">${m.hxg != null ? (home ? `${dec(m.hxg, 1)}–${dec(m.axg, 1)}` : `${dec(m.axg, 1)}–${dec(m.hxg, 1)}`) : '–'}</td>
      <td class="num">${pick(m.hst, m.ast)}</td><td class="num">${pick(m.hc, m.ac)}</td>
      <td class="num">${m.hy != null ? pick(m.hy + (m.hr || 0), m.ay + (m.ar || 0)) : '–'}</td>
      <td class="num">${(home ? m.oH : m.oA) ? dec(home ? m.oH : m.oA) : '–'}</td>
      <td class="small">${m.ref ? (S.refs[slug(m.ref)] ? `<a href="#domare-${slug(m.ref)}">${esc(m.ref)}</a>` : esc(m.ref)) : ''}</td></tr>`;
  }).join('')}</tbody></table></div><p class="note">Odds = snittodds på att laget vinner. Statistik som "för–emot" ur lagets perspektiv.</p>`;
}

function seasonLabel(s) {
  if (/^\d{4}$/.test(s) && (+s.slice(0, 2) + 1) % 100 === +s.slice(2)) return `20${s.slice(0, 2)}/${s.slice(2)}`;
  return s.replace(/^(\d{4})\/\d{2}(\d{2})$/, '$1/$2');
}
function slug(s) {
  return s.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------ vy: domare
function viewDomare() {
  const u = S.ui.dom;
  const refLgs = order().filter(lg => S.leagues[lg].hasRef);
  let list = Object.values(S.refs).filter(r => r.n >= u.minN && (u.lg === 'all' || r.leagues.some(([l]) => l === u.lg)));
  const nextOf = r => r.upcoming.map(id => S.fxById[id]).filter(Boolean)[0];
  list = sortRows(list, u.sort, u.asc, u.sort === 'name' ? r => r.name : u.sort === 'next' ? r => nextOf(r)?.ko ? -new Date(nextOf(r).ko).getTime() : null : null);
  return `<div class="stack">
    <div><h1>Domare</h1><p class="lead">Domarstatistik för ${refLgs.length} ligor i England och Skottland (de enda ligorna där datan anger domare), förra och innevarande säsong. Kortfaktor 1,20 betyder 20 % fler kort än ligasnittet.</p></div>
    <div class="controls">
      <label class="field" for="dLg">Liga ${leagueSelect('dLg', 'dom.lg', u.lg, { filter: L => L.hasRef })}</label>
      <label class="field" for="dMin">Minst antal matcher <input type="number" id="dMin" data-k="dom.minN" data-type="num" value="${u.minN}" min="1"></label>
    </div>
    <div class="tablewrap"><table data-table="dom"><thead><tr>
      ${th('name', 'Domare', u)}<th>Ligor</th>${th('n', 'Matcher', u, 'num')}${th('k', 'Kort/m', u, 'num', 'Gula + röda per match')}${th('y', 'Gula/m', u, 'num')}${th('rd', 'Röda/m', u, 'num')}${th('kf', 'Kortfaktor', u, 'num')}${th('k35', 'Ö3,5 kort', u, 'num')}${th('k45', 'Ö4,5 kort', u, 'num')}${th('f', 'Fouls/m', u, 'num')}${th('g', 'Mål/m', u, 'num')}${th('o25', 'Ö2,5', u, 'num')}${th('hw', 'Hemmavinst', u, 'num')}${th('next', 'Nästa match', u)}
    </tr></thead><tbody>${list.map(r => {
      const nx = nextOf(r);
      return `<tr><td><a href="#domare-${esc(r.id)}">${esc(r.name)}</a></td><td class="small muted">${r.leagues.map(([l]) => esc(lgShort(l))).join(', ')}</td>
        <td class="num">${r.n}</td><td class="num"><b>${dec(r.k)}</b></td><td class="num">${dec(r.y)}</td><td class="num">${dec(r.rd)}</td>
        <td class="num"><span class="${r.kf > 1.1 ? 'pill warn' : r.kf < 0.9 ? 'pill info' : ''}">${dec(r.kf)}</span></td>
        <td class="num">${pct(r.k35)}</td><td class="num">${pct(r.k45)}</td><td class="num">${dec(r.f, 1)}</td><td class="num">${dec(r.g)}</td><td class="num">${pct(r.o25)}</td><td class="num">${pct(r.hw)}</td>
        <td class="small">${nx ? `<a href="#match-${esc(nx.id)}">${esc(nx.home)} – ${esc(nx.away)}</a> <span class="faint">${dayChip(dayKey(nx.ko))}</span>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>
  </div>`;
}

function viewRef(id) {
  const r = S.refs[id];
  if (!r) return `<div class="panel"><h2>Domaren hittades inte</h2><p><a href="#domare">Till alla domare</a></p></div>`;
  const up = r.upcoming.map(fid => S.fxById[fid]).filter(Boolean);
  return `<div class="stack">
    <div class="panel stack"><span class="eyebrow">Domare · ${r.leagues.map(([l, n]) => `${esc(lgShort(l))} (${n})`).join(', ')}</span><h1>${esc(r.name)}</h1>
      <div class="small muted">${r.n} matcher förra och denna säsong, senast ${shortDate(r.last)}. Denna säsong ${r.nCur} matcher med ${dec(r.kCur)} kort per match.</div></div>
    ${up.length ? `<div><h2 style="margin-bottom:8px">Kommande matcher</h2>${fixtureGroups(up)}</div>` : ''}
    <div class="tiles">
      ${tile('Kort per match', dec(r.k), `${dec(r.y)} gula · ${dec(r.rd)} röda`)}
      ${tile('Kortfaktor', dec(r.kf), 'jämfört med ligasnittet')}
      ${tile('Över 3,5 kort', pct(r.k35))}${tile('Över 4,5 kort', pct(r.k45))}${tile('Över 5,5 kort', pct(r.k55))}
      ${tile('Kort hemma/borta', `${dec(r.kh, 1)}/${dec(r.ka, 1)}`)}
      ${tile('Fouls per match', dec(r.f, 1))}
      ${tile('Mål per match', dec(r.g), `över 2,5: ${pct(r.o25)}`)}
      ${tile('1 / X / 2', `${Math.round(r.hw * 100)}/${Math.round(r.dr * 100)}/${Math.round(r.aw * 100)}`, 'procent')}
      ${r.c != null ? tile('Hörnor per match', dec(r.c, 1)) : ''}
    </div>
    <div class="panel"><h2>Matcher</h2><div class="tablewrap"><table><thead><tr><th>Datum</th><th>Liga</th><th>Match</th><th class="num">Resultat</th><th class="num">Gula</th><th class="num">Röda</th><th class="num">Kort tot.</th><th class="num">Fouls</th></tr></thead>
    <tbody>${r.matches.map(([d, lg, h, a, hid, aid, hg, ag, hy, ay, hr, ar, hf, af]) => `<tr><td class="faint">${shortDate(d)} ${d.slice(0, 4)}</td><td class="small muted">${esc(lgShort(lg))}</td>
      <td>${teamLink(hid, h)} – ${teamLink(aid, a)}</td><td class="num"><b>${hg}–${ag}</b></td><td class="num">${hy ?? '–'}–${ay ?? '–'}</td><td class="num">${hr ?? 0}–${ar ?? 0}</td>
      <td class="num"><b>${hy != null ? hy + ay + (hr || 0) + (ar || 0) : '–'}</b></td><td class="num">${hf != null ? hf + af : '–'}</td></tr>`).join('')}</tbody></table></div></div>
  </div>`;
}

// ------------------------------------------------------------------ vy: ligor
function viewLigor() {
  const card = lg => {
    const L = S.leagues[lg], s = L.stats;
    return `<a class="lgcard" href="#liga-${lg}"><div><div class="eyebrow">${esc(L.country)}</div><h3>${esc(L.name)}</h3></div>
      <div class="small muted">${L.season} · ${L.matches} matcher spelade${L.fixtures ? ` · ${L.fixtures} kommande` : ''}</div>
      <dl><div><dt>Mål/match</dt><dd>${dec(s.gpm)}</dd></div><div><dt>Över 2,5</dt><dd>${pct(s.o25)}</dd></div><div><dt>BLGM</dt><dd>${pct(s.btts)}</dd></div>
      <div><dt>1 / X / 2</dt><dd>${s.hw != null ? `${Math.round(s.hw * 100)}/${Math.round(s.dr * 100)}/${Math.round(s.aw * 100)}` : '–'}</dd></div><div><dt>Hörnor</dt><dd>${dec(s.ct, 1)}</dd></div><div><dt>Kort</dt><dd>${dec(s.kt, 1)}</dd></div></dl></a>`;
  };
  const all = order();
  const groups = [
    ['Europacuper', all.filter(lg => S.leagues[lg].country === 'Europa')],
    ['Ligor', all.filter(lg => S.leagues[lg].kind !== 'cup')],
    ['Nationella cuper', all.filter(lg => S.leagues[lg].kind === 'cup' && S.leagues[lg].country !== 'Europa')],
  ].filter(g => g[1].length);
  const nLeagues = all.filter(lg => S.leagues[lg].kind !== 'cup').length;
  return `<div class="stack"><div><h1>Ligor och cuper</h1><p class="lead">${nLeagues} europeiska ligor och ${all.length - nLeagues} cuper. Siffrorna gäller innevarande säsong. 1 / X / 2 är andelen hemmavinster, oavgjorda och bortavinster i procent.</p></div>
    ${groups.map(([n, lgs]) => `<h2>${n}</h2><div class="lgcards">${lgs.map(card).join('')}</div>`).join('')}</div>`;
}

async function fillLeagueResults(lg) {
  const rows = (await leagueFile(lg)).slice(0, 30);
  const el = $('#lgResults');
  if (!el || location.hash.slice(1) !== 'liga-' + lg) return;
  if (!rows.length) { el.textContent = 'Inga resultat.'; return; }
  el.classList.remove('muted');
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Datum</th><th>Match</th><th class="num">Resultat</th><th class="num">Halvtid</th><th class="num">Hörnor</th><th class="num">Kort</th><th class="num">Skott på mål</th><th class="num">Bollinnehav</th></tr></thead><tbody>${rows.map(m =>
    `<tr><td class="faint">${shortDate(m.date)}</td><td>${teamLink(m.hid, m.home)} – ${teamLink(m.aid, m.away)}</td><td class="num"><b>${m.hg}–${m.ag}</b></td>
     <td class="num">${m.hthg != null ? `${m.hthg}–${m.htag}` : '–'}</td><td class="num">${m.hc != null ? `${m.hc}–${m.ac}` : '–'}</td>
     <td class="num">${m.hy != null ? `${m.hy + (m.hr || 0)}–${m.ay + (m.ar || 0)}` : '–'}</td><td class="num">${m.hst != null ? `${m.hst}–${m.ast}` : '–'}</td>
     <td class="num">${m.hpos != null ? `${Math.round(m.hpos)}–${Math.round(m.apos)}` : '–'}</td></tr>`).join('')}</tbody></table></div>`;
}

function viewLiga(lg) {
  const L = S.leagues[lg];
  setTimeout(() => fillLeagueResults(lg), 0);
  if (!L) return `<div class="panel"><h2>Ligan hittades inte</h2><p><a href="#ligor">Till alla ligor</a></p></div>`;
  const s = L.stats;
  const fx = S.fx.filter(f => f.lg === lg);
  const teams = L.table.map(r => S.teams[r.id]).filter(Boolean);
  const top = (k, n, fm, asc = false) => {
    const sorted = sortRows(teams.filter(t => t.all[k] != null), k, asc, t => t.all[k]).slice(0, 5);
    return sorted.length ? `<div class="panel"><h3>${n}</h3><table style="margin-top:6px"><tbody>${sorted.map(t => `<tr><td>${teamLink(t.id, t.name)}</td><td class="num"><b>${fm(t.all[k])}</b></td></tr>`).join('')}</tbody></table></div>` : '';
  };
  return `<div class="stack">
    <div><span class="eyebrow">${esc(L.country)} · säsong ${esc(L.season)}</span><h1>${esc(L.name)}</h1><p class="lead">${L.matches} matcher spelade, senast ${L.last ? shortDate(L.last) : '–'}. ${L.hasStats ? '' : 'För den här ligan finns bara resultat och odds, inte skott, hörnor eller kort (ingen gratis källa har det).'}${L.kind === 'cup' ? ' Lagens statistik och styrka kommer från deras ligor och alla cupmatcher, så lag från olika länder går att jämföra.' : ''}</p></div>
    <div class="tiles">
      ${tile('Mål per match', dec(s.gpm), `${dec(s.hg)} hemma, ${dec(s.ag)} borta`)}
      ${tile('1 / X / 2', s.hw != null ? `${Math.round(s.hw * 100)}/${Math.round(s.dr * 100)}/${Math.round(s.aw * 100)}` : '–', 'procent')}
      ${tile('Över 2,5 mål', pct(s.o25), `över 1,5: ${pct(s.o15)} · över 3,5: ${pct(s.o35)}`)}
      ${tile('Båda lagen gör mål', pct(s.btts))}
      ${s.ct != null ? tile('Hörnor per match', dec(s.ct, 1)) : ''}
      ${s.kt != null ? tile('Kort per match', dec(s.kt, 1)) : ''}
      ${s.homeAdv ? tile('Hemmafördel', `${sgn(s.homeAdv - 1, 0)}`, 'fler mål på hemmaplan enligt modellen') : ''}
    </div>
    ${fx.length ? `<div><h2 style="margin-bottom:8px">Kommande matcher</h2>${fixtureGroups(fx)}</div>` : ''}
    ${L.table.length ? `<div class="panel"><h2>${L.kind === 'cup' ? 'Tabell, alla matcher i turneringen' : 'Tabell'}</h2>${L.kind === 'cup' ? '<p class="note">Räknad från alla matcher denna säsong, även kvalet och slutspelet om de spelats. Under ligaspelet är det samma som UEFA:s tabell.</p>' : ''}<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th class="num">#</th><th>Lag</th><th class="num">M</th><th class="num">V</th><th class="num">O</th><th class="num">F</th><th class="num">Mål</th><th class="num">+/−</th><th class="num">P</th>${L.hasXg ? '<th class="num">xG</th><th class="num">xG emot</th>' : ''}<th>Form</th><th class="num" title="Modellens styrka: förväntad målskillnad per match mot ett snittlag">Styrka</th></tr></thead>
    <tbody>${L.table.map(r => `<tr><td class="num">${r.pos}</td><td>${teamLink(r.id, r.name)}</td><td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td><td class="num">${r.gf}–${r.ga}</td><td class="num">${r.gf - r.ga > 0 ? '+' : ''}${r.gf - r.ga}</td><td class="num"><b>${r.pts}</b></td>${L.hasXg ? `<td class="num">${dec(r.xgf, 1)}</td><td class="num">${dec(r.xga, 1)}</td>` : ''}<td>${formChips(r.form)}</td><td class="num">${r.net != null ? (r.net > 0 ? '+' : '') + dec(r.net) : '–'}</td></tr>`).join('')}</tbody></table></div>
    <p class="note">Tabellen är räknad från resultaten och tar inte hänsyn till poängavdrag eller slutspelsserier.</p></div>` : ''}
    <div class="panel"><h2>Senaste resultat</h2><div id="lgResults" class="muted">Laddar …</div></div>
    ${L.kind === 'cup' ? '' : `<div class="grid3">
      ${top('o25', 'Flest matcher över 2,5 mål', pct)}${top('btts', 'Oftast båda lagen gör mål', pct)}${top('cs', 'Oftast hållit nollan', pct)}
      ${top('ct', 'Flest hörnor per match', x => dec(x, 1))}${top('kt', 'Flest kort per match', x => dec(x, 1))}${top('roiW', 'Bäst att spela på (vinst)', x => sgn(x, 0))}
    </div>`}
  </div>`;
}

// ------------------------------------------------------------------ vy: modell
function calChart(bins) {
  const W = 420, H = 300, m = { l: 44, r: 22, t: 12, b: 38 };
  const x = v => m.l + v * (W - m.l - m.r), y = v => H - m.b - v * (H - m.t - m.b);
  let g = '';
  for (let v = 0; v <= 1.0001; v += 0.2) {
    g += `<line class="gridline" x1="${x(0)}" x2="${x(1)}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)} %</text>`;
    g += `<text x="${x(v)}" y="${H - m.b + 16}" text-anchor="middle">${Math.round(v * 100)} %</text>`;
  }
  g += `<line class="axis" x1="${x(0)}" x2="${x(1)}" y1="${y(0)}" y2="${y(0)}"/><line class="ref" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>`;
  g += `<text x="${(x(0) + x(1)) / 2}" y="${H - 4}" text-anchor="middle">Vår chans</text><text transform="translate(12 ${(y(0) + y(1)) / 2}) rotate(-90)" text-anchor="middle">Utfall</text>`;
  const pts = bins.map(b => `<circle class="pt" cx="${x(b.forvantad)}" cy="${y(b.utfall)}" r="${Math.max(5, Math.min(11, Math.sqrt(b.n) / 6))}" data-tip="Bedömt ${pct(b.forvantad)}, gick in ${pct(b.utfall)} (${b.n.toLocaleString('sv-SE')} spel)"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kalibrering: bedömd chans mot utfall">${g}${pts}</svg>`;
}

function viewModell() {
  const b = S.bt;
  if (!b) return '<div class="panel">Backtestet saknas i datan.</div>';
  const u = S.ui.bt, per = b.perioder[u.per] || b.perioder[0];
  const ll = per.logloss;
  const roi = per.roi.filter(r => r.odds === u.odds && r.grupp === u.grp && (r.maxodds ?? null) === (u.cap ? VALUE_MAX_ODDS : null));
  const mo = b.endastModell.find(r => r.odds === 'avg' && r.grupp === 'Alla');
  return `<div class="stack">
    <div><h1>Modell och träffsäkerhet</h1>
    <p class="lead">Alla siffror nedan kommer från ett backtest där modellen varje vecka bara fick se matcherna före veckan och sedan tippade veckans matcher. Inget är efterhandskonstruerat.</p></div>
    <div class="grid2">
      <div class="panel stack"><h2>Så räknas chanserna</h2>
        <p>1. <b>Statistikmodell.</b> Varje lag får en anfalls- och försvarsstyrka från mål, xG och skott på mål de senaste två säsongerna, där nya matcher väger mest. Nyuppflyttade lag startar lite svagare, nedflyttade lite starkare. Ur styrkorna räknas förväntade mål och en resultatmatris.</p>
        <p>2. <b>Marknaden.</b> Spelbolagens odds räknas om till förväntade mål, utan spelbolagens marginal.</p>
        <p>3. <b>Kombination.</b> Vikten mellan modell och marknad väljs i backtestet. Just nu är modellens vikt <b>${Math.round(b.alpha * 100)} %</b>, eftersom oddsen träffade bättre än statistiken ensam. Därför bygger chanserna för 1X2 och mål i praktiken på marknaden, medan modellen och lagstatistiken står för hörnor och kort.</p>
        <p>4. <b>Alla andra spel</b> (båda gör mål, lagmål, första halvlek, andra mållinjer) räknas ur samma förväntade mål. Hörnor och kort räknas från lagens snitt för och emot, och för kort också domarens kortfaktor.</p>
        <p class="note">Värde = chans × odds − 1. Ett spel med 50 % chans och odds 2,20 har värdet +10 %.</p>
      </div>
      <div class="panel stack"><h2>Träffar chanserna?</h2>
        <div class="chips">${b.perioder.map((p, i) => `<button class="chip ${u.per === i ? 'on' : ''}" data-k="bt.per" data-v="${i}" data-type="num">${esc(p.namn)}</button>`).join('')}</div>
        ${calChart(per.kalibrering)}
        <p class="note">Varje punkt är en grupp spel (1X2 och över/under 2,5). Ligger punkten på den streckade linjen gick spelen in lika ofta som vi bedömde. ${per.matcher.toLocaleString('sv-SE')} matcher ${shortDate(per.fran)} ${per.fran.slice(0, 4)} – ${shortDate(per.till)} ${per.till.slice(0, 4)}.</p>
      </div>
    </div>
    <div class="panel"><h2>Modell mot marknad</h2>
      <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th></th><th class="num">Log-loss 1X2</th><th class="num">Rätt tecken</th><th class="num">Log-loss över/under 2,5</th></tr></thead><tbody>
      ${[['modell', 'Bara statistikmodellen'], ['marknad', 'Bara oddsen (utan marginal)'], ['kombination', 'Det sidan använder']].map(([k, n]) => ll[k] ? `<tr><td>${n}</td><td class="num">${dec(ll[k].ll1x2, 4)}</td><td class="num">${pct(ll[k].acc1x2, 1)}</td><td class="num">${dec(ll[k].llou, 4)}</td></tr>` : '').join('')}
      </tbody></table></div>
      <p class="note">Lägre log-loss är bättre. ${mo ? `Den som spelar på allt där bara statistikmodellen ser minst 5 % värde mot snittodds hade fått <b class="bad">${sgn(mo.roi, 0)}</b> på ${mo.n.toLocaleString('sv-SE')} spel innevarande säsong. Därför vägs modellen mot oddsen.` : ''}</p>
    </div>
    <div class="panel stack"><h2>Om man spelat på värde</h2>
      <div class="row">
        <div class="chips">${[['avg', 'Snittodds'], ['max', 'Bästa odds']].map(([k, n]) => `<button class="chip ${u.odds === k ? 'on' : ''}" data-k="bt.odds" data-v="${k}">${n}</button>`).join('')}</div>
        <div class="chips">${['Alla', '1X2', 'Ö/U 2,5'].map(g => `<button class="chip ${u.grp === g ? 'on' : ''}" data-k="bt.grp" data-v="${g}">${g}</button>`).join('')}</div>
        <div class="chips"><button class="chip ${u.cap ? 'on' : ''}" data-k="bt.cap" data-v="1" data-type="num">Odds upp till ${VALUE_MAX_ODDS}</button><button class="chip ${!u.cap ? 'on' : ''}" data-k="bt.cap" data-v="0" data-type="num">Alla odds</button></div>
      </div>
      ${roi.length ? `<div class="tablewrap"><table><thead><tr><th>Minsta värde</th><th class="num">Spel</th><th class="num">Träff</th><th class="num">Snittodds</th><th class="num">Resultat per spelad krona</th></tr></thead><tbody>
        ${roi.map(r => `<tr><td>${r.troskel > 0 ? '+' + Math.round(r.troskel * 100) + ' %' : 'över 0 %'}</td><td class="num">${r.n.toLocaleString('sv-SE')}</td><td class="num">${pct(r.traff)}</td><td class="num">${dec(r.snittodds)}</td><td class="num"><b class="${r.roi > 0 ? 'good' : 'bad'}">${sgn(r.roi, 1)}</b></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Inga spel med värde mot de här oddsen. Med snittodds är spelbolagens marginal redan inräknad, så marknadens egen bedömning ger aldrig värde mot snittet.</p>'}
      <p class="note">Visar ${esc(per.namn.toLowerCase())}. Få spel och höga odds ger stor slump: några hundra spel räcker inte för att säkert skilja en vinnande metod från tur. Taket på odds ${VALUE_MAX_ODDS} sattes efter att vi sett att långa odds drog ner resultatet, så siffrorna med tak är något optimistiska. Bästa odds är det högsta priset bland spelbolagen i datan och kan vara svårt att få i praktiken.</p>
    </div>
    ${S.bt.lappar?.length ? `<div class="panel stack"><h2>Lappstrategier</h2><p class="note">Huvudligorna, oddsen före matchen hos ett och samma bolag (en lapp läggs hos ett bolag). Stängningsvärde = oddset jämfört med marknadens rättvisa pris vid avspark. Ett positivt stängningsvärde är det säkraste tecknet på att en strategi går plus i längden, även när resultatet på några få lappar är minus.</p>${strategyTable(false)}</div>` : ''}
    <div class="grid2">
      <div class="panel"><h2>Säkra spel</h2><p class="note">Alla 1X2- och över/under-spel där vår chans var minst 60, 70 eller 80 %, spelade till snittodds.</p>
        <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Chans minst</th><th class="num">Spel</th><th class="num">Bedömt</th><th class="num">Gick in</th><th class="num">Snittodds</th><th class="num">Resultat</th></tr></thead><tbody>
        ${per.sakra.map(r => `<tr><td>${Math.round(r.niva * 100)} %</td><td class="num">${r.n.toLocaleString('sv-SE')}</td><td class="num">${pct(r.forvantad)}</td><td class="num">${pct(r.traff)}</td><td class="num">${dec(r.snittodds)}</td><td class="num"><b class="${r.roi > 0 ? 'good' : 'bad'}">${sgn(r.roi, 1)}</b></td></tr>`).join('')}
        </tbody></table></div><p class="note">Favoriter går in ofta, men oddsen är så låga att marginalen äter upp vinsten.</p></div>
      <div class="panel"><h2>Värdespel per liga</h2><p class="note">Spel med minst 5 % värde mot snittodds, ${esc(per.namn.toLowerCase())}.</p>
        ${per.ligor.length ? `<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Liga</th><th class="num">Spel</th><th class="num">Resultat</th></tr></thead><tbody>${sortRows(per.ligor, 'roi', false).map(r => `<tr><td>${esc(lgName(r.lg))}</td><td class="num">${r.n}</td><td class="num"><b class="${r.roi > 0 ? 'good' : 'bad'}">${sgn(r.roi, 0)}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Inga sådana spel mot snittodds.</p>'}</div>
    </div>
    <div class="panel"><h2>Data</h2><p class="note">Resultat, statistik, domare och odds för 22 huvudligor och resultat och odds för 10 extraligor kommer från football-data.co.uk. Europacuperna, de stora nationella cuperna, Eerste Divisie, bollinnehav, spelschemat en vecka framåt och hörnor, kort och skott för Sverige, Norge, Danmark, Österrike och Ryssland kommer från ESPN, med odds från DraftKings. Allt uppdateras varje dag. xG finns från 2026/27 i de flesta huvudligor, annars används skott på mål. Domare finns bara för England och Skottland. För Schweiz, Polen, Rumänien, Finland och Irland finns bara resultat och odds. Cupmatcherna ingår inte i backtestet.</p></div>
  </div>`;
}

// ------------------------------------------------------------------ router och händelser
const VIEWS = { matcher: viewMatcher, match: viewMatch, spel: viewSpel, lappar: viewLappar, lag: viewLag, domare: viewDomare, ligor: viewLigor, liga: viewLiga, modell: viewModell };
const NAV_OF = { match: 'matcher', liga: 'ligor' };
let lastHash = null;

function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1)) || 'matcher';
  const i = h.indexOf('-');
  let view = i < 0 ? h : h.slice(0, i), arg = i < 0 ? '' : h.slice(i + 1);
  if (view === 'lag' && arg) view = 'team';
  if (view === 'domare' && arg) view = 'ref';
  return { view, arg };
}

async function route() {
  let { view, arg } = parseHash();
  if (view === 'modell' && !S.bt) S.bt = await getJSON('data/backtest.json').catch(() => null);
  const fn = { team: viewTeam, ref: viewRef }[view] || VIEWS[view] || viewMatcher;
  const navView = view === 'team' ? 'lag' : view === 'ref' ? 'domare' : (NAV_OF[view] || (VIEWS[view] ? view : 'matcher'));
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === navView));
  const focusId = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  $('#app').innerHTML = fn(arg);
  if (location.hash !== lastHash) { window.scrollTo(0, 0); lastHash = location.hash; }
  else if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* inte textfält */ } } }
  if (view === 'lappar') settleSaved();
  document.title = view === 'match' && S.fxById[arg] ? `${S.fxById[arg].home} – ${S.fxById[arg].away} · Matchlabbet` : view === 'team' && S.teams[arg] ? `${S.teams[arg].name} · Matchlabbet` : 'Matchlabbet';
}
const rerender = () => route();

function setPath(path, v) {
  const parts = path.split('.');
  let o = S.ui;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = v;
}
function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  let v = el.dataset.v ?? el.value;
  if (el.type === 'number' || el.dataset.type === 'num') {
    if (v === '') return el.dataset.scale ? -1 : 0;
    v = parseFloat(String(v).replace(',', '.'));
    if (el.dataset.scale) v = v / +el.dataset.scale;
  }
  return v;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-add],[data-sort],[data-k][data-v],[data-preset],[data-del],[data-use],[data-delsaved],[data-odds],#saveSlip,#clearSlip');
  if (!t) return;
  if (t.dataset.add) { e.preventDefault(); const [fid, key] = t.dataset.add.split('|'); toggleSlip(fid, key, t.dataset.src || S.set.odds); return; }
  if (t.dataset.sort) {
    const tbl = t.closest('table').dataset.table;
    const st = S.ui[tbl];
    if (st.sort === t.dataset.sort) st.asc = !st.asc; else { st.sort = t.dataset.sort; st.asc = ['name', 'm', 'ko', 'rank'].includes(t.dataset.sort); }
    return rerender();
  }
  if (t.dataset.preset) { const u = S.ui.spel; Object.assign(u, PRESETS[t.dataset.preset].set, { preset: t.dataset.preset }); return rerender(); }
  if (t.dataset.k && t.dataset.v != null) { setPath(t.dataset.k, readValue(t)); if (t.dataset.k.startsWith('gen.')) S.ui.gen.out = null; return rerender(); }
  if (t.dataset.del != null) { S.slip.splice(+t.dataset.del, 1); persist('ml-slip', S.slip); updateSlipCount(); return rerender(); }
  if (t.dataset.delsaved != null) { S.saved.splice(+t.dataset.delsaved, 1); persist('ml-saved', S.saved); return rerender(); }
  if (t.dataset.odds) { S.set.odds = t.dataset.odds; $('#oddsSrc').value = S.set.odds; persist('ml-settings', S.set); return rerender(); }
  if (t.dataset.use != null) {
    const legs = S.ui.gen.out[+t.dataset.use];
    S.slip = [];
    legs.forEach(({ fid, key }) => toggleSlip(fid, key, S.ui.gen.book));
    return rerender();
  }
  if (t.id === 'saveSlip') {
    S.saved.push({ saved: new Date().toISOString(), stake: S.ui.stake, legs: S.slip.map(l => ({ ...l })) });
    persist('ml-saved', S.saved);
    S.slip = []; persist('ml-slip', S.slip); updateSlipCount();
    return rerender();
  }
  if (t.id === 'clearSlip') { S.slip = []; persist('ml-slip', S.slip); updateSlipCount(); return rerender(); }
});

function onField(e) {
  const t = e.target;
  if (t.id === 'oddsSrc') { S.set.odds = t.value; persist('ml-settings', S.set); S.ui.gen.out = null; return rerender(); }
  if (t.id === 'stake') { S.ui.stake = Math.max(1, +t.value || 100); return rerender(); }
  if (t.id === 'bank') { S.set.bank = Math.max(100, +t.value || 1000); persist('ml-settings', S.set); return rerender(); }
  if (t.dataset.leg != null) {
    const v = parseFloat(t.value.replace(',', '.'));
    if (v > 1) { S.slip[+t.dataset.leg].o = v; persist('ml-slip', S.slip); }
    return rerender();
  }
  if (!t.dataset.k || t.dataset.v != null) return;
  setPath(t.dataset.k, readValue(t));
  if (t.dataset.k.startsWith('gen.')) S.ui.gen.out = null;
  if (t.dataset.k.startsWith('spel.')) S.ui.spel.preset = null;
  rerender();
}
document.addEventListener('change', e => { if (e.target.type !== 'search') onField(e); });
document.addEventListener('input', e => { if (e.target.type === 'search') onField(e); });

// verktygstips för diagram
document.addEventListener('pointerover', e => {
  const t = e.target.closest('[data-tip]');
  const tip = $('#tip');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - 250, r.right + 8) + 'px';
  tip.style.top = (r.top - 8) + 'px';
});

window.addEventListener('hashchange', route);

async function init() {
  $('#oddsSrc').value = S.set.odds;
  updateSlipCount();
  try {
    const [meta, fx, teams, leagues, refs] = await Promise.all(['meta', 'fixtures', 'teams', 'leagues', 'referees'].map(n => getJSON(`data/${n}.json`)));
    Object.assign(S, { meta, fx, teams, leagues, refs });
    fx.forEach(f => { S.fxById[f.id] = f; });
    S.bt = await getJSON('data/backtest.json').catch(() => null);
  } catch (err) {
    $('#app').innerHTML = `<div class="panel stack"><h2>Datan är inte byggd än</h2><p class="muted">Kör <code>python scripts/fotboll/build.py</code> eller arbetsflödet i GitHub Actions. (${esc(err.message)})</p></div>`;
    return;
  }
  $('#foot').innerHTML = `Data: football-data.co.uk · uppdaterad ${longDateTime(S.meta.updated)} · ${S.meta.nMatches.toLocaleString('sv-SE')} matcher i analysen.
    Statistik och sannolikheter, inga garantier. Spela med pengar du har råd att förlora, 18 år. Stöd: <a href="https://www.stodlinjen.se" target="_blank" rel="noopener">stodlinjen.se</a>, 020-81 91 00.`;
  route();
}
init();
