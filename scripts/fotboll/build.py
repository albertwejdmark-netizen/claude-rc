"""Bygger all data till fotbollssidan (site/fotboll/data/).

    pip install numpy
    python scripts/fotboll/build.py            # hämtar data och bygger
    python scripts/fotboll/build.py --offline  # använder cachen i .cache/fotboll
    python scripts/fotboll/build.py --tune     # jämför modellinställningar i backtestet

Steg:
  1. Hämtar resultat, statistik, domare och odds (data.py).
  2. Backtest: modellen skattas om varje vecka på matcherna före och tippar veckans
     matcher (ingen framåtblick). Vikten mellan modell och marknad väljs på säsongen
     innan den nuvarande och kontrolleras på den nuvarande.
  3. Skattar modellen på all data och räknar sannolikheter för kommande matcher.
  4. Statistik per lag, liga och domare.
"""

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402
import espn as X  # noqa: E402
import model as M  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "fotboll" / "data"
CACHE = ROOT / ".cache" / "fotboll"
SE = ZoneInfo("Europe/Stockholm")

ALPHAS = [round(a * 0.1, 1) for a in range(11)]
CORNER_LINES = (7.5, 8.5, 9.5, 10.5, 11.5)
CARD_LINES = (2.5, 3.5, 4.5, 5.5)


def r(x, n=3):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), n)


# ---------------------------------------------------------------- hjälp för säsonger och startgissningar

def league_seasons(info):
    """Säsongsnycklar per liga, nyast först."""
    return {lg: i["seasons"] for lg, i in info.items()}


def make_priors(matches, info):
    """Startgissning (anfall, log-skala) per (liga, säsong, lag):
    0 om laget spelade i ligan säsongen innan, +0,20 om det kom från en högre division,
    annars -0,15 (uppflyttat eller okänt)."""
    played = defaultdict(set)  # (lag, säsong) -> {liga}
    for m in matches:
        played[(m["hid"], m["season"])].add(m["lg"])
        played[(m["aid"], m["season"])].add(m["lg"])
    seasons = league_seasons(info)

    def prior(lg, season, team):
        ss = seasons[lg]
        if season not in ss or ss.index(season) + 1 >= len(ss):
            return 0.0
        prev = ss[ss.index(season) + 1]
        prev_lgs = played.get((team, prev), set())
        if lg in prev_lgs:
            return 0.0
        tier = info[lg]["tier"]
        if any(info[p]["kind"] != "cup" and info[p]["tier"] < tier and info[p]["country"] == info[lg]["country"]
               for p in prev_lgs if p in info):
            return 0.20
        return -0.15

    return prior


SOT_PROXY = True


def rows_for_fit(ms):
    """Rader till modellen. Saknas xG men skott på mål finns används skott på mål × ligans
    målkvot per skott på mål som ersättning för xG."""
    conv = None
    if SOT_PROXY:
        g = sum(m["hg"] + m["ag"] for m in ms if m.get("hst") is not None and m.get("ast") is not None)
        st = sum(m["hst"] + m["ast"] for m in ms if m.get("hst") is not None and m.get("ast") is not None)
        conv = g / st if st else None
    out = []
    for m in ms:
        hx, ax = m.get("hxg"), m.get("axg")
        if (hx is None or ax is None) and conv and m.get("hst") is not None and m.get("ast") is not None:
            hx, ax = m["hst"] * conv, m["ast"] * conv
        out.append((m["date"].toordinal(), m["hid"], m["aid"], m["hg"], m["ag"], hx, ax, 0.0 if m.get("neutral") else 1.0))
    return out


def prior_map(prior_fn, lg, season, teams):
    return {t: prior_fn(lg, season, t) for t in teams}


# ---------------------------------------------------------------- backtest

def backtest(by_lg, info, prior_fn, params=None):
    params = params or {}
    recs = []
    for lg, ms in by_lg.items():
        if info[lg]["kind"] == "cup":
            continue  # cuperna saknar historiska odds och tippas med den gemensamma modellen
        test_seasons = info[lg]["seasons"][:2]
        test = [m for m in ms if m["season"] in test_seasons]
        if not test:
            continue
        start = test[0]["date"]
        start = start - timedelta(days=start.weekday())  # måndag
        prev_fit = None
        i = 0
        while i < len(test):
            wk_end = start + timedelta(days=7)
            week = []
            while i < len(test) and test[i]["date"] < wk_end:
                week.append(test[i])
                i += 1
            if week:
                train = [m for m in ms if start - timedelta(days=730) <= m["date"] < start]
                teams = {m["hid"] for m in train + week} | {m["aid"] for m in train + week}
                season = week[0]["season"]
                prior = prior_map(prior_fn, lg, season, teams)
                f = M.fit(rows_for_fit(train), start.toordinal(), prior, init=prev_fit,
                          iters=30 if prev_fit else 80, **params)
                if f is not None:
                    prev_fit = f
                    for m in week:
                        lh, la = f.lambdas(m["hid"], m["aid"], prior)
                        recs.append({"m": m, "lam": (lh, la)})
            start = wk_end
    return recs


def market_probs(m):
    """(1X2 utan marginal, chans till över mållinjen, mållinjen)."""
    o = m["odds"]
    p1x2 = M.devig(o["1x2"]["avg"]) if "1x2" in o and "avg" in o["1x2"] else None
    if "ou25" in o and "avg" in o["ou25"]:
        return p1x2, M.devig(o["ou25"]["avg"])[0], 2.5
    if "ou_other" in o:
        return p1x2, M.devig(o["ou_other"]["odds"])[0], o["ou_other"]["line"]
    return p1x2, None, 2.5


def add_market_lambdas(items, get_match):
    """Lägger till marknadens förväntade mål ('mk') för poster med 1X2-odds."""
    idx, P1, PO, LN = [], [], [], []
    for k, it in enumerate(items):
        p1x2, pov, line = market_probs(get_match(it))
        if p1x2:
            idx.append(k)
            P1.append(p1x2)
            PO.append(np.nan if pov is None else pov)
            LN.append(line)
    if idx:
        lh, la = M.market_lambdas(np.array(P1), np.array(PO), np.array(LN))
        for j, k in enumerate(idx):
            items[k]["mk"] = (float(lh[j]), float(la[j]))
    for it in items:
        it.setdefault("mk", None)


def outcome(m):
    return 0 if m["hg"] > m["ag"] else (1 if m["hg"] == m["ag"] else 2)


