"""Signalbot för Nasdaq 100 och guld.

Hämtar kurser från Yahoo Finance (dag och timme, 4 timmar räknas fram från timdata),
räknar indikatorer, kör fem strategier åt båda hållen (long och short), backtestar
varje strategi med stoploss och take profit och väger ihop de som håller i
kontrollperioden till en samlad signal: KÖP, SÄLJ eller AVVAKTA.

Resultatet sparas i site/trading/data/signals.json och visas på /trading/.
Med --notify skickas nya signaler till Telegram och/eller Discord (se README).

    pip install yfinance numpy pandas
    python scripts/trading/build.py              # hämta data och bygg sidan
    python scripts/trading/build.py --notify     # och skicka nya signaler
    python scripts/trading/build.py --demo       # syntetisk data, för test utan nät
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notify  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "trading" / "data"

INSTRUMENTS = [
    # id, namn, Yahoo-symboler i prioritetsordning, kostnad per affär (andel av priset, tur och retur)
    {"id": "NDX", "name": "Nasdaq 100", "symbols": ["^NDX", "NQ=F"], "cost": 0.0002, "decimals": 1},
    {"id": "GOLD", "name": "Guld", "symbols": ["GC=F", "XAUUSD=X"], "cost": 0.0003, "decimals": 1},
]

TIMEFRAMES = [
    # id, namn, längsta väntetid i bars innan affären stängs, antal bars som visas i grafen
    {"id": "1d", "name": "Dag", "max_hold": 30, "show": 400, "fresh": 3},
    {"id": "4h", "name": "4 timmar", "max_hold": 40, "show": 400, "fresh": 3},
    {"id": "1h", "name": "Timme", "max_hold": 48, "show": 400, "fresh": 4},
]

SL_GRID = [1.5, 2.0, 3.0]          # stoploss i ATR
TP_GRID = [1.0, 1.5, 2.0, 3.0]     # take profit i R (risken)
TRAIN_SHARE = 0.7                  # första 70 % väljer inställning, sista 30 % kontrollerar
MIN_TRADES = 15


# --------------------------------------------------------------------------- data

def fetch_yahoo(symbol: str, interval: str) -> pd.DataFrame:
    import yfinance as yf

    period = {"1d": "max", "1h": "730d"}[interval]
    df = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=False)
    if df.empty:
        return df
    df = df[["Open", "High", "Low", "Close"]].dropna()
    df.index = pd.to_datetime(df.index, utc=True)
    if interval == "1d":
        df.index = df.index.normalize()
        df = df[df.index >= df.index[-1] - pd.Timedelta(days=365 * 15)]
    return df[~df.index.duplicated(keep="last")]


def demo_data(seed: int, interval: str, start_price: float) -> pd.DataFrame:
    """Syntetisk kursdata med trender och volatilitetsskiften, för test utan nätverk."""
    rng = np.random.default_rng(seed + (0 if interval == "1d" else 7))
    if interval == "1d":
        idx = pd.bdate_range(end=pd.Timestamp.now(tz="UTC").normalize() - pd.Timedelta(days=1), periods=3500, tz="UTC")
        vol = 0.012
    else:
        end = pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=1)
        idx = pd.date_range(end=end, periods=730 * 22, freq="h", tz="UTC")
        idx = idx[idx.dayofweek < 5]
        vol = 0.0028
    n = len(idx)
    drift = np.repeat(rng.normal(0.0002, 0.0015, n // 120 + 1), 120)[:n] * (vol / 0.012)
    sigma = vol * np.exp(np.repeat(rng.normal(0, 0.35, n // 60 + 1), 60)[:n])
    ret = drift + sigma * rng.standard_t(5, n) / 1.3
    close = start_price * np.exp(np.cumsum(ret))
    opn = np.r_[start_price, close[:-1]] * (1 + rng.normal(0, vol * 0.15, n))
    hi = np.maximum(opn, close) * (1 + np.abs(rng.normal(0, vol * 0.5, n)))
    lo = np.minimum(opn, close) * (1 - np.abs(rng.normal(0, vol * 0.5, n)))
    return pd.DataFrame({"Open": opn, "High": hi, "Low": lo, "Close": close}, index=idx)


def drop_unfinished(df: pd.DataFrame, interval: str, now: pd.Timestamp) -> pd.DataFrame:
    """Tar bort sista baren om den inte har stängt än (signaler bara på stängda bars)."""
    if df.empty:
        return df
    length = {"1d": pd.Timedelta(hours=22), "4h": pd.Timedelta(hours=4), "1h": pd.Timedelta(hours=1)}[interval]
    if df.index[-1] + length > now:
        return df.iloc[:-1]
    return df


def to_4h(df1h: pd.DataFrame) -> pd.DataFrame:
    g = df1h.resample("4h", origin="epoch", label="left")
    out = pd.DataFrame({
        "Open": g["Open"].first(), "High": g["High"].max(), "Low": g["Low"].min(), "Close": g["Close"].last(),
    }).dropna()
    return out


# ---------------------------------------------------------------------- indikatorer

def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(close: pd.Series, n: int) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    c, h, l = df.Close, df.High, df.Low
    prev = c.shift()
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    df["ema20"], df["ema50"], df["ema200"] = ema(c, 20), ema(c, 50), ema(c, 200)
    df["rsi14"], df["rsi2"] = rsi(c, 14), rsi(c, 2)
    macd = ema(c, 12) - ema(c, 26)
    df["macd"], df["macd_sig"] = macd, ema(macd, 9)
    # ADX
    upm, dnm = h.diff(), -l.diff()
    plus = np.where((upm > dnm) & (upm > 0), upm, 0.0)
    minus = np.where((dnm > upm) & (dnm > 0), dnm, 0.0)
    atr_s = tr.ewm(alpha=1 / 14, adjust=False).mean()
    pdi = 100 * pd.Series(plus, index=df.index).ewm(alpha=1 / 14, adjust=False).mean() / atr_s
    mdi = 100 * pd.Series(minus, index=df.index).ewm(alpha=1 / 14, adjust=False).mean() / atr_s
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    df["adx"] = dx.ewm(alpha=1 / 14, adjust=False).mean().fillna(0)
    df["dc_hi"] = h.rolling(20).max().shift()   # 20-bars högsta, utan dagens bar
    df["dc_lo"] = l.rolling(20).min().shift()
    return df


# ------------------------------------------------------------------------ strategier
# Varje strategi ger +1 (long), -1 (short) eller 0 på stängningen av varje bar.

def cross_up(a: pd.Series, b: pd.Series) -> pd.Series:
    return (a > b) & (a.shift() <= b.shift())


def strat_trend(d):
    up = cross_up(d.ema20, d.ema50) & (d.Close > d.ema200) & (d.adx > 20)
    dn = cross_up(d.ema50, d.ema20) & (d.Close < d.ema200) & (d.adx > 20)
    return up, dn


def strat_breakout(d):
    up = (d.Close > d.dc_hi) & (d.Close.shift() <= d.dc_hi.shift()) & (d.ema50 > d.ema200)
    dn = (d.Close < d.dc_lo) & (d.Close.shift() >= d.dc_lo.shift()) & (d.ema50 < d.ema200)
    return up, dn


def strat_pullback(d):
    up = (d.ema50 > d.ema200) & (d.Close > d.ema200) & (d.rsi14 > 40) & (d.rsi14.shift() <= 40)
    dn = (d.ema50 < d.ema200) & (d.Close < d.ema200) & (d.rsi14 < 60) & (d.rsi14.shift() >= 60)
    return up, dn


def strat_macd(d):
    up = cross_up(d.macd, d.macd_sig) & (d.macd < 0) & (d.Close > d.ema200)
    dn = cross_up(d.macd_sig, d.macd) & (d.macd > 0) & (d.Close < d.ema200)
    return up, dn


def strat_meanrev(d):
    up = (d.rsi2 < 10) & (d.rsi2.shift() >= 10) & (d.Close > d.ema200)
    dn = (d.rsi2 > 90) & (d.rsi2.shift() <= 90) & (d.Close < d.ema200)
    return up, dn


STRATEGIES = [
    {"id": "trend", "name": "Trendföljning", "fn": strat_trend,
     "rule": "EMA 20 korsar EMA 50 i samma riktning som EMA 200, ADX över 20 (stark trend)."},
    {"id": "breakout", "name": "Utbrott", "fn": strat_breakout,
     "rule": "Stänger över 20-bars högsta (long) eller under 20-bars lägsta (short) när EMA 50 ligger rätt mot EMA 200."},
    {"id": "pullback", "name": "Rekyl i trend", "fn": strat_pullback,
     "rule": "Upptrend (EMA 50 över EMA 200) och RSI 14 vänder upp över 40 efter en rekyl. Spegelvänt för short."},
    {"id": "macd", "name": "MACD-vändning", "fn": strat_macd,
     "rule": "MACD korsar signallinjen under nollan (long) eller över nollan (short), med kursen rätt sida om EMA 200."},
    {"id": "meanrev", "name": "Översåld/överköpt", "fn": strat_meanrev,
     "rule": "RSI 2 under 10 i upptrend (köp dippen) eller över 90 i nedtrend (sälj studsen)."},
]


# -------------------------------------------------------------------------- backtest

def simulate(d: pd.DataFrame, sig: np.ndarray, sl_mult: float, tp_r: float, max_hold: int, cost: float) -> list[dict]:
    """Går in på nästa bars öppning. Stoploss = sl_mult × ATR, take profit = tp_r × risken.
    Når baren både SL och TP räknas det som SL (försiktigt). En affär åt gången per strategi."""
    o, h, l, c, atr = (d[k].to_numpy() for k in ("Open", "High", "Low", "Close", "atr"))
    n, trades, i = len(d), [], 0
    while i < n - 1:
        s = sig[i]
        if s == 0 or not np.isfinite(atr[i]):
            i += 1
            continue
        entry = o[i + 1]
        risk = sl_mult * atr[i]
        sl = entry - s * risk
        tp = entry + s * tp_r * risk
        result, exit_i, exit_px = None, None, None
        for j in range(i + 1, min(n, i + 1 + max_hold)):
            hit_sl = l[j] <= sl if s > 0 else h[j] >= sl
            hit_tp = h[j] >= tp if s > 0 else l[j] <= tp
            if hit_sl:
                result, exit_i, exit_px = "sl", j, sl
                break
            if hit_tp:
                result, exit_i, exit_px = "tp", j, tp
                break
        if result is None:
            last = min(n, i + 1 + max_hold) - 1
            if last < i + max_hold and last == n - 1:
                # affären är fortfarande öppen
                trades.append({"i": i, "dir": int(s), "entry": entry, "sl": sl, "tp": tp, "open": True,
                               "r": (c[last] - entry) * s / risk})
                break
            result, exit_i, exit_px = "time", last, c[last]
        r = (exit_px - entry) * s / risk - cost * entry / risk
        trades.append({"i": i, "dir": int(s), "entry": entry, "sl": sl, "tp": tp, "open": False,
                       "result": result, "exit_i": exit_i, "exit": exit_px, "r": r})
        i = exit_i + 1
    return trades


def stats(trades: list[dict]) -> dict:
    closed = [t for t in trades if not t["open"]]
    if not closed:
        return {"n": 0, "win": None, "avg_r": None, "pf": None, "total_r": 0.0, "max_dd": 0.0}
    r = np.array([t["r"] for t in closed])
    gains, losses = r[r > 0].sum(), -r[r < 0].sum()
    eq = np.cumsum(r)
    dd = float(np.max(np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]))
    return {
        "n": len(closed),
        "win": round(float((r > 0).mean()), 3),
        "avg_r": round(float(r.mean()), 3),
        "pf": round(float(gains / losses), 2) if losses > 0 else None,
        "total_r": round(float(r.sum()), 1),
        "max_dd": round(dd, 1),
    }


def backtest_strategy(d: pd.DataFrame, strat: dict, tf: dict, cost: float) -> dict:
    up, dn = strat["fn"](d)
    sig = np.where(up.fillna(False), 1, np.where(dn.fillna(False), -1, 0))
    sig[:200] = 0  # EMA 200 behöver uppvärmning
    split = int(len(d) * TRAIN_SHARE)
    best = None
    for sl_mult in SL_GRID:
        for tp_r in TP_GRID:
            tr = simulate(d.iloc[:split], sig[:split], sl_mult, tp_r, tf["max_hold"], cost)
            st = stats(tr)
            if st["n"] < MIN_TRADES:
                continue
            # välj på snitt-R men dra av för få affärer (mindre slump)
            score = st["avg_r"] - 0.5 / math.sqrt(st["n"])
            if best is None or score > best[0]:
                best = (score, sl_mult, tp_r, st)
    if best is None:
        sl_mult, tp_r, train = 2.0, 2.0, stats(simulate(d.iloc[:split], sig[:split], 2.0, 2.0, tf["max_hold"], cost))
    else:
        _, sl_mult, tp_r, train = best
    all_trades = simulate(d, sig, sl_mult, tp_r, tf["max_hold"], cost)
    test_trades = [t for t in all_trades if t["i"] >= split]
    test = stats(test_trades)
    # strategin räknas med i den samlade signalen om den tjänat pengar i båda perioderna
    ok = (train["n"] >= MIN_TRADES and (train["avg_r"] or 0) > 0
          and test["n"] >= 5 and (test["avg_r"] or 0) > 0)
    weight = 0.0
    if ok:
        weight = round(min(1.0, (test["avg_r"] or 0) * math.sqrt(test["n"]) / 2), 3)
    return {"sig": sig, "trades": all_trades, "sl_mult": sl_mult, "tp_r": tp_r,
            "train": train, "test": test, "ok": ok, "weight": weight, "split": split}


# --------------------------------------------------------------------- sammanvägning

def fmt_time(ts: pd.Timestamp, tf: str) -> int | str:
    return ts.strftime("%Y-%m-%d") if tf == "1d" else int(ts.timestamp())


def analyse(df: pd.DataFrame, inst: dict, tf: dict) -> dict:
    d = indicators(df)
    n = len(d)
    last = d.iloc[-1]
    show_from = max(0, n - tf["show"])
    res_strats, markers, active, fresh = [], [], [], []
    score, weight_sum = 0.0, 0.0
    for s in STRATEGIES:
        bt = backtest_strategy(d, s, tf, inst["cost"])
        open_trade = next((t for t in bt["trades"] if t["open"]), None)
        last_sig_i = int(np.flatnonzero(bt["sig"])[-1]) if np.any(bt["sig"]) else None
        state = 0
        if open_trade:
            state = open_trade["dir"]
        elif last_sig_i is not None and last_sig_i == n - 1:
            state = int(bt["sig"][-1])  # signal på sista baren, inträde nästa öppning
        if bt["ok"] and state:
            score += state * bt["weight"]
        if bt["ok"]:
            weight_sum += bt["weight"]

        risk = bt["sl_mult"] * last.atr
        plan = None
        if state:
            if open_trade:
                entry, sl, tp = open_trade["entry"], open_trade["sl"], open_trade["tp"]
                since = d.index[open_trade["i"]]
            else:
                entry = last.Close
                sl, tp = entry - state * risk, entry + state * bt["tp_r"] * risk
                since = d.index[-1]
            plan = {"dir": state, "entry": round(entry, inst["decimals"]), "sl": round(sl, inst["decimals"]),
                    "tp": round(tp, inst["decimals"]), "since": fmt_time(since, tf["id"]),
                    "r_now": round(open_trade["r"], 2) if open_trade else 0.0}
            active.append({"strategy": s["id"], "name": s["name"], "counts": bt["ok"], **plan})

        if last_sig_i is not None and last_sig_i >= n - tf["fresh"]:
            fresh.append({"strategy": s["id"], "name": s["name"], "dir": int(bt["sig"][last_sig_i]),
                          "time": fmt_time(d.index[last_sig_i], tf["id"]), "bars_ago": n - 1 - last_sig_i,
                          "counts": bt["ok"], "price": round(float(d.Close.iloc[last_sig_i]), inst["decimals"]),
                          "sl_mult": bt["sl_mult"], "tp_r": bt["tp_r"]})

        recent = []
        for t in bt["trades"]:
            if t["i"] < show_from:
                continue
            markers.append({"time": fmt_time(d.index[t["i"]], tf["id"]), "dir": t["dir"], "strategy": s["id"],
                            "result": "open" if t["open"] else t["result"], "r": round(t["r"], 2)})
        for t in bt["trades"][-8:][::-1]:
            recent.append({"time": fmt_time(d.index[t["i"]], tf["id"]), "dir": t["dir"],
                           "entry": round(t["entry"], inst["decimals"]),
                           "exit": None if t["open"] else round(t["exit"], inst["decimals"]),
                           "result": "open" if t["open"] else t["result"], "r": round(t["r"], 2)})
        res_strats.append({
            "id": s["id"], "name": s["name"], "rule": s["rule"], "sl_mult": bt["sl_mult"], "tp_r": bt["tp_r"],
            "train": bt["train"], "test": bt["test"], "ok": bt["ok"], "weight": bt["weight"], "state": state,
            "plan": plan, "recent": recent,
        })

    # Samlad signal: viktad röst från strategierna som håller i kontrollperioden, plus trendläget.
    trend = 1 if (last.Close > last.ema200 and last.ema50 > last.ema200) else -1 if (
        last.Close < last.ema200 and last.ema50 < last.ema200) else 0
    norm = score / weight_sum if weight_sum > 0 else 0.0
    if norm >= 0.25:
        verdict = "KÖP"
    elif norm <= -0.25:
        verdict = "SÄLJ"
    else:
        verdict = "AVVAKTA"
    strength = min(100, round(abs(norm) * 100))

    # Gemensam handelsplan för den samlade signalen: stoploss 2 × ATR, mål 1R / 2R / 3R
    plan = None
    if verdict != "AVVAKTA":
        dr = 1 if verdict == "KÖP" else -1
        risk = 2 * last.atr
        e = last.Close
        dec = inst["decimals"]
        plan = {"dir": dr, "entry": round(e, dec), "sl": round(e - dr * risk, dec),
                "tp1": round(e + dr * risk, dec), "tp2": round(e + dr * 2 * risk, dec),
                "tp3": round(e + dr * 3 * risk, dec), "risk_pct": round(risk / e * 100, 2)}

    seg = d.iloc[show_from:]
    dec = inst["decimals"]
    candles = [[fmt_time(ts, tf["id"]), round(r.Open, dec), round(r.High, dec), round(r.Low, dec), round(r.Close, dec)]
               for ts, r in seg.iterrows()]
    lines = {k: [round(float(v), dec) if np.isfinite(v) else None for v in seg[k]] for k in ("ema20", "ema50", "ema200")}
    chg = (last.Close / d.Close.iloc[-2] - 1) * 100 if n > 1 else 0
    return {
        "tf": tf["id"], "tf_name": tf["name"], "last_time": fmt_time(d.index[-1], tf["id"]),
        "close": round(float(last.Close), dec), "change_pct": round(float(chg), 2),
        "verdict": verdict, "score": round(norm, 3), "strength": strength, "trend": trend, "plan": plan,
        "ind": {"rsi14": round(float(last.rsi14), 1), "adx": round(float(last.adx), 1),
                "atr": round(float(last.atr), dec), "atr_pct": round(float(last.atr / last.Close * 100), 2),
                "ema20": round(float(last.ema20), dec), "ema50": round(float(last.ema50), dec),
                "ema200": round(float(last.ema200), dec), "macd": round(float(last.macd), 2),
                "macd_sig": round(float(last.macd_sig), 2)},
        "strategies": res_strats, "active": active, "fresh": fresh,
        "candles": candles, "lines": lines, "markers": markers,
        "bars": n, "from": fmt_time(d.index[0], tf["id"]), "split_time": fmt_time(d.index[int(n * TRAIN_SHARE)], tf["id"]),
    }


# ------------------------------------------------------------------------------ main

def load(inst: dict, demo: bool, now: pd.Timestamp) -> tuple[dict[str, pd.DataFrame], str]:
    frames, used = {}, None
    if demo:
        seed = 1 if inst["id"] == "NDX" else 2
        start = 9000.0 if inst["id"] == "NDX" else 1300.0
        frames["1d"] = demo_data(seed, "1d", start)
        frames["1h"] = demo_data(seed, "1h", float(frames["1d"].Close.iloc[-1]))
        used = "demo"
    else:
        for sym in inst["symbols"]:
            try:
                d1 = fetch_yahoo(sym, "1d")
                h1 = fetch_yahoo(sym, "1h")
            except Exception as e:  # noqa: BLE001
                print(f"{inst['id']}: {sym} misslyckades ({e})", file=sys.stderr)
                continue
            if len(d1) > 300 and len(h1) > 300:
                frames["1d"], frames["1h"], used = d1, h1, sym
                break
            print(f"{inst['id']}: för lite data från {sym} ({len(d1)} dagar, {len(h1)} timmar)", file=sys.stderr)
    if not used:
        return {}, ""
    frames["1d"] = drop_unfinished(frames["1d"], "1d", now)
    frames["1h"] = drop_unfinished(frames["1h"], "1h", now)
    frames["4h"] = drop_unfinished(to_4h(frames["1h"]), "4h", now)
    return frames, used


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="syntetisk data (ingen nätverksåtkomst behövs)")
    ap.add_argument("--notify", action="store_true", help="skicka nya signaler till Telegram/Discord")
    ap.add_argument("--state", default=str(ROOT / ".cache" / "trading_sent.json"), help="fil med redan skickade signaler")
    args = ap.parse_args()

    now = pd.Timestamp.now(tz="UTC")
    OUT.mkdir(parents=True, exist_ok=True)
    result = {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "demo": args.demo,
              "train_share": TRAIN_SHARE, "instruments": []}
    for inst in INSTRUMENTS:
        frames, used = load(inst, args.demo, now)
        if not frames:
            print(f"FEL: ingen data för {inst['name']}", file=sys.stderr)
            continue
        entry = {"id": inst["id"], "name": inst["name"], "symbol": used, "timeframes": []}
        for tf in TIMEFRAMES:
            df = frames[tf["id"]]
            if len(df) < 400:
                print(f"{inst['id']} {tf['id']}: för lite data ({len(df)})", file=sys.stderr)
                continue
            a = analyse(df, inst, tf)
            entry["timeframes"].append(a)
            print(f"{inst['name']:<11} {tf['name']:<9} {a['verdict']:<8} styrka {a['strength']:>3} %  "
                  f"stängning {a['close']}  strategier som räknas: "
                  f"{sum(s['ok'] for s in a['strategies'])}/{len(a['strategies'])}")
        result["instruments"].append(entry)

    (OUT / "signals.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Sparade {OUT / 'signals.json'}")

    if args.notify:
        notify.send_new(result, Path(args.state))
    return 0 if len(result["instruments"]) == len(INSTRUMENTS) else 1


if __name__ == "__main__":
    sys.exit(main())
