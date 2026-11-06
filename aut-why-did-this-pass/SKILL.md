---
name: aut-why-did-this-pass
description: Onderzoekt groene Playwright-tests met de vraag of ze terecht groen zijn - het omgekeerde van debuggen. Leest de test, page objects en fixtures op assertions die niet kunnen falen, niet uitgevoerd worden of het verkeerde controleren, bekijkt de trace van een groene run, en bewijst met sabotage in een tijdelijke kopie (verwachte waarde fout zetten, actie overslaan, app-respons breken via page.route) of de test rood kan worden. Oordeelt per test terecht groen, twijfelachtig groen of vals groen, schrijft de analyse weg in analyses/ en past zelf nooit code aan. Gebruik dit wanneer de gebruiker vraagt waarom een test groen is, of een test wel iets test, of een test terecht slaagt, of hij vals positief is, of de tests te vertrouwen zijn, of wanneer een test groen is terwijl de app stuk lijkt.
---

# Why did this pass?

## Doel

Debuggen vraagt *waarom is deze test rood?* Deze skill vraagt het omgekeerde: **waarom is deze test groen, en is dat terecht?** Een groene test is pas iets waard als hij **rood wordt wanneer de functionaliteit stuk is**. Een test die altijd slaagt, is erger dan geen test: hij geeft vals vertrouwen.

De skill **onderzoekt en stelt voor, maar past zelf nooit iets aan**: geen tests, page objects, fixtures, config of `.env`. De enige uitzondering is een **tijdelijke sabotagekopie** van de testfile (zie "Sabotage"), die altijd weer verwijderd wordt.

## Wanneer

- De gebruiker vraagt of een test (of een testfile, of een domein) wel iets test, of terecht groen is.
- Een test is groen terwijl de app volgens een tester of een bugticket stuk is.
- Een nieuwe test uit `aut-create-test` is meteen groen en de gebruiker wil zeker zijn dat hij kan falen.
- Na een fix van `aut-fix-flaky-test` of een aangepaste assertion: is de test niet afgezwakt?
- Een test is nooit rood geweest in de geschiedenis (Testmo of CI) en de gebruiker vertrouwt dat niet.

## Input

Haal uit de vraag, en vraag wat ontbreekt:
- **welke test(s)**: testfile en testtitel, een hele testfile, of een domein (`tests/<domein>/`). Bij meer dan 5 tests: vraag of de gebruiker ze allemaal wil, of eerst de belangrijkste;
- **wat de test hoort te bewijzen**: de functionele beschrijving of de Testmo-case. Staat er een case-nummer in de code (bv. `case #12696`) of noemt de gebruiker er een, lees die case dan via de Testmo MCP. Zonder beschrijving leid je het verwachte resultaat af uit de testtitel (`Wanneer <actie>, <verwacht resultaat>`), en zeg je dat;
- **eventuele aanleiding**: een bugticket in `bugs/`, een analyse in `analyses/`, of een melding dat de app stuk is.

## Werkwijze

1. **Opruimen**: zoek naar achtergebleven sabotagekopieën (`tests/**/*.why-did-this-pass.spec.ts`) van een eerdere oproep. Gevonden: meld ze en vraag of ze weg mogen.
2. **Verwachting bepalen**: wat moet de test bewijzen, volgens de beschrijving of de Testmo-case? Schrijf het verwachte resultaat in één of enkele zinnen uit, **vóór** je de code leest. Zo beoordeel je de test op wat hij moet doen, en niet op wat hij toevallig doet.
3. **Statisch lezen**: lees de test en **alles wat hij gebruikt**: page objects, componenten, fixtures (ook flow-fixtures en `api/`). Loop de "Rode vlaggen" af.
4. **Dekking vergelijken**: zet elk verwacht resultaat uit stap 2 naast de assertion die het controleert. Een verwacht resultaat zonder assertion is een gat.
5. **Groene run bekijken** (met toestemming, zie "Draaien"): tel welke assertions echt uitgevoerd zijn en wat de pagina toonde op het moment van de assertion.
6. **Sabotage** (met toestemming): bewijs dat de test rood kan worden.
7. **Oordelen** per test (zie "Oordeel").
8. **Wegschrijven** naar `analyses/` (zie "Sjabloon") en **rapporteren** in de chat.
9. **Volgende stap** voorstellen (zie "Doorgeven"). Doe niets zonder akkoord.

