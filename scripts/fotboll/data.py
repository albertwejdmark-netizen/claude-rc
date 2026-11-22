"""Hämtar och tolkar matchdata från football-data.co.uk.

Huvudligorna (22 st) har resultat, halvtid, skott, hörnor, kort, fouls, domare (England
och Skottland), xG (de flesta från 2026/27) och odds före matchen (snitt, bästa, Bet365)
för 1X2, över/under 2,5 och asiatiskt handikapp. De extra ligorna (Österrike, Danmark,
Finland, Irland, Norge, Polen, Rumänien, Ryssland, Sverige, Schweiz) har resultat och
stängningsodds för 1X2.

Filerna sparas i en cachemapp så att man kan köra om bygget utan nätverk (--offline).
"""

import csv
import io
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://www.football-data.co.uk"
UK = ZoneInfo("Europe/London")  # avsparkstiderna i filerna är brittisk tid

# kod: (land, liga, nivå)
MAIN = {
    "E0": ("England", "Premier League", 1),
    "E1": ("England", "Championship", 2),
    "E2": ("England", "League One", 3),
    "E3": ("England", "League Two", 4),
    "EC": ("England", "National League", 5),
    "SC0": ("Skottland", "Premiership", 1),
    "SC1": ("Skottland", "Championship", 2),
    "SC2": ("Skottland", "League One", 3),
    "SC3": ("Skottland", "League Two", 4),
    "D1": ("Tyskland", "Bundesliga", 1),
    "D2": ("Tyskland", "2. Bundesliga", 2),
    "I1": ("Italien", "Serie A", 1),
    "I2": ("Italien", "Serie B", 2),
    "SP1": ("Spanien", "La Liga", 1),
    "SP2": ("Spanien", "Segunda División", 2),
    "F1": ("Frankrike", "Ligue 1", 1),
    "F2": ("Frankrike", "Ligue 2", 2),
    "N1": ("Nederländerna", "Eredivisie", 1),
    "B1": ("Belgien", "Pro League", 1),
    "P1": ("Portugal", "Primeira Liga", 1),
    "T1": ("Turkiet", "Süper Lig", 1),
    "G1": ("Grekland", "Super League", 1),
}

# kod: (land på svenska, liga, land som det står i filen)
EXTRA = {
    "AUT": ("Österrike", "Bundesliga", "Austria"),
    "DNK": ("Danmark", "Superliga", "Denmark"),
    "FIN": ("Finland", "Veikkausliiga", "Finland"),
    "IRL": ("Irland", "Premier Division", "Ireland"),
    "NOR": ("Norge", "Eliteserien", "Norway"),
    "POL": ("Polen", "Ekstraklasa", "Poland"),
    "ROU": ("Rumänien", "Superliga", "Romania"),
    "RUS": ("Ryssland", "Premier League", "Russia"),
    "SWE": ("Sverige", "Allsvenskan", "Sweden"),
    "SWZ": ("Schweiz", "Super League", "Switzerland"),
}
EXTRA_BY_COUNTRY = {v[2]: k for k, v in EXTRA.items()}


def season_codes(today: date, n: int = 3) -> list[str]:
    """Säsongskoder för huvudligorna, nyast först: 2627, 2526, 2425 ..."""
    start = today.year if today.month >= 7 else today.year - 1
    return [f"{(start - i) % 100:02d}{(start - i + 1) % 100:02d}" for i in range(n)]


def season_label(code: str) -> str:
    return f"20{code[:2]}/{code[2:]}"


# ---------------------------------------------------------------- hämtning

def download(url: str, dest: Path, offline: bool) -> str | None:
    if offline:
        return dest.read_text(encoding="utf-8-sig", errors="replace") if dest.exists() else None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (fotbollsanalys)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            text = raw.decode("utf-8-sig", errors="replace")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")
            return text
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print(f"  kunde inte hämta {url}: {e}", file=sys.stderr)
                if dest.exists():
                    print("  använder sparad kopia", file=sys.stderr)
                    return dest.read_text(encoding="utf-8-sig", errors="replace")
                return None
            time.sleep(2 * (attempt + 1))
    return None


def fetch_all(cache: Path, today: date, offline: bool = False) -> dict:
    """Hämtar alla filer. Returnerar {'main': {(kod, säsong): text}, 'extra': {kod: text}, 'fixtures': text, 'extra_fixtures': text}."""
    jobs = {}
    for s in season_codes(today):
        for code in MAIN:
            jobs[("main", (code, s))] = (f"{BASE}/mmz4281/{s}/{code}.csv", cache / f"{s}_{code}.csv")
    for code in EXTRA:
        jobs[("extra", code)] = (f"{BASE}/new/{code}.csv", cache / f"new_{code}.csv")
    jobs[("fixtures", None)] = (f"{BASE}/fixtures.csv", cache / "fixtures.csv")
    jobs[("extra_fixtures", None)] = (f"{BASE}/new_league_fixtures.csv", cache / "new_league_fixtures.csv")
    with ThreadPoolExecutor(max_workers=6) as ex:
        texts = dict(zip(jobs, ex.map(lambda j: download(j[0], j[1], offline), jobs.values())))
    out = {"main": {}, "extra": {}, "fixtures": None, "extra_fixtures": None}
    for (kind, key), text in texts.items():
        if not text:
            continue
        if key is None:
            out[kind] = text
        else:
            out[kind][key] = text
    return out


