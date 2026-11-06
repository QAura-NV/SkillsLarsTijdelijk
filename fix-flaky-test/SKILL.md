---
name: fix-flaky-test
description: Zoekt de oorzaak van een flaky Playwright-test (soms rood, soms groen) door hem herhaaldelijk te draaien met --repeat-each en de traces van rode en groene runs te vergelijken, stelt een fix voor als diff en past die pas toe na akkoord, en verifieert met 20 groene runs. Verbergt het probleem nooit met retries, timeouts of waits. Gebruik dit wanneer een test flaky, flakey, instabiel of intermittent is, soms faalt, faalt in CI maar lokaal groen is, slaagt na een retry, of als het HTML-rapport hem als flaky markeert.
---

# Flaky tests fixen

## Doel

Een test is **flaky** als hij soms slaagt en soms faalt zonder dat er iets aan de code verandert. Deze skill zoekt **waarom**, en lost die oorzaak op in de test, het page object of de fixture. De fout verbergen telt niet als oplossing.

Lokaal staat `retries` op 0, dus lokaal krijg je het label "flaky" nooit. Flaky gedrag komt aan het licht via het label in CI (`retries: 2`), via `--repeat-each`, of omdat een test soms rood is.

## Input

Haal uit de vraag van de gebruiker, en vraag wat ontbreekt:
- **testfile en testtitel** (bv. `tests/installation/installation.spec.ts` en `"Wanneer de gebruiker de installatiepagina opent, zijn alle titels zichtbaar"`);
- **browser/project** waarin hij faalde, als dat bekend is;
- **context**: alleen in CI? alleen in één browser? sinds een bepaalde release? alleen bij parallel draaien?
- **bestaand bewijs**: een analyse in `analyses/` (van `analyze-test-failure`), CI-artefacten (`test-results`, `playwright-report`) of een `trace.zip`. Dit is de sterkste bron. Vraag er altijd naar als de flaky run uit CI komt.

Bestaat er al een analyse in `analyses/` voor deze test, begin daar dan en doe dat werk niet opnieuw.

## Toestemming om te draaien

Deze skill wijkt **bewust** af van de algemene regel om voor elke run toestemming te vragen.

1. Vraag **één keer**, vóór de eerste run, met AskUserQuestion. Toon het volledige **testplan** met alle commando's die je mogelijk zal draaien (zie "Testplan").
2. Na akkoord mag je **alle commando's uit dat plan** draaien zonder opnieuw te vragen, ook de verificatie na een fix, binnen **deze ene oproep** van de skill.
3. Het akkoord geldt **niet** voor:
   - andere tests, andere testfiles of de volledige suite;
   - commando's die niet in het plan stonden (bv. een extra browser). Vraag die apart;
   - een volgende oproep van de skill, of het werk van andere skills daarna.
4. Geeft de gebruiker geen akkoord, geef dan de commando's mee en analyseer enkel het bestaande bewijs.

### Testplan

Vervang `<file>`, `<titel>` en `<project>`. Gebruik altijd `-g` met de exacte titel, zodat alleen deze test draait.

| Fase | Commando | Wanneer |
|---|---|---|
| Reproduceren, serieel | `npx playwright test <file> -g "<titel>" --project=<project> --repeat-each=20 --workers=1 --trace=on` | Altijd eerst |
| Reproduceren, parallel | `npx playwright test <file> -g "<titel>" --project=<project> --repeat-each=20 --workers=4 --trace=on` | Als serieel 20/20 groen is |
| Verifiëren | Hetzelfde commando als de reproductie die faalde (zelfde workers) | Na een toegepaste fix |

`--trace=on` zorgt dat je ook traces van **groene** runs hebt, om mee te vergelijken. Zonder `--project` draait elke herhaling in drie browsers. Kies daarom één browser: die waarin hij faalde, of anders `chromium`. Wijst de context naar een specifieke browser, neem die dan op in het plan.

## Verboden "fixes"

Deze verbergen het probleem in plaats van het op te lossen. Ze zijn **nooit** toegelaten, ook niet als tijdelijke oplossing:

- `waitForTimeout`, `setTimeout`, of een andere vaste wachttijd;
- een timeout verhogen: `timeout` in een actie of `expect`, `test.setTimeout`, `test.slow()`, of een timeout in de config;
- `retries` toevoegen of verhogen, ook niet via `test.describe.configure({ retries })`;
- `force: true` op een actie;
- een assertion afzwakken, verwijderen of vervangen door iets wat altijd slaagt;
- `test.skip`, `test.fixme` of `test.fail`;
- `playwright.config.ts`, `.env`, de CI-workflow of de applicatie aanpassen.

Lijkt een van deze de enige oplossing, dan is de oorzaak nog niet gevonden of ligt ze niet in de test. Stop en meld het.

## Werkwijze

1. **Input verzamelen** (zie "Input"). Lees de testfile en de page objects, componenten en fixtures die de test gebruikt.
2. **Bestaand bewijs eerst**: analyseer een CI-trace of een bestaande analyse vóór je lokaal draait (zie "Traces vergelijken").
3. **Toestemming vragen** voor het testplan (één keer).
4. **Bewijs bewaren**: kopieer `test-results/` na **elke** run naar `analyses/<naam>/<fase>/` (bv. `reproductie-serieel`, `reproductie-parallel`, `verificatie`). Een volgende run maakt `test-results/` leeg.
5. **Reproduceren** volgens het plan. Tel per run hoeveel van de 20 herhalingen faalden, uit `test-results/results.json` (elke herhaling is een aparte entry in `specs[].tests[]` met eigen `status`). Gefaalde herhalingen hebben een map met `-repeat<N>` in de naam.
6. **Niet gereproduceerd?** Als zowel serieel als parallel 20/20 groen zijn en er geen trace van een rode run is: **stop**. Zeg dat de flakiness lokaal niet te reproduceren is en gok geen oorzaak. Stel voor wat wel kan helpen: de CI-artefacten van een rode run aanleveren, een andere browser proberen (apart vragen), of de context aanvullen.
7. **Oorzaak bepalen** door rode en groene runs te vergelijken (zie "Traces vergelijken" en "Typische oorzaken").
8. **Classificeren**:
   - **testbug** (oorzaak in test, page object of fixture): ga verder naar stap 9;
   - **applicatiebug** (bv. een race condition in de app, een sporadische 5xx): fix **niets**. Schrijf de analyse en stel `create-bug-report` in **testmodus** voor;
   - **omgeving** (trage of onstabiele testomgeving, externe dienst): fix **niets**. Meld wat je vond en waar het opgelost moet worden.
9. **Fix voorstellen**: toon de **diff** in de chat, met per wijziging één zin uitleg waarom die de oorzaak wegneemt. Vraag akkoord met AskUserQuestion: *toepassen* / *aanpassen* (de gebruiker zegt wat anders moet) / *niet toepassen*. **Pas niets aan voor er akkoord is.**
10. **Fix toepassen** na akkoord, enkel in `tests/`, `pages/` en `fixtures/`, volgens de conventies van `create-test` en `create-page-object`. Controleer met `npx tsc` en `npx eslint .`.
11. **Controle op verboden fixes**: lees je eigen diff na tegen "Verboden fixes". Staat er iets in, draai het dan terug en zoek verder.
12. **Verifiëren** met hetzelfde commando als de reproductie die faalde. De fix is pas goed bij **20/20 groen**. Faalt hij nog, ga dan terug naar stap 7 met de nieuwe traces. Na **twee** mislukte fixpogingen stop je en rapporteer je wat je weet.
13. **Analyse wegschrijven** en **rapporteren** (zie "Sjabloon" en "Rapporteren").

## Traces vergelijken

Pak een trace van een **rode** en van een **groene** herhaling uit in een nieuwe map in de scratchpad. Op Windows: `/c/Windows/System32/tar.exe -xf trace.zip -C <map>`, want de `tar` van Git Bash kan geen zip lezen. Vergelijk:

- **Acties** (`*-trace.trace`): bij welke actie lopen rood en groen uiteen? Wat was de duur van de acties ervoor?
- **DOM / page snapshot** op het moment van falen (`error-context.md`): was het element er nog niet, er twee keer, bedekt, of al weer weg?
- **Netwerk** (`*-trace.network`): kwam een request in rood later binnen, gaf het een andere status, of ontbrak het?
- **Console en page errors**: alleen in de rode run?
- **Screenshots en screencast**: overlay, spinner, animatie, cookie-banner?

Het **verschil** tussen rood en groen is het bewijs. Een oorzaak zonder zo'n verschil is een vermoeden: zeg dat ook zo.