Stap 5 en 6 mogen overgeslagen worden als de gebruiker niet wil draaien. Het oordeel steunt dan enkel op stap 3 en 4: zeg dat, en zet de zekerheid hoogstens op **middel**.

## Rode vlaggen

Patronen die een test groen maken zonder dat hij iets bewijst. Controleer ze allemaal, ook in page objects en fixtures.

### De assertion wordt nooit (echt) uitgevoerd

- **Geen `expect`** in de test, of enkel in een tussenstap en niet in de laatste `test.step` (het verwachte resultaat).
- **Niet ge-`await`e `expect`** op een locator of op `page`: de promise loopt los en de test eindigt voor hij faalt. De lintregel `no-floating-promises` vangt dit normaal, maar check of er `eslint-disable` staat of de file niet gelint wordt.
- **Lus over een lege lijst**: `for (const item of await locator.all())` of een array uit de app die leeg kan zijn. Nul elementen = nul assertions = groen. Een vaste lijst in de test (zoals `sectionTitles`) heeft dit probleem niet.
- **Voorwaardelijke assertion**: `if (await x.isVisible()) { await expect(...) }`. Is het element er niet, dan wordt er niets gecontroleerd.
- **Fouten ingeslikt**: `try { ... } catch {}`, `.catch(() => {})`, of een fixture die een fout opvangt en verder gaat.
- **Overgeslagen**: `test.skip`, `test.fixme`, een voorwaardelijke `test.skip(condition)`, of `test.fail` (dan is groen = "faalde zoals verwacht"). In `results.json` is de status dan `skipped` of `expectedStatus: failed`, en het HTML-rapport telt hem niet als rood.
- **`test.only` elders** in een lokale run, waardoor deze test niet draaide.

### De assertion kan niet falen

- **Altijd waar**: `expect(locator).toBeTruthy()` / `toBeDefined()` (een `Locator`-object bestaat altijd), `expect(await locator.count()).toBeGreaterThanOrEqual(0)`, `toContainText('')`, `toHaveURL(/.*/)`, `expect(true).toBe(true)`.
- **Te losse match**: een regex of `toContainText` die ook op de verkeerde pagina of de foutpagina past (bv. `toHaveURL(/docs/)` na een klik die naar `/docs/intro` moet, terwijl je al op `/docs/` stond; `toContainText('Error')` die ook "No errors" vindt).
- **Verwachte waarde uit de app zelf**: de test leest een tekst uit de pagina en vergelijkt die later met dezelfde of een afgeleide tekst. Dat bewijst enkel dat de pagina consistent is, niet dat ze klopt.
- **De test controleert wat hij zelf deed**: `fill('x')` en daarna `toHaveValue('x')`. Dat test de browser, niet de app. Het verwachte resultaat zit meestal een stap verder (opgeslagen, getoond na reload, bevestigingsmelding).
- **Grote tolerantie**: `toHaveScreenshot` met hoge `maxDiffPixels` / `threshold`, of numerieke vergelijkingen met een te ruime marge.

### De assertion controleert het verkeerde

- **Was al waar vóór de actie**: het element of de URL die gecontroleerd wordt, stond er al voor de klik of de submit. Bv. een kop die in de navigatie staat en niet op de doelpagina, of een succesmelding van een vorige poging.
- **Verkeerd element**: een te brede locator met `.first()` / `.nth()` die een ander element vindt dan bedoeld, of een `getByText` die ook in de header of footer staat. Bekijk in de trace of page snapshot **welk** element gevonden werd.
- **Negatieve assertion met een foute locator**: `not.toBeVisible()`, `toBeHidden()` of `toHaveCount(0)` slaagt altijd als de locator niets kan vinden (typfout, verkeerde rol of naam). Controleer dat de locator het element **wel** vindt in de toestand waarin het er hoort te zijn.
- **Negatieve assertion te vroeg**: `not.toBeVisible()` op een foutmelding vlak na een submit slaagt meteen, voor de melding de kans had om te verschijnen. Wacht eerst op een positief teken dat de actie afgelopen is.
- **Enkel de status gecontroleerd** (API): `expect(response.ok()).toBeTruthy()` of `toBe(200)` zonder de body, terwijl het verwachte resultaat over de inhoud gaat. Of de body wordt gecontroleerd tegen de request die de test zelf stuurde, zonder het aangemaakte object terug op te halen.
- **Gemockt**: `page.route` of een fixture die de respons vervangt, waardoor de test de mock test en niet de app. Mocken mag, maar dan moet het verwachte resultaat over de UI-logica gaan en niet over de backend.
- **Dekking onvolledig**: het verwachte resultaat heeft drie delen, de test controleert er één.

