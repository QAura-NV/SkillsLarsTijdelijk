---
name: bug-create-report
description: Schrijft een bugticket uit volgens de bug reporting template van het team (titel "As a ..., I can ...", probleembeschrijving, stappen, verwacht/werkelijk resultaat, severity, priority, tijdstip, statistieken, workaround, omgeving, aanvullende info, bijlagen) op basis van een functionele beschrijving van de gebruiker (tester of developer), en bewaart het als .txt-bestand in de map skills-bugs/, in het Nederlands of Engels. Gebruik dit wanneer de gebruiker een bug, fout of afwijkend gedrag wil melden, uitschrijven of als ticket wil vastleggen.
---

# Bugticket uitschrijven

Het ticket volgt de **bug reporting template van het team**: een vaste structuur zodat developers een bug snel begrijpen, reproduceren en oplossen.

Deze skill heeft twee modi:

- **Manuele modus** (standaard): de gebruiker, vaak een **manuele functionele tester**, beschrijft de bug. Alle informatie in het ticket komt **van de gebruiker**, niet uit het Playwright-framework. Zie "Bronnen: enkel wat de gebruiker vertelt".
- **Testmodus**: de skill wordt aangeroepen vanuit `bug-analyze-test-failure` met een analyse van een gefaalde Playwright-test. Zie "Testmodus" onderaan. Gebruik deze modus **enkel** als je vanuit `bug-analyze-test-failure` komt of als de gebruiker expliciet naar een analyse in `skills-analyses/` verwijst.

## Bronnen: enkel wat de gebruiker vertelt (manuele modus)

- Haal **geen** gegevens uit het project: niet uit `.env`, `package.json`, `playwright.config.ts`, `tests/`, `test-results/` of andere bestanden.
- **Verzin niets.** Leid je iets af uit de beschrijving (bv. de stappen herschrijven als genummerde lijst, of de titel in de vorm "As a ..., I can ..."), voeg dan geen stappen, waarden of conclusies toe die de gebruiker niet gaf.
- Het **tijdstip van optreden** komt van de gebruiker: dat is wanneer de bug gebeurde, niet wanneer het ticket gemaakt wordt. Enkel de **datum en tijd voor de bestandsnaam** haal je zelf op van het systeem (zie "Bestandsnaam"). Gok nooit een datum.
- **Geen wachtwoorden of andere geheimen** in het ticket. Geeft de gebruiker er een, vervang die dan door `***` en meld dat.

## Werkwijze

1. **Taal bepalen.** Noemt de gebruiker geen taal, vraag dan eerst: Nederlands of Engels (met AskUserQuestion). De taal geldt voor de headers **en** de inhoud. Voorlopig zijn enkel Nederlands en Engels toegelaten.
2. **Beschrijving lezen** en elk veld uit "Velden" invullen met wat de gebruiker vertelde.
3. **Alle ontbrekende velden vragen**, gebundeld in één keer:
   - keuzevelden (**Severity/Ernst**, **Priority/Prioriteit**) met AskUserQuestion en de vaste waarden als opties, met je voorstel als eerste optie;
   - vrije velden (bv. **Tijdstip van optreden**, **Statistieken**, **Toestel/OS**, **Browser**, **App-versie**, **Geteste gebruiker**, **Bijlagen**) in één bericht met een lijstje van wat ontbreekt.
   - Zegt de gebruiker dat er voor een veld niets is, vul dan de lege waarde in (zie "Lege velden").
4. **Datum en tijd voor de bestandsnaam ophalen** van het systeem.
5. **Ticket wegschrijven** naar `skills-bugs/<bestandsnaam>.txt` volgens "Sjabloon".
6. **Rapporteren**: het pad van het bestand, en het ticket zelf in je antwoord, zodat de gebruiker het kan nalezen. Bied aan om iets aan te passen.

## Bestandsnaam

```
skills-bugs/<YYYY-MM-DD>_<HH-mm>_<korte-beschrijving>.txt
```

