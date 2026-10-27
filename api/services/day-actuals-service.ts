import { fetchHaHistory, fetchHaStats, fetchHaTimeZone } from './ha-client.ts';
import { loadData } from './data-store.ts';
import { loadSettings } from './settings-store.ts';
import { toAllInExportPrices, toAllInImportPrices } from './all-in-prices.ts';

const GRID = [
  'sensor.gx_device_grid_power_l1_2',
  'sensor.gx_device_grid_power_l2_2',
  'sensor.gx_device_grid_power_l3_2',
];
const PV = [
  'sensor.gx_device_pv_on_grid_power_l1',
  'sensor.gx_device_pv_on_grid_power_l2',
  'sensor.gx_device_pv_on_grid_power_l3',
  'sensor.gx_device_pv_on_output_power_l1',
  'sensor.gx_device_pv_on_output_power_l2',
  'sensor.gx_device_pv_on_output_power_l3',
];
const BATTERY = 'sensor.gx_device_dc_battery_power_2';
const EPEX_PRICE = 'sensor.epex_price_prediction';
const SENSOR_IDS = [...GRID, ...PV, BATTERY];
const SAMPLE_MS = 5 * 60_000;
const QUARTER_MS = 15 * 60_000;
const QUARTER_HOURS = QUARTER_MS / 3_600_000;

type FlowKey = 'load' | 'pv' | 'imp' | 'exp' | 'pv2l' | 'pv2b' | 'pv2g' | 'b2l' | 'b2g' | 'g2l' | 'g2b' | 'g2ev' | 'pv2ev' | 'b2ev';

type Flow = Record<FlowKey, number>;

function seriesValueAt(series: { start: string; step?: number; values: number[] } | null | undefined, at: number): number | null {
  if (!series) return null;
  const stepMinutes = series.step ?? 15;
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) return null;
  const index = Math.floor((at - new Date(series.start).getTime()) / (stepMinutes * 60_000));
  const value = series.values[index];
  return Number.isFinite(value) ? value : null;
}

function allInPricesFromHistory(history: Awaited<ReturnType<typeof fetchHaHistory>>, startMs: number, endMs: number, settings: Awaited<ReturnType<typeof loadSettings>>) {
  const firstSlot = Math.floor(startMs / QUARTER_MS) * QUARTER_MS;
  const lastSlot = Math.floor((endMs - 1) / QUARTER_MS) * QUARTER_MS;
  if (lastSlot < firstSlot) return { importPrice: null, exportPrice: null };
  const baseBySlot = new Map<number, number>();
  const states = history.flat().filter(state => state.entity_id === EPEX_PRICE)
    .sort((a, b) => Date.parse(a.last_updated) - Date.parse(b.last_updated));
  for (const state of states) {
    const timestamp = Date.parse(state.last_updated);
    const basePrice = Number(state.state);
    if (!Number.isFinite(timestamp) || !Number.isFinite(basePrice)) continue;
    const slot = Math.floor(timestamp / QUARTER_MS) * QUARTER_MS;
    if (slot < firstSlot || slot > lastSlot) continue;
    // HA updates the price sensor a few seconds after the quarter starts;
    // retain the latest update within that quarter.
    baseBySlot.set(slot, basePrice);
  }
  if (baseBySlot.size === 0) return { importPrice: null, exportPrice: null };
  const values = Array.from({ length: Math.floor((lastSlot - firstSlot) / QUARTER_MS) + 1 }, (_, index) =>
    baseBySlot.get(firstSlot + index * QUARTER_MS) ?? Number.NaN);
  const base = { start: new Date(firstSlot).toISOString(), step: 15, values };
  return {
    importPrice: toAllInImportPrices(base, settings),
    exportPrice: toAllInExportPrices(base, settings),
  };
}

