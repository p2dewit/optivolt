import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { Data, TimeSeries } from '../types.ts';

const STORE_PATH = path.join(resolveDataDir(), 'forecast-accuracy.json');
const TIME_ZONE = 'Europe/Amsterdam';
const WINDOW_DAYS = 30;
const PENDING_RETENTION_DAYS = 10;

type Point = { predicted: number; actual: number };
interface DayScore { date: string; count: number; absoluteError: number; absoluteActual: number; points: Point[]; }
interface PendingForecast { date: string; points: Array<{ instant: number; predicted: number }>; }
interface Store { days: DayScore[]; pendingForecasts: PendingForecast[]; }

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23',
});
function localDay(ms: number): string { return dayFormatter.format(ms); }
function localHour(ms: number): number { return Number(timeFormatter.format(ms)); }

function slotsByDay(series?: TimeSeries): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  if (!series || !Number.isFinite(series.step) || !series.step) return result;
  const start = Date.parse(series.start);
  if (!Number.isFinite(start)) return result;
  const stepMs = series.step * 60_000;
  series.values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const ms = start + index * stepMs;
    const date = localDay(ms);
    const day = result.get(date) ?? new Map<number, number>();
    day.set(ms, value);
    result.set(date, day);
  });
  return result;
}

function expectedSlots(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  // Amsterdam changes clocks after 00:00 UTC; bracket this delivery day.
  const wallMidnight = Date.UTC(y, m - 1, d);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour), Number(v.minute)) - ms;
  };
  const delta = offsetAt(wallMidnight + 24 * 60 * 60_000) - offsetAt(wallMidnight);
  return 96 - delta / (15 * 60_000);
}

async function loadStore(): Promise<Store> {
  try {
    const raw = await readJson<Store>(STORE_PATH);
    return {
      days: Array.isArray(raw.days) ? raw.days : [],
      pendingForecasts: Array.isArray(raw.pendingForecasts) ? raw.pendingForecasts : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { days: [], pendingForecasts: [] };
    throw error;
  }
}

/**
 * Preserve the last forecast available before actual prices cover a delivery day.
 * Forecast refreshes can run just before the API price update, overwriting the
 * only pre-publication forecast before the corresponding actuals arrive.
 */
export async function rememberForecastAccuracyCandidates(data: Data): Promise<void> {
  const forecasts = slotsByDay(data.importPriceForecast);
  const actuals = slotsByDay(data.importPrice);
  const store = await loadStore();
  const recorded = new Set(store.days.map(day => day.date));
  const pending = new Map(store.pendingForecasts.map(day => [day.date, day]));
  const cutoff = localDay(Date.now() - PENDING_RETENTION_DAYS * 24 * 60 * 60_000);

  for (const [date, forecast] of forecasts) {
    if (date < cutoff || recorded.has(date) || forecast.size !== expectedSlots(date)) continue;
    if ((actuals.get(date)?.size ?? 0) === expectedSlots(date)) continue;
    pending.set(date, {
      date,
      points: [...forecast].map(([instant, predicted]) => ({ instant, predicted })),
    });
  }

  store.pendingForecasts = [...pending.values()].filter(day => day.date >= cutoff && !recorded.has(day.date));
  await writeJson(STORE_PATH, store);
}

/** Preserve a forecast vintage and score it once actual prices cover that full day. */
export async function reconcileForecastAccuracy(before: Data, after: Data): Promise<void> {
  const previousActuals = slotsByDay(before.importPrice);
  const actuals = slotsByDay(after.importPrice);
  const previousForecasts = slotsByDay(before.importPriceForecast);
  const store = await loadStore();
  const recorded = new Set(store.days.map(day => day.date));
  const pending = new Map(store.pendingForecasts.map(day => [day.date, day]));

  for (const [date, actual] of actuals) {
    const expected = expectedSlots(date);
    if (recorded.has(date) || actual.size !== expected) continue;

    // Prefer the saved pre-publication vintage. The direct prior-data fallback
    // applies only on the update that first completed this actual delivery day.
    const vintage = pending.get(date);
    const completedNow = (previousActuals.get(date)?.size ?? 0) < expected;
    const forecast = vintage
      ? new Map(vintage.points.map(point => [point.instant, point.predicted]))
      : (completedNow ? previousForecasts.get(date) : undefined);
    if (!forecast || forecast.size < expected) continue;

    let absoluteError = 0;
    let absoluteActual = 0;
    let count = 0;
    const points: Point[] = [];
    for (const [instant, actualValue] of actual) {
      const predicted = forecast.get(instant);
      if (predicted === undefined) continue;
      absoluteError += Math.abs(predicted - actualValue);
      absoluteActual += Math.abs(actualValue);
      points.push({ predicted, actual: actualValue });
      count += 1;
    }
    if (count !== expected) continue;
    store.days.push({ date, count, absoluteError, absoluteActual, points });
    recorded.add(date);
    pending.delete(date);
  }

  store.days.sort((a, b) => a.date.localeCompare(b.date));
  store.pendingForecasts = [...pending.values()];
  await writeJson(STORE_PATH, store);
}

export async function getForecastAccuracy() {
  const store = await loadStore();
  const days = store.days.slice(-WINDOW_DAYS);
  const count = days.reduce((sum, day) => sum + day.count, 0);
  const absoluteError = days.reduce((sum, day) => sum + day.absoluteError, 0);
  const absoluteActual = days.reduce((sum, day) => sum + day.absoluteActual, 0);
  return {
    scorePercent: count > 0 && absoluteActual > 0 ? Math.max(0, (1 - absoluteError / absoluteActual) * 100) : null,
    days: days.length,
    slots: count,
    windowDays: WINDOW_DAYS,
    metric: '100% - WAPE',
    latestDeliveryDay: days.at(-1)?.date ?? null,
  };
}