- Datum en tijd van het moment van aanmaken, opgehaald met `date "+%Y-%m-%d_%H-%M"` (Bash). Geen `:` in de naam (niet toegelaten in Windows).
- Korte beschrijving: in de taal van het ticket, kleine letters, kebab-case, zonder accenten of leestekens, maximaal ±50 tekens.
- Voorbeeld: `skills-bugs/2026-11-04_14-35_admin-kan-geen-foto-toevoegen-bij-nieuw-bedrijf.txt`
- Bestaat de map `skills-bugs/` nog niet, maak ze dan aan. De map staat in `.gitignore`.

## Velden

Alle velden staan **altijd** in het ticket, in deze volgorde, ook als er geen gegevens zijn.

| # | Engels (template) | Nederlands | Inhoud |
|---|---|---|---|
| 1 | *(titel, zonder header)* | *(titel, zonder header)* | Eén regel in de vorm **"As a <rol>, I can(not) ..."** / **"Als <rol> kan ik (niet) ..."**. Zie "Titel" |
| 2 | Problem Description | Probleembeschrijving | Korte samenvatting van het probleem, **en** de impact op de eindgebruiker |
| 3 | Steps to reproduce | Stappen om te reproduceren | Genummerde stappen |
| 4 | Expected result | Verwacht resultaat | Wat er had moeten gebeuren (volgens de requirement) |
| 5 | Actual result | Werkelijk resultaat | Wat er tijdens de test gebeurde, foutmeldingen letterlijk |
| 6 | Severity | Ernst | Eén van de vaste waarden hieronder |
| 7 | Priority | Prioriteit | Eén van de vaste waarden hieronder |
| 8 | Timestamp of occurrence | Tijdstip van optreden | Wanneer de bug optrad; mag een bereik zijn (bv. `31/10/2024 09:00 - 11:30`) |
| 9 | Statistics | Statistieken | Iterations, Pass rate en Fail rate (zie "Statistieken") |
| 10 | Workaround | Workaround | Is er een workaround, en wat deed de tester om verder te testen? Lost het probleem zichzelf op? |
| 11 | Environmental Information | Omgevingsinformatie | Device/OS, Browser, App Version |
| 12 | Additional Information | Aanvullende informatie | Geteste gebruiker (Admin, manager, klant, ...), links naar gerelateerde feature-tickets, URL, testdata, voorwaarden en andere info die nergens anders past |
| 13 | Attachments | Bijlagen | Screenshots, logs, video's: namen, paden of links die de gebruiker aanlevert |

### Titel

- Engels: `As a <role>, I can ...` of `As a <role>, I cannot ...` (bv. *As an admin, I cannot add a picture when creating a new company*).
- Nederlands: `Als <rol> kan ik ...` of `Als <rol> kan ik niet ...` (bv. *Als admin kan ik geen foto toevoegen bij het aanmaken van een nieuw bedrijf*).
- Eén regel, functioneel, zonder technische termen of locators.
- Noemt de gebruiker geen rol, gebruik dan de rol uit de beschrijving (bv. "bezoeker" als niemand ingelogd is). Is ook dat niet duidelijk, vraag het.

### Vaste waarden

| Veld | Engels | Nederlands |
|---|---|---|
| Severity / Ernst | Critical, Major, Minor, Trivial | Kritiek, Groot, Klein, Triviaal |
| Priority / Prioriteit | High, Medium, Low | Hoog, Middel, Laag |

Betekenis van de severity (gebruik dit als hulp bij het voorstel, de gebruiker beslist):
- **Critical / Kritiek**: de gebruiker kan niet verder, geen workaround, of dataverlies (bv. inloggen onmogelijk).
- **Major / Groot**: belangrijke functionaliteit werkt niet of geeft foute resultaten.
- **Minor / Klein**: functionaliteit werkt gedeeltelijk, of er is een workaround.
- **Trivial / Triviaal**: cosmetisch of klein ongemak (tekst, uitlijning).

Priority is hoe dringend de bug opgelost moet worden. Dat is een keuze van de gebruiker of het team: stel een waarde voor, maar laat altijd kiezen.

### Statistieken

