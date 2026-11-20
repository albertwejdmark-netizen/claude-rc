"""Kompletterande data från ESPN:s öppna API (site.api.espn.com).

ESPN används till det som football-data.co.uk saknar:
  * Europacuperna (Champions League, Europa League, Conference League) och de stora
    nationella cuperna: resultat, hörnor, kort, skott, fouls, bollinnehav och spelschema.
  * Eerste Divisie (Nederländernas andradivision).
  * Hörnor, kort, skott, fouls och halvtidsresultat för Allsvenskan, Eliteserien,
    Superligaen, österrikiska Bundesliga och ryska Premier League, plus bollinnehav
    för huvudligorna.
  * Kommande matcher längre fram än football-data, med odds från DraftKings.

Lagen paras ihop med football-data-namnen genom att jämföra matcher samma dag med samma
resultat (och liknande namn). Det kräver inga handskrivna namnlistor.
"""

import json
import re
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from zoneinfo import ZoneInfo

API = "https://site.api.espn.com/apis/site/v2/sports/soccer"
UK = ZoneInfo("Europe/London")

# football-data-kod -> ESPN-liga
FD_TO_ESPN = {
    "E0": "eng.1", "E1": "eng.2", "E2": "eng.3", "E3": "eng.4", "EC": "eng.5",
    "SC0": "sco.1", "SC1": "sco.2", "SC2": "sco.3", "SC3": "sco.4",
    "D1": "ger.1", "D2": "ger.2", "I1": "ita.1", "I2": "ita.2", "SP1": "esp.1", "SP2": "esp.2",
    "F1": "fra.1", "F2": "fra.2", "N1": "ned.1", "B1": "bel.1", "P1": "por.1", "T1": "tur.1", "G1": "gre.1",
    "SWE": "swe.1", "NOR": "nor.1", "DNK": "den.1", "AUT": "aut.1", "RUS": "rus.1",
}
CALENDAR_SEASON = {"SWE", "NOR"}  # spelar vår–höst

# Tävlingar som bara finns hos ESPN: kod -> (ESPN-liga, land, namn, typ, nivå)
COMPS = {
    "CL": ("uefa.champions", "Europa", "Champions League", "cup", 0),
    "EL": ("uefa.europa", "Europa", "Europa League", "cup", 0),
    "ECL": ("uefa.europa.conf", "Europa", "Conference League", "cup", 0),
    "N2": ("ned.2", "Nederländerna", "Eerste Divisie", "main", 2),
    "FAC": ("eng.fa", "England", "FA-cupen", "cup", 1),
    "EFL": ("eng.league_cup", "England", "Ligacupen", "cup", 1),
    "CDR": ("esp.copa_del_rey", "Spanien", "Copa del Rey", "cup", 1),
    "DFB": ("ger.dfb_pokal", "Tyskland", "DFB-Pokal", "cup", 1),
    "CI": ("ita.coppa_italia", "Italien", "Coppa Italia", "cup", 1),
    "CDF": ("fra.coupe_de_france", "Frankrike", "Coupe de France", "cup", 1),
}


# ---------------------------------------------------------------- hämtning

def _get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (fotbollsanalys)", "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                print(f"  ESPN: {url.split('soccer/')[-1]}: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))
    return None


def months_between(a: date, b: date):
    y, m = a.year, a.month
    while (y, m) <= (b.year, b.month):
        yield f"{y}{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def fetch_month(slug, ym, cache: Path, offline: bool, today: date):
    """Matcher för en liga och en månad (tolkade). Avslutade månader sparas och återanvänds."""
    f = cache / f"{slug}_{ym}.json"
    y, m = int(ym[:4]), int(ym[4:])
    month_end = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    finished = month_end < today - timedelta(days=4)
    if f.exists() and (offline or finished):
        return json.loads(f.read_text(encoding="utf-8"))
    if offline:
        return []
    d = _get(f"{API}/{slug}/scoreboard?dates={ym}&limit=400")
    if d is None:
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []
    evs = [x for x in (parse_event(e, slug) for e in d.get("events", [])) if x]
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(evs, ensure_ascii=False), encoding="utf-8")
    return evs


def _minute(disp):
    m = re.match(r"\s*(\d+)", disp or "")
    return int(m.group(1)) if m else None


