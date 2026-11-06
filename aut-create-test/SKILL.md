---
name: aut-create-test
description: Schrijft een Playwright-test op basis van een functionele beschrijving (stappen en verwacht resultaat) in een testfile per domein, met page objects en fixtures, één test.step per functionele stap, en draait de test daarna na toestemming van de gebruiker. Gebruik dit wanneer de gebruiker een test of scenario functioneel uitlegt en wil dat die als Playwright-test wordt weggeschreven of een bestaande test wil uitbreiden.
---

# Tests schrijven uit een functionele beschrijving

## Input

De gebruiker beschrijft een test functioneel, bv. als stappen + verwacht resultaat of als Gegeven / Wanneer / Dan. Haal daaruit:

- **Domein en feature**: over welk deel van de applicatie gaat het (bv. `home`, `auth`, `cart`)?
- **Voorwaarden**: moet de gebruiker ingelogd zijn, met welke rol? Moet er data bestaan?
- **Stappen**: de acties van de gebruiker, in volgorde.
- **Verwacht resultaat**: wat de test moet controleren. Elke test heeft minstens één assertion op het verwachte resultaat.
- **Testdata**: vaste waarden in de beschrijving, of gegevens uit `.env` (accounts, wachtwoorden).
- **Varianten**: meerdere scenario's (bv. ook negatieve) worden aparte tests.
- **Taal**: Nederlands of Engels voor de `test.describe`, de testtitel en de `test.step`-teksten (zie "Taal").

## Bij twijfel: vragen, niet zelf beslissen

Als je niet zeker weet wat je moet doen, **stop en vraag het aan de gebruiker** (met AskUserQuestion) voordat je bestanden aanmaakt of wijzigt. Bundel je vragen in één keer en geef bij elke vraag je voorstel als eerste optie. Vraag zeker:

- als het **verwacht resultaat** ontbreekt of vaag is ("het werkt");
- als niet duidelijk is tot welk **domein** de test hoort of in welk bestand;
- als een stap een **element of actie nodig heeft die nog niet in een page object of component staat**: vraag de **broncode** van die pagina/dat onderdeel en maak of breid het page object uit met de `aut-create-page-object` skill. Is er geen broncode, stel dan voor om de pagina live te bekijken via de Playwright MCP (met toestemming, volgens de regels in `aut-create-page-object`, "Pagina live bekijken"). Schrijf nooit losse locators in de test;
- als de test een **flow** nodig heeft (inloggen als rol, testdata aanmaken) waarvoor nog geen flow-fixture bestaat: stel de fixture voor en vraag welke rollen, `.env`-variabelen en succescontrole nodig zijn;
- als testdata **gevoelig** is (accounts, wachtwoorden): die komen uit `.env`, vraag de naam van de variabelen.

## Werkwijze

1. **Lees de beschrijving** en vul de punten uit "Input" in. Vraag wat ontbreekt, en vraag altijd de **taal** (zie "Taal"), in dezelfde AskUserQuestion als je andere vragen.
2. **Inventariseer wat er al is**: lees `pages/`, `pages/components/` en `fixtures/`. Koppel elke stap aan een bestaande functie of locator. Gebruikt een stap een fixture uit "Gedeelde steps", neem dan die vaste step-naam.
3. **Vul gaten aan**: ontbreekt een element of actie, vraag dan de broncode (of, zonder broncode, bekijk de pagina live via de Playwright MCP na toestemming) en gebruik de `aut-create-page-object` skill. Ontbreekt een flow-fixture, stel ze voor (zie hierboven). Komt er een flow-fixture bij die vaker gebruikt zal worden, voeg ze toe aan "Gedeelde steps".
4. **Bepaal de testfile**: `tests/<domein>/<feature>.spec.ts`. Bestaat dat bestand al, voeg de test toe in de bestaande `test.describe`.
5. **Schrijf de test** volgens "Structuur van een test" hieronder.
6. **Controleer** met `npx tsc` en `npx eslint tests` en los fouten op.
7. **Vraag toestemming en draai de test**, elke keer opnieuw na een wijziging aan de test of een page object (zie "Test draaien").
8. **Rapporteer** (zie "Rapporteren").