- **Iterations**: hoe vaak de stappen uitgevoerd zijn.
- **Pass rate** en **Fail rate**: `x out of y (z%)` / `x van y (z%)`. Pass + fail = iterations.
- Gaf de gebruiker enkel "altijd" of "soms" zonder aantallen, vraag dan de aantallen. Weet de gebruiker het niet, vul dan de lege waarde in.

### Lege velden

Heeft de gebruiker voor een veld niets, schrijf dan:
- Engels: `Not provided`
- Nederlands: `Niet opgegeven`

## Sjabloon

De titel staat op de eerste regel, zonder header. Elk ander veld krijgt de header op een eigen regel met de inhoud eronder. Severity/Ernst en Priority/Prioriteit staan als `Header: waarde`. Laat één lege regel tussen de velden.

De taal van het ticket (headers, subvelden, vaste waarden, lege waarde en inhoud) volgt **altijd de keuze van de gebruiker** uit stap 1 van de werkwijze. Meng nooit twee talen in één ticket.

Engels (de template van het team):

```
<As a ..., I can(not) ...>

Problem Description:
<korte samenvatting van het probleem>
<impact op de eindgebruiker>

Steps to reproduce:
1. <stap>
2. <stap>

Expected result:
<verwacht resultaat>

Actual result:
<werkelijk resultaat>

Severity: <Critical|Major|Minor|Trivial>

Priority: <High|Medium|Low>

Timestamp of occurrence:
<tijdstip of bereik>

Statistics:
Iterations: <aantal>
Pass rate: <x out of y (z%)>
Fail rate: <x out of y (z%)>

Workaround:
<workaround, en wat de tester deed om verder te testen>
<lost het probleem zichzelf op?>

Environmental Information:
Device/OS: <toestel en besturingssysteem>
Browser: <browser en versie>
App Version: <versie>

Additional Information:
Tested user: <rol>
Feature ticket: <link>
<andere informatie>

Attachments:
<screenshots>
<logs>
<video's>
```

Nederlands: hetzelfde sjabloon met de Nederlandse headers uit de tabel (`Probleembeschrijving:`, `Stappen om te reproduceren:`, ...), de Nederlandse vaste waarden, en in de subvelden `Iteraties`, `Geslaagd`, `Gefaald`, `Toestel/OS`, `Browser`, `App-versie`, `Geteste gebruiker`, `Feature-ticket`.

Regels:
- In **Statistieken**, **Omgevingsinformatie** en **Aanvullende informatie** staan de subvelden altijd. Een leeg subveld krijgt de lege waarde, bv. `App Version: Not provided`.
- In **Aanvullende informatie** zijn `Tested user` en `Feature ticket` vast. Andere info (URL, testdata, voorwaarden) komt eronder als vrije tekst, en enkel als de gebruiker ze gaf.
- In **Bijlagen** komt één bijlage per regel. Zijn er geen, schrijf dan één keer de lege waarde.

## Voorbeeld (Engels)

Beschrijving van de gebruiker: *"Als admin kan ik bij het aanmaken van een nieuw bedrijf geen foto uploaden: er komt '.txt' achter de bestandsnaam, ook al heeft het bestand die extensie niet. Getest op 31/10/2024 in Chrome 130 op Windows 11, Cyclobility web 0.9.8. Drie keer geprobeerd, faalt altijd. Feature ticket: https://documents.calibrate.be/issues/232322. Bijlagen: image.png, SampleVideo.mp4, SampleLog.txt"*

```
As an admin, I cannot add a picture when creating a new company

Problem Description:
When logged in as an administrator and creating a new company, a picture cannot be uploaded to the form. When a file is uploaded, '.txt' is added after the file name, even though the file does not have this extension.
The administrator cannot set a custom picture for a new company.

Steps to reproduce:
1. Open the website.
2. Log in as administrator.
3. Go to Commerce → Companies.
4. Click on 'Add a company'.
5. Scroll down and remove the current picture.
6. Attempt to add a picture from the computer.

Expected result:
A custom picture can be added.

Actual result:
A custom picture cannot be added. '.txt' is added after the file name.

Severity: Minor

Priority: Medium

Timestamp of occurrence:
31/10/2024

Statistics:
Iterations: 3
Pass rate: 0 out of 3 (0%)
Fail rate: 3 out of 3 (100%)

Workaround:
Not provided

Environmental Information:
Device/OS: Windows 11
Browser: Chrome 130
App Version: Cyclobility web 0.9.8

Additional Information:
Tested user: Administrator
Feature ticket: https://documents.calibrate.be/issues/232322

Attachments:
image.png
SampleVideo.mp4
SampleLog.txt
```