def logloss_report(recs, alpha):
    """Log-loss för 1X2 och Ö/U 2,5 för modell, marknad och kombination."""
    out = {}
    sel = [x for x in recs if x["mk"]]
    if not sel:
        return out
    lm = np.array([x["lam"] for x in sel])
    lk = np.array([x["mk"] for x in sel])
    lf = np.exp(alpha * np.log(lm) + (1 - alpha) * np.log(lk))
    y = np.array([outcome(x["m"]) for x in sel])
    over = np.array([1.0 if x["m"]["hg"] + x["m"]["ag"] > 2.5 else 0.0 for x in sel])
    pov_mk = np.array([market_probs(x["m"])[1] if market_probs(x["m"])[1] is not None else np.nan for x in sel])
    p_mk = np.array([market_probs(x["m"])[0] for x in sel])
    for name, lam in (("modell", lm), ("kombination", lf)):
        h, d, a, o = M.basic(lam[:, 0], lam[:, 1])
        P = np.stack([h, d, a], 1)
        out[name] = {
            "ll1x2": float(-np.log(np.clip(P[np.arange(len(y)), y], 1e-9, 1)).mean()),
            "acc1x2": float((P.argmax(1) == y).mean()),
            "llou": float(-np.nanmean(np.where(np.isnan(pov_mk), np.nan, over * np.log(o) + (1 - over) * np.log(1 - o)))),
        }
    out["marknad"] = {
        "ll1x2": float(-np.log(np.clip(p_mk[np.arange(len(y)), y], 1e-9, 1)).mean()),
        "acc1x2": float((p_mk.argmax(1) == y).mean()),
        "llou": float(-np.nanmean(over * np.log(pov_mk) + (1 - over) * np.log(1 - pov_mk))),
    }
    out["n"] = len(sel)
    return out


def choose_alpha(recs):
    sel = [x for x in recs if x["mk"]]
    lm = np.array([x["lam"] for x in sel])
    lk = np.array([x["mk"] for x in sel])
    y = np.array([outcome(x["m"]) for x in sel])
    over = np.array([1.0 if x["m"]["hg"] + x["m"]["ag"] > 2.5 else 0.0 for x in sel])
    has_ou = np.array([market_probs(x["m"])[1] is not None for x in sel])
    res = []
    for a in ALPHAS:
        lf = np.exp(a * np.log(lm) + (1 - a) * np.log(lk))
        h, d, aw, o = M.basic(lf[:, 0], lf[:, 1])
        P = np.stack([h, d, aw], 1)
        ll = -np.log(np.clip(P[np.arange(len(y)), y], 1e-9, 1)).mean()
        llo = -(over * np.log(o) + (1 - over) * np.log(1 - o))[has_ou].mean() if has_ou.any() else 0
        res.append((a, float(ll), float(llo)))
    best = min(res, key=lambda t: t[1] + t[2])
    return best[0], res


def bet_candidates(m, lam):
    """(marknad, sannolikhet, avg-odds, max-odds, vann?) för 1X2 och Ö/U 2,5."""
    h, d, a, o = (float(v[0]) for v in M.basic([lam[0]], [lam[1]]))
    out = []
    oo = m["odds"]
    res = outcome(m)
    if "1x2" in oo:
        avg, mx = oo["1x2"].get("avg"), oo["1x2"].get("max")
        for k, (p, key) in enumerate(((h, "1"), (d, "X"), (a, "2"))):
            out.append((key, p, avg[k] if avg else None, mx[k] if mx else None, res == k))
    if "ou25" in oo:
        avg, mx = oo["ou25"].get("avg"), oo["ou25"].get("max")
        ov = m["hg"] + m["ag"] > 2.5
        out.append(("Ö2.5", o, avg[0] if avg else None, mx[0] if mx else None, ov))
        out.append(("U2.5", 1 - o, avg[1] if avg else None, mx[1] if mx else None, not ov))
    return out


VALUE_MAX_ODDS = 5.0  # sidan visar värdespel upp till de här oddsen som standard


def roi_table(recs, alpha, thresholds=(0.0, 0.03, 0.05, 0.10, 0.15)):
    """Resultat om man spelat alla val där vår sannolikhet × odds - 1 > tröskel,
    både för alla odds och för odds upp till VALUE_MAX_ODDS."""
    cands = []
    for x in recs:
        if not x["mk"]:
            continue
        lf = M.blend(x["lam"], x["mk"], alpha)
        for key, p, oa, om, won in bet_candidates(x["m"], lf):
            cands.append((x["m"], key, p, oa, om, won))
    rows = []
    combos = [(s, g, c, t) for s in ("avg", "max") for g in ("1X2", "Ö/U 2,5", "Alla")
              for c in (None, VALUE_MAX_ODDS) for t in thresholds]
    for src, grp, cap, t in combos:
        n = wins = 0
        profit = odds_sum = 0.0
        for m, key, p, oa, om, won in cands:
            o = oa if src == "avg" else om
            if not o or (cap and o > cap):
                continue
            if grp == "1X2" and key not in ("1", "X", "2"):
                continue
            if grp == "Ö/U 2,5" and key not in ("Ö2.5", "U2.5"):
                continue
            if p * o - 1 <= t:
                continue
            n += 1
            odds_sum += o
            if won:
                wins += 1
                profit += o - 1
            else:
                profit -= 1
        if n:
            rows.append({"odds": src, "grupp": grp, "maxodds": cap, "troskel": t, "n": n, "traff": r(wins / n),
                         "roi": r(profit / n), "snittodds": r(odds_sum / n, 2)})
    return rows, cands


def safe_bets(cands, levels=(0.6, 0.7, 0.8)):
    out = []
    for lv in levels:
        sel = [(p, oa, won) for m, k, p, oa, om, won in cands if p >= lv and oa]
        if not sel:
            continue
        n = len(sel)
        wins = sum(1 for _, _, w in sel if w)
        profit = sum((o - 1) if w else -1 for _, o, w in sel)
        out.append({"niva": lv, "n": n, "traff": r(wins / n), "forvantad": r(sum(p for p, _, _ in sel) / n),
                    "roi": r(profit / n), "snittodds": r(sum(o for _, o, _ in sel) / n, 2)})
    return out


def calibration(cands):
    bins = [[0, 0.0, 0] for _ in range(10)]
    for m, k, p, oa, om, won in cands:
        b = min(9, int(p * 10))
        bins[b][0] += 1
        bins[b][1] += p
        bins[b][2] += 1 if won else 0
    return [{"fran": i / 10, "n": n, "forvantad": r(s / n), "utfall": r(w / n)} for i, (n, s, w) in enumerate(bins) if n >= 30]


def league_roi(cands, info, thr=0.05):
    acc = defaultdict(lambda: [0, 0.0])
    for m, k, p, oa, om, won in cands:
        if oa and p * oa - 1 > thr:
            acc[m["lg"]][0] += 1
            acc[m["lg"]][1] += (oa - 1) if won else -1
    return [{"lg": lg, "n": n, "roi": r(pr / n)} for lg, (n, pr) in sorted(acc.items()) if n]


# ---------------------------------------------------------------- lappstrategier

SLIP_BOOKS = {"b365": "Bet365", "bw": "bwin", "max": "Bästa odds"}
VALUE_THR = 0.02  # minsta värde för ett värdespel


