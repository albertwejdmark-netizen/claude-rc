# Stöd & Motstånd

En hemsida som visar stöd- och motståndsnivåer för aktier, med candlestick-graf, nivåtabell och klassiska pivotpunkter.

## Så räknas nivåerna
1. **Svängpunkter**: en dag räknas som svängtopp/-botten om dess högsta/lägsta är högst/lägst inom ±N dagar (*Känslighet*).
2. **Zoner**: svängpunkter som ligger inom *Zonbredd × ATR(14)* från varandra slås ihop till en nivå.
3. **Styrka**: fler träffar och färskare träffar väger tyngre. Nivåer under kursen är stöd, över är motstånd.
4. **Pivotpunkter** (P, R1–R3, S1–S3) räknas från förra dagen, veckan eller månaden.

Allt räknas i webbläsaren, så reglagen uppdaterar direkt.

## Data
- `watchlist.txt` listar aktierna (Yahoo Finance-symboler, svenska har `.ST`). Lägg till eller ta bort rader där.
- GitHub Actions (`.github/workflows/pages.yml`) hämtar 5 års dagsdata med `yfinance` varje vardagskväll och publicerar sidan på GitHub Pages.
- Du kan också ladda upp en egen CSV (kolumner: Datum, Öppning, Högst, Lägst, Stängning, Volym; engelska namn fungerar också).

## Kom igång
1. Slå ihop koden till `main`.
2. Gå till **Settings → Pages** och välj **Source: GitHub Actions**.
3. Kör arbetsflödet manuellt en gång (**Actions → Uppdatera data och publicera hemsidan → Run workflow**).

Lokalt:
```bash
pip install yfinance
python scripts/fetch_data.py
cd site && python -m http.server 8000   # öppna http://localhost:8000
```

*Endast i informationssyfte, inte investeringsrådgivning.*