## Bestanden en naamgeving

| Wat | Conventie | Voorbeeld |
|---|---|---|
| Map | `tests/<domein>/`, domein in kebab-case | `tests/home/`, `tests/auth/` |
| Bestand | `<feature>.spec.ts`, kebab-case | `tests/auth/login.spec.ts` |
| `test.describe` | Naam van de feature/pagina, in de gekozen taal | `'Inloggen'` / `'Login'` |
| Testtitel | Vast format, in de gekozen taal (zie "Testtitel") | `'Wanneer de gebruiker een fout wachtwoord ingeeft, verschijnt een foutmelding'` / `'When the user enters a wrong password, an error message appears'` |
| `test.step` | Eén per functionele stap, in de gekozen taal | `'Vul een fout wachtwoord in'` / `'Enter a wrong password'` |
| Code (variabelen, functies, fixtures) | Altijd Engels | `invalidPassword`, `loginPage` |
| Commentaar in de code | Altijd Engels | `// Soft: each title is an independent check.` |

`test.describe`-namen, testtitels en `test.step`-teksten beginnen **altijd met een hoofdletter**.

## Testtitel

Elke testtitel volgt hetzelfde format: eerst de **actie**, na de komma het **verwachte resultaat**.

| Taal | Format | Met voorwaarde (enkel als ze ertoe doet) |
|---|---|---|
| Nederlands | `Wanneer <actie>, <verwacht resultaat>` | `Als <voorwaarde>, wanneer <actie>, <verwacht resultaat>` |
| Engels | `When <action>, <expected result>` | `Given <precondition>, when <action>, <expected result>` |

Regels:
- **Eén zin.** Het verwachte resultaat is wat de laatste `test.step` controleert.
- **De actor staat erin**: "de gebruiker" / "the user", een rol ("een admin", "een gast"), of bij API-tests "de API" / "the API".
- **Tegenwoordige tijd en functioneel**: geen locators, functienamen of statuscodes. Zichtbare labels (bv. "Get started") mogen.
- **Een voorwaarde** (rol, bestaande data, ingelogd zijn) enkel als ze het gedrag bepaalt, bv. `Als admin, wanneer ...`.
- **Herhaal de pagina of feature niet**: die staat al in `test.describe`.
- Begint met een hoofdletter, en is uniek binnen de `test.describe`.
- De `test.step`-teksten blijven kort en gebiedend ("Klik op Get started" / "Click Get started").

Voorbeelden:

| Nederlands | Engels |
|---|---|
| Wanneer de gebruiker op Get started klikt, opent de introductiepagina | When the user clicks Get started, the introduction page opens |
| Wanneer de gebruiker een fout wachtwoord ingeeft, verschijnt een foutmelding | When the user enters a wrong password, an error message appears |
| Als gast, wanneer de gebruiker Green Room verlaat, opent het dashboard | Given a guest, when the user leaves the Green Room, the dashboard opens |
| Wanneer een pet wordt toegevoegd, geeft de API het nieuwe id terug | When a pet is added, the API returns the new id |

Komt de test uit een **Testmo-case**, volg dan toch dit format (de case-naam in Testmo mag anders zijn), en koppel de case met de annotation `{ type: 'testmo', description: '<case_id>' }`.

## Taal

- `test.describe`, testtitels en `test.step`-teksten (ook de boodschap van een assertion, bv. `` `Titel '${title}'` ``) zijn **Nederlands of Engels, naar keuze van de gebruiker**. Vraag het altijd met AskUserQuestion, tenzij de gebruiker de taal al noemde.
- **Bestaat de testfile al**, geef dan de taal van de bestaande `test.describe` als voorstel (eerste optie), en meld dat een andere keuze twee talen in één bestand geeft. Meng nooit twee talen binnen één `test.describe`.
- Code en commentaar zijn **altijd Engels**: dat is het framework, los van de taal van de test. Vraag daar niet naar.

## Structuur van een test