def _round_key(d):
    """Omgång: helg (fredag–måndag) eller vecka (tisdag–torsdag)."""
    wd = d.weekday()
    if wd in (4, 5, 6):
        return d - timedelta(days=wd - 4)
    if wd == 0:
        return d - timedelta(days=3)
    return d - timedelta(days=wd - 1)


def _slip_legs(m, book):
    """Spel för en match med ett spelbolags odds: (p, odds, vann, stängningsvärde).
    p = marknadens chans utan marginal (snittodds), som sidan använder."""
    o, oc = m["odds"], m.get("odds_c") or {}
    out = []
    res = outcome(m)
    if "avg" in o.get("1x2", {}) and book in o.get("1x2", {}):
        p, pc = M.devig(o["1x2"]["avg"]), (M.devig(oc["1x2"]["avg"]) if "avg" in oc.get("1x2", {}) else None)
        for k in range(3):
            od = o["1x2"][book][k]
            out.append((p[k], od, res == k, od * pc[k] - 1 if pc else None))
    if "avg" in o.get("ou25", {}) and book in o.get("ou25", {}):
        p, pc = M.devig(o["ou25"]["avg"]), (M.devig(oc["ou25"]["avg"]) if "avg" in oc.get("ou25", {}) else None)
        over = m["hg"] + m["ag"] > 2.5
        for k in range(2):
            od = o["ou25"][book][k]
            out.append((p[k], od, over if k == 0 else not over, od * pc[k] - 1 if pc else None))
    return out


def slip_backtest(by_lg, info):
    """Hur olika lappstrategier hade gått i huvudligorna, med odds från ETT spelbolag
    (en lapp läggs hos ett bolag). Spelen tas med oddsen före matchen; stängningsvärdet
    jämför dem med marknadens rättvisa pris vid avspark."""
    rows = []
    for lg, ms in by_lg.items():
        if info[lg]["kind"] != "main" or info[lg].get("source") == "espn":
            continue
        rows += [m for m in ms if m.get("odds_kind") == "pre" and m["season"] in info[lg]["seasons"][:2]]
    if not rows:
        return []
    cur = {info[m["lg"]]["seasons"][0] for m in rows}

    def summarize(name, desc, book, slips, legs_used):
        out = {"namn": name, "beskrivning": desc, "bolag": SLIP_BOOKS[book], "perioder": []}
        for per, sel in (("Förra säsongen", lambda s: s not in cur), ("Nuvarande säsong", lambda s: s in cur)):
            ss = [x for x in slips if sel(x[2])]
            lg_ = [x for x in legs_used if sel(x[1])]
            clv = [c for c, _ in lg_ if c is not None]
            if not ss:
                out["perioder"].append({"namn": per, "n": 0})
                continue
            out["perioder"].append({
                "namn": per, "n": len(ss), "traff": r(sum(1 for o, w, _ in ss if w) / len(ss)),
                "roi": r(sum((o - 1) if w else -1 for o, w, _ in ss) / len(ss)),
                "snittodds": r(sum(o for o, _, _ in ss) / len(ss), 2),
                "clv": r(sum(clv) / len(clv)) if clv else None,
                "slogStangning": r(sum(1 for c in clv if c > 0) / len(clv)) if clv else None,
            })
        return out

    result = []
    for book in ("b365", "bw", "max"):
        singles, legs_used = [], []
        rounds = defaultdict(list)
        for m in rows:
            for p, od, won, clv in _slip_legs(m, book):
                e = p * od - 1
                if e > VALUE_THR and od <= VALUE_MAX_ODDS:
                    singles.append((od, won, m["season"]))
                    legs_used.append((clv, m["season"]))
                    rounds[_round_key(m["date"])].append((e, m["id"], od, won, clv, m["season"]))
        result.append(summarize("Värdesinglar", f"Alla spel med minst {round(VALUE_THR * 100)} % värde och odds upp till {VALUE_MAX_ODDS:g}, ett i taget.", book, singles, legs_used))
        if book == "max":
            continue  # bästa odds finns hos olika bolag och går inte att kombinera på en lapp
        for k, name in ((2, "Värdedubbel"), (3, "Värdetrippel")):
            slips, lu = [], []
            for rk, ls in rounds.items():
                pick, used = [], set()
                for e, mid, od, won, clv, season in sorted(ls, reverse=True):
                    if mid not in used:
                        used.add(mid)
                        pick.append((od, won, clv, season))
                    if len(pick) == k:
                        break
                if len(pick) == k:
                    slips.append((math.prod(x[0] for x in pick), all(x[1] for x in pick), pick[0][3]))
                    lu += [(x[2], x[3]) for x in pick]
            result.append(summarize(name, f"De {k} spel med högst värde i varje omgång (helg eller vecka), olika matcher.", book, slips, lu))
    for k, name in ((2, "Säker dubbel"), (3, "Säker trippel")):
        rounds = defaultdict(list)
        for m in rows:
            for p, od, won, clv in _slip_legs(m, "b365"):
                if od >= 1.2:
                    rounds[_round_key(m["date"])].append((p, m["id"], od, won, clv, m["season"]))
        slips, lu = [], []
        for rk, ls in rounds.items():
            pick, used = [], set()
            for p, mid, od, won, clv, season in sorted(ls, reverse=True):
                if mid not in used:
                    used.add(mid)
                    pick.append((od, won, clv, season))
                if len(pick) == k:
                    break
            if len(pick) == k:
                slips.append((math.prod(x[0] for x in pick), all(x[1] for x in pick), pick[0][3]))
                lu += [(x[2], x[3]) for x in pick]
        result.append(summarize(name, f"De {k} spel med högst chans i varje omgång (odds minst 1,20).", "b365", slips, lu))
    return result


def run_backtest(by_lg, info, prior_fn):
    t0 = time.time()
    recs = backtest(by_lg, info, prior_fn)
    add_market_lambdas(recs, lambda x: x["m"])
    print(f"  backtest: {len(recs)} matcher på {time.time() - t0:.0f} s")
    # vikten väljs på den äldre testsäsongen och kontrolleras på den nuvarande
    older = [x for x in recs if x["m"]["season"] == info[x["m"]["lg"]]["seasons"][1 if len(info[x["m"]["lg"]]["seasons"]) > 1 else 0]]
    newer = [x for x in recs if x["m"]["season"] == info[x["m"]["lg"]]["seasons"][0]]
    alpha, grid = choose_alpha(older)
    print(f"  vald modellvikt: {alpha}")
    periods = []
    for name, part in (("Förra säsongen", older), ("Nuvarande säsong", newer)):
        roi, cands = roi_table(part, alpha)
        periods.append({
            "namn": name, "matcher": len(part),
            "fran": min(x["m"]["date"] for x in part).isoformat() if part else None,
            "till": max(x["m"]["date"] for x in part).isoformat() if part else None,
            "logloss": logloss_report(part, alpha), "roi": roi,
            "sakra": safe_bets(cands), "kalibrering": calibration(cands),
            "ligor": league_roi(cands, info),
        })
    model_only, _ = roi_table(newer, 1.0, thresholds=(0.05,))
    return {
        "alpha": alpha, "grid": [{"alpha": a, "ll1x2": r(l, 4), "llou": r(o, 4)} for a, l, o in grid],
        "perioder": periods, "endastModell": model_only,
        "lappar": slip_backtest(by_lg, info),
    }


