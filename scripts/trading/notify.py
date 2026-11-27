"""Skickar nya signaler från signalboten till Telegram och/eller Discord.

Inställningar (miljövariabler, i GitHub: Settings → Secrets and variables → Actions):
    TELEGRAM_BOT_TOKEN  token från @BotFather
    TELEGRAM_CHAT_ID    ditt chatt-id (eller en kanals @namn)
    DISCORD_WEBHOOK_URL webhook-adress från en Discord-kanal
    SITE_URL            (valfritt) länk till hemsidan, läggs till i meddelandet

Skickar:
  * nya strategisignaler som kom på senaste stängda baren (bara strategier som håller i backtestet)
  * när den samlade signalen byter läge (t.ex. AVVAKTA → KÖP)
Redan skickade signaler sparas i en state-fil så att inget skickas två gånger.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ARROW = {1: "🟢 LONG", -1: "🔴 SHORT"}
VERDICT_ICON = {"KÖP": "🟢", "SÄLJ": "🔴", "AVVAKTA": "⚪"}


def fmt(x) -> str:
    return f"{x:,.1f}".replace(",", " ").replace(".", ",")


def build_messages(result: dict, state: dict) -> tuple[list[str], dict]:
    sent = set(state.get("sent", []))
    verdicts = dict(state.get("verdicts", {}))
    first_run = not state
    msgs = []
    for inst in result["instruments"]:
        for tf in inst["timeframes"]:
            key_tf = f"{inst['id']}|{tf['tf']}"
            atr = tf["ind"]["atr"]
            for f in tf["fresh"]:
                if f["bars_ago"] != 0 or not f["counts"]:
                    continue
                key = f"{key_tf}|{f['strategy']}|{f['time']}|{f['dir']}"
                if key in sent:
                    continue
                sent.add(key)
                risk = f["sl_mult"] * atr
                sl = f["price"] - f["dir"] * risk
                tp = f["price"] + f["dir"] * f["tp_r"] * risk
                msgs.append(
                    f"{ARROW[f['dir']]} {inst['name']} ({tf['tf_name'].lower()})\n"
                    f"Strategi: {f['name']}\n"
                    f"Kurs: {fmt(f['price'])}  SL: {fmt(sl)}  TP: {fmt(tp)} ({f['tp_r']:g}R)\n"
                    f"Samlad signal: {tf['verdict']} ({tf['strength']} %)"
                )
            prev = verdicts.get(key_tf)
            verdicts[key_tf] = tf["verdict"]
            if prev is not None and prev != tf["verdict"] and not first_run:
                p = tf["plan"]
                line = (f"{VERDICT_ICON[tf['verdict']]} {inst['name']} ({tf['tf_name'].lower()}): "
                        f"{prev} → {tf['verdict']} ({tf['strength']} %)\nKurs: {fmt(tf['close'])}")
                if p:
                    line += f"\nSL: {fmt(p['sl'])}  TP1: {fmt(p['tp1'])}  TP2: {fmt(p['tp2'])}  TP3: {fmt(p['tp3'])}"
                msgs.append(line)
    # spara bara de senaste nycklarna så att filen inte växer för evigt
    return msgs, {"sent": sorted(sent)[-2000:], "verdicts": verdicts}


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
