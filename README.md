# Stöd & Motstånd

En hemsida som visar stöd- och motståndsnivåer för amerikanska aktier, med candlestick-graf, nivåtabell, klassiska pivotpunkter och long-signaler.

## Så räknas nivåerna
1. **Svängpunkter**: en dag räknas som svängtopp/-botten om dess högsta/lägsta är högst/lägst inom ±N dagar (*Känslighet*).
2. **Zoner**: svängpunkter som ligger inom *Zonbredd × ATR(14)* från varandra slås ihop till en nivå.
3. **Styrka**: fler träffar och färskare träffar väger tyngre. Nivåer under kursen är stöd, över är motstånd.
4. **Pivotpunkter** (P, R1–R3, S1–S3) räknas från förra dagen, veckan eller månaden.

## Bättre nivåer
- Svängpunkter grupperas mot gruppens snitt och närliggande grupper slås ihop.
- Varje svängpunkt väger efter färskhet, volym (relativ volym) och om den syns även på längre sikt (3× svängfönstret).
- **Respekterad %**: hur ofta kursen vände i zonen jämfört med hur ofta den stängde igenom.
- **Rollbyte**: nivåer som varit både stöd och motstånd får bonus.
- Nivåerna visas som zoner (övre/undre kant) i grafen och tabellen.

## Stoploss och take profit
Handelsplanen visar köp, stoploss och TP1–TP3 med avstånd i % och R-multipel, för en aktiv signal eller annars för köp på senaste kurs.
- **Stoploss**: under stödzonen (standard) eller 1,5 / 2 / 3 × ATR under köpet.
- **Take profit**: nästa tre motstånd (fylls på med R-multiplar om det saknas motstånd) eller 1R / 2R / 3R.
- Varje historisk signal följs upp: vilka TP som nåddes innan stoploss.

## Signaler
Signalerna utvärderas på dagens stängning mot nivåerna som fanns dagen innan (ingen framåtblick):

| Signal | Typ | Regel |
|---|---|---|
| Long | Utbrott | Stänger över ett motstånd med minst ¼ ATR marginal |
| Long | Studs på stöd | Dagens lägsta når stödzonen, stänger över stödet, grön dag |

- **Trendfilter** (valbart): signaler bara när kursen ligger över SMA 50.
- **Minsta risk/belöning** filtrerar bort signaler med för litet mål i förhållande till stoppet.
- Varje historisk signal följs upp (mål nått, stoppad eller aktiv) och sidan visar träffsäkerhet och snitt-R för perioden.
- **Signalöversikten** skannar alla aktier i listan efter färska signaler.

Allt räknas i webbläsaren, så reglagen uppdaterar direkt.

## Data
- `watchlist.txt` listar aktierna (Yahoo Finance-symboler, just nu drygt 120 amerikanska aktier). Lägg till eller ta bort rader där.
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
