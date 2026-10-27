# OptiVolt 🔋

## Aanpassingen in deze fork — OptiVolt DESS 1.0

Deze fork bouwt voort op [bmesuere/optivolt](https://github.com/bmesuere/optivolt), met upstream-commit `410a954` als vertrekpunt. Onderstaande uitbreidingen beschrijven de lokale broncode, inclusief de wijzigingen van 26 oktober 2026. De oorspronkelijke functionaliteit en installatie-instructies staan verderop. Versie **1.0** in de paginakop is de versieaanduiding van deze persoonlijke fork.

### Prijzen, strategieën en opbrengsten

- **All-in tarieven:** energiebelasting, inkoopopslag, verkoopkosten, btw en een salderingsoptie worden centraal toegepast op API-prijzen en prijsvoorspellingen. De basisprijsreeksen blijven bewaard, zodat gewijzigde tariefinstellingen opnieuw kunnen worden toegepast zonder dubbel te rekenen. De tariefinstellingen zijn in €/kWh; de prijsreeksen gebruiken cent/kWh.
- **Import:** `(basisprijs + inkoopopslag + energiebelasting) × btw-factor`. **Export:** `(basisprijs − verkoopkosten + eventuele energiebelasting bij salderen) × btw-factor`, met bedragen naar dezelfde eenheid omgerekend. Dit is de geïmplementeerde rekenregel; vul de waarden volgens je eigen contract in.
- **Nieuwe API-prijzen verversen de planning:** na het opslaan wordt opnieuw gerekend. Deze automatische herberekening schrijft zelf geen planning naar Victron.
- **Voorspellingen uit HTTP(S) of een lokaal `file:`-bestand:** de ingestelde forecastfeed kan de horizon voorbij de bekende prijzen aanvullen. Werkelijke prijzen blijven leidend. De uitgebreide horizon zelf bestond al upstream.
- **Aggressive en Green:** Aggressive behoudt de economische optimalisatie. Green geeft eigen verbruik en het opslaan van zonne-energie extra prioriteit, beperkt netladen boven de ingestelde maximuminkoopprijs en batterij-export onder de minimumverkoopprijs. Zachte reserve-SoC-doelen rond de voorspelde zonneproductie helpen de nacht en ochtend te overbruggen; het zijn geen onvoorwaardelijke garanties.
- **Netto-opbrengst in de energiegrafiek:** optionele cumulatieve lijn met exportopbrengst minus importkosten en berekende batterijslijtage, met eurobedragen in de tooltip. Dit is een planningsresultaat, geen gemeten of gefactureerde opbrengst.

### Live block guard voor laden én ontladen

De guard controleert iedere **60 seconden** de actuele SoC en het Victron-doel. Hij bekijkt maximaal de vier beschikbare DESS-slots en herkent aaneengesloten laad- of ontlaadblokken. Het doel is te voorkomen dat een tussentijds SoC-doel zo'n blok te vroeg onderbreekt.

- **Gelijke herkenning in Monitor en Automatic:** beide gebruiken dezelfde actuele serverplanning, met een browserplanning uitsluitend als vooruitblik wanneer geen actuele serverplanning beschikbaar is. Een ontbrekende pushbevestiging blokkeert automatisch schrijven, niet het tonen van herkende blokken.
- **Off / Monitor / Automatic:** Monitor toont uitsluitend voorstellen. Automatic vereist ook ingeschakelde push en een bevestigde verzending van de actuele planning.
- **Herkenning:** minstens één slot in het doorlopende blok bereikt 75% van de ingestelde vermogenslimiet. Dit percentage is een herkenningscriterium, geen opdracht om op 75% te laden. Lagere vermogens aan de randen kunnen bij het blok horen.
- **Afnemend vermogen:** bij laden vanaf 85% SoC en ontladen tot 15% SoC kunnen ook blokken met lagere vermogens worden herkend. Dit is een SoC-gebaseerde aanname, geen uitlezing van BMS-vermogenslimieten.
- **Standbycompensatie telt niet als laden:** laadvermogen dat na rendement alleen het ingestelde standbyverlies compenseert, verbindt een rustslot niet met een later laadblok. Bijvoorbeeld: 42,105 W bij 95% rendement compenseert ongeveer 40 W verlies en vormt geen actieve laadstart.
- **Vooruitblik zonder vroege aanpassing:** ook een toekomstig blok dat alleen in slot 4 zichtbaar is kan worden getoond. De guard stelt daarvoor nog geen nieuw huidig SoC-doel voor en schrijft niets totdat het blok actief is. Een enkel eindslot wordt niet verlengd als er geen volgend aangesloten slot beschikbaar is.
- **Aanpassen binnen 1 procentpunt:** als het doel het actieve blok dreigt te onderbreken, wordt een nieuw doel berekend uit de resterende geplande energie, capaciteit en rendementen, binnen de SoC-grenzen. Dit is een SoC-marge, geen exacte voorspelling van één minuut tot het doel.
- **Dubbele wijzigingen worden vermeden**, en vóór automatisch schrijven worden de relevante instellingen en planning opnieuw gecontroleerd.

![Voorbeeld van de live-block-guardtooltip](docs/images/live-block-guard-example.png)

*Screenshot van een geïsoleerd UI-voorbeeld met fictieve waarden. De balkjes tonen gepland vermogen: blauw laden, oranje ontladen, grijs buiten het blok. Het actuele slot is gemarkeerd. De huidige tooltip vermeldt daarnaast een voorgesteld of uitgevoerd nieuw SoC-doel, zowel bij verhogen als verlagen. Klik op de tooltip om hem te sluiten; Escape werkt ook.*

### Overdracht tussen OptiVolt en Victron/VRM

Bij een daadwerkelijke planning-push stelt deze fork eerst **Dynamic ESS-modus 4 (Node-RED)** in en leest de waarde terug via MQTT. Alleen na bevestiging worden de planningsslots verstuurd. Er zijn maximaal drie leespogingen; zonder bevestiging volgt een foutmelding.

Bij het uitzetten van **Push to Victron** wordt push eerst opgeslagen als uitgeschakeld. Daarna stelt OptiVolt **modus 1 (Auto/VRM)** in en controleert ook die overdracht. De interface meldt bevestiging of een fout. Bij een mislukte overdracht blijft push uit; een volgende instellingenopslag kan tijdens dezelfde serverrun opnieuw proberen. Planning- en guard-writes worden geserialiseerd met de overdracht, zodat een lopende push niet ná de overdracht alsnog modus 4 instelt.

De directe MQTT-topics beginnen met `W/<portal-ID>/…` voor schrijven, `R/<portal-ID>/…` voor opvragen en `N/<portal-ID>/…` voor antwoorden. Voor de modus wordt `settings/0/Settings/DynamicEss/Mode` gebruikt, met bijvoorbeeld `{"value":4}`. Een extra `victron/`-prefix hoort alleen bij een bridge die daarvoor is ingericht. Modus 4 betreft **Dynamic ESS**, niet de algemene ESS-instelling External control.

### DA reliability: registratie van voorspelfouten

`GET /forecast-accuracy` en het veld **DA reliability · 30d** tonen een score op basis van de laatste maximaal 30 volledig geregistreerde leveringsdagen. Dat zijn niet noodzakelijk 30 aaneengesloten kalenderdagen. Alleen dagen met complete, overeenkomende kwartieren tellen mee; zomer-/wintertijd wordt meegenomen.

De opgeslagen voorspelling van vóór ontvangst van de complete werkelijke prijzen wordt vergeleken met de inkoopprijzen:

```text
WAPE = 100 × som(|voorspeld − werkelijk|) / som(|werkelijk|)
score = max(0, 100 − WAPE)
```

**82% betekent dus ongeveer 18% relatieve totale absolute prijsafwijking**, niet dat 82% van de kwartieren correct is en ook niet dat de komende week met 82% zekerheid klopt. Bij een nulnoemer is er geen berekenbare score. De vergelijking gebruikt de opgeslagen inkoopprijsreeksen, inclusief de toegepaste tariefformule. Belasting en opslagen beïnvloeden daardoor de schaal van de score.

De hovertooltip toont de uitleg en het actuele aantal dagen en kwartieren. Klik op de tooltip of druk Escape om hem te sluiten. De registratie staat in `DATA_DIR/forecast-accuracy.json` en staat los van de modeltraining in EpexPredictor.

### Interface en opgeslagen voorkeuren

- **Update data before recompute**, **Push to Victron** en de guardmodus worden opgeslagen.
- **Show DESS details**, **Show kWh**, grafiekbereik, tijdresolutie van de energiestromen en de opbrengstlijn blijven bewaard op de server. Bestaande browservoorkeuren kunnen bij de eerste migratie worden overgenomen.
- Het veranderen van alleen weergavevoorkeuren maakt de gecachte planning niet ongeldig en start geen nieuwe optimalisatie.
- Aangepaste layout, grafiektypografie voor kleine schermen, tooltipopmaak en een versieaanduiding naast het logo.
- Lokale gegevens, geheimen en tijdelijke bestanden worden via de ignore-regels buiten de broncode gehouden. Vul API-sleutels lokaal in; publiceer geen persoonlijke configuratie of datamappen.

### Activeren en controleren

Backendwijzigingen vereisen een herstart van de actieve service/container. Bij een standalone systemd-installatie met deze servicenaam: `systemctl restart optivolt.service`. Vernieuw daarna de browser; alleen statische UI-wijzigingen vereisen normaal geen serverherstart.

Gerichte regressietests dekken onder meer blokherkenning, standbycompensatie, tapering, toekomstige blokken, MQTT-modusbevestiging en de overdracht naar VRM. Gebruik `npm run typecheck` en `npm run test:run` om de huidige checkout te controleren. De registratie van voorspelfouten moet uitwijzen hoeveel de gekoppelde voorspellingen in de praktijk verbeteren; deze README claimt geen gemeten nauwkeurigheidswinst.


Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant App** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Built-in load forecasting based on Home Assistant historical sensor data
- Server-side VRM integration for forecasts/prices and system limits
- Optional Dynamic ESS schedule pushes over MQTT (first 4 slots)
- EV charging integration: LP-optimized schedule with departure deadline, target SoC, and per-slot charge mode classification
- Optional extended planning horizon (up to 6 extra days) with forecast prices, so multi-day EV targets ("80% in 3 days") become real constraints
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory

## Installation

### Home Assistant App (Recommended)

1. **Expose the add-on directory over Samba:**
   Install the Samba share App in Home Assistant and configure it so the `/addons` directory is available as a network share. Mount that share on your computer. Apps used to be add-ons in Home Assistant, this has been changed in the ui but not yet on the file system, so this directory is called addons.
2. **Copy the Optivolt files:**
   Copy the contents of your local Optivolt repository into the mounted `addons` share. Using `rsync` (macOS/Linux) skips development artifacts:
   ```bash
   rsync -av --delete --exclude 'node_modules' --exclude '.git' --exclude '.claude' --exclude '.DS_Store' --exclude 'tests' --exclude 'vendor/highs-js' ~/Code/optivolt/ /Volumes/addons/optivolt/
   ```
3. **Install the App:**
   Go to **Settings → Apps → Install App**. Reload local Apps if necessary (click check for updates), find **Optivolt**, and click **Install**.
4. **Configure connection settings:**
   Open the Optivolt App configuration panel and enter your Victron VRM credentials / installation ID, and the Victron IP address on your local network.
   *(Note: Make sure mqtt access is enabled on your local Venus OS device: open the remote console: Settings, Services → toggle the MQTT access switch.)*
   *(Note: Optivolt automatically connects to the internal HA WebSocket API using the supervisor token to fetch historical sensor data.)*
5. **Start and verify:**
   Start the Optivolt App, open the UI, and verify that data (time series, prices, SoC, etc.) is being fetched correctly.

### Standalone / Local Development

Requires **Node.js >= 22.18** (server code runs as TypeScript directly via Node's type stripping, which is only enabled by default from that version onward).

```bash
npm install
npm run api       # or: npm run dev  (loads .env.local via dotenv-cli + nodemon)
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**
- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`); stores `settings.json`, `data.json`, and `prediction-config.json`
- `VRM_INSTALLATION_ID`, `VRM_TOKEN` (enable VRM refresh routes)
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` (optional; required to push Dynamic ESS schedules)

Create a `.env.local` file in the project root to set these variables for local development.

## Home Assistant Integration

Optivolt is designed to be coordinated heavily via Home Assistant. Below are the steps and examples to automate its features.

> **Note:** The examples below call the App over the direct host port (`localhost:3070`, mapped by default). This API is unauthenticated, so any device on your LAN can reach it; if you don't need direct access, clear the port mapping in the Optivolt App's network configuration to make it ingress-only.

### 1. Trigger the Optimizer Loop
Optivolt relies on a periodic trigger to fetch new data, calculate a plan, and (optionally) push it to Victron. Create a REST command to call the `/calculate/` endpoint:
```yaml
rest_command:
  optivolt_calculate:
    url: "http://localhost:3070/calculate/"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "updateData": true,
        "writeToVictron": true
      }
