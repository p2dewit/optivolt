import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, resolveDataDir, writeJson } from './json-store.ts';
import { getDayActuals } from './day-actuals-service.ts';

type DayActuals = Awaited<ReturnType<typeof getDayActuals>>;

const archiveDir = () => path.join(resolveDataDir(), 'day-actuals');
const archivePath = (dateKey: string) => path.join(archiveDir(), `${dateKey}.json`);
let queue: Promise<unknown> = Promise.resolve();

async function readDay(dateKey: string): Promise<DayActuals | null> {
  try {
    return await readJson<DayActuals>(archivePath(dateKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function mergeDay(previous: DayActuals | undefined, incoming: DayActuals): DayActuals {
  if (!previous) return incoming;
  const oldRows = new Map(previous.rows.map(row => [row.timestampMs, row]));
  const rows = incoming.rows.map(row => {
    const old = oldRows.get(row.timestampMs);
    if (!old) return row;
    const merged = { ...old, ...row };
    const oldGrid = Number(old.gridObservedMinutes) || 0;
    const newGrid = Number(row.gridObservedMinutes) || 0;
    if (newGrid < oldGrid) {
      merged.importCost_cents = old.importCost_cents;
      merged.exportCost_cents = old.exportCost_cents;
      merged.gridObservedMinutes = old.gridObservedMinutes;
      merged.missingImportPriceMinutes = old.missingImportPriceMinutes;
      merged.missingExportPriceMinutes = old.missingExportPriceMinutes;
      merged.ic = old.ic;
      merged.ec = old.ec;
    }
    if ((Number(row.batteryObservedMinutes) || 0) < (Number(old.batteryObservedMinutes) || 0)) {
      merged.batteryWearCost_cents = old.batteryWearCost_cents;
      merged.batteryObservedMinutes = old.batteryObservedMinutes;
    }
    if ((Number(row.observedMinutes) || 0) < (Number(old.observedMinutes) || 0)) {
      for (const key of ['load', 'pv', 'imp', 'exp', 'pv2l', 'pv2b', 'pv2g', 'b2l', 'b2g', 'g2l', 'g2b', 'g2ev', 'pv2ev', 'b2ev'] as const) merged[key] = old[key];
      merged.observedMinutes = old.observedMinutes;
      merged.pvObservedMinutes = old.pvObservedMinutes;
      merged.missing = old.missing;
    }
    return merged;
  });
  const quality = { ...incoming.quality };
  quality.gridObservedMs = rows.reduce((sum, row) => sum + (Number(row.gridObservedMinutes) || 0) * 60_000, 0);
  quality.batteryObservedMs = rows.reduce((sum, row) => sum + (Number(row.batteryObservedMinutes) || 0) * 60_000, 0);
  quality.pvObservedMs = rows.reduce((sum, row) => sum + (Number(row.pvObservedMinutes) || 0) * 60_000, 0);
  quality.chartObservedMs = rows.reduce((sum, row) => sum + (Number(row.observedMinutes) || 0) * 60_000, 0);
  quality.missingGridMs = Math.max(0, quality.expectedMs - quality.gridObservedMs);
  quality.missingBatteryMs = Math.max(0, quality.expectedMs - quality.batteryObservedMs);
  quality.missingPvMs = Math.max(0, quality.expectedMs - quality.pvObservedMs);
  quality.missingImportPriceMs = rows.reduce((sum, row) => sum + (Number(row.missingImportPriceMinutes) || 0) * 60_000, 0);
  quality.missingExportPriceMs = rows.reduce((sum, row) => sum + (Number(row.missingExportPriceMinutes) || 0) * 60_000, 0);
  const totals = rows.reduce((sum, row) => ({
    costs_cents: sum.costs_cents + (Number(row.importCost_cents) || 0),
    revenue_cents: sum.revenue_cents + (Number(row.exportCost_cents) || 0),
    batteryCosts_cents: sum.batteryCosts_cents + (Number(row.batteryWearCost_cents) || 0),
  }), { costs_cents: 0, revenue_cents: 0, batteryCosts_cents: 0 });
  const costs = quality.gridObservedMs > 0 && quality.missingImportPriceMs === 0 ? totals.costs_cents : null;
  const revenue = quality.gridObservedMs > 0 && quality.missingExportPriceMs === 0 ? totals.revenue_cents : null;
  const batteryCosts = quality.batteryObservedMs > 0 ? totals.batteryCosts_cents : null;
  return { ...incoming, rows, quality, totals: {
    costs_cents: costs, revenue_cents: revenue, batteryCosts_cents: batteryCosts,
    result_cents: costs === null || revenue === null || batteryCosts === null ? null : revenue - costs - batteryCosts,
  } };
}

export async function storeDayActuals(payload: DayActuals): Promise<DayActuals> {
  const operation = queue.then(async () => {
    const previous = await readDay(payload.dateKey);
    const merged = mergeDay(previous ?? undefined, payload);
    if (merged.rows.some(row => (Number(row.gridObservedMinutes) || 0) > 0 || (Number(row.batteryObservedMinutes) || 0) > 0 || (Number(row.observedMinutes) || 0) > 0)) {
      await writeJson(archivePath(payload.dateKey), merged);
    }
    return merged;
  });
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getDayActualsRange(): Promise<{ minDate: string | null; maxDate: string | null }> {
  let names: string[];
  try { names = await fs.readdir(archiveDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { minDate: null, maxDate: null };
    throw error;
  }
  const dates = names.map(name => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter((date): date is string => !!date).sort();
  return { minDate: dates[0] ?? null, maxDate: dates.at(-1) ?? null };
}

export async function readArchivedDayActuals(dateKey: string): Promise<DayActuals | null> {
  return readDay(dateKey);
}

export async function fetchAndStoreDayActuals(now = new Date(), dateKey?: string): Promise<DayActuals> {
  const fetched = await getDayActuals(now, dateKey);
  if (fetched.isFuture) return fetched;
  return storeDayActuals(fetched);
}

/** Bootstrap the current day and recent HA-retained history, then keep today's archive current. */
export function startDayActualsArchive(): void {
  let collectingToday = false;
  let backfill: Promise<void> | null = null;
  let backfillDone = false;
  const collect = async () => {
    if (collectingToday) return;
    collectingToday = true;
    try {
      const today = await fetchAndStoreDayActuals();
      if (!backfill && !backfillDone) {
        backfill = (async () => {
          const base = new Date(`${today.dateKey}T12:00:00Z`);
          for (let ago = 1; ago <= 9; ago += 1) {
            const day = new Date(base);
            day.setUTCDate(day.getUTCDate() - ago);
            const key = day.toISOString().slice(0, 10);
            if (!(await readArchivedDayActuals(key))) {
              try { await fetchAndStoreDayActuals(new Date(), key); }
              catch (error) { console.warn(`[day-actuals] could not backfill ${key}:`, error instanceof Error ? error.message : String(error)); }
            }
          }
        })().finally(() => { backfill = null; backfillDone = true; });
      }
    } catch (error) {
      console.warn('[day-actuals] archive collection failed:', error instanceof Error ? error.message : String(error));
    } finally { collectingToday = false; }
  };
  void collect();
  setInterval(() => { void collect(); }, 5 * 60_000).unref();
}