def parse_event(e, slug):
    try:
        c = e["competitions"][0]
        st = c["status"]["type"]
        side = {x["homeAway"]: x for x in c["competitors"]}
        h, a = side["home"], side["away"]
    except (KeyError, IndexError):
        return None

    def team(x):
        t = x["team"]
        name = (t.get("displayName") or t.get("name") or "").strip()
        return {"id": str(t["id"]), "name": name, "short": (t.get("shortDisplayName") or name).strip()}

    ev = {"eid": str(e["id"]), "slug": slug, "ko": e["date"], "done": bool(st.get("completed")), "state": st.get("name"),
          "neutral": bool(c.get("neutralSite")), "h": team(h), "a": team(a)}
    if not ev["done"]:
        return ev
    if ev["state"] not in ("STATUS_FULL_TIME", "STATUS_FINAL", "STATUS_FINAL_AET", "STATUS_FINAL_PEN", "STATUS_END_OF_EXTRATIME"):
        return None  # inställd, avbruten o.s.v.

    def stats(x):
        s = {i["name"]: i.get("displayValue") for i in x.get("statistics", [])}

        def n(k):
            try:
                return float(s[k])
            except (KeyError, TypeError, ValueError):
                return None
        return {"c": n("wonCorners"), "s": n("totalShots"), "st": n("shotsOnTarget"), "f": n("foulsCommitted"), "pos": n("possessionPct")}

    hs, as_ = stats(h), stats(a)
    if not ((hs["s"] or 0) + (as_["s"] or 0)):  # ESPN skriver 0 överallt när statistiken inte förts
        hs = as_ = {"c": None, "s": None, "st": None, "f": None, "pos": None}
    hid, aid = ev["h"]["id"], ev["a"]["id"]
    y = {hid: 0, aid: 0}
    rd = {hid: 0, aid: 0}
    goals = []
    for d in c.get("details", []):
        tid = str(d.get("team", {}).get("id", ""))
        if d.get("shootout"):
            continue
        if d.get("yellowCard") and tid in y:
            y[tid] += 1
        if d.get("redCard") and tid in rd:
            rd[tid] += 1
        if d.get("scoringPlay") and tid in y:
            goals.append((tid, _minute(d.get("clock", {}).get("displayValue")), bool(d.get("ownGoal"))))
    try:
        ft = (int(h.get("score")), int(a.get("score")))
    except (TypeError, ValueError):
        return None

    def count(flip_own, upto):
        g = {hid: 0, aid: 0}
        for tid, mnt, own in goals:
            if mnt is None or mnt > upto:
                continue
            if own and flip_own:
                tid = aid if tid == hid else hid
            g[tid] += 1
        return g[hid], g[aid]

    # räkna fram ordinarie tid och halvtid från målen; kontrollera mot slutresultatet
    ht = reg = None
    for flip in (False, True):
        full = count(flip, 999)
        if full == ft:
            ht, reg = count(flip, 45), count(flip, 90)
            break
    aet = ev["state"] in ("STATUS_FINAL_AET", "STATUS_FINAL_PEN", "STATUS_END_OF_EXTRATIME")
    if aet:
        if reg is None:
            return None  # vet inte resultatet efter 90 minuter
        ft = reg
    ev.update({
        "hg": ft[0], "ag": ft[1], "ht": list(ht) if ht else None, "aet": aet,
        "hc": hs["c"], "ac": as_["c"], "hs": hs["s"], "as": as_["s"], "hst": hs["st"], "ast": as_["st"],
        "hf": hs["f"], "af": as_["f"], "hpos": hs["pos"], "apos": as_["pos"],
        "hy": y[hid], "ay": y[aid], "hr": rd[hid], "ar": rd[aid],
    })
    if not c.get("details"):  # utan händelselista vet vi inte kort eller halvtid
        ev.update({"hy": None, "ay": None, "hr": None, "ar": None, "ht": None})
    return ev


def american_to_decimal(x):
    try:
        x = float(str(x).replace("+", ""))
    except (TypeError, ValueError):
        return None
    if x == 0:
        return None
    return round(1 + (x / 100 if x > 0 else 100 / -x), 3)