function splitFlows(gridW: number, pvW: number, batteryW: number): Flow {
  const imp = Math.max(0, gridW), exp = Math.max(0, -gridW);
  const charge = Math.max(0, batteryW), discharge = Math.max(0, -batteryW);
  const load = Math.max(0, pvW + gridW - batteryW);
  const pv2l = Math.min(pvW, load), pvLeft = Math.max(0, pvW - pv2l);
  const pv2b = Math.min(pvLeft, charge), pv2g = Math.max(0, pvLeft - pv2b);
  const loadLeft = Math.max(0, load - pv2l), b2l = Math.min(discharge, loadLeft);
  const b2g = Math.max(0, discharge - b2l), g2l = Math.min(imp, Math.max(0, loadLeft - b2l));
  const g2b = Math.max(0, imp - g2l);
  return { load, pv: pvW, imp, exp, pv2l, pv2b, pv2g, b2l, b2g, g2l, g2b, g2ev: 0, pv2ev: 0, b2ev: 0 };
}

const FLOW_KEYS: FlowKey[] = ['load', 'pv', 'imp', 'exp', 'pv2l', 'pv2b', 'pv2g', 'b2l', 'b2g', 'g2l', 'g2b', 'g2ev', 'pv2ev', 'b2ev'];

function localDayStartForKey(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day);
  let guess = wallClockUtc;
  for (let i = 0; i < 3; i += 1) {
    const zoned = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(guess)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])) as Record<string, number>;
    const represented = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour === 24 ? 0 : zoned.hour, zoned.minute, zoned.second);
    guess = wallClockUtc - (represented - guess);
  }
  return new Date(guess);
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function resolveTimeZone(haUrl: string, haToken: string): Promise<string> {
  try {
    return await fetchHaTimeZone({ haUrl, haToken });
  } catch (error) {
    // HA's /api/config endpoint is admin-only. OptiVolt can still read sensor
    // states and recorder statistics with a restricted token, so use the
    // LXC's configured IANA timezone when that one endpoint returns 401.
    if (!(error instanceof Error) || !/HA returned 401 for its configuration/.test(error.message)) {
      throw error;
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) throw error;
    return timeZone;
  }
}

interface QuarterBucket {
  timestampMs: number;
  expectedMs: number;
  chartObservedMs: number;
  flowWh: Record<FlowKey, number>;
  costs_cents: number;
  revenue_cents: number;
  batteryCosts_cents: number;
  ic: number | null;
  ec: number | null;
}

function makeBucket(timestampMs: number, data: Awaited<ReturnType<typeof loadData>>): QuarterBucket {
  return {
    timestampMs,
    expectedMs: 0,
    chartObservedMs: 0,
    flowWh: Object.fromEntries(FLOW_KEYS.map(key => [key, 0])) as Record<FlowKey, number>,
    costs_cents: 0,
    revenue_cents: 0,
    batteryCosts_cents: 0,
    ic: seriesValueAt(data.importPrice, timestampMs),
    ec: seriesValueAt(data.exportPrice, timestampMs),
  };
}