## Testmodus

Je komt vanuit `bug-analyze-test-failure`: een gefaalde Playwright-test is geanalyseerd en geclassificeerd als **applicatiebug**. De analyse staat in `skills-analyses/<bestand>.md`.

### Bronnen in testmodus

Naast wat de gebruiker vertelt, mag je **enkel** deze bronnen gebruiken:

- de analyse in `skills-analyses/`;
- `test-results/results.json` en de map van de gefaalde test in `test-results/` (`error-context.md`, screenshots, video, trace);
- de testfile en de page objects die de test gebruikt (om de stappen functioneel te beschrijven);
- `playwright.config.ts` (projectnaam en toestel) en `.github/workflows/playwright.yml` (besturingssysteem in CI).

Nog altijd verboden:
- **`.env` lezen**. Accounts en wachtwoorden komen nooit in het ticket, ook niet als ze in de trace of de testdata staan: vervang ze door `***`.
- **Iets verzinnen.** Wat niet in de bronnen staat, vraag je of vul je in met de lege waarde.

### Velden in testmodus

| Veld | Bron |
|---|---|
| Titel | Uit de analyse, in de vorm "As a <rol>, I can(not) ...". De rol komt uit de flow-fixtures van de test (bv. `loginAs('admin')`); zonder login is het een bezoeker. Geen testnaam of locator |
| Probleembeschrijving | Uit de analyse, in mensentaal, met de impact op de eindgebruiker |
| Stappen om te reproduceren | De `test.step`-teksten als genummerde lijst, **functioneel** zodat een manuele tester ze kan volgen. Geen code, geen locators |
| Verwacht resultaat | Wat de assertion controleert, functioneel uitgelegd |
| Werkelijk resultaat | Wat de app effectief deed, met de **foutmelding letterlijk** (`Expected` / `Received`) |
| Severity | **Voorstellen en laten kiezen** met AskUserQuestion |
| Priority | **Voorstellen en laten kiezen** met AskUserQuestion |
| Tijdstip van optreden | `startTime` van de gefaalde run(s) uit `results.json`; bij meerdere pogingen een bereik |
| Statistieken | Uit de runs in `results.json`: iterations = alle pogingen (inclusief retries en `--repeat-each`), pass en fail geteld per poging |
| Workaround | Vragen, anders de lege waarde |
| Omgevingsinformatie | Device/OS: device uit `playwright.config.ts` (bv. `Desktop Chrome (geëmuleerd)`) en het besturingssysteem (lokaal: van het systeem, CI: `runs-on` uit de workflow, bv. `Ubuntu (GitHub Actions, ubuntu-latest)`). Browser: Playwright-project (bv. `Chromium (Playwright-project chromium)`) en de versie als die in de bronnen staat. App Version: vragen, anders de lege waarde |
| Aanvullende informatie | Tested user: de rol uit de flow-fixtures. Feature ticket: vragen, anders de lege waarde. Daaronder: de URL bij het falen (uit `error-context.md` of de trace), testdata zonder geheimen, en `Found by automated test <testfile> › <testtitel> [<project>]` |
| Bijlagen | Paden naar screenshot, video en trace in de map van de analyse (`skills-analyses/<naam>/`), en naar de analyse zelf |

### Werkwijze in testmodus

1. **Taal bepalen** (zoals in de manuele modus).
2. **Velden invullen** uit de bronnen hierboven.
3. **Ontbrekende velden vragen**, gebundeld: zeker **Severity** en **Priority**, en waar nodig App Version, Feature ticket en Workaround.
4. **Toon het ontwerp-ticket** aan de gebruiker en vraag akkoord voordat je het wegschrijft.
5. **Wegschrijven en rapporteren**, zoals in de manuele modus (zelfde bestandsnaam en sjabloon).