### Groen door geluk

- **`status: flaky`** in `results.json` (CI, na retry): telt als groen in de pipeline, maar is het niet. Doorgeven aan `aut-fix-flaky-test`.
- **Afhankelijk van bestaande data of de volgorde**: de test slaagt omdat een andere test of een vorige run de data al klaarzette.
- **`waitForTimeout`** gevolgd door een niet-wachtende check (`isVisible()`, `textContent()`): slaagt zolang de app snel genoeg is, en checkt een momentopname.

## Draaien

**Draai nooit een test zonder toestemming.** Vraag het **elke keer** met AskUserQuestion, ook als je eerder al toestemming kreeg. Toon het exacte commando.

Bundel om het aantal vragen klein te houden: alle sabotagevarianten van één testfile komen in **één** sabotagekopie, die met **één** commando draait.

| Run | Commando |
|---|---|
| Groene run met trace | `npx playwright test <file> -g "<titel>" --project=chromium --trace=on` |
| Sabotagerun | `npx playwright test <kopie> --project=chromium --trace=on` |

- `--trace=on` is nodig: de config bewaart traces enkel bij gefaalde tests.
- Eén browser volstaat (`chromium`, of de browser waar de vraag over gaat): het gaat om de logica van de test, niet om de browser.
- Een nieuwe run maakt `test-results/` leeg. Kopieer de traces die je nodig hebt **meteen na elke run** naar de bewijsmap (zie "Bestandsnaam").

### Groene run lezen

Pak de trace uit in een nieuwe map in de scratchpad (op Windows: `/c/Windows/System32/tar.exe -xf trace.zip -C <map>` in Bash, of `Expand-Archive`). In `test.trace` staat elke stap, ook elke `expect`:
- **tel de `expect`-stappen** per `test.step` en vergelijk met wat je in de code verwacht. Minder = een assertion werd overgeslagen (lus, `if`, skip);
- kijk bij elke `expect` **op welk element** hij matchte en hoe lang hij duurde. Een assertion van 0 ms die slaagt vlak na een actie is verdacht: misschien was het al waar vóór de actie;
- bekijk in `*-trace.trace` en `*-trace.network` of er `pageError`s, console-fouten of 4xx/5xx-responses zijn **terwijl de test groen is**. Dat is een sterke aanwijzing voor een vals groen, of voor een applicatiebug die de test mist;
- bekijk de frames in `screencast/` rond de laatste `test.step`: toont de pagina echt het verwachte resultaat?

## Sabotage

Het sterkste bewijs dat een test terecht groen is: **hij wordt rood als je het verwachte resultaat kapotmaakt.** Blijft hij groen na sabotage, dan is hij vals groen, met zekerheid hoog.

### Regels

- Saboteer **nooit** de originele testfile, page objects, fixtures, config of de applicatie.
- Maak een **kopie** van de testfile naast het origineel: `tests/<domein>/<feature>.why-did-this-pass.spec.ts`. Dan blijven de relatieve imports (`../../fixtures`) werken. Dit patroon staat in `.gitignore`.
- Neem in de kopie **enkel de te onderzoeken test(s)** op, één keer per variant. Begin elke titel met `[SABOTAGE <letter>]`, zodat in de output meteen duidelijk is welke variant wat deed.
- Heb je een page object of fixture nodig met ander gedrag, overschrijf het dan **lokaal in de kopie** (bv. via `test.extend` of door de actie in de kopie over te slaan), niet in `pages/` of `fixtures/`.
- Saboteer via `page.route` **enkel lezend verkeer** of door een respons te vervangen. Laat nooit een wijzigende request (POST, PUT, DELETE) door naar de echte app als dat niet ook in de originele test gebeurt.
- **Verwijder de kopie altijd** na de run, ook als de run faalt of afgebroken wordt. Controleer daarna met `git status` dat er geen kopie achterbleef en dat er niets anders gewijzigd is.

