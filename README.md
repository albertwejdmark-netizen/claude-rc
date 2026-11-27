# Stöd & Motstånd

En hemsida som visar stöd- och motståndsnivåer för alla aktier i S&P 500, med candlestick-graf, nivåtabell, klassiska pivotpunkter och long-signaler.

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

## Strategier (från backtest)
`scripts/backtest.js` testar tusentals kombinationer av filter på alla aktier. Strategierna valdes på 122 aktier med data före 2025; siffrorna nedan är kontrollen på alla ~506 aktier i S&P 500 med data från 2025. Arbetsflödet *Backtest av signalerna* kör det i GitHub Actions.

| Strategi | Regler | Vinst (TP1 före SL), kontroll | Snitt per affär |
|---|---|---|---|
| **Utbrott med volym** (standard) | Utbrott, volym ≥ 1,8 × snitt, stängning i översta fjärdedelen av dagen, nivå respekterad ≥ 60 %, SL 3 × ATR, TP 1R/2R/3R | 52 % | +0,10 R |
| Studs på stöd | Studs, kurs över SMA 50, stängning i övre halvan, nivå respekterad ≥ 60 %, RSI ≤ 70, SL 3 × ATR, TP nästa motstånd | 61 % | +0,04 R |
| Ursprungliga reglerna | Utbrott + studs, kurs över SMA 50, SL under stödzonen, TP nästa motstånd, R/R ≥ 1 | 37 % | +0,04 R |

Historiskt resultat är ingen garanti. Courtage och slippage är inte medräknat.

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
- **Alla aktier i S&P 500** hämtas automatiskt. Listan över bolag hämtas från [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) vid varje körning, så ändringar i indexet följer med. `sp500.csv` är en reservkopia.
- `watchlist.txt` är för **extra** aktier utanför S&P 500.
- GitHub Actions (`.github/workflows/pages.yml`) hämtar 5 års dagsdata med `yfinance` varje vardagskväll, räknar fram signalöversikten i förväg (`scripts/scan.js`) och publicerar sidan på GitHub Pages.
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

---

# Matchlabbet (fotboll)

`site/fotboll/` är en hemsida som analyserar alla matcher i 33 europeiska fotbollsligor, Champions League, Europa League, Conference League och sex nationella cuper: chanser och rättvisa odds för alla vanliga spel, lag- och domarstatistik, spelförslag och en lappbyggare. Den publiceras på samma GitHub Pages-sida under `/fotboll/` (länk finns uppe till höger på aktiesidan).

## Vyer
| Vy | Innehåll |
|---|---|
| **Matcher** | Kommande matcher per dag och liga: chans till 1/X/2, odds, över 2,5 och båda lagen gör mål. Grönt odds = spelvärde. |
| **Matchsida** | Alla spel (1X2, dubbelchans, mållinjer, båda gör mål, lagmål, första halvlek, hörnor, kort, asiatiskt handikapp) med chans, rättvist odds, odds och värde. Lagjämförelse hemma/borta, form, inbördes möten och domare. |
| **Spelförslag** | Alla spel på alla kommande matcher, filtrerbart på marknad, chans, odds, värde, dag och liga. Snabbval: värdespel, säkra spel, mål, båda gör mål, hörnor, kort. |
| **Lappar** | Bygg en lapp, skriv in ditt spelbolags odds och se totalodds, verklig chans och förväntat värde. Lappgeneratorn föreslår tre lappar efter strategi. Sparade lappar rättas automatiskt. |
| **Lag** | Sorterbar tabell över alla lag (översikt, mål, hörnor och kort, resultat om man spelat varje match) med uppdelning alla/hemma/borta/senaste 6. Lagsidor med all statistik, sviter och matchlista. |
| **Domare** | Kort per match, kortfaktor mot ligasnittet, över 3,5/4,5 kort, fouls, mål och hemmavinster, plus kommande uppdrag. |
| **Ligor** | Europacuper, ligor och cuper: tabell, snitt, senaste resultat (med hörnor, kort, skott och bollinnehav) och topplistor. |
| **Modell** | Hur chanserna räknas och hur de har träffat i backtestet. |

## Så räknas chanserna
1. **Statistikmodell (Dixon–Coles):** anfalls- och försvarsstyrka per lag från mål blandat med xG (eller skott på mål där xG saknas), två säsonger bakåt med halveringstid 180 dagar. Nyuppflyttade lag startar svagare, nedflyttade starkare.
2. **Marknaden:** snittoddsen för 1X2 och över/under 2,5 räknas om till förväntade mål utan spelbolagens marginal.
3. **Kombination:** vikten mellan modell och marknad väljs i backtestet på förra säsongen och kontrolleras på den nuvarande. Hittills har oddsen träffat bättre än statistikmodellen ensam (log-loss 1,005 mot 1,025), så vikten för modellen är 0 och chanserna för mål och resultat bygger på marknaden. Modellens egen bedömning visas ändå på matchsidan.
4. **Hörnor och kort:** lagens snitt för och emot i förhållande till ligasnittet, negativ binomialfördelning. Korten justeras med domarens kortfaktor.
5. **Cuper:** en gemensam modell över alla lag i alla tävlingar. Europacupmatcherna och cupmatcherna mellan divisioner knyter ihop ligorna, så lag från olika länder går att jämföra. Hörnor och kort räknas på samma sätt, där varje match jämförs med sin egen tävlings snitt.

