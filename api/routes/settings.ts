import { releaseDynamicEssToVrm, ensureDynamicEssMode4 } from '../services/mqtt-service.ts';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import {
  loadSettings,
  saveSettings,
  loadDefaultSettings,
  SettingsValidationError,
} from '../services/settings-store.ts';
import { HA_TOKEN_SENTINEL, redactSettingsForClient } from '../settings-redaction.ts';
import {
  buildPredictionRunConfig,
  runCombinedPredictionForecast,
} from '../services/prediction-forecast-runner.ts';
import type { Settings } from '../types.ts';
import { isAddon } from '../env.ts';
import { loadData, saveData } from '../services/data-store.ts';
import {
  toAllInExportPrices,
  toAllInImportPrices,
  toBaseEpexExportPrices,
  toBaseEpexImportPrices,
} from '../services/all-in-prices.ts';

const router = express.Router();
let vrmHandoverPending = false;

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json({ ...redactSettingsForClient(settings), isAddon: isAddon() });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body ?? {};
    assertCondition(
      payload && typeof payload === 'object' && !Array.isArray(payload),
      400,
      'settings payload must be an object',
    );

    const incoming = pickKnownKeys(payload, await loadDefaultSettings());

    const prevSettings = await loadSettings();
    if (incoming.haToken === HA_TOKEN_SENTINEL) {
      incoming.haToken = prevSettings.haToken;
    }
    const mergedSettings = {
      ...prevSettings,
      ...incoming,
      dataSources: { ...prevSettings.dataSources, ...incoming.dataSources },
    };
    try {
      await saveSettings(mergedSettings);
    } catch (error) {
      if (error instanceof SettingsValidationError) throw toHttpError(error, 400);
      throw error;
    }

    // Re-read so the response and all subsequent calculations use clamped settings.
    const savedSettings = await loadSettings();
    let victronModeConfirmed: number | null = null;
    if (incoming.pushToVictronEnabled === false && (prevSettings.pushToVictronEnabled || vrmHandoverPending)) {
      vrmHandoverPending = true;
      await releaseDynamicEssToVrm();
      vrmHandoverPending = false;
      victronModeConfirmed = 1;
    }
    // Confirm mode 4 when Push is enabled. Ordinary settings saves (for example
    // chart preferences) must not look like a plan push is about to start.
    if (incoming.pushToVictronEnabled === true && !prevSettings.pushToVictronEnabled) {
      await ensureDynamicEssMode4();
      victronModeConfirmed = 4;
    }
    const priceSettingsChanged = savedSettings.energyTax_eur_per_kWh !== prevSettings.energyTax_eur_per_kWh
      || savedSettings.buyCost_eur_per_kWh !== prevSettings.buyCost_eur_per_kWh
      || savedSettings.sellCost_eur_per_kWh !== prevSettings.sellCost_eur_per_kWh
      || savedSettings.vat_percent !== prevSettings.vat_percent
      || savedSettings.netMetering !== prevSettings.netMetering;
    const pricesRecalculated = priceSettingsChanged
      ? await recalculateStoredPrices(savedSettings, prevSettings)
      : false;

    let forecastsRefreshed = false;
    if (savedSettings.extendedHorizonDays !== prevSettings.extendedHorizonDays) {
      forecastsRefreshed = await refreshForecastsForNewHorizon(savedSettings);
    }

    // Reported so the client can re-read the stored series: the Predictions tab
    // caches them, and would otherwise show the old window until a manual
    // forecast run or a page reload.
    res.json({ message: 'Settings saved successfully.', settings: redactSettingsForClient(savedSettings), forecastsRefreshed, pricesRecalculated, victronModeConfirmed });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

/**
 * Recalculate stored price series from their base EPEX inputs after settings change.
 * Legacy all-in series without a retained base are inverted once using the
 * previous settings so fees and VAT are not applied on top of themselves.
 */
async function recalculateStoredPrices(settings: Settings, previous: Settings): Promise<boolean> {
  const data = await loadData();
  let changed = false;

  if (settings.dataSources.prices === 'api' && previous.dataSources.prices === 'api') {
    const importBase = data.importPriceBase ?? toBaseEpexImportPrices(data.importPrice, previous);
    const exportBase = data.exportPriceBase ?? toBaseEpexExportPrices(data.exportPrice, previous);
    data.importPriceBase = importBase;
    data.exportPriceBase = exportBase;
    data.importPrice = toAllInImportPrices(importBase, settings);
    data.exportPrice = toAllInExportPrices(exportBase, settings);
    changed = true;
  }

  const importForecastBase = data.importPriceForecastBase
    ?? (data.importPriceForecast ? toBaseEpexImportPrices(data.importPriceForecast, previous) : undefined);
  const exportForecastBase = data.exportPriceForecastBase
    ?? (data.exportPriceForecast ? toBaseEpexExportPrices(data.exportPriceForecast, previous) : undefined);
  if (importForecastBase) {
    data.importPriceForecastBase = importForecastBase;
    data.importPriceForecast = toAllInImportPrices(importForecastBase, settings);
    changed = true;
  }
  if (exportForecastBase) {
    data.exportPriceForecastBase = exportForecastBase;
    data.exportPriceForecast = toAllInExportPrices(exportForecastBase, settings);
    changed = true;
  }

  if (changed) await saveData(data);
  return changed;
}

/**
 * The load and PV forecasts are generated over the configured horizon, but are
 * otherwise only refreshed out-of-band (an HA cron hitting /predictions/forecast).
 * A plan can never run past its data, so after a horizon change the stored
 * series would cap the plan at the old window until that cron next fires.
 * Regenerate them here instead.
 *
 * Awaited so the recompute that follows a settings change sees the new series.
 * Failures are logged, not surfaced: the settings are already saved, and the
 * next scheduled run recovers.
 */
async function refreshForecastsForNewHorizon(settings: Settings): Promise<boolean> {
  // Only these sources are written by the forecast runner; skip the external
  // calls entirely when neither applies.
  if (settings.dataSources.load !== 'api' && settings.dataSources.pv !== 'api') return false;
  try {
    const config = await buildPredictionRunConfig();
    await runCombinedPredictionForecast(config, 'horizon-change');
    return true;
  } catch (error) {
    console.warn(
      '[settings] forecast refresh after horizon change failed:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** Drop keys absent from the known Settings shape (the defaults object), including nested dataSources keys. */
function pickKnownKeys(payload: Record<string, unknown>, defaults: Settings): Partial<Settings> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(payload, key)) continue;
    picked[key] = payload[key];
  }

  const dataSources = picked.dataSources;
  if (dataSources && typeof dataSources === 'object' && !Array.isArray(dataSources)) {
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(defaults.dataSources)) {
      if (!Object.hasOwn(dataSources as Record<string, unknown>, key)) continue;
      filtered[key] = (dataSources as Record<string, unknown>)[key];
    }
    picked.dataSources = filtered;
  } else if (dataSources !== undefined) {
    delete picked.dataSources;
  }

  return picked as Partial<Settings>;
}

export default router;