### Varianten

Kies per test de varianten die passen bij het verwachte resultaat. Minstens A en B, en C of D als de test op data van de app steunt.

| Variant | Wat je doet in de kopie | Moet de test... | Blijft hij groen, dan... |
|---|---|---|---|
| **A. Foute verwachting** | Vervang de verwachte waarde in elke assertion van de laatste step door iets wat niet kan kloppen (`'Introduction'` → `'Introduction-SABOTAGE'`, `/\/docs\/intro/` → `/\/docs\/sabotage/`) | rood worden | wordt de assertion niet uitgevoerd of niet ge-`await` |
| **B. Actie overslaan** | Laat de stap weg die het verwachte resultaat veroorzaakt (de klik, de submit, de navigatie) | rood worden | was het verwachte resultaat al waar vóór de actie: de test bewijst de actie niet |
| **C. App-respons breken** | `page.route` op de request waar het resultaat van afhangt: `route.fulfill({ status: 500 })`, een lege lijst, of een body met een andere waarde | rood worden | controleert de test niet wat de app teruggeeft, of is hij gemockt |
| **D. Element weghalen** | Na het laden het verwachte element verwijderen of verbergen met `page.evaluate` (alleen in de kopie) | rood worden | kijkt de assertion naar een ander element dan bedoeld |
| **E. Negatieve check omdraaien** | Bij `not.toBeVisible()` / `toBeHidden()` / `toHaveCount(0)`: zet de toestand waarin het element **wel** hoort te verschijnen, en controleer met de positieve assertion dat de locator het vindt | groen worden (de locator vindt het) | kan de locator het element nooit vinden: de negatieve check slaagt altijd |

Wordt een variant **om de verkeerde reden** rood (bv. variant B faalt op een timeout in een latere actie, niet in de assertion van het verwachte resultaat), dan telt dat niet als bewijs. Kijk in de foutmelding **welke** stap en **welke** assertion faalde.

## Oordeel

Kies per test **één** oordeel, met een zekerheid: **hoog** (sabotage bevestigt het), **middel** (statisch en de groene run zijn eenduidig, geen sabotage) of **laag** (enkel statisch, of tegenstrijdig bewijs).

| Oordeel | Betekenis |
|---|---|
| **Terecht groen** | Elk verwacht resultaat wordt gecontroleerd, de assertions zijn uitgevoerd en specifiek genoeg, en de sabotagevarianten maken de test rood om de juiste reden |
| **Twijfelachtig groen** | De test kan falen, maar dekt niet alles: een deel van het verwachte resultaat ontbreekt, een assertion is te los, of hij slaagt door geluk (data, timing). Benoem precies wat hij **niet** zou opmerken |
| **Vals groen** | De test kan niet rood worden voor het verwachte resultaat: een sabotage blijft groen, of een assertion wordt aantoonbaar niet uitgevoerd of controleert iets wat altijd waar is |
| **Onbeslist** | Te weinig bewijs (geen beschrijving, geen run, sabotage niet mogelijk). Zeg wat ontbreekt |

Zie je in de groene run dat de **app zelf stuk** is (foutmelding op de screenshot, 5xx, `pageError`) terwijl de test groen is, dan is de test vals groen **en** is er een mogelijke applicatiebug. Meld beide.

Wees eerlijk in beide richtingen: een test die terecht groen is, noem je zo. Zoek geen probleem om er een te vinden.

## Doorgeven

| Oordeel | Volgende stap |
|---|---|
| Terecht groen | Niets. Vermeld welke sabotages hem rood maakten, als bewijs |
| Twijfelachtig groen | Beschrijf wat de test mist en geef een **voorstel** voor de extra of strengere assertion als codefragment. **Pas niets aan.** De gebruiker beslist of hij `aut-create-test` (test) of `aut-create-page-object` (ontbrekende locator) gebruikt |
| Vals groen | Idem, met voorrang. Bij `status: flaky` of timing: stel `aut-fix-flaky-test` voor |
| Mogelijke applicatiebug | Vraag of er een bugticket gemaakt moet worden. Bij akkoord: start `bug-create-report` in **testmodus**, met het pad naar de analyse |
| Onbeslist | Vraag de ontbrekende informatie |

