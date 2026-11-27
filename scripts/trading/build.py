"""Signalbot för Nasdaq 100 och guld.

Hämtar kurser från Yahoo Finance på sju tidsramar (dag, 4 timmar, timme, 30, 15, 5 och
1 minut), räknar indikatorer, kör fem strategier åt båda hållen (long och short), backtestar
varje strategi med stoploss och take profit och väger ihop de som tjänat pengar
till en samlad signal: KÖP, SÄLJ eller AVVAKTA. Ett walk-forward-test visar vad boten
hade gett om den körts live (inställningar valda bara på data före varje period).

Alla tidsramar kombineras: en signal skickas bara om trenden på de två närmast högre
tidsramarna inte pekar åt andra hållet och minst en av dem håller med, och om just den
kombinationen har tjänat pengar i walk-forward-testet.

Resultatet sparas i site/trading/data/signals.json och visas på /trading/.
Med --notify skickas nya signaler till Telegram och/eller Discord (se README).

    pip install yfinance numpy pandas
    python scripts/trading/build.py              # hämta data och bygg sidan
    python scripts/trading/build.py --notify     # och skicka nya signaler
    python scripts/trading/build.py --notify --loop 60   # kör varje minut (egen dator/server)
    python scripts/trading/build.py --demo       # syntetisk data, för test utan nät
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notify  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "trading" / "data"

INSTRUMENTS = [
    # Yahoo-symboler i prioritetsordning för dagsdata och för kortare tidsramar.
    # Nasdaq under dagen: terminen NQ=F, som handlas nästan dygnet runt (som CFD:n US100).
    # cost_pts: spread + slippage per affär (tur och retur) i indexpunkter / dollar.
    {"id": "NDX", "name": "Nasdaq 100", "daily": ["^NDX", "NQ=F"], "intraday": ["NQ=F", "^NDX"],
     "cost_pts": 2.5, "decimals": 1},
    {"id": "GOLD", "name": "Guld", "daily": ["GC=F"], "intraday": ["GC=F"], "cost_pts": 0.6, "decimals": 1},
]

TIMEFRAMES = [
    # id, namn, längd i minuter, källa (hämtas eller räknas om från), längsta tid i bars innan affären stängs
    {"id": "1d", "name": "Dag", "short": "D", "min": 1440, "src": "1d", "max_hold": 30, "fresh": 2},
    {"id": "4h", "name": "4 timmar", "short": "4h", "min": 240, "src": "1h", "max_hold": 40, "fresh": 2},
    {"id": "1h", "name": "Timme", "short": "1h", "min": 60, "src": "1h", "max_hold": 48, "fresh": 3},
    {"id": "30m", "name": "30 min", "short": "30m", "min": 30, "src": "5m", "max_hold": 40, "fresh": 3},
    {"id": "15m", "name": "15 min", "short": "15m", "min": 15, "src": "5m", "max_hold": 40, "fresh": 4},
    {"id": "5m", "name": "5 min", "short": "5m", "min": 5, "src": "5m", "max_hold": 48, "fresh": 6},
    {"id": "1m", "name": "1 min", "short": "1m", "min": 1, "src": "1m", "max_hold": 60, "fresh": 15},
]
SHOW_BARS = 400
MTF_HIGHER = 2                     # antal högre tidsramar som måste stämma

SL_GRID = [1.5, 2.0, 3.0]          # stoploss i ATR
TP_GRID = [1.0, 1.5, 2.0, 3.0]     # take profit i R (risken)
MIN_TRADES = 15
WF_START = 0.4                     # walk-forward: första 40 % är bara inlärning
WF_FOLDS = 6                       # resten delas i 6 perioder som handlas en i taget
RISK_PCT = 1.0                     # procent av kontot som riskeras per affär i resultatet
NOTIFY_MIN_TRADES = 30             # walk-forward med filter måste ha minst så många affärer ...
NOTIFY_MIN_PF = 1.1                # ... minst den vinstfaktorn ...
NOTIFY_MIN_T = 2.0                 # ... och ett t-värde på minst 2 (troligen inte tur)


# --------------------------------------------------------------------------- data

def fetch_yahoo(symbol: str, interval: str) -> pd.DataFrame:
    import yfinance as yf

    t = yf.Ticker(symbol)
    if interval == "1m":
        # Yahoo ger 1-minutersdata högst 7 dagar per anrop och 30 dagar bakåt
        now, parts = pd.Timestamp.now(tz="UTC"), []
        for k in range(5):
            end = now - pd.Timedelta(days=7 * k)
            start = max(end - pd.Timedelta(days=7), now - pd.Timedelta(days=29))
            if start >= end:
                break
            parts.append(t.history(start=start, end=end, interval="1m", auto_adjust=False))
        parts = [p for p in parts if not p.empty]
        df = pd.concat(parts).sort_index() if parts else pd.DataFrame()
    else:
        period = {"1d": "max", "1h": "730d", "5m": "60d"}[interval]
        df = t.history(period=period, interval=interval, auto_adjust=False)
    return df


def demo_data(seed: int, interval: str, start_price: float) -> pd.DataFrame:
    """Syntetisk kursdata med trender och volatilitetsskiften, för test utan nätverk."""
    rng = np.random.default_rng(seed + {"1d": 0, "1h": 7, "5m": 11, "1m": 13}[interval])
    if interval == "1d":
        idx = pd.bdate_range(end=pd.Timestamp.now(tz="UTC").normalize() - pd.Timedelta(days=1), periods=3500, tz="UTC")
        vol = 0.012
    else:
        freq, periods, vol = {"1h": ("h", 730 * 22, 0.0028), "5m": ("5min", 60 * 270, 0.0008),
                              "1m": ("min", 29 * 1380, 0.00035)}[interval]
        end = pd.Timestamp.now(tz="UTC").floor(freq) - pd.tseries.frequencies.to_offset(freq)
        idx = pd.date_range(end=end, periods=periods, freq=freq, tz="UTC")
        idx = idx[idx.dayofweek < 5]
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
    if df.index[-1] + bar_length(interval) > now:
        return df.iloc[:-1]
    return df


def bar_length(tf: str) -> pd.Timedelta:
    """Tid från barens start till stängning. Dagsbaren räknas som stängd 22:00 UTC."""
    return pd.Timedelta(hours=22) if tf == "1d" else pd.Timedelta(minutes=next(t["min"] for t in TIMEFRAMES if t["id"] == tf))


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    g = df.resample(rule, origin="epoch", label="left")
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
    n, trades, free = len(d), [], 0
    for i in np.flatnonzero(sig[: n - 1]):
        if i < free or not np.isfinite(atr[i]):
            continue
        s = sig[i]
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
                trades.append({"i": int(i), "dir": int(s), "entry": entry, "sl": sl, "tp": tp, "open": True,
                               "r": (c[last] - entry) * s / risk})
                break
            result, exit_i, exit_px = "time", last, c[last]
        r = (exit_px - entry) * s / risk - cost * entry / risk
        trades.append({"i": int(i), "dir": int(s), "entry": entry, "sl": sl, "tp": tp, "open": False,
                       "result": result, "exit_i": exit_i, "exit": exit_px, "r": r})
        free = exit_i + 1
    return trades


def stats(trades: list[dict]) -> dict:
    closed = [t for t in trades if not t["open"]]
    if not closed:
        return {"n": 0, "win": None, "avg_r": None, "pf": None, "total_r": 0.0, "max_dd": 0.0, "t": None}
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
        # t-värde: hur säkert snittet skiljer sig från noll (över 2 = troligen inte slump)
        "t": round(float(r.mean() / r.std(ddof=1) * math.sqrt(len(r))), 2) if len(r) > 2 and r.std() > 0 else None,
    }


def signals(d: pd.DataFrame, strat: dict) -> np.ndarray:
    up, dn = strat["fn"](d)
    sig = np.where(up.fillna(False), 1, np.where(dn.fillna(False), -1, 0))
    sig[:200] = 0  # EMA 200 behöver uppvärmning
    return sig


def choose(d: pd.DataFrame, sig: np.ndarray, end: int, tf: dict, cost: float) -> tuple[float, float, dict, bool]:
    """Väljer stoploss och mål på bars före `end` och avgör om strategin ska användas.
    Använder bara data före `end`, så att samma regel går att testa ärligt bakåt i tiden."""
    best = None
    for sl_mult in SL_GRID:
        for tp_r in TP_GRID:
            st = stats(simulate(d.iloc[:end], sig[:end], sl_mult, tp_r, tf["max_hold"], cost))
            if st["n"] < MIN_TRADES:
                continue
            # välj på snitt-R men dra av för få affärer (mindre slump)
            score = st["avg_r"] - 0.5 / math.sqrt(st["n"])
            if best is None or score > best[0]:
                best = (score, sl_mult, tp_r, st)
    if best is None:
        st = stats(simulate(d.iloc[:end], sig[:end], 2.0, 2.0, tf["max_hold"], cost))
        return 2.0, 2.0, st, False
    score, sl_mult, tp_r, st = best
    return sl_mult, tp_r, st, score > 0  # används bara om den tjänat pengar även efter avdraget


def walk_forward(d: pd.DataFrame, sigs: dict, tf: dict, cost: float) -> dict:
    """Ärligt test av hela boten: för varje period väljs inställningar och strategier bara på
    data före perioden, sedan handlas perioden. Ger det resultat boten hade fått live."""
    n = len(d)
    start = max(400, int(n * WF_START))
    edges = np.linspace(start, n, WF_FOLDS + 1).astype(int)
    per_strat = {k: [] for k in sigs}
    used = {k: 0 for k in sigs}
    for a, b in zip(edges[:-1], edges[1:]):
        for k, sig in sigs.items():
            sl_mult, tp_r, _, use = choose(d, sig, a, tf, cost)
            masked = np.zeros_like(sig)
            masked[a:b] = sig[a:b]
            trades = [t for t in simulate(d, masked, sl_mult, tp_r, tf["max_hold"], cost) if not t["open"]]
            for t in trades:
                t["used"] = use
            per_strat[k] += trades
            used[k] += int(use)
    bot = sorted((t for ts in per_strat.values() for t in ts if t["used"]), key=lambda t: t["exit_i"])
    st = stats(bot)
    r = np.array([t["r"] for t in bot]) if bot else np.zeros(0)
    eq = np.cumsum(r)
    # pengar: 1 % av kontot riskeras per affär (utan ränta-på-ränta)
    ret_pct = float(r.sum()) * RISK_PCT
    dd_pct = st["max_dd"] * RISK_PCT
    first, last = d.Close.iloc[start], d.Close.iloc[-1]
    years = (d.index[-1] - d.index[start]).days / 365.25
    curve = [[fmt_time(d.index[t["exit_i"]], tf["id"]), round(float(e), 2)] for t, e in zip(bot, eq)]
    return {
        "from": fmt_time(d.index[start], tf["id"]), "to": fmt_time(d.index[-1], tf["id"]),
        "years": round(years, 2), "folds": WF_FOLDS, **st,
        "ret_pct": round(ret_pct, 1), "dd_pct": round(dd_pct, 1),
        # omräkning till per år bara när testet är minst ett halvår, annars blir siffran missvisande
        "ret_pct_year": round(ret_pct / years, 1) if years >= 0.5 else None,
        "bh_pct": round(float((last / first - 1) * 100), 1),
        "long": stats([t for t in bot if t["dir"] > 0]), "short": stats([t for t in bot if t["dir"] < 0]),
        "per_strategy": {k: {**stats(v), "used_folds": used[k],
                             "used": stats([t for t in v if t["used"]])} for k, v in per_strat.items()},
        "curve": curve,
    }


def backtest_strategy(d: pd.DataFrame, sig: np.ndarray, tf: dict, cost: float) -> dict:
    """Inställning för live-signalerna: samma regel som i walk-forward, på all data fram till nu."""
    sl_mult, tp_r, hist, ok = choose(d, sig, len(d), tf, cost)
    all_trades = simulate(d, sig, sl_mult, tp_r, tf["max_hold"], cost)
    weight = round(min(1.0, (hist["avg_r"] or 0) * math.sqrt(hist["n"]) / 2), 3) if ok else 0.0
    return {"sig": sig, "trades": all_trades, "sl_mult": sl_mult, "tp_r": tp_r,
            "hist": hist, "ok": ok, "weight": weight}


# --------------------------------------------------------------------- sammanvägning

def fmt_time(ts: pd.Timestamp, tf: str) -> int | str:
    return ts.strftime("%Y-%m-%d") if tf == "1d" else int(ts.timestamp())


def trend_of(d: pd.DataFrame) -> np.ndarray:
    """+1 upptrend (kurs och EMA 50 över EMA 200), -1 nedtrend, 0 oklart."""
    up = (d.Close > d.ema200) & (d.ema50 > d.ema200)
    dn = (d.Close < d.ema200) & (d.ema50 < d.ema200)
    return np.where(up, 1, np.where(dn, -1, 0))


def higher_trends(lower: pd.DataFrame, lower_tf: str, higher: list[tuple[str, pd.DataFrame]]) -> np.ndarray:
    """Trenden på högre tidsramar vid stängningen av varje lägre bar. Bara högre bars som redan
    hade stängt räknas (ingen framåtblick). Returnerar en matris: rad = lägre bar, kolumn = högre tidsram."""
    close_t = pd.DataFrame({"t": lower.index + bar_length(lower_tf)})
    out = np.zeros((len(lower), len(higher)), dtype=int)
    for k, (tf_id, h) in enumerate(higher):
        ht = pd.DataFrame({"t": h.index + bar_length(tf_id), "trend": trend_of(h)}).sort_values("t")
        m = pd.merge_asof(close_t, ht, on="t", direction="backward")
        out[:, k] = m["trend"].fillna(0).to_numpy().astype(int)
    return out


def mtf_allowed(ht: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Long tillåts om ingen högre tidsram är i nedtrend och minst en är i upptrend. Spegelvänt för short."""
    if ht.shape[1] == 0:
        ones = np.ones(ht.shape[0], dtype=bool)
        return ones, ones
    long_ok = (ht >= 0).all(axis=1) & (ht > 0).any(axis=1)
    short_ok = (ht <= 0).all(axis=1) & (ht < 0).any(axis=1)
    return long_ok, short_ok


