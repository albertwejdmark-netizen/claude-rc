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
| **Lappar** | Värdelappar hos ditt spelbolag (Bet365 eller bwin) och värdesinglar, med föreslagen insats efter din spelkassa (¼ Kelly, högst 3 %). Bygg egna lappar med ditt spelbolags odds. Sparade lappar rättas automatiskt, och "Din statistik" visar resultat och stängningsvärde. |
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

## Lappstrategi
En lapp läggs hos ett spelbolag, så strategierna testas med odds från ett och samma bolag (eller det högsta av Bet365 och bwin, spelat som singlar). Det rättvisa priset räknas från snittoddsen med power-metoden, som tar mer av marginalen från långa odds. Den träffade bättre än att dela marginalen lika (log-loss 1X2 1,0021 mot 1,0030 och 0,9836 mot 0,9859) och tog bort falska värdespel på långa odds. Resultat i huvudligorna (förra säsongen / innevarande):

| Strategi | Resultat | Stängningsvärde | Slog stängningsoddset |
|---|---|---|---|
| Säker dubbel/trippel (högst chans), Bet365 | −13 till −15 % / −9 till −14 % | −2 till −3 % | 24–30 % |
| Värdesinglar, Bet365 eller bwin | +20 % (19 spel) / +6 % (16 spel) | +6,5 % / +4,9 % | 68 % / 75 % |
| Värdesinglar, bästa odds | +15 % (224 spel) / −12 % (68 spel) | +6,6 % / +13,8 % | 74 % / 84 % |

Stängningsvärdet (oddset jämfört med marknadens rättvisa pris vid avspark) säger mest om en strategi går plus i längden, eftersom resultatet på några hundra spel styrs av slumpen. Värdespel är få: några per månad hos ett enskilt bolag. Generatorn föreslår därför singlar med insats efter spelkassan (¼ Kelly, högst 3 %), och dubblar bara när samma bolag har två värdespel.

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
