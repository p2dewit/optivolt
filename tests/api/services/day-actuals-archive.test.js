import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDayActualsRange, readArchivedDayActuals, storeDayActuals } from '../../../api/services/day-actuals-archive.ts';

const previousDataDir = process.env.DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optivolt-day-actuals-'));
process.env.DATA_DIR = dataDir;

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

function day({ observedMinutes = 15, costs = 20 } = {}) {
  const row = {
    timestampMs: Date.parse('2026-10-26T22:00:00.000Z'),
    load: 100, pv: 30, imp: 70, exp: 0, pv2l: 30, pv2b: 0, pv2g: 0,
    b2l: 0, b2g: 0, g2l: 70, g2b: 0, g2ev: 0, pv2ev: 0, b2ev: 0,
    importCost_cents: costs, exportCost_cents: 0, batteryWearCost_cents: 2,
    observedMinutes, gridObservedMinutes: observedMinutes, batteryObservedMinutes: observedMinutes,
    pvObservedMinutes: observedMinutes, missingImportPriceMinutes: 0, missingExportPriceMinutes: 0,
  };
  return {
    dateKey: '2026-10-27', start: '2026-10-26T22:00:00.000Z', end: '2026-10-27T22:00:00.000Z',
    observedAt: '2026-10-27T22:00:00.000Z', timeZone: 'Europe/Amsterdam', isFuture: false,
    rows: [row],
    quality: { expectedMs: 900_000, gridObservedMs: observedMinutes * 60_000, batteryObservedMs: observedMinutes * 60_000, pvObservedMs: observedMinutes * 60_000, chartObservedMs: observedMinutes * 60_000, missingGridMs: (15 - observedMinutes) * 60_000, missingBatteryMs: (15 - observedMinutes) * 60_000, missingPvMs: (15 - observedMinutes) * 60_000, missingImportPriceMs: 0, missingExportPriceMs: 0, pvSensorCount: 1 },
    totals: { costs_cents: costs, revenue_cents: 0, batteryCosts_cents: 2, result_cents: -costs - 2 },
  };
}

it('archives a day, merges improved quarter data without losing earlier observations, and exposes its date range', async () => {
  await storeDayActuals(day());
  await storeDayActuals(day({ observedMinutes: 5, costs: 9 }));

  const stored = await readArchivedDayActuals('2026-10-27');
  expect(stored.rows[0]).toMatchObject({ observedMinutes: 15, gridObservedMinutes: 15, importCost_cents: 20 });
  expect(stored.totals).toMatchObject({ costs_cents: 20, batteryCosts_cents: 2, result_cents: -22 });
  expect(await getDayActualsRange()).toEqual({ minDate: '2026-10-27', maxDate: '2026-10-27' });
});