def analyse(d: pd.DataFrame, inst: dict, tf: dict, cost: float, ht: np.ndarray, higher_ids: list[str]) -> dict:
    n = len(d)
    last = d.iloc[-1]
    dec = inst["decimals"]
    show_from = max(0, n - SHOW_BARS)
    long_ok, short_ok = mtf_allowed(ht)
    res_strats, markers, active, fresh = [], [], [], []
    score, weight_sum = 0.0, 0.0
    sigs = {s["id"]: signals(d, s) for s in STRATEGIES}
    sigs_f = {k: np.where(((v > 0) & long_ok) | ((v < 0) & short_ok), v, 0) for k, v in sigs.items()}
    wf = walk_forward(d, sigs, tf, cost)
    wf_f = walk_forward(d, sigs_f, tf, cost)
    notify_ok = bool(wf_f["n"] >= NOTIFY_MIN_TRADES and (wf_f["pf"] or 0) >= NOTIFY_MIN_PF
                     and (wf_f["avg_r"] or 0) > 0 and (wf_f["t"] or 0) >= NOTIFY_MIN_T)
    for s in STRATEGIES:
        bt = backtest_strategy(d, sigs[s["id"]], tf, cost)
        bf = backtest_strategy(d, sigs_f[s["id"]], tf, cost)
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
            plan = {"dir": state, "entry": round(entry, dec), "sl": round(sl, dec),
                    "tp": round(tp, dec), "since": fmt_time(since, tf["id"]),
                    "r_now": round(open_trade["r"], 2) if open_trade else 0.0}
            active.append({"strategy": s["id"], "name": s["name"], "counts": bt["ok"], **plan})

        if last_sig_i is not None and last_sig_i >= n - tf["fresh"]:
            dr = int(bt["sig"][last_sig_i])
            aligned = bool(long_ok[last_sig_i] if dr > 0 else short_ok[last_sig_i])
            # signalen skickas med inställningen från testet med filter
            atr_i = float(d.atr.iloc[last_sig_i])
            price = float(d.Close.iloc[last_sig_i])
            r_f = bf["sl_mult"] * atr_i
            fresh.append({"strategy": s["id"], "name": s["name"], "dir": dr,
                          "time": fmt_time(d.index[last_sig_i], tf["id"]),
                          "close_ts": int((d.index[last_sig_i] + bar_length(tf["id"])).timestamp()),
                          "bars_ago": n - 1 - last_sig_i, "counts": bt["ok"],
                          "aligned": aligned, "counts_mtf": bf["ok"],
                          "higher": [int(x) for x in ht[last_sig_i]],
                          "price": round(price, dec), "sl_mult": bf["sl_mult"], "tp_r": bf["tp_r"],
                          "sl": round(price - dr * r_f, dec), "tp": round(price + dr * bf["tp_r"] * r_f, dec)})

        recent = []
        for t in bt["trades"]:
            if t["i"] < show_from:
                continue
            ok_mtf = bool(long_ok[t["i"]] if t["dir"] > 0 else short_ok[t["i"]])
            markers.append({"time": fmt_time(d.index[t["i"]], tf["id"]), "dir": t["dir"], "strategy": s["id"],
                            "result": "open" if t["open"] else t["result"], "r": round(t["r"], 2), "mtf": ok_mtf})
        for t in bt["trades"][-8:][::-1]:
            recent.append({"time": fmt_time(d.index[t["i"]], tf["id"]), "dir": t["dir"],
                           "entry": round(t["entry"], dec),
                           "exit": None if t["open"] else round(t["exit"], dec),
                           "result": "open" if t["open"] else t["result"], "r": round(t["r"], 2),
                           "mtf": bool(long_ok[t["i"]] if t["dir"] > 0 else short_ok[t["i"]])})
        res_strats.append({
            "id": s["id"], "name": s["name"], "rule": s["rule"], "sl_mult": bt["sl_mult"], "tp_r": bt["tp_r"],
            "hist": bt["hist"], "wf": wf["per_strategy"][s["id"]], "wf_mtf": wf_f["per_strategy"][s["id"]],
            "ok": bt["ok"], "ok_mtf": bf["ok"], "weight": bt["weight"], "state": state,
            "plan": plan, "recent": recent,
        })

    trend = int(trend_of(d.iloc[-1:])[0])
    norm = score / weight_sum if weight_sum > 0 else 0.0
    verdict = "KÖP" if norm >= 0.25 else "SÄLJ" if norm <= -0.25 else "AVVAKTA"
    strength = min(100, round(abs(norm) * 100))

    # Gemensam handelsplan för den samlade signalen: stoploss 2 × ATR, mål 1R / 2R / 3R
    plan = None
    if verdict != "AVVAKTA":
        dr = 1 if verdict == "KÖP" else -1
        risk = 2 * last.atr
        e = last.Close
        plan = {"dir": dr, "entry": round(e, dec), "sl": round(e - dr * risk, dec),
                "tp1": round(e + dr * risk, dec), "tp2": round(e + dr * 2 * risk, dec),
                "tp3": round(e + dr * 3 * risk, dec), "risk_pct": round(risk / e * 100, 2)}

    seg = d.iloc[show_from:]
    candles = [[fmt_time(ts, tf["id"]), round(r.Open, dec), round(r.High, dec), round(r.Low, dec), round(r.Close, dec)]
               for ts, r in seg.iterrows()]
    lines = {k: [round(float(v), dec) if np.isfinite(v) else None for v in seg[k]] for k in ("ema20", "ema50", "ema200")}
    chg = (last.Close / d.Close.iloc[-2] - 1) * 100 if n > 1 else 0
    return {
        "tf": tf["id"], "tf_name": tf["name"], "tf_short": tf["short"], "last_time": fmt_time(d.index[-1], tf["id"]),
        "close": round(float(last.Close), dec), "change_pct": round(float(chg), 2),
        "verdict": verdict, "score": round(norm, 3), "strength": strength, "trend": trend, "plan": plan,
        "mtf": {"higher": higher_ids, "trends": [int(x) for x in ht[-1]] if len(higher_ids) else [],
                "long_ok": bool(long_ok[-1]), "short_ok": bool(short_ok[-1])},
        "notify_ok": notify_ok,
        "ind": {"rsi14": round(float(last.rsi14), 1), "adx": round(float(last.adx), 1),
                "atr": round(float(last.atr), dec), "atr_pct": round(float(last.atr / last.Close * 100), 3),
                "ema20": round(float(last.ema20), dec), "ema50": round(float(last.ema50), dec),
                "ema200": round(float(last.ema200), dec), "macd": round(float(last.macd), 2),
                "macd_sig": round(float(last.macd_sig), 2)},
        "strategies": res_strats, "active": active, "fresh": fresh,
        "candles": candles, "lines": lines, "markers": markers,
        "bars": n, "from": fmt_time(d.index[0], tf["id"]), "wf": wf, "wf_mtf": wf_f,
    }