# ---------------------------------------------------------------- hörnor och kort

def side_model(ms, ref_ord, key_h, key_a, half_life=180.0, k=6.0):
    """Faktorer för 'gjorda' och 'insläppta' (t.ex. hörnor) per lag, i förhållande till ligasnittet."""
    sel = [m for m in ms if m.get(key_h) is not None and m.get(key_a) is not None and ref_ord - m["date"].toordinal() <= 420]
    if len(sel) < 30:
        return None
    w = [math.exp(-math.log(2) / half_life * (ref_ord - m["date"].toordinal())) for m in sel]
    sw = sum(w)
    avg_h = sum(wi * m[key_h] for wi, m in zip(w, sel)) / sw
    avg_a = sum(wi * m[key_a] for wi, m in zip(w, sel)) / sw
    if avg_h <= 0 or avg_a <= 0:
        return None
    f_for, f_ag = defaultdict(lambda: [0.0, 0.0]), defaultdict(lambda: [0.0, 0.0])
    for wi, m in zip(w, sel):
        f_for[m["hid"]][0] += wi * m[key_h] / avg_h
        f_for[m["hid"]][1] += wi
        f_for[m["aid"]][0] += wi * m[key_a] / avg_a
        f_for[m["aid"]][1] += wi
        f_ag[m["aid"]][0] += wi * m[key_h] / avg_h
        f_ag[m["aid"]][1] += wi
        f_ag[m["hid"]][0] += wi * m[key_a] / avg_a
        f_ag[m["hid"]][1] += wi
    ff = {t: (s + k) / (n + k) for t, (s, n) in f_for.items()}
    fa = {t: (s + k) / (n + k) for t, (s, n) in f_ag.items()}
    # spridning: varians kring det förväntade / medel
    num = den = 0.0
    for wi, m in zip(w, sel):
        mu = avg_h * ff[m["hid"]] * fa[m["aid"]] + avg_a * ff[m["aid"]] * fa[m["hid"]]
        x = m[key_h] + m[key_a]
        num += wi * (x - mu) ** 2
        den += wi * mu
    return {"avg_h": avg_h, "avg_a": avg_a, "ff": ff, "fa": fa, "ratio": max(1.0, num / den)}


def side_model_global(ms, ref_ord, key_h, key_a, half_life=180.0, k=6.0):
    """Som side_model men över alla tävlingar: varje match jämförs med sin egen tävlings snitt,
    så lagens faktorer blir jämförbara mellan ligor. Returnerar {tävling: modell} för tävlingens egna snitt."""
    sel = [m for m in ms if m.get(key_h) is not None and m.get(key_a) is not None and ref_ord - m["date"].toordinal() <= 420]
    if len(sel) < 30:
        return {}
    w = {id(m): math.exp(-math.log(2) / half_life * (ref_ord - m["date"].toordinal())) for m in sel}
    lg_avg = {}
    for lg in {m["lg"] for m in sel}:
        lm = [m for m in sel if m["lg"] == lg]
        sw = sum(w[id(m)] for m in lm)
        ah, aa = sum(w[id(m)] * m[key_h] for m in lm) / sw, sum(w[id(m)] * m[key_a] for m in lm) / sw
        if len(lm) >= 20 and ah > 0 and aa > 0:
            lg_avg[lg] = (ah, aa)
    f_for, f_ag = defaultdict(lambda: [0.0, 0.0]), defaultdict(lambda: [0.0, 0.0])
    for m in sel:
        if m["lg"] not in lg_avg:
            continue
        ah, aa = lg_avg[m["lg"]]
        wi = w[id(m)]
        for t, v, avg, tab in ((m["hid"], m[key_h], ah, f_for), (m["aid"], m[key_a], aa, f_for),
                               (m["aid"], m[key_h], ah, f_ag), (m["hid"], m[key_a], aa, f_ag)):
            tab[t][0] += wi * v / avg
            tab[t][1] += wi
    ff = {t: (s_ + k) / (n + k) for t, (s_, n) in f_for.items()}
    fa = {t: (s_ + k) / (n + k) for t, (s_, n) in f_ag.items()}
    out = {}
    for lg, (ah, aa) in lg_avg.items():
        num = den = 0.0
        for m in sel:
            if m["lg"] != lg:
                continue
            mu = ah * ff[m["hid"]] * fa[m["aid"]] + aa * ff[m["aid"]] * fa[m["hid"]]
            num += w[id(m)] * (m[key_h] + m[key_a] - mu) ** 2
            den += w[id(m)] * mu
        out[lg] = {"avg_h": ah, "avg_a": aa, "ff": ff, "fa": fa, "ratio": max(1.0, num / den) if den else 1.2}
    return out


def expected(sm, h, a):
    if not sm:
        return None
    return (sm["avg_h"] * sm["ff"].get(h, 1) * sm["fa"].get(a, 1), sm["avg_a"] * sm["ff"].get(a, 1) * sm["fa"].get(h, 1))


def cards(m, side):
    y, rd = m.get(side + "y"), m.get(side + "r")
    return None if y is None else y + (rd or 0)


# ---------------------------------------------------------------- statistik per lag

def perspective(m, home):
    s, o = ("h", "a") if home else ("a", "h")
    odds = m["odds"].get("1x2", {}).get("avg")
    ou = m["odds"].get("ou25", {}).get("avg")
    gf, ga = (m["hg"], m["ag"]) if home else (m["ag"], m["hg"])
    return {
        "id": m["id"], "lg": m["lg"], "season": m["season"], "date": m["date"], "v": "H" if home else "B",
        "opp": m["away"] if home else m["home"], "oppId": m["aid"] if home else m["hid"],
        "gf": gf, "ga": ga,
        "htgf": m.get(f"ht{s}g"), "htga": m.get(f"ht{o}g"),
        "sf": m.get(s + "s"), "sa": m.get(o + "s"), "stf": m.get(s + "st"), "sta": m.get(o + "st"),
        "cf": m.get(s + "c"), "ca": m.get(o + "c"), "kf": cards(m, s), "ka": cards(m, o),
        "ff": m.get(s + "f"), "fa": m.get(o + "f"), "xgf": m.get(s + "xg"), "xga": m.get(o + "xg"),
        "pos": m.get(s + "pos"),
        "oW": (odds[0] if home else odds[2]) if odds else None, "oD": odds[1] if odds else None,
        "oL": (odds[2] if home else odds[0]) if odds else None,
        "oO": ou[0] if ou else None, "oU": ou[1] if ou else None,
    }


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def share(rows, cond, need=None):
    rs = [x for x in rows if need is None or all(x.get(k) is not None for k in need)]
    return sum(1 for x in rs if cond(x)) / len(rs) if rs else None