# ---------------------------------------------------------------- tolkning

def num(x):
    if x is None:
        return None
    x = x.strip()
    if not x:
        return None
    try:
        v = float(x)
    except ValueError:
        return None
    return v


def odd(x):
    v = num(x)
    return v if v and v > 1.0 else None


def parse_date(s: str) -> date | None:
    s = (s or "").strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def kickoff_utc(d: date, t: str | None) -> str:
    t = (t or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{2})", t)
    hh, mm = (int(m.group(1)), int(m.group(2))) if m else (15, 0)
    local = datetime(d.year, d.month, d.day, hh, mm, tzinfo=UK)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def slug(s: str) -> str:
    s = s.lower()
    for a, b in (("å", "a"), ("ä", "a"), ("ö", "o"), ("é", "e"), ("ü", "u"), ("ç", "c"), ("ş", "s"), ("ğ", "g"), ("ı", "i")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def team_id(country: str, name: str) -> str:
    return slug(country) + "--" + slug(name)


def match_id(lg: str, d: date, home: str, away: str) -> str:
    return f"{lg}-{d:%Y%m%d}-{slug(home)}-{slug(away)}"


def triple(row, prefix, suffixes=("H", "D", "A")):
    vals = [odd(row.get(prefix + s)) for s in suffixes]
    return vals if all(vals) else None


def odds_main(row, closing=False):
    """Odds från en rad i huvudligornas filer. Returnerar dict med 1x2/ou/ah per källa."""
    c = "C" if closing else ""
    o = {}
    for src, pre in (("avg", "Avg"), ("max", "Max"), ("b365", "B365"), ("bw", "BW"), ("bfe", "BFE")):
        x = triple(row, pre + c)
        if x:
            o.setdefault("1x2", {})[src] = x
        ov, un = odd(row.get(f"{pre}{c}>2.5")), odd(row.get(f"{pre}{c}<2.5"))
        if ov and un:
            o.setdefault("ou25", {})[src] = [ov, un]
        ah_h, ah_a = odd(row.get(f"{pre}{c}AHH")), odd(row.get(f"{pre}{c}AHA"))
        if ah_h and ah_a:
            o.setdefault("ah", {})[src] = [ah_h, ah_a]
    line = num(row.get("AHCh" if closing else "AHh"))
    if "ah" in o and line is not None:
        o["ah_line"] = line
    else:
        o.pop("ah", None)
    return o


def parse_main(code: str, season: str, text: str) -> list[dict]:
    country, _, _ = MAIN[code]
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        home, away = (row.get("HomeTeam") or "").strip(), (row.get("AwayTeam") or "").strip()
        d = parse_date(row.get("Date"))
        hg, ag = num(row.get("FTHG")), num(row.get("FTAG"))
        if not home or not away or not d or hg is None or ag is None:
            continue
        m = {
            "id": match_id(code, d, home, away), "lg": code, "season": season, "date": d,
            "ko": kickoff_utc(d, row.get("Time")), "home": home, "away": away,
            "hid": team_id(country, home), "aid": team_id(country, away),
            "hg": int(hg), "ag": int(ag),
            "hthg": num(row.get("HTHG")), "htag": num(row.get("HTAG")),
            "ref": (row.get("Referee") or "").strip() or None,
            "hs": num(row.get("HS")), "as": num(row.get("AS")),
            "hst": num(row.get("HST")), "ast": num(row.get("AST")),
            "hf": num(row.get("HF")), "af": num(row.get("AF")),
            "hc": num(row.get("HC")), "ac": num(row.get("AC")),
            "hy": num(row.get("HY")), "ay": num(row.get("AY")),
            "hr": num(row.get("HR")), "ar": num(row.get("AR")),
            "hxg": num(row.get("HxG")), "axg": num(row.get("AxG")),
            "odds": odds_main(row), "odds_c": odds_main(row, closing=True), "odds_kind": "pre",
        }
        out.append(m)
    return out


def parse_extra(code: str, text: str, since: date) -> list[dict]:
    country, _, _ = EXTRA[code]
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        home, away = (row.get("Home") or "").strip(), (row.get("Away") or "").strip()
        d = parse_date(row.get("Date"))
        hg, ag = num(row.get("HG")), num(row.get("AG"))
        if not home or not away or not d or hg is None or ag is None or d < since:
            continue
        o = {}
        for src, pre in (("avg", "AvgC"), ("max", "MaxC"), ("b365", "B365C")):
            x = triple(row, pre)
            if x:
                o.setdefault("1x2", {})[src] = x
        if "1x2" in o and "b365" not in o["1x2"]:  # en av filerna har stavfelet B36CA
            x = [odd(row.get("B365CH")), odd(row.get("B365CD")), odd(row.get("B36CA"))]
            if all(x):
                o["1x2"]["b365"] = x
        season = (row.get("Season") or "").strip()
        out.append({
            "id": match_id(code, d, home, away), "lg": code, "season": season, "date": d,
            "ko": kickoff_utc(d, row.get("Time")), "home": home, "away": away,
            "hid": team_id(country, home), "aid": team_id(country, away),
            "hg": int(hg), "ag": int(ag), "ref": None,
            "odds": o, "odds_c": o, "odds_kind": "closing",
        })
    return out


def parse_fixtures(text: str | None, extra_text: str | None) -> list[dict]:
    out = []
    for row in csv.DictReader(io.StringIO(text or "")):
        code = (row.get("Div") or "").strip()
        if code not in MAIN:
            continue
        country = MAIN[code][0]
        home, away = (row.get("HomeTeam") or "").strip(), (row.get("AwayTeam") or "").strip()
        d = parse_date(row.get("Date"))
        if not home or not away or not d:
            continue
        out.append({
            "id": match_id(code, d, home, away), "lg": code, "date": d, "ko": kickoff_utc(d, row.get("Time")),
            "home": home, "away": away, "hid": team_id(country, home), "aid": team_id(country, away),
            "ref": (row.get("Referee") or "").strip() or None, "odds": odds_main(row),
        })
    for row in csv.DictReader(io.StringIO(extra_text or "")):
        code = EXTRA_BY_COUNTRY.get((row.get("Country") or "").strip())
        if not code:
            continue
        country = EXTRA[code][0]
        home, away = (row.get("Home") or "").strip(), (row.get("Away") or "").strip()
        d = parse_date(row.get("Date"))
        if not home or not away or not d:
            continue
        o = {}
        for src, pre in (("avg", "Avg"), ("max", "Max"), ("b365", "B365")):
            x = triple(row, pre)
            if x:
                o.setdefault("1x2", {})[src] = x
        out.append({
            "id": match_id(code, d, home, away), "lg": code, "date": d, "ko": kickoff_utc(d, row.get("Time")),
            "home": home, "away": away, "hid": team_id(country, home), "aid": team_id(country, away),
            "ref": None, "odds": o,
        })
    return out


def load(cache: Path, today: date, offline: bool = False):
    """Returnerar (matcher sorterade på datum, kommande matcher, info per liga)."""
    raw = fetch_all(cache, today, offline)
    seasons = season_codes(today)
    matches, info = [], {}
    for code, (country, name, tier) in MAIN.items():
        lm = []
        for s in seasons:
            if (code, s) in raw["main"]:
                lm += parse_main(code, s, raw["main"][(code, s)])
        cur = [m for m in lm if m["season"] == seasons[0]]
        info[code] = {
            "code": code, "country": country, "name": name, "tier": tier, "kind": "main",
            "season": season_label(seasons[0]), "seasonKey": seasons[0],
            "seasons": [s for s in seasons if any(m["season"] == s for m in lm)],
            "hasStats": any(m["hc"] is not None for m in lm),
            "hasXg": any(m["hxg"] is not None for m in cur),
            "hasRef": any(m["ref"] for m in lm),
        }
        matches += lm
    since = today - timedelta(days=3 * 365 + 60)
    for code, (country, name, _) in EXTRA.items():
        if code not in raw["extra"]:
            continue
        lm = parse_extra(code, raw["extra"][code], since)
        if not lm:
            continue
        ss = []
        for m in sorted(lm, key=lambda m: m["date"]):
            if m["season"] not in ss:
                ss.append(m["season"])
        ss = ss[::-1][:3]
        lm = [m for m in lm if m["season"] in ss]
        info[code] = {
            "code": code, "country": country, "name": name, "tier": 1, "kind": "extra",
            "season": ss[0].replace("/20", "/"), "seasonKey": ss[0], "seasons": ss,
            "hasStats": False, "hasXg": False, "hasRef": False,
        }
        matches += lm
    matches.sort(key=lambda m: (m["ko"], m["lg"], m["home"]))
    fixtures = parse_fixtures(raw["fixtures"], raw["extra_fixtures"])
    fixtures.sort(key=lambda m: (m["ko"], m["lg"], m["home"]))
    return matches, fixtures, info
