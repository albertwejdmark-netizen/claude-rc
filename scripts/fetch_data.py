"""Hämtar dagliga kurser för aktierna i watchlist.txt och sparar dem som JSON i site/data/.

Körs av GitHub Actions (se .github/workflows/pages.yml) men fungerar även lokalt:
    pip install yfinance
    python scripts/fetch_data.py
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "watchlist.txt"
OUT = ROOT / "site" / "data"


def file_id(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", symbol)


def read_watchlist() -> list[str]:
    symbols = []
    for line in WATCHLIST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            symbols.append(line)
    return symbols


def fetch(symbol: str) -> dict | None:
    t = yf.Ticker(symbol)
    df = t.history(period="5y", interval="1d", auto_adjust=False)
    if df.empty:
        return None
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    candles = [
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
    name, currency = symbol, ""
    try:
        info = t.get_info()
        name = info.get("longName") or info.get("shortName") or symbol
        currency = info.get("currency") or ""
    except Exception:  # info-anropet är opålitligt; kursdatan räcker
        pass
    if not currency and "." not in symbol:
        currency = "USD"
    return {"symbol": symbol, "name": name, "currency": currency, "candles": candles}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for symbol in read_watchlist():
        try:
            data = fetch(symbol)
        except Exception as e:
            print(f"FEL {symbol}: {e}", file=sys.stderr)
            continue
        if not data:
            print(f"Ingen data för {symbol}", file=sys.stderr)
            continue
        fid = file_id(symbol)
        (OUT / f"{fid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        index.append({"symbol": symbol, "name": data["name"], "file": f"{fid}.json"})
        print(f"OK {symbol}: {len(data['candles'])} dagar")
        time.sleep(0.3)  # var snäll mot Yahoo
    (OUT / "index.json").write_text(
        json.dumps(
            {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "stocks": index},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return 0 if index else 1


if __name__ == "__main__":
    sys.exit(main())