def roi(rows, odds_key, cond):
    rs = [x for x in rows if x.get(odds_key)]
    if not rs:
        return None
    return sum((x[odds_key] - 1) if cond(x) else -1 for x in rs) / len(rs)


def agg(rows):
    n = len(rows)
    if not n:
        return {"n": 0}
    w = sum(1 for x in rows if x["gf"] > x["ga"])
    d = sum(1 for x in rows if x["gf"] == x["ga"])
    tot = lambda x: x["gf"] + x["ga"]  # noqa: E731
    ct = lambda x: x["cf"] + x["ca"]  # noqa: E731
    kt = lambda x: x["kf"] + x["ka"]  # noqa: E731
    fh = lambda x: x["htgf"] + x["htga"]  # noqa: E731
    out = {
        "n": n, "w": w, "d": d, "l": n - w - d, "pts": 3 * w + d, "ppg": r((3 * w + d) / n, 2),
        "gf": r(mean([x["gf"] for x in rows]), 2), "ga": r(mean([x["ga"] for x in rows]), 2),
        "gfT": sum(x["gf"] for x in rows), "gaT": sum(x["ga"] for x in rows),
        "xgf": r(mean([x["xgf"] for x in rows]), 2), "xga": r(mean([x["xga"] for x in rows]), 2),
        "o15": r(share(rows, lambda x: tot(x) > 1.5)), "o25": r(share(rows, lambda x: tot(x) > 2.5)),
        "o35": r(share(rows, lambda x: tot(x) > 3.5)),
        "btts": r(share(rows, lambda x: x["gf"] > 0 and x["ga"] > 0)),
        "cs": r(share(rows, lambda x: x["ga"] == 0)), "fts": r(share(rows, lambda x: x["gf"] == 0)),
        "fh05": r(share(rows, lambda x: fh(x) > 0.5, ("htgf", "htga"))),
        "fh15": r(share(rows, lambda x: fh(x) > 1.5, ("htgf", "htga"))),
        "htw": r(share(rows, lambda x: x["htgf"] > x["htga"], ("htgf", "htga"))),
        "cf": r(mean([x["cf"] for x in rows]), 2), "ca": r(mean([x["ca"] for x in rows]), 2),
        "ct": r(mean([ct(x) for x in rows if x["cf"] is not None and x["ca"] is not None]), 2),
        "c85": r(share(rows, lambda x: ct(x) > 8.5, ("cf", "ca"))),
        "c95": r(share(rows, lambda x: ct(x) > 9.5, ("cf", "ca"))),
        "c105": r(share(rows, lambda x: ct(x) > 10.5, ("cf", "ca"))),
        "kf": r(mean([x["kf"] for x in rows]), 2), "ka": r(mean([x["ka"] for x in rows]), 2),
        "kt": r(mean([kt(x) for x in rows if x["kf"] is not None and x["ka"] is not None]), 2),
        "k35": r(share(rows, lambda x: kt(x) > 3.5, ("kf", "ka"))),
        "k45": r(share(rows, lambda x: kt(x) > 4.5, ("kf", "ka"))),
        "sf": r(mean([x["sf"] for x in rows]), 1), "sa": r(mean([x["sa"] for x in rows]), 1),
        "stf": r(mean([x["stf"] for x in rows]), 1), "sta": r(mean([x["sta"] for x in rows]), 1),
        "ff": r(mean([x["ff"] for x in rows]), 1), "fa": r(mean([x["fa"] for x in rows]), 1),
        "poss": r(mean([x["pos"] for x in rows]), 1),
        "roiW": r(roi(rows, "oW", lambda x: x["gf"] > x["ga"])),
        "roiD": r(roi(rows, "oD", lambda x: x["gf"] == x["ga"])),
        "roiL": r(roi(rows, "oL", lambda x: x["gf"] < x["ga"])),
        "roiO": r(roi(rows, "oO", lambda x: tot(x) > 2.5)),
        "roiU": r(roi(rows, "oU", lambda x: tot(x) < 2.5)),
    }
    return {k: v for k, v in out.items() if v is not None}


def streaks(rows):
    """Pågående sviter (senaste matchen sist i listan)."""
    tests = {
        "obesegrade": lambda x: x["gf"] >= x["ga"], "vinster": lambda x: x["gf"] > x["ga"],
        "utanVinst": lambda x: x["gf"] <= x["ga"], "forluster": lambda x: x["gf"] < x["ga"],
        "gjortMal": lambda x: x["gf"] > 0, "slapptIn": lambda x: x["ga"] > 0, "hallitNollan": lambda x: x["ga"] == 0,
        "over25": lambda x: x["gf"] + x["ga"] > 2.5, "under25": lambda x: x["gf"] + x["ga"] < 2.5,
        "btts": lambda x: x["gf"] > 0 and x["ga"] > 0, "ejBtts": lambda x: not (x["gf"] > 0 and x["ga"] > 0),
    }
    out = {}
    for k, f in tests.items():
        n = 0
        for x in reversed(rows):
            if f(x):
                n += 1
            else:
                break
        if n >= 2:
            out[k] = n
    return out


def res_letter(x):
    return "V" if x["gf"] > x["ga"] else ("O" if x["gf"] == x["ga"] else "F")