```ts
import { test, expect } from '../../fixtures';

test.describe('Homepagina', () => {
  test('Wanneer de gebruiker op Get started klikt, opent de introductiepagina', async ({ docsIntroPage, homePage, page }) => {
    await test.step('Open de homepagina', async () => {
      await homePage.goto();
    });

    await test.step('Klik op Get started', async () => {
      await homePage.clickGetStarted();
    });

    await test.step('De introductiepagina van de documentatie wordt getoond', async () => {
      // Hard: without the right page the checks below are pointless.
      await expect(page).toHaveURL(/\/docs\/intro/);
      // Soft: independent checks, so the report lists all missing titles.
      for (const title of ['Introduction', 'Installing Playwright']) {
        await expect.soft(docsIntroPage.sectionHeading(title), `Titel '${title}'`).toBeVisible();
      }
    });
  });
});
```

Regels:
- Importeer `test` en `expect` **altijd uit `fixtures`** (relatief pad naar `fixtures/index.ts`), nooit uit `@playwright/test`.
- Page objects, componenten en flow-fixtures komen binnen als **fixture-argument** (`async ({ homePage }) => ...`). Nooit `new HomePage(page)` in een test.
- **Eén `test.step` per functionele stap** uit de beschrijving, met de tekst van de gebruiker zo letterlijk mogelijk. Het verwachte resultaat is een eigen, laatste step. Zo leest het HTML-rapport als de functionele beschrijving. Uitzondering: voor een fixture uit "Gedeelde steps" gebruik je **altijd de vaste step-naam**, ook als de gebruiker het anders verwoordt.
- In de test enkel **functies en locators van page objects/componenten**. Geen `page.getByRole(...)`, `page.locator(...)` of andere locators in de test; ontbreekt er iets, vul dan het page object aan (na broncode te vragen). `page` mag wel voor pagina-brede assertions zoals `toHaveURL` en `toHaveTitle`.
- Enkel **web-first assertions** (`toBeVisible`, `toHaveText`, `toHaveURL`, `toHaveCount`, ...). Nooit `waitForTimeout` of handmatige waits.
- Kies per assertion tussen `expect` en `expect.soft` (zie "Harde of soft assertion").
- Elke Playwright-call en elke `test.step` wordt **ge-`await`ed** (ESLint `no-floating-promises`).
- Elke test is **onafhankelijk**: geen afhankelijkheid van de volgorde of van een andere test. Gemeenschappelijke setup van alle tests in een `describe` (bv. `goto()`) mag in een `test.beforeEach`.
- **Geen gevoelige data in de code**: accounts en wachtwoorden komen uit `.env` via een flow-fixture.
- Bestaat de testfile al: **voeg toe**, wijzig of verwijder geen bestaande tests zonder te vragen.

## Gedeelde steps

Flow-fixtures die in veel tests terugkomen, krijgen overal **dezelfde step-naam**, zodat elk HTML-rapport dezelfde stap op dezelfde manier toont. Kies de kolom in de taal van de `test.describe`. Eén step per aanroep, met enkel die aanroep erin:

```ts
await test.step('Inloggen als standard_user', async () => {
  await loginAsStandard();
});
```

| Fixture | Nederlands | Engels |
|---|---|---|
| `loginAs(user)` | `Inloggen als <user>` (bv. `Inloggen als visual_user`) | `Log in as <user>` |
| `loginAsProblem()` | `Inloggen als problem_user` | `Log in as problem_user` |
| `loginAsStandard()` | `Inloggen als standard_user` | `Log in as standard_user` |

Regels:
- **Neem de naam exact over**: geen synoniemen ("Log in als ...", "Aanmelden als ..."), geen extra woorden.
- **Nieuwe flow-fixture** die vaker gebruikt zal worden (bv. een nieuwe rol, testdata aanmaken via de UI): stel een step-naam in beide talen voor, laat de gebruiker die bevestigen, en voeg ze toe aan deze tabel, alfabetisch op fixture.
- **Afwijkende naam in een bestaande test**: pas ze niet stilzwijgend aan. Meld het en vraag of ze gelijkgetrokken moet worden.
- Precondities die niet als step in de test horen (bv. `existingUser`, een user die vóór de test aangemaakt wordt) staan **niet** in deze tabel: die krijgen geen step.

## Harde of soft assertion

Kies per assertion of de test moet stoppen als ze faalt.