## Typische oorzaken en de juiste fix

| Oorzaak | Signaal in de trace | Juiste fix |
|---|---|---|
| Actie vóór navigatie of rendering klaar is | Rood: klik of assertion op de oude pagina, of vóór de inhoud geladen is | Web-first assertion op de nieuwe staat vóór de volgende stap (`await expect(page).toHaveURL(...)`, `await expect(locator).toBeVisible()`) |
| Niet-web-first check | `expect(await locator.textContent())`, `isVisible()` in een `if`, `count()` direct vergeleken | Vervangen door `await expect(locator).toHaveText(...)`, `toBeVisible()`, `toHaveCount(...)` |
| Locator vindt soms meerdere elementen | Af en toe `strict mode violation`, bv. tijdens een transitie | Locator scherper maken (scopen binnen een `root` of `article`, `exact: true`, rol en naam) in het page object |
| Overlay, cookie-banner of toast bedekt het element | Rood: "element intercepts pointer events" of de overlay staat op de screenshot | Overlay expliciet afhandelen in een fixture of `page.addLocatorHandler`, en wachten tot hij weg is |
| Animatie of verschuivende layout | "element is not stable", klik landt op het verkeerde element | Wachten op de eindstaat met een web-first assertion |
| Gedeelde of resterende testdata | Faalt alleen met `--workers=4`, of alleen na een andere test | Unieke data per test (bv. met `testInfo.workerIndex` of een uniek id), opruimen in de fixture-teardown |
| Afhankelijkheid van volgorde | Faalt alleen als hij solo of als eerste draait | Eigen setup in de test of fixture, geen gedeelde state |
| Tijd of datum | Faalt rond middernacht, het weekend of in een andere tijdzone | `page.clock` gebruiken, of de verwachte waarde berekenen |
| Niet ge-`await`e call | Actie loopt door terwijl de vorige nog bezig is | `await` toevoegen (ESLint `no-floating-promises` zou dit moeten vangen) |

## Bestandsnaam

```
analyses/<YYYY-MM-DD>_<HH-mm>_flaky-<korte-beschrijving>.md
analyses/<YYYY-MM-DD>_<HH-mm>_flaky-<korte-beschrijving>/<fase>/   (bewijs per run)
```

Datum en tijd van het systeem, met `date "+%Y-%m-%d_%H-%M"` (Bash). Korte beschrijving in het Nederlands, kebab-case, zonder accenten, maximaal ±50 tekens.

## Sjabloon

```markdown
# Flaky: <korte titel>

- **Datum en tijd:** <YYYY-MM-DD HH:mm>
- **Test:** `<file>:<regel>` › <testtitel> [<project>]
- **Context:** <van de gebruiker, bv. "faalt soms in CI">
- **Bewijs:** `analyses/<naam>/`

## Reproductie

| Fase | Commando | Resultaat |
|---|---|---|
| Serieel | `...--workers=1` | <x>/20 gefaald |
| Parallel | `...--workers=4` | <x>/20 gefaald of niet gedraaid |

## Oorzaak

- **Categorie:** Testbug | Applicatiebug | Omgeving | Niet gereproduceerd
- **Zekerheid:** hoog | middel | laag

<Wat er gebeurt in rode runs en niet in groene, met het bewijs uit de traces. 3 tot 6 zinnen.>

## Fix

<Diff, of "geen fix: <reden>">

Akkoord van de gebruiker: ja | nee | aangepast

## Verificatie

| Commando | Resultaat |
|---|---|
| `...` | <x>/20 gefaald |

Controle verboden fixes: geen waitForTimeout, geen hogere timeout, geen retries, geen force, geen afgezwakte assertion, geen skip.

## Aanbevelingen

<Optioneel, bv. dezelfde oorzaak in andere tests, of `--fail-on-flaky-tests` in CI zodra de suite stabiel is>
```

## Rapporteren

Kort, in de chat:
- de oorzaak in één of twee zinnen, met de categorie en de zekerheid;
- de faalkans vóór de fix (bv. *4/20*) en erna (bv. *0/20*);
- welke bestanden aangepast zijn, of dat er niets aangepast is en waarom;
- het pad naar de analyse;
- **een expliciete vraag om de diff te reviewen**, vooral op verborgen waits, timeouts of afgezwakte assertions;
- bij een applicatiebug of omgevingsprobleem: de voorgestelde volgende stap.