# ---------------------------------------------------------------- huvudprogram

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="använd sparade filer i .cache/fotboll")
    ap.add_argument("--no-backtest", action="store_true")
    ap.add_argument("--tune", action="store_true", help="jämför modellinställningar och avsluta")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    today = now.astimezone(SE).date()
    t0 = time.time()
    print("Hämtar data ...")
    matches, fixtures, info = D.load(CACHE, today, offline=args.offline)
    print(f"  football-data: {len(matches)} spelade matcher, {len(fixtures)} kommande, {len(info)} ligor ({time.time() - t0:.0f} s)")
    try:
        ev = X.load(CACHE, today, offline=args.offline)
        matches, fixtures, info = X.integrate(matches, fixtures, info, ev, today, D.team_id, D.match_id, offline=args.offline)
    except Exception as e:  # noqa: BLE001 – sidan fungerar utan ESPN, bara med mindre data
        print(f"  ESPN gick inte att använda: {e}", file=sys.stderr)
    matches.sort(key=lambda m: (m["ko"], m["lg"], m["home"]))
    fixtures.sort(key=lambda m: (m["ko"], m["lg"], m["home"]))
    print(f"  totalt {len(matches)} spelade matcher, {len(fixtures)} kommande, {len(info)} tävlingar ({time.time() - t0:.0f} s)")
    if not matches:
        sys.exit("Ingen data – avbryter")

    by_lg = defaultdict(list)
    for m in matches:
        by_lg[m["lg"]].append(m)
    info = {lg: i for lg, i in info.items() if lg in by_lg}
    prior_fn = make_priors(matches, info)

    if args.tune:
        tune(by_lg, info, prior_fn)
        return

    bt = None
    alpha = 0.3
    if not args.no_backtest:
        print("Backtest ...")
        bt = run_backtest(by_lg, info, prior_fn)
        alpha = bt["alpha"]

    print("Skattar modellen för kommande matcher ...")
    played_ids = {m["id"] for m in matches}
    cutoff = (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%MZ")
    fixtures = [f for f in fixtures if f["id"] not in played_ids and f["ko"] >= cutoff and f["lg"] in info]
    fits, priors, corner_m, card_m, fh_share = {}, {}, {}, {}, {}
    ref_ord = today.toordinal()
    # gemensam modell för alla lag i alla tävlingar: Europacuperna och cuperna knyter ihop ligorna
    recent_all = [m for m in matches if (today - m["date"]).days <= 730]
    gfit = M.fit(rows_for_fit(recent_all), ref_ord, {})
    g_corner = side_model_global(matches, ref_ord, "hc", "ac")
    g_card = side_model_global([dict(m, hk=cards(m, "h"), ak=cards(m, "a")) for m in matches], ref_ord, "hk", "ak")
    for lg, ms in by_lg.items():
        cur = info[lg]["seasonKey"]
        if info[lg]["kind"] == "cup":
            fits[lg], priors[lg] = gfit, {}
            corner_m[lg] = g_corner.get(lg)
            card_m[lg] = g_card.get(lg)
            ht = [m for m in ms if m.get("hthg") is not None and (today - m["date"]).days <= 730]
            g = sum(m["hg"] + m["ag"] for m in ht)
            fh_share[lg] = (sum(m["hthg"] + m["htag"] for m in ht) / g) if ht and g else None
            continue
        recent = [m for m in ms if (today - m["date"]).days <= 730]
        teams = {m["hid"] for m in recent} | {m["aid"] for m in recent}
        teams |= {f["hid"] for f in fixtures if f["lg"] == lg} | {f["aid"] for f in fixtures if f["lg"] == lg}
        priors[lg] = prior_map(prior_fn, lg, cur, teams)
        fits[lg] = M.fit(rows_for_fit(recent), ref_ord, priors[lg])
        corner_m[lg] = side_model(ms, ref_ord, "hc", "ac")
        card_m[lg] = side_model([dict(m, hk=cards(m, "h"), ak=cards(m, "a")) for m in ms], ref_ord, "hk", "ak")
        ht = [m for m in ms if m.get("hthg") is not None and m.get("htag") is not None and (today - m["date"]).days <= 730]
        g = sum(m["hg"] + m["ag"] for m in ht)
        fh_share[lg] = (sum(m["hthg"] + m["htag"] for m in ht) / g) if ht and g else None

    # ------------------------------------------------ domare
    ref_matches = defaultdict(list)
    for m in matches:
        if m.get("ref") and m["season"] in info[m["lg"]]["seasons"][:2]:
            ref_matches[m["ref"]].append(m)
    lg_cards = {}
    for lg, ms in by_lg.items():
        ks = [cards(m, "h") + cards(m, "a") for m in ms if cards(m, "h") is not None and m["season"] in info[lg]["seasons"][:2]]
        lg_cards[lg] = sum(ks) / len(ks) if ks else None

    def ref_factor(name):
        ms = [m for m in ref_matches.get(name, []) if cards(m, "h") is not None and lg_cards.get(m["lg"])]
        if not ms:
            return 1.0, 0
        ratio = sum((cards(m, "h") + cards(m, "a")) / lg_cards[m["lg"]] for m in ms)
        k = 10
        return (ratio + k) / (len(ms) + k), len(ms)

    # ------------------------------------------------ kommande matcher
    fx_items = [{"f": f} for f in fixtures]
    add_market_lambdas(fx_items, lambda x: x["f"])
    out_fx = []
    for it in fx_items:
        f = it["f"]
        lg = f["lg"]
        fit = fits.get(lg) or gfit
        if fit is None:
            continue
        lam_m = fit.lambdas(f["hid"], f["aid"], priors.get(lg, {}), neutral=bool(f.get("neutral")))
        lam_k = it["mk"]
        lam = M.blend(lam_m, lam_k, alpha) if lam_k else lam_m
        p, cs, mat = M.goal_markets(lam[0], lam[1], fh_share.get(lg))
        odds = {}
        o = f["odds"]
        srcs = ("avg", "max", "b365", "bw")  # samma ordning som SRC i app.js
        if "1x2" in o:
            for k, key in enumerate(("1", "X", "2")):
                odds[key] = [r(o["1x2"][s][k], 2) if s in o["1x2"] else None for s in srcs]
        if "ou25" in o:
            odds["O2.5"] = [r(o["ou25"][s][0], 2) if s in o["ou25"] else None for s in srcs]
            odds["U2.5"] = [r(o["ou25"][s][1], 2) if s in o["ou25"] else None for s in srcs]
        if "ou_other" in o and o["ou_other"]["line"] in M.LINES:
            L = o["ou_other"]["line"]
            odds[f"O{L}"] = [r(o["ou_other"]["odds"][0], 2)] * 2 + [None, None]  # snitt/bästa = enda bolaget
            odds[f"U{L}"] = [r(o["ou_other"]["odds"][1], 2)] * 2 + [None, None]
        ah = None
        if "ah" in o and "ah_line" in o:
            line = o["ah_line"]
            ah = {"line": line}
            for side, k in (("H", 0), ("A", 1)):
                od = [r(o["ah"][s][k], 2) if s in o["ah"] else None for s in srcs]
                evs = []
                pwin = None
                for x in od:
                    if x:
                        res = M.ah_ev(mat, line, x if side == "H" else None, x if side == "A" else None)[side]
                        evs.append(r(res[0] - 1))
                        pwin = res[1]
                    else:
                        evs.append(None)
                ah[side] = {"odds": od, "ev": evs, "pwin": r(pwin)}
        # hörnor och kort
        ec = expected(corner_m.get(lg), f["hid"], f["aid"])
        corners = None
        if ec:
            ratio = corner_m[lg]["ratio"]
            corners = {"h": r(ec[0], 2), "a": r(ec[1], 2)}
            for L in CORNER_LINES:
                po = M.nb_over(ec[0] + ec[1], ratio, L)
                p[f"C:O{L}"], p[f"C:U{L}"] = po, 1 - po
        ek = expected(card_m.get(lg), f["hid"], f["aid"])
        cardd = None
        if ek:
            rf, rn = ref_factor(f["ref"]) if f.get("ref") else (1.0, 0)
            kh, ka = ek[0] * rf, ek[1] * rf
            cardd = {"h": r(kh, 2), "a": r(ka, 2), "rf": r(rf, 2), "rn": rn}
            for L in CARD_LINES:
                po = M.nb_over(kh + ka, card_m[lg]["ratio"], L)
                p[f"K:O{L}"], p[f"K:U{L}"] = po, 1 - po
        out_fx.append({
            "id": f["id"], "lg": lg, "ko": f["ko"], "home": f["home"], "away": f["away"],
            "hid": f["hid"], "aid": f["aid"], "ref": f.get("ref"), "refId": D.slug(f["ref"]) if f.get("ref") else None,
            "lam": [r(lam[0]), r(lam[1])], "lamM": [r(lam_m[0]), r(lam_m[1])],
            "lamK": [r(lam_k[0]), r(lam_k[1])] if lam_k else None,
            "p": {k: r(v, 4) for k, v in p.items()}, "cs": cs, "odds": odds, "ah": ah,
            "corners": corners, "cards": cardd, "oddsProvider": f.get("oddsProvider"), "neutral": bool(f.get("neutral")),
        })
    print(f"  {len(out_fx)} kommande matcher med prognos")

    # ------------------------------------------------ lag
    per_team = defaultdict(list)
    for m in matches:
        per_team[m["hid"]].append(perspective(m, True))
        per_team[m["aid"]].append(perspective(m, False))
    names, countries = {}, {}
    for m in matches + fixtures:
        names[m["hid"]], names[m["aid"]] = m["home"], m["away"]
        if m["lg"] in info and (info[m["lg"]]["kind"] != "cup" or m["hid"] not in countries):
            countries[m["hid"]] = info[m["lg"]]["country"]
        if m["lg"] in info and (info[m["lg"]]["kind"] != "cup" or m["aid"] not in countries):
            countries[m["aid"]] = info[m["lg"]]["country"]
    next_fx = defaultdict(list)
    for f in out_fx:
        next_fx[f["hid"]].append(f["id"])
        next_fx[f["aid"]].append(f["id"])

    teams = {}
    tables = {}
    # tävlingar per lag denna säsong (liga + cuper), ligorna först
    comps = defaultdict(list)
    for t, rows in per_team.items():
        for x in sorted(rows, key=lambda x: (info[x["lg"]]["kind"] == "cup", x["date"])):
            if x["season"] == info[x["lg"]]["seasonKey"] and x["lg"] not in comps[t]:
                comps[t].append(x["lg"])
    # ligorna först så att lagets huvudsida blir ligan, cuperna lägger bara till lag som saknas
    for lg, li in sorted(info.items(), key=lambda kv: kv[1]["kind"] == "cup"):
        cup = li["kind"] == "cup"
        cur = li["seasonKey"]
        lteams = sorted({m["hid"] for m in by_lg[lg] if m["season"] == cur} | {m["aid"] for m in by_lg[lg] if m["season"] == cur})
        fit = fits.get(lg)
        ratings = {}
        for t in lteams:
            rt = fit.rating(t) if fit else None
            if rt:
                ratings[t] = rt
        order = sorted(ratings, key=lambda t: ratings[t][0] - ratings[t][1], reverse=True)
        table = []
        for t in lteams:
            rows = sorted([x for x in per_team[t] if x["lg"] == lg and x["season"] == cur], key=lambda x: x["date"])
            if not rows:
                continue
            a_all = agg(rows)
            rt = ratings.get(t)
            if cup and t in teams:
                teams[t]["next"] = next_fx.get(t, [])
            else:
                teams[t] = {
                    "id": t, "name": names[t], "country": countries.get(t), "lg": lg,
                    "all": a_all, "home": agg([x for x in rows if x["v"] == "H"]), "away": agg([x for x in rows if x["v"] == "B"]),
                    "last6": agg(rows[-6:]),
                    "form": [[x["date"].isoformat(), x["v"], x["opp"], x["oppId"], x["gf"], x["ga"], res_letter(x)] for x in rows[-6:]],
                    "streaks": streaks(rows),
                    "rating": {"att": r(rt[0], 2), "def": r(rt[1], 2), "net": r(rt[0] - rt[1], 2),
                               "rank": order.index(t) + 1, "of": len(order)} if rt else None,
                    "next": next_fx.get(t, []),
                }
            teams[t]["comps"] = comps.get(t, [lg])
            table.append({"id": t, "name": names[t], "p": a_all["n"], "w": a_all["w"], "d": a_all["d"], "l": a_all["l"],
                          "gf": a_all["gfT"], "ga": a_all["gaT"], "pts": a_all["pts"],
                          "xgf": r(sum(x["xgf"] for x in rows if x["xgf"] is not None), 1) if li["hasXg"] else None,
                          "xga": r(sum(x["xga"] for x in rows if x["xga"] is not None), 1) if li["hasXg"] else None,
                          "form": "".join(res_letter(x) for x in rows[-5:]),
                          "net": r(rt[0] - rt[1], 2) if rt else None})
        table.sort(key=lambda x: (-x["pts"], -(x["gf"] - x["ga"]), -x["gf"], x["name"]))
        if cup and li["country"] != "Europa":
            table = []  # utslagsturneringar har ingen tabell
        for i, row in enumerate(table):
            row["pos"] = i + 1
            if row["id"] in teams and teams[row["id"]]["lg"] == lg:
                teams[row["id"]]["pos"] = i + 1
                teams[row["id"]]["of"] = len(table)
        tables[lg] = table

    # ------------------------------------------------ ligor
    leagues = {}
    for lg, li in info.items():
        cur = [m for m in by_lg[lg] if m["season"] == li["seasonKey"]]
        rows = [perspective(m, True) for m in cur]
        a = agg(rows)
        last = max((m["date"] for m in by_lg[lg]), default=None)
        fit = fits.get(lg)
        leagues[lg] = dict(li, **{
            "matches": len(cur), "last": last.isoformat() if last else None,
            "stats": {
                "gpm": r(mean([x["gf"] + x["ga"] for x in rows]), 2), "hg": a.get("gf"), "ag": a.get("ga"),
                "hw": r(a["w"] / a["n"]) if a.get("n") else None, "dr": r(a["d"] / a["n"]) if a.get("n") else None,
                "aw": r(a["l"] / a["n"]) if a.get("n") else None,
                "o15": a.get("o15"), "o25": a.get("o25"), "o35": a.get("o35"), "btts": a.get("btts"),
                "ct": a.get("ct"), "kt": a.get("kt"), "fh05": a.get("fh05"), "fhShare": r(fh_share.get(lg)),
                "roiH": a.get("roiW"), "roiD": a.get("roiD"), "roiA": a.get("roiL"), "roiO": a.get("roiO"), "roiU": a.get("roiU"),
                "homeAdv": r(math.exp(fit.home), 2) if fit else None,
            },
            "table": tables.get(lg, []),
            "fixtures": sum(1 for f in out_fx if f["lg"] == lg),
        })
        leagues[lg].pop("seasons", None)

    # ------------------------------------------------ domare
    refs = {}
    upcoming_ref = defaultdict(list)
    for f in out_fx:
        if f["ref"]:
            upcoming_ref[f["ref"]].append(f["id"])
    for name, ms in ref_matches.items():
        ms = sorted(ms, key=lambda m: m["date"])
        kms = [m for m in ms if cards(m, "h") is not None]
        if len(ms) < 3:
            continue
        rf, rn = ref_factor(name)
        tot = [m["hg"] + m["ag"] for m in ms]
        kt = [cards(m, "h") + cards(m, "a") for m in kms]
        lg_count = defaultdict(int)
        for m in ms:
            lg_count[m["lg"]] += 1
        cur_ms = [m for m in kms if m["season"] == info[m["lg"]]["seasonKey"]]
        refs[D.slug(name)] = {
            "id": D.slug(name), "name": name, "n": len(ms), "nCur": len(cur_ms),
            "leagues": sorted(lg_count.items(), key=lambda t: -t[1]),
            "y": r(mean([m["hy"] + m["ay"] for m in kms]), 2), "rd": r(mean([(m["hr"] or 0) + (m["ar"] or 0) for m in kms]), 3),
            "k": r(mean(kt), 2), "kCur": r(mean([cards(m, "h") + cards(m, "a") for m in cur_ms]), 2),
            "kh": r(mean([cards(m, "h") for m in kms]), 2), "ka": r(mean([cards(m, "a") for m in kms]), 2),
            "k35": r(share(kt, lambda x: x > 3.5)), "k45": r(share(kt, lambda x: x > 4.5)), "k55": r(share(kt, lambda x: x > 5.5)),
            "f": r(mean([(m["hf"] or 0) + (m["af"] or 0) for m in kms if m.get("hf") is not None]), 1),
            "g": r(mean(tot), 2), "o25": r(share(tot, lambda x: x > 2.5)),
            "btts": r(share(ms, lambda m: m["hg"] > 0 and m["ag"] > 0)),
            "hw": r(share(ms, lambda m: m["hg"] > m["ag"])), "dr": r(share(ms, lambda m: m["hg"] == m["ag"])),
            "aw": r(share(ms, lambda m: m["hg"] < m["ag"])),
            "c": r(mean([m["hc"] + m["ac"] for m in ms if m.get("hc") is not None]), 2),
            "kf": r(rf, 2), "last": ms[-1]["date"].isoformat(),
            "upcoming": upcoming_ref.get(name, []),
            "matches": [[m["date"].isoformat(), m["lg"], m["home"], m["away"], m["hid"], m["aid"], m["hg"], m["ag"],
                         m.get("hy"), m.get("ay"), m.get("hr"), m.get("ar"), m.get("hf"), m.get("af")] for m in ms[::-1]],
        }

    # ------------------------------------------------ matchfiler per liga
    # Kompakt: lagen som index i en lista, matchens id räknas fram i webbläsaren.
    cols = ["date", "season", "h", "a", "hg", "ag", "hthg", "htag", "hs", "as", "hst", "ast",
            "hc", "ac", "hy", "ay", "hr", "ar", "hf", "af", "hxg", "axg", "ref", "oH", "oD", "oA", "oO", "oU", "hpos", "apos",
            "cH", "cD", "cA", "cO", "cU"]  # c* = stängningsodds (snitt), för att räkna stängningsvärde

    def compact(v):
        return int(v) if isinstance(v, float) and v.is_integer() else v

    def league_file(ms):
        tix, tlist = {}, []
        rows = []
        for m in sorted(ms, key=lambda m: m["ko"], reverse=True):
            for t, n in ((m["hid"], m["home"]), (m["aid"], m["away"])):
                if t not in tix:
                    tix[t] = len(tlist)
                    tlist.append([t, n])
            o1 = m["odds"].get("1x2", {}).get("avg") or [None] * 3
            ou = m["odds"].get("ou25", {}).get("avg") or [None] * 2
            c1 = (m.get("odds_c") or {}).get("1x2", {}).get("avg") or [None] * 3
            cou = (m.get("odds_c") or {}).get("ou25", {}).get("avg") or [None] * 2
            vals = {**m, "date": m["date"].isoformat(), "h": tix[m["hid"]], "a": tix[m["aid"]],
                    "oH": o1[0], "oD": o1[1], "oA": o1[2], "oO": ou[0], "oU": ou[1],
                    "cH": c1[0], "cD": c1[1], "cA": c1[2], "cO": cou[0], "cU": cou[1]}
            rows.append([compact(vals.get(c)) for c in cols])
        return {"cols": cols, "teams": tlist, "rows": rows}

    # ------------------------------------------------ skriv
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "matches").mkdir(exist_ok=True)
    for old in (OUT / "matches").glob("*.json"):
        old.unlink()

    def dump(path, obj):
        path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    for lg, ms in by_lg.items():
        dump(OUT / "matches" / f"{lg}.json", league_file(ms))
    dump(OUT / "fixtures.json", out_fx)
    dump(OUT / "teams.json", teams)
    dump(OUT / "leagues.json", leagues)
    dump(OUT / "referees.json", refs)
    if bt:
        dump(OUT / "backtest.json", bt)
    meta = {
        "updated": now.strftime("%Y-%m-%dT%H:%MZ"), "alpha": alpha, "nMatches": len(matches), "nFixtures": len(out_fx),
        "nTeams": len(teams), "nRefs": len(refs), "source": "football-data.co.uk",
        "order": ([c for c in ("CL", "EL", "ECL") if c in info]
                  + [c for c in info if info[c]["kind"] != "cup" and c not in ("CL", "EL", "ECL")]
                  + [c for c in info if info[c]["kind"] == "cup" and c not in ("CL", "EL", "ECL")]),
    }
    dump(OUT / "meta.json", meta)
    size = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"Klart på {time.time() - t0:.0f} s: {len(teams)} lag, {len(refs)} domare, {size / 1e6:.1f} MB data i {OUT.relative_to(ROOT)}")


def tune(by_lg, info, prior_fn):
    """Jämför några modellinställningar på backtestet (log-loss 1X2, bara modellen)."""
    global SOT_PROXY
    variants = [{}, {"half_life": 120.0}, {"half_life": 270.0}, {"xg_weight": 0.3}, {"xg_weight": 0.8}, {"k": 2.0}, {"k": 10.0}]
    for v in [None] + variants:  # None = utan skott på mål-skattningen
        SOT_PROXY = v is not None
        v = v or {}
        t0 = time.time()
        recs = backtest(by_lg, info, prior_fn, v)
        add_market_lambdas(recs, lambda x: x["m"])
        rep = logloss_report(recs, 1.0)
        a, grid = choose_alpha(recs)
        best = min(grid, key=lambda t: t[1] + t[2])
        print(f"{v!s:28} modell ll1x2={rep['modell']['ll1x2']:.4f} llou={rep['modell']['llou']:.4f} | "
              f"marknad {rep['marknad']['ll1x2']:.4f}/{rep['marknad']['llou']:.4f} | bästa alpha {a}: {best[1]:.4f}/{best[2]:.4f} "
              f"({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
