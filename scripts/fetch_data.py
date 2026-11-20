"""Hämtar dagliga kurser för alla aktier i S&P 500 (plus extra aktier i watchlist.txt)
och sparar dem som JSON i site/data/.

Listan över S&P 500-bolag hämtas från datasets/s-and-p-500-companies på GitHub vid
varje körning. Går den inte att nå används den sparade kopian sp500.csv.

Körs av GitHub Actions (se .github/workflows/pages.yml) men fungerar även lokalt:
    pip install yfinance
    python scripts/fetch_data.py
"""

import csv
import io
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "watchlist.txt"
SP500_COPY = ROOT / "sp500.csv"
SP500_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
OUT = ROOT / "site" / "data"
MARKET = "SPY"  # S&P 500-fonden, används för marknadsfiltret


def file_id(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", symbol)


def sp500() -> list[dict]:
    """[{symbol, name, sector}] för S&P 500, med Yahoo-symboler (BRK.B -> BRK-B)."""
    text = None
    try:
        with urllib.request.urlopen(SP500_URL, timeout=30) as r:
            text = r.read().decode("utf-8")
        rows = list(csv.DictReader(io.StringIO(text)))
        if len(rows) < 400:
            raise ValueError(f"bara {len(rows)} rader")
        SP500_COPY.write_text(text, encoding="utf-8")  # uppdatera reservkopian lokalt
        print(f"S&P 500-lista hämtad: {len(rows)} bolag")
    except Exception as e:
        print(f"Kunde inte hämta S&P 500-listan ({e}), använder sparad kopia", file=sys.stderr)
        rows = list(csv.DictReader(io.StringIO(SP500_COPY.read_text(encoding="utf-8"))))
    return [
        {"symbol": r["Symbol"].strip().replace(".", "-"), "name": r["Security"].strip(), "sector": r["GICS Sector"].strip()}
        for r in rows
    ]


def extras() -> list[str]:
    if not WATCHLIST.exists():
        return []
    return [l.strip() for l in WATCHLIST.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]


def fetch(symbol: str) -> list | None:
    df = yf.Ticker(symbol).history(period="5y", interval="1d", auto_adjust=False)
    if df.empty:
        return None
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    return [
        [
            idx.strftime("%Y-%m-%d"),
            round(float(r.Open), 4),
            round(float(r.High), 4),
            round(float(r.Low), 4),
            round(float(r.Close), 4),
            int(r.Volume) if r.Volume == r.Volume else 0,
        ]
        for idx, r in df.iterrows()
    ]


def name_of(symbol: str) -> str:
    try:
        info = yf.Ticker(symbol).get_info()
        return info.get("longName") or info.get("shortName") or symbol
    except Exception:
        return symbol


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    universe = sp500()
    known = {s["symbol"] for s in universe}
    for sym in extras():
        if sym not in known:
            universe.append({"symbol": sym, "name": name_of(sym), "sector": "Utanför S&P 500"})
            known.add(sym)

    index, failed = [], []
    for s in universe:
        sym = s["symbol"]
        candles = None
        for attempt in range(3):
            try:
                candles = fetch(sym)
                break
            except Exception as e:
                print(f"Försök {attempt + 1} misslyckades för {sym}: {e}", file=sys.stderr)
                time.sleep(2 * (attempt + 1))
        if not candles:
            failed.append(sym)
            continue
        fid = file_id(sym)
        data = {"symbol": sym, "name": s["name"], "sector": s["sector"], "currency": "USD", "candles": candles}
        (OUT / f"{fid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        index.append({"symbol": sym, "name": s["name"], "sector": s["sector"], "file": f"{fid}.json"})
        time.sleep(0.05)
    print(f"Hämtade {len(index)} av {len(universe)} aktier")
    if failed:
        print("Saknar data för: " + ", ".join(failed), file=sys.stderr)

    market_file = None
    try:
        m = fetch(MARKET)
        if m:
            market_file = "market_SPY.json"
            (OUT / market_file).write_text(
                json.dumps({"symbol": MARKET, "candles": m}, separators=(",", ":")), encoding="utf-8")
    except Exception as e:
        print(f"FEL marknad {MARKET}: {e}", file=sys.stderr)

    index.sort(key=lambda s: s["symbol"])
    (OUT / "index.json").write_text(
        json.dumps(
            {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "stocks": index, "market": market_file},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return 0 if len(index) > len(universe) * 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
