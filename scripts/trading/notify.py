"""Skickar nya signaler från signalboten till Telegram och/eller Discord.

Inställningar (miljövariabler, i GitHub: Settings → Secrets and variables → Actions):
    TELEGRAM_BOT_TOKEN  token från @BotFather
    TELEGRAM_CHAT_ID    ditt chatt-id (eller en kanals @namn)
    DISCORD_WEBHOOK_URL webhook-adress från en Discord-kanal
    SITE_URL            (valfritt) länk till hemsidan, läggs till i meddelandet

    NOTIFY_WINDOW_MIN   (valfritt) hur gamla signaler som skickas, i minuter (standard 20)

Skickar:
  * nya strategisignaler som klarar filtret för högre tidsramar, på tidsramar som tjänat
    pengar i walk-forward-testet (se build_messages)
  * när den samlade signalen byter läge på en sådan tidsram (t.ex. AVVAKTA → KÖP)
Redan skickade signaler sparas i en state-fil så att inget skickas två gånger.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ARROW = {1: "🟢 LONG", -1: "🔴 SHORT"}
VERDICT_ICON = {"KÖP": "🟢", "SÄLJ": "🔴", "AVVAKTA": "⚪"}


def fmt(x) -> str:
    return f"{x:,.1f}".replace(",", " ").replace(".", ",")


def trend_line(inst: dict) -> str:
    arrow = {1: "▲", -1: "▼", 0: "–"}
    return "Trend: " + "  ".join(f"{t['tf_short']} {arrow[t['trend']]}" for t in inst["timeframes"])


def build_messages(result: dict, state: dict, now: float | None = None) -> tuple[list[str], dict]:
    """Skickar bara signaler som klarar alla villkor:
    1. strategin används (har tjänat pengar) i testet med filter för högre tidsramar,
    2. de högre tidsramarnas trend stämmer med signalen när den kom,
    3. tidsramen har tjänat pengar i walk-forward-testet med filtret (tillräckligt många affärer,
       vinstfaktor och t-värde, se build.py),
    4. signalens bar stängde nyligen (NOTIFY_WINDOW_MIN minuter, minst en bar)."""
    now = now if now is not None else time.time()
    window = float(os.environ.get("NOTIFY_WINDOW_MIN", "20")) * 60
    sent = set(state.get("sent", []))
    verdicts = dict(state.get("verdicts", {}))
    first_run = not state
    arrow = {1: "▲", -1: "▼", 0: "–"}
    msgs = []
    for inst in result["instruments"]:
        tl = trend_line(inst)
        for tf in inst["timeframes"]:
            key_tf = f"{inst['id']}|{tf['tf']}"
            w = tf["wf_mtf"]
            bar_sec = {"1d": 86400, "4h": 14400, "1h": 3600, "30m": 1800, "15m": 900, "5m": 300, "1m": 60}[tf["tf"]]
            for f in tf["fresh"]:
                if not (tf["notify_ok"] and f["counts_mtf"] and f["aligned"]):
                    continue
                if now - f["close_ts"] > max(window, bar_sec * 1.5):
                    continue
                key = f"{key_tf}|{f['strategy']}|{f['time']}|{f['dir']}"
                if key in sent:
                    continue
                sent.add(key)
                age = max(0, round((now - f["close_ts"]) / 60))
                higher = ", ".join(f"{h} {arrow[t]}" for h, t in zip(tf["mtf"]["higher"], f["higher"])) or "ingen (högsta tidsramen)"
                msgs.append(
                    f"{ARROW[f['dir']]} {inst['name']} ({tf['tf_name'].lower()}, {tf.get('symbol', '')})\n"
                    f"Strategi: {f['name']}  ·  för {age} min sedan\n"
                    f"Kurs: {fmt(f['price'])}  SL: {fmt(f['sl'])}  TP: {fmt(f['tp'])} ({f['tp_r']:g}R)\n"
                    f"Högre tidsramar: {higher}\n"
                    f"{tl}\n"
                    f"Testat: {w['n']} affärer, vinst {round((w['win'] or 0) * 100)} %, snitt {w['avg_r']:+.2f}R, PF {w['pf']}".replace(".", ",")
                )
            prev = verdicts.get(key_tf)
            verdicts[key_tf] = tf["verdict"]
            if tf["notify_ok"] and prev is not None and prev != tf["verdict"] and not first_run:
                p = tf["plan"]
                line = (f"{VERDICT_ICON[tf['verdict']]} {inst['name']} ({tf['tf_name'].lower()}): "
                        f"{prev} → {tf['verdict']} ({tf['strength']} %)\nKurs: {fmt(tf['close'])}")
                if p:
                    line += f"\nSL: {fmt(p['sl'])}  TP1: {fmt(p['tp1'])}  TP2: {fmt(p['tp2'])}  TP3: {fmt(p['tp3'])}"
                msgs.append(line + "\n" + tl)
    # spara bara de senaste nycklarna så att filen inte växer för evigt
    return msgs, {"sent": sorted(sent)[-3000:], "verdicts": verdicts}


def post(url: str, data: dict, as_json: bool) -> None:
    if as_json:
        body, headers = json.dumps(data).encode(), {"Content-Type": "application/json"}
    else:
        body, headers = urllib.parse.urlencode(data).encode(), {}
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


def send_new(result: dict, state_file: Path) -> None:
    state = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except ValueError:
            state = {}
    msgs, new_state = build_messages(result, state)
    tg_token, tg_chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    discord = os.environ.get("DISCORD_WEBHOOK_URL")
    site = os.environ.get("SITE_URL", "").strip()
    footer = "\n\nEndast information, inte investeringsrådgivning." + (f"\n{site}" if site else "")

    if not msgs:
        print("Inga nya signaler att skicka")
    elif not (tg_token and tg_chat) and not discord:
        print("Nya signaler, men varken Telegram eller Discord är inställt:")
        for m in msgs:
            print("---\n" + m)
    else:
        text = "\n\n".join(msgs) + footer
        for chunk in [text[i:i + 3800] for i in range(0, len(text), 3800)]:
            if tg_token and tg_chat:
                try:
                    post(f"https://api.telegram.org/bot{tg_token}/sendMessage",
                         {"chat_id": tg_chat, "text": chunk, "disable_web_page_preview": "true"}, as_json=False)
                except Exception as e:  # noqa: BLE001
                    print(f"Telegram misslyckades: {e}", file=sys.stderr)
            if discord:
                for part in [chunk[i:i + 1900] for i in range(0, len(chunk), 1900)]:
                    try:
                        post(discord, {"content": part}, as_json=True)
                    except Exception as e:  # noqa: BLE001
                        print(f"Discord misslyckades: {e}", file=sys.stderr)
        print(f"Skickade {len(msgs)} signaler")
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(new_state, ensure_ascii=False), encoding="utf-8")