**Värde** = chans × odds − 1. Spel som saknar odds i datan (t.ex. båda gör mål, hörnor, kort) visar ett uppskattat odds med ≈; jämför rättvist odds med ditt spelbolag.

Backtestet (`scripts/fotboll/build.py`) skattar om modellen varje vecka på matcherna före och tippar veckans matcher. Spel med minst 3 % värde mot bästa odds och odds upp till 5 gav +7 % förra säsongen (707 spel) och +9 % hittills i år (169 spel). Utan oddstak blev det förlust. Säkra spel (chans ≥ 70 %) gick in lika ofta som bedömt men gav −2 % till snittodds. Inget av detta är en garanti.

## Data
- [football-data.co.uk](https://www.football-data.co.uk): resultat, halvtid, skott, hörnor, kort, fouls, xG, domare (England och Skottland) och odds för 22 huvudligor (tre säsonger), resultat och stängningsodds för 10 extra ligor, samt kommande matcher med odds.
- ESPN:s öppna API (`scripts/fotboll/espn.py`): Champions League, Europa League, Conference League, FA-cupen, Ligacupen, Copa del Rey, DFB-Pokal, Coppa Italia, Coupe de France och Eerste Divisie; hörnor, kort, skott, fouls och halvtid för Sverige, Norge, Danmark, Österrike och Ryssland; bollinnehav; spelschemat en vecka framåt med odds från DraftKings. Lagen paras ihop med football-data genom att jämföra matcher samma dag med samma resultat.
- Schweiz, Polen, Rumänien, Finland och Irland har bara resultat och odds, eftersom ingen gratis källa har mer.
- GitHub Actions bygger datan varje morgon och tisdag/fredag eftermiddag (nya odds) i samma arbetsflöde som aktiesidan.

Lokalt:
```bash
pip install numpy
python scripts/fotboll/build.py          # hämtar data och bygger site/fotboll/data/
python scripts/fotboll/build.py --tune   # jämför modellinställningar i backtestet
cd site && python -m http.server 8000    # öppna http://localhost:8000/fotboll/
```

*Statistik och sannolikheter, inga garantier. Spela bara för pengar du har råd att förlora. 18 år. Stöd: [stodlinjen.se](https://www.stodlinjen.se), 020-81 91 00.*

---

# Signalbot (Nasdaq 100 och guld)

`site/trading/` visar köp- och säljsignaler för **Nasdaq 100** och **guld** på sju tidsramar: dag, 4 timmar, timme, 30, 15, 5 och 1 minut. Alla tidsramar kombineras innan en signal skickas, och varje kombination testas med walk-forward så att man ser om den faktiskt hade fungerat. Sidan publiceras under `/trading/`, och boten kan skicka signaler till Telegram eller Discord.

## Data
| Tidsram | Källa | Historik hos Yahoo |
|---|---|---|
| Dag | `^NDX` / `GC=F` | 15 år (begränsat i koden) |
| 4 timmar, timme | `NQ=F` / `GC=F`, timdata (4 h byggs av timdata) | 2 år |
| 30, 15, 5 min | `NQ=F` / `GC=F`, 5-minutersdata | 60 dagar |
| 1 min | `NQ=F` / `GC=F` | 30 dagar |

Nasdaq under dagen tas från terminen NQ=F, som handlas nästan dygnet runt precis som CFD:n US100. Spread och slippage dras med 2,5 punkter (Nasdaq) och 0,6 dollar (guld) per affär.

## Strategier
Fem regelbaserade strategier, åt båda hållen (long och short):

| Strategi | Regel |
|---|---|
| Trendföljning | EMA 20 korsar EMA 50 i samma riktning som EMA 200, ADX > 20 |
| Utbrott | Stänger över 20-bars högsta / under 20-bars lägsta, EMA 50 rätt sida om EMA 200 |
| Rekyl i trend | Upptrend och RSI 14 vänder upp över 40 (spegelvänt för short) |
| MACD-vändning | MACD korsar signallinjen under nollan (long) / över nollan (short), rätt sida om EMA 200 |
| Översåld/överköpt | RSI 2 < 10 i upptrend, eller > 90 i nedtrend |

Inträde på nästa bars öppning. Stoploss 1,5 / 2 / 3 × ATR och mål 1 / 1,5 / 2 / 3 R väljs per strategi och tidsram. Når en bar både stopp och mål räknas det som stopp.

## Kombination av tidsramar
En signal tas bara när de **två närmast högre tidsramarna** inte är i motsatt trend och minst en av dem går åt samma håll (trend = kurs och EMA 50 över/under EMA 200). En köpsignal på 5 minuter kräver alltså att 15 och 30 minuter inte är i nedtrend. Bara högre staplar som redan stängt räknas, så det finns ingen framåtblick. Sidan visar också en samlad signal över alla sju tidsramar.

## Walk-forward: fungerar det?
Första 40 % av datan är inlärning, resten delas i 6 perioder. Före varje period väljs stopp, mål och strategier bara på data före perioden, och sedan handlas perioden. Det görs både utan och med filtret för högre tidsramar. Resultat med filter (körning 27 nov 2026, 1 % risk per affär):

| | Testat | Affärer | Snitt R | PF | t | Resultat | Notiser |
|---|---|---|---|---|---|---|---|
| Nasdaq 100, dag | 9 år | 191 | +0,37 | 1,65 | 3,0 | +71 % | ja |
| Nasdaq 100, 4 h | 1,4 år | 74 | −0,19 | 0,70 | −1,5 | −14 % | nej |
| Nasdaq 100, timme | 1,4 år | 306 | +0,02 | 1,03 | 0,3 | +7 % | nej |
| Nasdaq 100, 30 / 15 / 5 / 1 min | 18–40 dagar | 53 / 131 / 261 / 505 | +0,08 / +0,17 / +0,14 / −0,01 | | 0,4 / 1,3 / 1,6 / −0,2 | | nej |
| Guld, dag | 9 år | 81 | +0,46 | 1,88 | 2,5 | +37 % | ja |
| Guld, 4 h | 1,4 år | 126 | +0,37 | 1,69 | 2,6 | +47 % | ja |
| Guld, timme | 1,4 år | 320 | +0,37 | 1,69 | 4,0 | +118 % | ja |
| Guld, 30 / 15 / 5 / 1 min | 18–40 dagar | 55 / 77 / 99 / 314 | +0,19 / +0,03 / +0,05 / −0,01 | | 1,1 / 0,2 / 0,5 / −0,1 | | nej |

t-värdet visar hur säkert snittet är skilt från noll. Under 2 kan resultatet lika gärna vara tur. Filtret hjälpte mest på guld timme och på Nasdaq 5–30 min, men på de korta tidsramarna är testet för kort för att säga något säkert. 1 minut gick back både med och utan filter.

## Notiser till Telegram eller Discord
En signal skickas bara om
1. tidsramen klarat walk-forward-testet med filter (minst 30 affärer, PF ≥ 1,1, t ≥ 2),
2. strategin används på tidsramen,
3. de högre tidsramarna stämmer när signalen kommer, och
4. signalen är färsk (högst 20 minuter, minst en och en halv bar).

Varje notis visar kurs, stoploss, mål, de högre tidsramarnas trend, trenden på alla sju tidsramar och testresultatet. Testet görs om vid varje körning, så en kort tidsram börjar skicka notiser om den klarar kraven senare.

Arbetsflödet `.github/workflows/trading-bot.yml` kör boten var 5:e minut på vardagar. GitHub startar schemalagda jobb med några minuters fördröjning, så för 1- och 5-minuterssignaler i realtid kör du boten på en egen dator eller server:
```bash
python scripts/trading/build.py --notify --loop 60
```

Lägg in under **Settings → Secrets and variables → Actions** (eller som miljövariabler lokalt):
- **Telegram:** skapa en bot hos [@BotFather](https://t.me/BotFather), skicka ett meddelande till den och hämta ditt chatt-id (t.ex. via `https://api.telegram.org/bot<TOKEN>/getUpdates`). Spara `TELEGRAM_BOT_TOKEN` och `TELEGRAM_CHAT_ID` som secrets.
- **Discord:** Kanalinställningar → Integrationer → Webhooks → Ny webhook. Spara adressen som secret `DISCORD_WEBHOOK_URL`.
- Valfritt: variabeln `SITE_URL` (länk i meddelandena) och `NOTIFY_WINDOW_MIN` (hur gamla signaler som skickas).

Hemsidan uppdateras av huvudarbetsflödet (fyra gånger per vardag). Notiserna är alltid färska.

Lokalt:
```bash
pip install yfinance numpy pandas
python scripts/trading/build.py            # bygger site/trading/data/signals.json
python scripts/trading/build.py --notify   # och skickar nya signaler
python scripts/trading/build.py --demo     # syntetisk data, utan nätverk
cd site && python -m http.server 8000      # öppna http://localhost:8000/trading/
```

*Endast i informationssyfte, inte investeringsrådgivning. Handel med hävstång kan ge förluster större än insatsen.*