Een voorstel **verzwakt nooit** een assertion en voegt geen `waitForTimeout`, retries of `force: true` toe. Het voorstel volgt de regels van `CLAUDE.md`: geen locators in de test, `expect` niet in page objects.

## Bestandsnaam

```
analyses/<YYYY-MM-DD>_<HH-mm>_groen-<korte-beschrijving>.md
analyses/<YYYY-MM-DD>_<HH-mm>_groen-<korte-beschrijving>/   (traces van de groene run en de sabotagerun)
```

- Datum en tijd van het systeem, met `date "+%Y-%m-%d_%H-%M"` (Bash). Geen `:` in de naam.
- Het voorvoegsel `groen-` onderscheidt deze analyses van die van `bug-analyze-test-failure`.
- Korte beschrijving in het Nederlands, kleine letters, kebab-case, zonder accenten, maximaal ±50 tekens. Bv. `groen-installatiepagina-titels`.
- Bewaar ook de **inhoud van de sabotagekopie** als `sabotage.spec.ts.txt` in de bewijsmap (`.txt`, zodat Playwright hem niet oppikt), zodat de varianten na verwijdering van de kopie nog na te lezen zijn.
- `analyses/` staat in `.gitignore`. Maak de map aan als ze nog niet bestaat.

## Sjabloon

Eén bestand per oproep. De sectie `## Test` komt één keer per onderzochte test.

```markdown
# Why did this pass: <korte titel>

- **Datum en tijd:** <YYYY-MM-DD HH:mm>
- **Onderzocht:** <testfile(s)>
- **Verwachting uit:** Testmo-case #<nr> | functionele beschrijving van de gebruiker | testtitel (geen beschrijving)
- **Bewijs:** `analyses/<naam>/`

## Samenvatting

<Per test één regel: testtitel [project] → oordeel (zekerheid)>

## Test: <testtitel> [<project>]

- **Testfile:** `tests/<domein>/<feature>.spec.ts:<regel>`
- **Oordeel:** Terecht groen | Twijfelachtig groen | Vals groen | Onbeslist
- **Zekerheid:** hoog | middel | laag

### Wat de test moet bewijzen

<Verwacht resultaat in 1 tot 3 zinnen, met de bron>

### Dekking

| Verwacht resultaat | Assertion | Uitgevoerd in groene run? | Beoordeling |
|---|---|---|---|
| <deel 1> | `<assertion>` (`<bestand>:<regel>`) | ja, <n>× / nee / niet gedraaid | ok / te los / ontbreekt / controleert iets anders |

### Rode vlaggen

<Gevonden patronen met bestand:regel, of "geen">

### Groene run

<Aantal uitgevoerde expect-stappen per step, opvallende assertions (0 ms, verkeerd element), console- en netwerkfouten, wat de pagina toonde. Of "niet gedraaid">

### Sabotage

| Variant | Wat | Resultaat | Faalde op | Conclusie |
|---|---|---|---|---|
| A | <wat aangepast> | rood / groen | <step + assertion> | <bewijst ... / bewijst niets> |

<Of "niet gedraaid" met de reden>

### Conclusie

<Waarom dit oordeel, in 2 tot 5 zinnen. Wat zou de test NIET opmerken als het stuk ging?>

### Voorstel

<Codefragment voor een strengere of extra assertion. Dit is een voorstel: er is niets aangepast>

### Volgende stap

<bv. Niets | Assertion toevoegen via aut-create-test | Locator toevoegen via aut-create-page-object | Bugticket via bug-create-report | aut-fix-flaky-test>
```

## Rapporteren

Kort, in de chat:
- per test: het oordeel, de zekerheid, en in één zin **wat de test niet zou opmerken** (of dat hij terecht groen is en welke sabotage dat bewees);
- het pad naar de analyse;
- de voorgestelde volgende stap, en de vraag of je die mag zetten;
- expliciet dat er **niets aangepast** is aan de code, en dat de sabotagekopie verwijderd is (met de uitkomst van `git status`).