```

Then create an automation to trigger it every 15 minutes, a few seconds after each quarter hour:
```yaml
automation:
  - alias: "Trigger Optivolt calculate every quarter hour"
    trigger:
      - platform: time_pattern
        minutes: "/15"
        seconds: 5
    action:
      - service: rest_command.optivolt_calculate
```

### 2. Victron DESS mode in this fork

Enable the persisted **Push to Victron** switch before requesting a schedule write. This fork sets and verifies Dynamic ESS mode **4** before sending the schedule. Disabling the switch requests and verifies mode **1** to hand control back to VRM. See the fork notes above for failure handling and the live block guard.

Use a working price source for your installation. The former upstream example of automatically switching modes around midday is not part of this fork's control workflow and can interfere with ownership of the schedule.

### 3. Load Forecasting Periodic Trigger (Optional)
Call the endpoint `/predictions/forecast/now` periodically from Home Assistant (via a REST Command) to generate up-to-date load forecasts. Be sure to first configure the predictor on the optimizer page of the UI.
```yaml
rest_command:
  optivolt_predict:
    url: "http://localhost:3070/predictions/forecast/now"
    method: GET
```

### 4. Push Custom Pricing / Sensor Data (Optional)
If you don't use VRM for pricing and instead manually push data (by setting data sources to "API" in the UI), you can use the `/data` endpoint.
```yaml
rest_command:
  optivolt_push_prices:
    url: "http://localhost:3070/data"
    method: POST
    content_type: "application/json"
    payload: >-
      {% set import_data = state_attr('sensor.ecopower_consumption_price', 'consumption_data') %}
      {% set export_data = state_attr('sensor.ecopower_injection_price', 'injection_data') %}
      {% set step = 15 %}

      {% set import_start_ts = as_timestamp(as_datetime(import_data[0].time)) | int %}
      {% set export_start_ts = as_timestamp(as_datetime(export_data[0].time)) | int %}

      {% set import_start_iso = import_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}
      {% set export_start_iso = export_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}

      {
        "importPrice": {
          "start": {{ import_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (import_data | map(attribute='price') | list) | tojson }}
        },
        "exportPrice": {
          "start": {{ export_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (export_data | map(attribute='price') | list) | tojson }}
        }
      }