def fetch_odds(slug, eid):
    """Odds från ESPN:s matchsida (DraftKings): 1X2 och över/under för spelbolagets mållinje."""
    d = _get(f"{API}/{slug}/summary?event={eid}")
    if not d:
        return None
    for p in d.get("pickcenter") or []:
        h = american_to_decimal((p.get("homeTeamOdds") or {}).get("moneyLine"))
        a = american_to_decimal((p.get("awayTeamOdds") or {}).get("moneyLine"))
        dr = american_to_decimal((p.get("drawOdds") or {}).get("moneyLine"))
        if not (h and a and dr):
            continue
        out = {"1x2": [h, dr, a], "provider": (p.get("provider") or {}).get("name", "ESPN")}
        line, ov, un = p.get("overUnder"), american_to_decimal(p.get("overOdds")), american_to_decimal(p.get("underOdds"))
        if line is not None and ov and un and float(line) % 1 == 0.5:
            out["ou"] = [float(line), ov, un]
        return out
    return None


def load(cache: Path, today: date, offline=False):
    """Hämtar alla ESPN-månader som behövs. Returnerar {kod: [händelser]}."""
    jobs = []
    season_start = date(today.year if today.month >= 7 else today.year - 1, 7, 1)
    prev_start = date(season_start.year - 1, 7, 1)
    next_month = (today.replace(day=1) + timedelta(days=32)).replace(day=1)
    for code, slug in FD_TO_ESPN.items():
        if code in ("SWE", "NOR"):
            start = date(today.year - 1, 1, 1)
        elif code in ("DNK", "AUT", "RUS"):
            start = prev_start
        else:
            start = season_start  # huvudligorna: innevarande säsong (namnparning, bollinnehav, schema)
        jobs += [(code, slug, ym) for ym in months_between(start, next_month)]
    for code, (slug, *_rest) in COMPS.items():
        jobs += [(code, slug, ym) for ym in months_between(prev_start, next_month)]
    cache = cache / "espn"
    with ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(lambda j: (j[0], fetch_month(j[1], j[2], cache, offline, today)), jobs))
    out = defaultdict(dict)
    for code, evs in res:
        for e in evs:
            out[code][e["eid"]] = e  # samma match kan komma med i två månader
    return {k: sorted(v.values(), key=lambda e: e["ko"]) for k, v in out.items()}


# ---------------------------------------------------------------- namnparning