| | `expect` (hard) | `expect.soft` (soft) |
|---|---|---|
| Bij falen | De test stopt meteen | De test gaat door. Op het einde faalt hij, met alle mislukte checks in het rapport |
| Gebruik wanneer | De volgende stappen niet zinvol zijn als dit faalt | Het een op zichzelf staande controle is en de volgende stappen er niet van afhangen |
| Voorbeelden | De juiste pagina is geopend (`toHaveURL`, de paginatitel). Inloggen is gelukt. Een dialoog is open voor je erin klikt. Een element is zichtbaar voor je erop klikt | Een lijst titels, labels of links die allemaal aanwezig moeten zijn. Meerdere velden van een detailpagina. De teksten in een footer |

Regels:
- **Hard is de standaard.** Gebruik soft enkel als de test na een fout nog iets zinvols kan controleren.
- **Een voorwaarde voor een volgende stap is altijd hard.** Een soft assertion vóór een actie die erop steunt, geeft een tweede, misleidende fout (een timeout op de klik).
- **Soft assertions horen samen in de laatste step met het verwachte resultaat**, of in een step met enkel controles. Volgt er nog een actie na een groep soft assertions, zet daar dan een harde controle vóór, of `expect(test.info().errors).toHaveLength(0)`, zodat de test stopt als er al iets misliep.
- **Geef soft assertions in een lus een boodschap**, zodat je in het rapport ziet welke waarde faalde: `` expect.soft(locator, `Titel '${title}'`) ``.
- Gebruik geen soft assertion om een test "groen te houden". Ook een soft assertion die faalt, maakt de test rood.

## Test draaien

**Draai nooit een test zonder toestemming.** Vraag het de gebruiker (met AskUserQuestion) **elke keer** voordat je een test draait, ook bij een nieuwe run na een aanpassing. Een eerder akkoord geldt niet voor een volgende run. Bied deze opties aan:

1. enkel chromium (voorstel): `npx playwright test tests/<domein>/<feature>.spec.ts --project=chromium`
2. alle browsers (chromium, firefox, webkit): `npx playwright test tests/<domein>/<feature>.spec.ts`
3. niet draaien: de gebruiker draait de test zelf. Geef dan het commando mee.

Geeft de gebruiker geen toestemming, rapporteer dan dat de test niet gedraaid is.

**Stabiliteitscheck voor een nieuwe test.** Is de test groen, stel dan (opnieuw met toestemming) een stabiliteitscheck voor, om flakiness op te vangen vóór de test in de suite komt:

```
npx playwright test tests/<domein>/<feature>.spec.ts -g "<testtitel>" --project=chromium --repeat-each=20 --workers=4
```

`-g` met de testtitel zorgt dat de test **alleen** draait, zonder de andere tests uit het bestand. Zo controleer je ook dat hij onafhankelijk werkt. Faalt hij ook maar één keer van de 20, dan is hij flaky: meld het en stel de skill `aut-fix-flaky-test` voor. Weigert de gebruiker, vermeld dan in het rapport dat de stabiliteitscheck niet gedraaid is.

Faalt de test:
- Zoek de oorzaak in de foutmelding (en eventueel de trace/screenshot in `test-results/`).
- **Ligt het aan de test** (verkeerde locator, verkeerde aanname over de flow): pas de test of het page object aan en vraag opnieuw toestemming om te draaien. Gaat het om een locator in een page object, vraag dan de broncode als je het juiste element niet kan afleiden.
- **Lijkt het aan de applicatie te liggen** (het verwacht resultaat uit de beschrijving klopt niet met wat de app doet): **pas de assertion niet aan om de test groen te krijgen.** Stop en meld het aan de gebruiker als mogelijke bug, met de foutmelding.

## Rapporteren

Kort, aan het einde:
- aangemaakte/gewijzigde testfiles en page objects;
- per test de titel en de steps;
- het resultaat van de laatste testrun (per browser), of dat de test niet gedraaid is;
- het resultaat van de stabiliteitscheck (bv. *20/20 groen*), of dat die niet gedraaid is;
- aannames die je deed en mogelijke bugs in de applicatie.
