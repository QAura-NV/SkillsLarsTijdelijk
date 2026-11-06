---
name: bug-html-report
description: Maakt van één of alle .txt-bugtickets uit skills-bugs/ een overzichtelijk HTML-rapport in de stijl van het Playwright HTML-rapport (lijst met filter op ernst en zoekveld, detailpagina per bug, screenshots en video's), voor stakeholders. Vraagt welke tickets, welke screenshots/video's bij welk ticket horen, de taal, en of er een zip gemaakt moet worden om te versturen. Gebruik dit wanneer de gebruiker bugs wil tonen, delen of versturen aan stakeholders, of een HTML-rapport, overzicht of zip van de bugtickets wil.
---

# HTML-rapport van bugtickets

## Doel

De bugtickets uit `skills-bugs/` (gemaakt met `bug-create-report`) omzetten naar **één HTML-pagina** die stakeholders zonder tools kunnen openen:

- een **lijst** zoals het Playwright-rapport: filter-chips per ernst met aantallen, een zoekveld, één rij per bug met ernst, prioriteit, datum en aantal bijlagen;
- een **detailpagina** per bug met alle velden, de stappen als genummerde lijst, de screenshots en video's, en een link naar het originele ticket;
- licht en donker thema volgens het systeem, ook leesbaar op een gsm.

Het rapport wordt gemaakt door het script **`generate.js`** naast deze skill. Schrijf de HTML **nooit zelf**: zo ziet elk rapport er hetzelfde uit.

## Werkwijze

1. **Inventariseer** met Glob: de tickets `skills-bugs/*.txt` en mogelijke bijlagen in `skills-bugs/` en `skills-bugs/media/` (afbeeldingen: png, jpg, jpeg, gif, webp, svg, bmp; video: mp4, webm, ogg, mov, m4v; andere bestanden zoals logs worden een downloadlink). Negeer `skills-bugs/reports/`.
   - Geen tickets: meld het en stel `bug-create-report` voor.
2. **Lees elk ticket** dat in aanmerking komt. Staat er iets in dat op een wachtwoord, token of ander geheim lijkt, **stop en meld het**: het rapport gaat naar stakeholders. Ga pas verder als de gebruiker het ticket aanpaste of uitdrukkelijk akkoord gaf.
3. **Vraag** met één AskUserQuestion (voorstel als eerste optie):
   - **Welke tickets**: alle tickets, of één ticket (welk). Zijn er meer dan drie tickets, bied dan "Alle tickets" en "Eén ticket" aan en vraag daarna welk ticket, met de titels als opties of via "Other".
   - **Bijlagen**: zijn er screenshots of video's? Toon de bestanden die je in stap 1 vond. Zijn er nog geen, zeg dan dat de gebruiker ze in **`skills-bugs/media/`** mag plaatsen en daarna laat weten.
   - **Taal** van het rapport (knoppen en labels): Nederlands of Engels. Voorstel: de taal van de tickets. De inhoud van de tickets wordt nooit vertaald.
   - **Zip**: moet er een zip gemaakt worden om het rapport makkelijk te versturen?
4. **Koppel de bijlagen aan de tickets** (enkel als er bijlagen zijn): stel een koppeling voor op basis van de bestandsnamen die in het veld **Bijlagen / Attachments** van elk ticket staan, en vraag de gebruiker die te bevestigen of aan te vullen. Gok nooit: een bijlage die je niet kan koppelen, vraag je. Een bijlage mag bij meerdere tickets horen.
5. **Bepaal de naam** van de outputmap (zie "Output") met `date "+%Y-%m-%d_%H-%M"`.
6. **Schrijf de config** naar de scratchpad (niet in het project) en **draai het script**:
   ```
   node .claude/skills/bug-html-report/generate.js <scratchpad>/bug-report-config.json
   ```
   ```json
   {
     "outDir": "skills-bugs/reports/2026-11-05_10-30_alle-bugs",
     "title": "Bugrapport",
     "lang": "nl",
     "tickets": [
       { "file": "skills-bugs/2026-11-04_12-27_admin-krijgt-verkeerd-bedrag.txt", "attachments": ["skills-bugs/media/premie.png", "skills-bugs/media/premie.mp4"] },
       { "file": "skills-bugs/2026-11-04_09-47_inloggen-mislukt.txt", "attachments": [] }
     ]
   }
   ```
   Het script kopieert de tickets naar `tickets/` en de bijlagen naar `attachments/<ticket>/` in de outputmap, en schrijft `index.html`. Het weigert een outputmap die al bestaat.
7. **Zip** (enkel als de gebruiker dat wou), de **inhoud** van de outputmap, met de zip ernaast:
   - Windows (PowerShell): `Compress-Archive -Path "skills-bugs/reports/<naam>/*" -DestinationPath "skills-bugs/reports/<naam>.zip"`
   - macOS/Linux (Bash): `cd skills-bugs/reports/<naam> && zip -r ../<naam>.zip .`
8. **Rapporteer** (zie "Rapporteren").

De originele tickets en bijlagen in `skills-bugs/` worden **nooit** gewijzigd, verplaatst of verwijderd: het script kopieert ze enkel.

## Output

```
skills-bugs/reports/<YYYY-MM-DD>_<HH-mm>_<korte-beschrijving>/
  index.html                         # het rapport, opent in elke browser
  tickets/<ticket>.txt               # kopie van elk originele ticket
  attachments/<ticket>/<bestand>     # kopie van de bijlagen per ticket
skills-bugs/reports/<YYYY-MM-DD>_<HH-mm>_<korte-beschrijving>.zip   # enkel op vraag
```

- Korte beschrijving: kleine letters, kebab-case, zonder accenten, maximaal ±50 tekens, in de taal van het rapport: bv. `alle-bugs` / `all-bugs`, of de korte beschrijving uit de bestandsnaam van het ene ticket.
- `skills-bugs/` staat in `.gitignore`, dus ook de rapporten en zips.
- Het rapport is **zelfstandig**: geen internet of server nodig. Verstuur altijd de **hele map of de zip**, niet enkel `index.html`, anders ontbreken de bijlagen.

## Enkel het formaat van bug-create-report

Het script leest **enkel** tickets in het huidige sjabloon van `bug-create-report`, in het Nederlands of het Engels:

- de **titel** op de eerste regel;
- alle **12 velden** met hun vaste kopjes (`Probleembeschrijving:` ... `Bijlagen:` / `Problem Description:` ... `Attachments:`);
- `Ernst: <waarde>` / `Severity: <waarde>` en `Prioriteit: <waarde>` / `Priority: <waarde>` op één regel.

Een ticket dat daar niet aan voldoet (een ouder formaat, een ontbrekend veld, tekst buiten een veld) wordt **geweigerd**: het script schrijft dan **niets** en meldt per ticket wat er mis is. Pas in dat geval **niet het script** aan. Meld het aan de gebruiker en stel voor om het ticket te herschrijven met `bug-create-report`, of het weg te laten uit het rapport.

Weergave:
- **Ernst** en **Prioriteit** worden badges. Kleur van de ernst: Kritiek/Critical rood, Groot/Major oranje, Klein/Minor geel, Triviaal/Trivial grijs. Prioriteit: Hoog/High oranje, Middel/Medium geel, Laag/Low grijs.
- **Stappen om te reproduceren** wordt een genummerde lijst.
- **Statistieken**, **Omgevingsinformatie** en **Aanvullende informatie**: de subvelden (`Browser: ...`) worden een tabel, vrije tekst eronder.
- `Niet opgegeven` / `Not provided` wordt grijs en cursief getoond. Links (`http(s)://...`) worden klikbaar.
- De lijst is gesorteerd op ernst en daarna op datum (nieuwste eerst). De datum komt uit de bestandsnaam (`YYYY-MM-DD_HH-mm_...`).

## Controle

Na het genereren:
- Controleer dat het script geen fout gaf en dat het aantal tickets en bijlagen in zijn output klopt.
- Bied aan om het rapport te openen: `start "" "skills-bugs/reports/<naam>/index.html"` (Windows) of `open` (macOS). Open het niet zonder te vragen.

## Rapporteren

Kort, aan het einde:
- het pad naar `index.html` en, als gemaakt, naar de zip;
- welke tickets erin staan (titel en ernst) en per ticket de bijlagen;
- tickets die er vreemd uitzagen of bijlagen die niet gekoppeld konden worden;
- de herinnering om de hele map of de zip te versturen, niet enkel `index.html`.
