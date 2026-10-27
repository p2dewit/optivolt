import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadData, saveData, validateData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import { assertCondition, toHttpError } from '../http-errors.ts';
import type { TimeSeries, SocData, Data } from '../types.ts';
import { toAllInExportPrices, toAllInImportPrices } from '../services/all-in-prices.ts';
import { computePlan } from '../services/planner-service.ts';
import { reconcileForecastAccuracy } from '../services/forecast-accuracy-service.ts';

const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadData();
    res.json(data);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to load data'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body as Record<string, unknown>;
    assertCondition(
      !!payload && typeof payload === 'object' && !Array.isArray(payload),
      400,
      'Payload must be a JSON object',
    );

    const currentData = await loadData();
    const settings = await loadSettings();
    const dataSources = settings.dataSources;

    const sourceMapping: Record<string, string> = {
      load: dataSources.load,
      pv: dataSources.pv,
      importPrice: dataSources.prices,
      exportPrice: dataSources.prices,
      soc: dataSources.soc,
    };

    const allowedKeys = ['load', 'pv', 'importPrice', 'exportPrice', 'soc'];
    const keysToUpdate = Object.keys(payload).filter(k => allowedKeys.includes(k) && sourceMapping[k] === 'api');

    assertCondition(
      keysToUpdate.length > 0,
      400,
      'No valid data keys provided or settings are not set to API',
    );

    const nextData: Data = { ...currentData };

    for (const key of keysToUpdate) {
      const value = payload[key];
      assertCondition(
        !!value && typeof value === 'object' && !Array.isArray(value),
        400,
        `'${key}' must be a JSON object`,
      );
      // Validate incoming price series before applying all-in conversion.
      // Otherwise a missing values array causes a TypeError and HTTP 500.
      if (key === 'importPrice' || key === 'exportPrice') {
        const series = value as Record<string, unknown>;
        assertCondition(
          Array.isArray(series.values),
          400,
          `'${key}.values' must be an array`,
        );
      }

      if (key === 'soc') {
        nextData.soc = value as SocData;
      } else if (key === 'importPrice') {
        // API price input contains base EPEX prices; convert to all-in prices
        // before storing them in the solver's c€/kWh unit.
        nextData.importPriceBase = value as TimeSeries;
        nextData.importPrice = toAllInImportPrices(nextData.importPriceBase, settings);
      } else if (key === 'exportPrice') {
        nextData.exportPriceBase = value as TimeSeries;
        nextData.exportPrice = toAllInExportPrices(nextData.exportPriceBase, settings);
      } else if (key === 'load' || key === 'pv') {
        nextData[key] = value as TimeSeries;
      }
    }

    try {
      validateData(nextData);
    } catch (validationError) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      throw toHttpError(validationError, 400, msg);
    }

    try {
      if (keysToUpdate.includes('importPrice')) {
        try { await reconcileForecastAccuracy(currentData, nextData); }
        catch (accuracyError) { console.error('[forecast-accuracy] reconciliation failed:', accuracyError instanceof Error ? accuracyError.message : String(accuracyError)); }
      }
      await saveData(nextData);
    } catch (saveError) {
      throw toHttpError(saveError, 500, 'Failed to persist data');
    }

    logDataUpdateCall(keysToUpdate);
    let planUpdated = false;
    if (keysToUpdate.includes('importPrice') || keysToUpdate.includes('exportPrice')) {
      try {
        // Re-solve from the newly persisted price series so cached plan costs
        // reflect the latest day-ahead prices. This never writes to Victron.
        await computePlan();
        planUpdated = true;
      } catch (planError) {
        console.error('[data] plan refresh after price update failed:', planError instanceof Error ? planError.message : String(planError));
      }
    }
    res.json({ message: 'Data updated successfully', keysUpdated: keysToUpdate, planUpdated });
  } catch (error) {
    next(toHttpError(error, 500));
  }
});

function logDataUpdateCall(keysUpdated: string[]): void {
  console.log('[data] update', {
    timestamp: new Date().toISOString(),
    keysUpdated,
  });
}

export default router;