def combine(tfs: list[dict]) -> dict:
    """Samlad bild över alla tidsramar: snitt av varje tidsrams samlade signal."""
    if not tfs:
        return {"verdict": "AVVAKTA", "score": 0, "strength": 0, "buy": 0, "sell": 0, "wait": 0}
    score = float(np.mean([t["score"] for t in tfs]))
    return {
        "verdict": "KÖP" if score >= 0.25 else "SÄLJ" if score <= -0.25 else "AVVAKTA",
        "score": round(score, 3), "strength": min(100, round(abs(score) * 100)),
        "buy": sum(t["verdict"] == "KÖP" for t in tfs), "sell": sum(t["verdict"] == "SÄLJ" for t in tfs),
        "wait": sum(t["verdict"] == "AVVAKTA" for t in tfs),
        "trend_up": sum(t["trend"] > 0 for t in tfs), "trend_down": sum(t["trend"] < 0 for t in tfs),
    }


# ------------------------------------------------------------------------------ main

def clean(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    if df.empty:
        return df
    df = df[["Open", "High", "Low", "Close"]].dropna()
    df.index = pd.to_datetime(df.index, utc=True)
    if interval == "1d":
        df.index = df.index.normalize()
        df = df[df.index >= df.index[-1] - pd.Timedelta(days=365 * 15)]
    return df[~df.index.duplicated(keep="last")].sort_index()


def fetch_any(symbols: list[str], interval: str, min_rows: int) -> tuple[pd.DataFrame, str]:
    for sym in symbols:
        for attempt in range(3):
            try:
                df = fetch_yahoo(sym, interval)
                break
            except Exception as e:  # noqa: BLE001
                print(f"{sym} {interval}: försök {attempt + 1} misslyckades ({e})", file=sys.stderr)
                df = pd.DataFrame()
                time.sleep(3 * (attempt + 1))
        if len(df) >= min_rows:
            return df, sym
        print(f"{sym} {interval}: för lite data ({len(df)} rader)", file=sys.stderr)
    return pd.DataFrame(), ""


def load(inst: dict, demo: bool, now: pd.Timestamp) -> tuple[dict[str, pd.DataFrame], dict[str, str]]:
    raw, syms = {}, {}
    if demo:
        seed = 1 if inst["id"] == "NDX" else 2
        raw["1d"] = demo_data(seed, "1d", 9000.0 if inst["id"] == "NDX" else 1300.0)
        last = float(raw["1d"].Close.iloc[-1])
        for iv in ("1h", "5m", "1m"):
            raw[iv] = demo_data(seed, iv, last)
        syms = {k: "demo" for k in ("1d", "1h", "5m", "1m")}
    else:
        raw["1d"], syms["1d"] = fetch_any(inst["daily"], "1d", 300)
        for iv in ("1h", "5m", "1m"):
            raw[iv], syms[iv] = fetch_any(inst["intraday"], iv, 300)
    frames, used = {}, {}
    rules = {"4h": "4h", "30m": "30min", "15m": "15min"}
    for tf in TIMEFRAMES:
        src = raw.get(tf["src"])
        if src is None or src.empty:
            continue
        df = clean(src, tf["src"]) if not demo else src
        if tf["id"] in rules:
            df = resample(df, rules[tf["id"]])
        frames[tf["id"]] = drop_unfinished(df, tf["id"], now)
        used[tf["id"]] = syms[tf["src"]]
    return frames, used


def build(demo: bool) -> dict:
    now = pd.Timestamp.now(tz="UTC")
    result = {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "demo": demo,
              "risk_pct": RISK_PCT, "mtf_higher": MTF_HIGHER,
              "notify_rule": {"min_trades": NOTIFY_MIN_TRADES, "min_pf": NOTIFY_MIN_PF, "min_t": NOTIFY_MIN_T}, "instruments": []}
    for inst in INSTRUMENTS:
        frames, used = load(inst, demo, now)
        if not frames:
            print(f"FEL: ingen data för {inst['name']}", file=sys.stderr)
            continue
        price = float(next(iter(frames.values())).Close.iloc[-1])
        cost = inst["cost_pts"] / price  # kostnad som andel av priset
        ready = {k: indicators(v) for k, v in frames.items() if len(v) >= 400}
        for k, v in frames.items():
            if len(v) < 400:
                print(f"{inst['id']} {k}: för lite data ({len(v)})", file=sys.stderr)
        order = [t for t in TIMEFRAMES if t["id"] in ready]
        entry = {"id": inst["id"], "name": inst["name"], "symbols": used, "cost_pts": inst["cost_pts"], "timeframes": []}
        for pos, tf in enumerate(order):
            higher = order[max(0, pos - MTF_HIGHER):pos][::-1]  # närmast högre först
            d = ready[tf["id"]]
            ht = higher_trends(d, tf["id"], [(h["id"], ready[h["id"]]) for h in higher])
            a = analyse(d, inst, tf, cost, ht, [h["id"] for h in higher])
            a["symbol"] = used[tf["id"]]
            entry["timeframes"].append(a)
            w, f = a["wf"], a["wf_mtf"]
            print(f"{inst['name']:<11} {tf['name']:<9} {a['verdict']:<8} {a['strength']:>3} % | utan filter: "
                  f"{w['n']:>4} aff, snitt {w['avg_r'] if w['avg_r'] is not None else '-':>6}R, PF {w['pf']} | "
                  f"med filter: {f['n']:>4} aff, snitt {f['avg_r'] if f['avg_r'] is not None else '-':>6}R, PF {f['pf']}, t {f['t']}, "
                  f"{f['ret_pct']:+.1f} % på {f['years']} år, DD {f['dd_pct']} % | notiser {'JA' if a['notify_ok'] else 'nej'}")
        entry["combined"] = combine(entry["timeframes"])
        result["instruments"].append(entry)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="syntetisk data (ingen nätverksåtkomst behövs)")
    ap.add_argument("--notify", action="store_true", help="skicka nya signaler till Telegram/Discord")
    ap.add_argument("--loop", type=int, default=0, metavar="SEK", help="kör om och om igen med så många sekunders mellanrum")
    ap.add_argument("--state", default=str(ROOT / ".cache" / "trading_sent.json"), help="fil med redan skickade signaler")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    while True:
        t0 = time.time()
        result = build(args.demo)
        (OUT / "signals.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"Sparade {OUT / 'signals.json'} ({time.time() - t0:.0f} s)")
        if args.notify:
            notify.send_new(result, Path(args.state))
        if not args.loop:
            break
        time.sleep(max(5, args.loop - (time.time() - t0)))
    return 0 if len(result["instruments"]) == len(INSTRUMENTS) else 1


if __name__ == "__main__":
    sys.exit(main())