```

### 5. Extended Planning Horizon (Optional)

By default the plan covers the classic day-ahead window (~12–36 h, bounded by
published prices and forecasts). Two settings in the UI's **Data Sources** card
extend it to multiple days, so long-range EV targets ("80% in 3 days") become
real solver constraints instead of manually staged intermediate targets:

- **Extra horizon (days)** (`extendedHorizonDays`, 0–6, default 0 = off):
  extends the load, PV, and price windows by that many days. Load predictions
  extrapolate from history; PV forecasts come from Open-Meteo (ICON seamless
  beyond 2 days); VRM forecasts are clamped to whatever VRM actually returns.
- **Price forecast URL** (`priceForecastUrl`, default empty): a JSON feed of
  predicted prices in the `energieprijs` `forecast.json` format
  (`consumption_data` / `injection_data` arrays of `{time, price}` in
  c€/kWh, 15-minute steps). OptiVolt pulls it during each `/calculate` update
  and stores it separately from the actual prices.

**Published prices always win.** Forecast values only extend the tail past the
end of the actual price series; the dashboard draws that region as a dashed
line with a shaded "forecast" zone. The plan itself is still bounded by the
shortest available series, so a missing forecast simply shrinks the horizon
back to today's behaviour. On multi-day plans the dashboard adds a
"Standard | Full horizon" view toggle, hourly bar aggregation, and collapsible
day sections in the schedule table.

Note that only the first 4 slots are ever pushed to Victron — the extra days
influence *today's* decisions (e.g. charging the EV during tomorrow's cheap
valley instead of tonight) without changing what gets written to hardware.

### 6. EV Charger Control via REST Sensor (Optional)

Poll the `/ev/current` endpoint every minute to get the current slot's EV charging decision. Add this to your HA `configuration.yaml`:

```yaml
rest:
  - resource: http://localhost:3070/ev/current
    scan_interval: 60
    sensor:
      - name: "OptiVolt EV Charge Mode"
        value_template: "{{ value_json.ev_charge_mode }}"
        unique_id: optivolt_ev_charge_mode

      - name: "OptiVolt EV Charge Current"
        value_template: "{{ value_json.ev_charge_A }}"
        unit_of_measurement: A
        device_class: current
        unique_id: optivolt_ev_charge_current_a