_STOP = {"fc", "afc", "cf", "sc", "ac", "as", "ss", "sv", "fk", "bk", "if", "ik", "sk", "cd", "ud", "rc", "club", "de", "the", "1", "calcio", "sad"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return " ".join(w for w in s.split() if w not in _STOP)


def name_sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = SequenceMatcher(None, a, b).ratio()
    ta, tb = set(a.split()), set(b.split())
    if ta & tb:
        r = max(r, 0.6 + 0.4 * len(ta & tb) / max(len(ta), len(tb)))
    # förkortningar som "man city" ~ "manchester city"
    if all(any(x.startswith(y[:3]) or y.startswith(x[:3]) for y in tb) for x in ta):
        r = max(r, 0.75)
    return r


def uk_date(ko):
    return datetime.strptime(ko, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).astimezone(UK).date()


def map_teams(fd_matches, espn_events):
    """{ESPN-lag-id: football-data-lag-id} för en liga, från matcher samma dag med samma resultat."""
    by_key = defaultdict(list)
    for m in fd_matches:
        by_key[(m["date"], m["hg"], m["ag"])].append(m)
    votes = defaultdict(lambda: defaultdict(float))
    for e in espn_events:
        if not e.get("done") or e.get("aet"):
            continue
        d = uk_date(e["ko"])
        cands = []
        for dd in (d, d - timedelta(days=1), d + timedelta(days=1)):
            cands += by_key.get((dd, e["hg"], e["ag"]), [])
        if not cands:
            continue
        scored = sorted(((name_sim(e["h"]["name"], m["home"]) + name_sim(e["h"]["short"], m["home"])
                          + name_sim(e["a"]["name"], m["away"]) + name_sim(e["a"]["short"], m["away"]), m) for m in cands),
                        key=lambda t: -t[0])
        best_s, best = scored[0]
        w = 1.0 if len(scored) == 1 else (0.5 + 0.5 * (best_s - scored[1][0]) / 4)
        votes[e["h"]["id"]][best["hid"]] += w * (0.5 + best_s / 4)
        votes[e["a"]["id"]][best["aid"]] += w * (0.5 + best_s / 4)
    pairs = sorted(((v, eid, fid) for eid, d in votes.items() for fid, v in d.items()), reverse=True)
    out, used = {}, set()
    for v, eid, fid in pairs:
        if eid in out or fid in used or v < 1.5:
            continue
        out[eid] = fid
        used.add(fid)
    return out


# ---------------------------------------------------------------- ihopslagning med football-data

STAT_KEYS = ("hc", "ac", "hs", "as", "hst", "ast", "hf", "af", "hy", "ay", "hr", "ar")


def season_key(lg_kind, code, d: date):
    """Säsongsnyckel i samma format som football-data använder för ligan."""
    if code in CALENDAR_SEASON:
        return str(d.year)
    start = d.year if d.month >= 7 else d.year - 1
    if lg_kind == "extra":
        return f"{start}/{start + 1}"
    return f"{start % 100:02d}{(start + 1) % 100:02d}"


def integrate(matches, fixtures, info, ev, today: date, team_id, match_id, horizon_days=8, offline=False):
    """Slår ihop ESPN-data med football-data. Ändrar listorna på plats och returnerar
    (matches, fixtures, info)."""
    names = {}
    for m in matches + fixtures:
        names[m["hid"]], names[m["aid"]] = m["home"], m["away"]
    by_lg = defaultdict(list)
    for m in matches:
        by_lg[m["lg"]].append(m)
    global_map = {}
    now = datetime.now(timezone.utc)
    horizon = (now + timedelta(days=horizon_days)).strftime("%Y-%m-%dT%H:%MZ")
    past = (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%MZ")
    new_fx = []
    added = defaultdict(int)
    merged = defaultdict(int)

    def to_match(e, lg, hid, aid, hname, aname, season):
        d = uk_date(e["ko"])
        ht = e.get("ht") or [None, None]
        return {
            "id": match_id(lg, d, hname, aname), "lg": lg, "season": season, "date": d, "ko": e["ko"],
            "home": hname, "away": aname, "hid": hid, "aid": aid, "hg": e["hg"], "ag": e["ag"],
            "hthg": ht[0], "htag": ht[1], "ref": None,
            **{k: e.get(k) for k in STAT_KEYS}, "hpos": e.get("hpos"), "apos": e.get("apos"),
            "hxg": None, "axg": None, "neutral": e.get("neutral", False),
            "odds": {}, "odds_c": {}, "odds_kind": None, "src": "espn",
        }

    def to_fixture(e, lg, hid, aid, hname, aname):
        d = uk_date(e["ko"])
        return {"id": match_id(lg, d, hname, aname), "lg": lg, "date": d, "ko": e["ko"], "home": hname, "away": aname,
                "hid": hid, "aid": aid, "ref": None, "odds": {}, "neutral": e.get("neutral", False),
                "eid": e["eid"], "slug": e["slug"]}

    # 1) ligor som football-data har: para lag, fyll på statistik, lägg till matcher som saknas
    for lg, slug_ in FD_TO_ESPN.items():
        if lg not in info or lg not in ev:
            continue
        evs = ev[lg]
        fd = by_lg[lg]
        mp = map_teams(fd, evs)
        # lag som inte gick att para via resultat: para på namn mot ligans lag
        fd_names = {m["hid"]: m["home"] for m in fd} | {m["aid"]: m["away"] for m in fd}
        used = set(mp.values())
        for e in evs:
            for t in (e["h"], e["a"]):
                if t["id"] in mp:
                    continue
                best = max(((max(name_sim(t["name"], n), name_sim(t["short"], n)), fid) for fid, n in fd_names.items() if fid not in used), default=(0, None))
                if best[0] >= 0.8:
                    mp[t["id"]] = best[1]
                    used.add(best[1])
        global_map.update(mp)
        country = info[lg]["country"]
        idx = defaultdict(list)
        for m in fd:
            idx[(m["hid"], m["aid"])].append(m)
        fx_idx = {(f["hid"], f["aid"]) for f in fixtures if f["lg"] == lg}
        seasons = set(info[lg]["seasons"])
        for e in evs:
            h = mp.get(e["h"]["id"])
            a = mp.get(e["a"]["id"])
            hn = names.get(h) if h else e["h"]["short"]
            an = names.get(a) if a else e["a"]["short"]
            h = h or team_id(country, hn)
            a = a or team_id(country, an)
            d = uk_date(e["ko"])
            if e["done"]:
                hit = [m for m in idx.get((h, a), []) if abs((m["date"] - d).days) <= 1]
                if hit:
                    m = hit[0]
                    for k in STAT_KEYS:
                        if m.get(k) is None and e.get(k) is not None:
                            m[k] = e[k]
                    if m.get("hthg") is None and e.get("ht"):
                        m["hthg"], m["htag"] = e["ht"]
                    m["hpos"], m["apos"] = e.get("hpos"), e.get("apos")
                    merged[lg] += 1
                elif e["h"]["id"] in mp and e["a"]["id"] in mp:
                    season = season_key(info[lg]["kind"], lg, d)
                    if season in seasons:
                        m = to_match(e, lg, h, a, hn, an, season)
                        matches.append(m)
                        idx[(h, a)].append(m)
                        added[lg] += 1
            elif past <= e["ko"] <= horizon and (h, a) not in fx_idx:
                new_fx.append(to_fixture(e, lg, h, a, hn, an))
        if any(m.get("hc") is not None for m in by_lg[lg]) or merged[lg]:
            info[lg]["hasStats"] = True

    # lag i cuperna som inte parats via en liga: para på namn mot alla lag hos football-data
    fd_all = {}
    for m in matches:
        if m.get("src") != "espn":
            fd_all[m["hid"]], fd_all[m["aid"]] = m["home"], m["away"]
    taken = set(global_map.values())
    cup_teams = {}
    for code in COMPS:
        for e in ev.get(code, []):
            for t in (e["h"], e["a"]):
                if t["id"] not in global_map:
                    cup_teams[t["id"]] = t
    for tid, t in cup_teams.items():
        scored = sorted(((max(name_sim(t["name"], n), name_sim(t["short"], n)), fid) for fid, n in fd_all.items() if fid not in taken), reverse=True)
        if scored and scored[0][0] >= 0.85 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.1):
            global_map[tid] = scored[0][1]
            taken.add(scored[0][1])

    # 2) tävlingar som bara ESPN har
    for code, (slug_, country, name, kind, tier) in COMPS.items():
        evs = ev.get(code, [])
        if not evs:
            continue
        done = [e for e in evs if e["done"]]
        seasons = sorted({season_key("main", code, uk_date(e["ko"])) for e in done}, reverse=True)
        if not seasons:
            continue
        info[code] = {
            "code": code, "country": country, "name": name, "tier": tier, "kind": kind,
            "season": f"20{seasons[0][:2]}/{seasons[0][2:]}", "seasonKey": seasons[0], "seasons": seasons[:2],
            "hasStats": True, "hasXg": False, "hasRef": False, "source": "espn",
        }
        for e in evs:
            ids = []
            for t in (e["h"], e["a"]):
                tid = global_map.get(t["id"])
                if tid:
                    ids.append((tid, names.get(tid, t["short"])))
                else:
                    tid = team_id(country, t["name"])
                    global_map[t["id"]] = tid
                    names[tid] = t["name"]
                    ids.append((tid, t["name"]))
            (h, hn), (a, an) = ids
            if e["done"]:
                season = season_key("main", code, uk_date(e["ko"]))
                if season in info[code]["seasons"]:
                    matches.append(to_match(e, code, h, a, hn, an, season))
                    added[code] += 1
            elif past <= e["ko"] <= horizon:
                new_fx.append(to_fixture(e, code, h, a, hn, an))

    # 3) odds för ESPN-matcherna (DraftKings via ESPN)
    def odds_job(f):
        if offline:
            return None
        return fetch_odds(f["slug"], f["eid"])
    with ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(odds_job, new_fx))
    for f, o in zip(new_fx, res):
        if not o:
            continue
        f["oddsProvider"] = o["provider"]
        f["odds"]["1x2"] = {"avg": o["1x2"], "max": o["1x2"], "b365": o["1x2"]}
        if "ou" in o:
            line, ov, un = o["ou"]
            if line == 2.5:
                f["odds"]["ou25"] = {"avg": [ov, un], "max": [ov, un], "b365": [ov, un]}
            else:
                f["odds"]["ou_other"] = {"line": line, "odds": [ov, un]}
    fixtures += new_fx
    print(f"  ESPN: statistik ihopslagen för {sum(merged.values())} matcher, {sum(added.values())} matcher tillagda, "
          f"{len(new_fx)} kommande matcher ({sum(1 for f in new_fx if f['odds'])} med odds)")
    return matches, fixtures, info