export async function getDayActuals(now = new Date(), requestedDate?: string) {
  const settings = await loadSettings();
  const [data, timeZone] = await Promise.all([
    loadData(),
    resolveTimeZone(settings.haUrl, settings.haToken),
  ]);
  const dateKey = requestedDate ?? localDateKey(now, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isFinite(Date.parse(`${dateKey}T00:00:00Z`))) throw new Error('Invalid day; expected YYYY-MM-DD');
  const start = localDayStartForKey(dateKey, timeZone);
  const startMs = start.getTime();
  const todayKey = localDateKey(now, timeZone);
  const tomorrowStart = localDayStartForKey(new Date(Date.parse(`${dateKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), timeZone);
  const endMs = tomorrowStart.getTime();
  const isFuture = dateKey > todayKey;
  const observedEndMs = isFuture ? startMs : Math.min(now.getTime(), endMs);
  const queryEnd = dateKey === todayKey ? observedEndMs : endMs;
  if (isFuture) return { dateKey, start: start.toISOString(), end: tomorrowStart.toISOString(), observedAt: now.toISOString(), timeZone, isFuture, rows: [], quality: { expectedMs: 0, gridObservedMs: 0, batteryObservedMs: 0, pvObservedMs: 0, chartObservedMs: 0, missingGridMs: 0, missingBatteryMs: 0, missingPvMs: 0, missingImportPriceMs: 0, missingExportPriceMs: 0, pvSensorCount: 0 }, totals: { costs_cents: null, revenue_cents: null, batteryCosts_cents: null, result_cents: null } };
  const [raw, priceHistory] = await Promise.all([
    fetchHaStats({
      haUrl: settings.haUrl,
      haToken: settings.haToken,
      entityIds: SENSOR_IDS,
      startTime: start.toISOString(),
      endTime: new Date(queryEnd).toISOString(),
      period: '5minute',
    }),
    fetchHaHistory({
      haUrl: settings.haUrl,
      haToken: settings.haToken,
      entityIds: [EPEX_PRICE],
      startTime: start.toISOString(),
      endTime: new Date(queryEnd).toISOString(),
    }).catch(error => {
      console.warn('[day-actuals] could not read historical EPEX prices from HA:', error instanceof Error ? error.message : String(error));
      return [];
    }),
  ]);
  const historyPrices = allInPricesFromHistory(priceHistory, startMs, queryEnd, settings);

  const samples = new Map<number, Map<string, number>>();
  for (const [id, readings] of Object.entries(raw)) {
    for (const reading of readings) {
      if (!Number.isFinite(reading.start) || !Number.isFinite(reading.mean)) continue;
      if (reading.start < startMs || reading.start >= queryEnd) continue;
      if (!samples.has(reading.start)) samples.set(reading.start, new Map());
      samples.get(reading.start)!.set(id, Number(reading.mean));
    }
  }

  // GX output-phase sensors that have never reported today are not active PV
  // inputs for this day. This also handles Victron's unavailable unused phases.
  const activePvIds = PV.filter(id => [...samples.values()].some(values => values.has(id)));
  const buckets = new Map<number, QuarterBucket>();
  const getBucket = (sampleStart: number) => {
    const timestampMs = Math.floor(sampleStart / QUARTER_MS) * QUARTER_MS;
    let bucket = buckets.get(timestampMs);
    if (!bucket) {
      bucket = makeBucket(timestampMs, data);
      buckets.set(timestampMs, bucket);
    }
    return bucket;
  };

  const quality = {
    expectedMs: 0,
    gridObservedMs: 0,
    batteryObservedMs: 0,
    pvObservedMs: 0,
    chartObservedMs: 0,
    missingGridMs: 0,
    missingBatteryMs: 0,
    missingPvMs: 0,
    missingImportPriceMs: 0,
    missingExportPriceMs: 0,
    pvSensorCount: activePvIds.length,
  };
  const batteryCostRate = Number(settings.batteryCost_cent_per_kWh);

  for (let sampleStart = Math.floor(startMs / SAMPLE_MS) * SAMPLE_MS; sampleStart < queryEnd; sampleStart += SAMPLE_MS) {
    const intervalStart = Math.max(startMs, sampleStart);
    const durationMs = Math.min(queryEnd, sampleStart + SAMPLE_MS) - intervalStart;
    if (durationMs <= 0) continue;
    const durationHours = durationMs / 3_600_000;
    const bucket = getBucket(sampleStart);
    bucket.expectedMs += durationMs;
    quality.expectedMs += durationMs;

    const values = samples.get(sampleStart);
    const gridReadings = GRID.map(id => values?.get(id));
    const hasGrid = gridReadings.every(Number.isFinite);
    const batteryW = values?.get(BATTERY);
    const hasBattery = Number.isFinite(batteryW);
    const pvReadings = activePvIds.map(id => values?.get(id));
    const hasPv = activePvIds.length > 0 && pvReadings.every(Number.isFinite);

    if (hasGrid) {
      quality.gridObservedMs += durationMs;
      const gridW = gridReadings.reduce<number>((sum, value) => sum + Number(value), 0);
      const imp = Math.max(0, gridW);
      const exp = Math.max(0, -gridW);
      const ic = seriesValueAt(historyPrices.importPrice, intervalStart) ?? seriesValueAt(data.importPrice, intervalStart);
      const ec = seriesValueAt(historyPrices.exportPrice, intervalStart) ?? seriesValueAt(data.exportPrice, intervalStart);
      if (imp === 0) {
        // No energy needs pricing for this interval.
      } else if (ic !== null) {
        bucket.costs_cents += imp * durationHours / 1000 * ic;
      } else {
        quality.missingImportPriceMs += durationMs;
      }
      if (exp === 0) {
        // No energy needs pricing for this interval.
      } else if (ec !== null) {
        bucket.revenue_cents += exp * durationHours / 1000 * ec;
      } else {
        quality.missingExportPriceMs += durationMs;
      }
    } else {
      quality.missingGridMs += durationMs;
    }

    if (hasBattery && Number.isFinite(batteryCostRate) && batteryCostRate >= 0) {
      quality.batteryObservedMs += durationMs;
      // Integrate absolute throughput sample by sample so charging and
      // discharging cannot cancel before the degradation cost is calculated.
      bucket.batteryCosts_cents += 0.5 * batteryCostRate * Math.abs(Number(batteryW)) * durationHours / 1000;
    } else {
      quality.missingBatteryMs += durationMs;
    }

    if (hasPv) {
      quality.pvObservedMs += durationMs;
    } else {
      quality.missingPvMs += durationMs;
    }

    if (hasGrid && hasBattery && hasPv) {
      const gridW = gridReadings.reduce<number>((sum, value) => sum + Number(value), 0);
      const pvW = Math.max(0, pvReadings.reduce<number>((sum, value) => sum + Number(value), 0));
      const flows = splitFlows(gridW, pvW, Number(batteryW));
      const hours = durationMs / 3_600_000;
      for (const key of FLOW_KEYS) bucket.flowWh[key] += flows[key] * hours;
      bucket.chartObservedMs += durationMs;
      quality.chartObservedMs += durationMs;
    }
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  const totals = sortedBuckets.reduce((sum, bucket) => ({
    costs_cents: sum.costs_cents + bucket.costs_cents,
    revenue_cents: sum.revenue_cents + bucket.revenue_cents,
    batteryCosts_cents: sum.batteryCosts_cents + bucket.batteryCosts_cents,
  }), { costs_cents: 0, revenue_cents: 0, batteryCosts_cents: 0 });

  let cumulativeNetCents = 0;
  const rows = [];
  for (const bucket of sortedBuckets) {
    cumulativeNetCents += bucket.revenue_cents - bucket.costs_cents - bucket.batteryCosts_cents;
    const flow = Object.fromEntries(FLOW_KEYS.map(key => [key, bucket.chartObservedMs > 0 ? bucket.flowWh[key] / QUARTER_HOURS : null])) as Flow;
    rows.push({
      tIdx: rows.length,
      timestampMs: bucket.timestampMs,
      ...flow,
      soc_percent: null,
      ic: bucket.ic,
      ec: bucket.ec,
      importCost_cents: bucket.costs_cents,
      exportCost_cents: bucket.revenue_cents,
      batteryWearCost_cents: bucket.batteryCosts_cents,
      cumulativeNetCents,
      observedMinutes: bucket.chartObservedMs / 60_000,
      missing: bucket.chartObservedMs === 0,
    });
  }

  const costs = quality.gridObservedMs > 0 && quality.missingImportPriceMs === 0 ? totals.costs_cents : null;
  const revenue = quality.gridObservedMs > 0 && quality.missingExportPriceMs === 0 ? totals.revenue_cents : null;
  const batteryCosts = quality.batteryObservedMs > 0 ? totals.batteryCosts_cents : null;
  return {
    dateKey,
    start: start.toISOString(),
    end: tomorrowStart.toISOString(),
    observedAt: new Date(queryEnd).toISOString(),
    timeZone,
    isFuture: false,
    rows,
    quality,
    totals: {
      costs_cents: costs,
      revenue_cents: revenue,
      batteryCosts_cents: batteryCosts,
      result_cents: costs === null || revenue === null || batteryCosts === null
        ? null
        : revenue - costs - batteryCosts,
    },
  };
}