```

Use `sensor.optivolt_ev_charge_mode` and `sensor.optivolt_ev_charge_current_a` in automations to control your charger. The mode values are `off`, `fixed`, `solar_only`, `solar_grid`, and `max`; the current is the target charge rate in amps.

## Architecture & HTTP API

```text
app/                 # Static web UI (index.html, main.js, app/src/**)
api/                 # Express TypeScript server (routes + services)
lib/                 # TypeScript core logic: LP builder, parser, DESS mapper, VRM/Victron payload helpers
addon/               # Home Assistant add-on wrapper (s6, run scripts)
translations/        # i18n strings for the HA add-on settings
Dockerfile           # Image for HA add-on / container use
config.yaml          # Home Assistant add-on manifest
```

The **UI** is static and calls the **Express API** on the same origin. Server-owned state lives in `DATA_DIR`:

- `settings.json` stores system, algorithm, Home Assistant, data-source, and EV settings.
- `data.json` stores time-series data, current SoC, manual prediction adjustments, and EV schedule entries.
- `prediction-config.json` stores load/PV prediction model configuration.

Data-source behavior is explicit: when a data source is set to `vrm`, VRM refreshes own that series in `data.json`; when set to `api`, pushed data or prediction endpoints may write that series. The solver always reads persisted settings and data server-side.

The **API** exposes:

- `GET /settings` — Reads persisted settings, or `api/defaults/default-settings.json` when missing.
- `POST /settings` — Merges the incoming settings object into `DATA_DIR/settings.json`.
- `GET /data` — Reads persisted time-series data.
- `POST /data` — Injects custom time-series data. The payload maps arrays of 15m values:
  ```json
  {
    "importPrice": {
      "start": "2024-01-01T00:00:00.000Z",
      "step": 15,
      "values": [10.5, 11.2, 12.0, 11.8]
    }
  }
  ```
- `POST /calculate` — Builds and solves the LP with **HiGHS** from persisted settings/data. Optional boolean body flags: `updateData` refreshes VRM series before solving, and `writeToVictron` attempts an MQTT DESS schedule write. All input series are resampled onto the configured solver step before solving.
- `GET /calculate/last` — Returns the cached plan when it solved optimally and still covers the current slot, with `inputsCurrent` telling the client whether settings/data changed since. Otherwise 404.
- `POST /vrm/refresh-settings` — Fetches latest Dynamic ESS limits/settings from VRM and persists.
- `GET /predictions/config` — Reads prediction configuration plus `isAddon`.
- `POST /predictions/config` — Saves prediction configuration. Home Assistant URL/token are intentionally stored in `/settings`, not this file.
- `GET /predictions/adjustments` — Lists active manual forecast adjustments and prunes expired ones.
- `POST /predictions/adjustments` — Creates a manual forecast adjustment for `load` or `pv`.
- `PATCH /predictions/adjustments/:id` — Updates a manual forecast adjustment.
- `DELETE /predictions/adjustments/:id` — Deletes a manual forecast adjustment.
- `POST /predictions/validate` — Runs load-predictor validation against Home Assistant history.
- `POST /predictions/load/forecast` — Runs the active load forecast and returns adjusted forecast data with `rawForecast` when adjustments apply.
- `POST /predictions/pv/forecast` — Runs the PV forecast when PV configuration is complete.
- `POST /predictions/forecast` — Runs load and PV forecasts together, persists raw forecasts according to data-source settings, and returns adjusted forecasts.
- `GET /predictions/forecast/now` — Same combined forecast path with recent comparison disabled.
- `GET /ev/current` — Current time slot's EV charging decision (`ev_charge_mode`, `ev_charge_A`, source flows, EV SoC). Outside the current plan horizon it returns a fail-safe `off` decision with `plan_valid: false`.
- `GET /ev/schedule` — Full per-slot EV charging schedule from the last computed plan.
- `GET /ev/schedule-entries` — Lists active EV schedule entries (arrival, departure, target) and prunes expired ones.
- `POST /ev/schedule-entries` — Creates an EV schedule entry.
- `PATCH /ev/schedule-entries/:id` — Updates an EV schedule entry.
- `DELETE /ev/schedule-entries/:id` — Deletes an EV schedule entry.
- `GET /ha/entity/:entityId` — Fetch live entity state from Home Assistant (used to validate EV sensor configuration).
- `GET /health` — Liveness probe used by the container health check.
