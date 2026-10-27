import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settings: vi.fn(), data: vi.fn(), stats: vi.fn(), history: vi.fn(), timezone: vi.fn() }));
vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: mocks.settings }));
vi.mock('../../../api/services/data-store.ts', () => ({ loadData: mocks.data }));
vi.mock('../../../api/services/ha-client.ts', () => ({ fetchHaStats: mocks.stats, fetchHaHistory: mocks.history, fetchHaTimeZone: mocks.timezone }));
import { getDayActuals } from '../../../api/services/day-actuals-service.ts';

const GRID = [
  'sensor.gx_device_grid_power_l1_2',
  'sensor.gx_device_grid_power_l2_2',
  'sensor.gx_device_grid_power_l3_2',
];
const PV = 'sensor.gx_device_pv_on_grid_power_l1';
const BATTERY = 'sensor.gx_device_dc_battery_power_2';
const DAY_START = Date.parse('2026-10-26T23:00:00.000Z');

function readings(starts, mean) {
  return starts.map(start => ({ start, end: start + 300_000, mean }));
}
function rawFor(starts, { grid = [1000, 1000, 1000], pv = 500, battery = 2000 } = {}) {
  const raw = Object.fromEntries(GRID.map((id, index) => [id, readings(starts, grid[index])]));
  raw[PV] = readings(starts, pv);
  raw[BATTERY] = readings(starts, battery);
  return raw;
}

beforeEach(() => {
  mocks.settings.mockResolvedValue({
    haUrl: 'ws://ha/api/websocket', haToken: 'secret', batteryCost_cent_per_kWh: 2,
    energyTax_eur_per_kWh: 0.09161, buyCost_eur_per_kWh: 0.015,
    sellCost_eur_per_kWh: -0.0105, vat_percent: 21, netMetering: true,
  });
  mocks.timezone.mockResolvedValue('Europe/Amsterdam');
  mocks.history.mockResolvedValue([]);
  mocks.data.mockResolvedValue({
    importPrice: { start: new Date(DAY_START).toISOString(), step: 15, values: Array(96).fill(20) },
    exportPrice: { start: new Date(DAY_START).toISOString(), step: 15, values: Array(96).fill(10) },
  });
});

it('aggregates GX phase power into quarter-hour flows and all-in day finances', async () => {
  const starts = [DAY_START, DAY_START + 300_000, DAY_START + 600_000];
  mocks.stats.mockResolvedValue(rawFor(starts, { grid: [1000, 1000, 1000], pv: 500, battery: 2000 }));
  const result = await getDayActuals(new Date(DAY_START + 900_000));

  expect(mocks.stats).toHaveBeenCalledWith(expect.objectContaining({
    startTime: new Date(DAY_START).toISOString(),
    endTime: new Date(DAY_START + 900_000).toISOString(),
    period: '5minute',
  }));
  expect(result.timeZone).toBe('Europe/Amsterdam');
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ imp: 3000, pv: 500, g2b: 2000, g2l: 1000, pv2l: 500 });
  expect(result.totals.costs_cents).toBeCloseTo(15);
  expect(result.totals.batteryCosts_cents).toBeCloseTo(0.5);
  expect(result.totals.result_cents).toBeCloseTo(-15.5);
  expect(result.quality.missingGridMs).toBe(0);
});

it('clips the current incomplete quarter to observed time and excludes a missing tail', async () => {
  const starts = [DAY_START, DAY_START + 300_000];
  mocks.stats.mockResolvedValue(rawFor(starts, { grid: [1000, 1000, 1000], pv: 500, battery: 1000 }));
  const result = await getDayActuals(new Date(DAY_START + 12 * 60_000));

  expect(result.totals.costs_cents).toBeCloseTo(10);
  expect(result.totals.batteryCosts_cents).toBeCloseTo(1 / 6);
  expect(result.rows[0].imp).toBeCloseTo(2000);
  expect(result.quality.expectedMs).toBe(12 * 60_000);
  expect(result.quality.missingGridMs).toBe(2 * 60_000);
  expect(result.quality.missingPvMs).toBe(2 * 60_000);
});

it('does not let missing grid phases or charging and discharging cancel out', async () => {
  const starts = [DAY_START, DAY_START + 300_000, DAY_START + 600_000];
  const raw = rawFor(starts, { pv: 500, battery: 2000 });
  raw[GRID[0]] = readings([starts[0], starts[2]], 1000);
  raw[BATTERY] = [
    { start: starts[0], mean: 2000 },
    { start: starts[1], mean: -2000 },
    { start: starts[2], mean: 2000 },
  ];
  mocks.stats.mockResolvedValue(raw);
  const result = await getDayActuals(new Date(DAY_START + 900_000));

  expect(result.totals.costs_cents).toBeCloseTo(10);
  expect(result.totals.batteryCosts_cents).toBeCloseTo(0.5);
  expect(result.quality.missingGridMs).toBe(5 * 60_000);
  expect(result.rows[0].observedMinutes).toBe(10);
});

it('uses the HA local day boundary across the autumn DST change', async () => {
  mocks.stats.mockResolvedValue({});
  const result = await getDayActuals(new Date('2026-10-25T00:15:00+02:00'));

  expect(result.start).toBe('2026-10-24T22:00:00.000Z');
  expect(result.timeZone).toBe('Europe/Amsterdam');
  expect(mocks.stats).toHaveBeenCalledWith(expect.objectContaining({
    startTime: '2026-10-24T22:00:00.000Z',
  }));
  expect(result.totals.result_cents).toBeNull();
});

it('returns a selected historical local day with every quarter, including gaps on the 25-hour DST day', async () => {
  mocks.stats.mockResolvedValue({});
  const result = await getDayActuals(new Date('2026-10-27T12:00:00+01:00'), '2026-10-25');

  expect(result.dateKey).toBe('2026-10-25');
  expect(result.start).toBe('2026-10-24T22:00:00.000Z');
  expect(result.end).toBe('2026-10-25T23:00:00.000Z');
  expect(result.rows).toHaveLength(100);
  expect(result.rows.every(row => row.missing && row.pv === null)).toBe(true);
  expect(mocks.stats).toHaveBeenCalledWith(expect.objectContaining({
    startTime: result.start,
    endTime: result.end,
  }));
});

it('falls back to the configured server timezone when HA denies its admin-only config endpoint', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'Europe/Amsterdam';
  mocks.timezone.mockRejectedValue(new Error('HA returned 401 for its configuration'));
  mocks.stats.mockResolvedValue({});
  try {
    const result = await getDayActuals(new Date('2026-10-25T00:15:00+02:00'));

    expect(result.timeZone).toBe('Europe/Amsterdam');
    expect(result.start).toBe('2026-10-24T22:00:00.000Z');
    expect(mocks.stats).toHaveBeenCalledWith(expect.objectContaining({
      startTime: '2026-10-24T22:00:00.000Z',
    }));
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

it('reports actual energy whose dynamic price is missing instead of pricing it at zero', async () => {
  const starts = [DAY_START, DAY_START + 300_000, DAY_START + 600_000];
  mocks.stats.mockResolvedValue(rawFor(starts));
  mocks.data.mockResolvedValue({
    importPrice: { start: new Date(DAY_START + 900_000).toISOString(), step: 15, values: [20] },
    exportPrice: { start: new Date(DAY_START).toISOString(), step: 15, values: [10] },
  });
  const result = await getDayActuals(new Date(DAY_START + 900_000));

  expect(result.totals.costs_cents).toBeNull();
  expect(result.totals.result_cents).toBeNull();
  expect(result.quality.missingImportPriceMs).toBe(15 * 60_000);
});

it('prices historical import from HA EPEX history using OptiVolt all-in settings', async () => {
  const starts = [DAY_START, DAY_START + 300_000, DAY_START + 600_000];
  mocks.stats.mockResolvedValue(rawFor(starts, { grid: [1000, 1000, 1000], pv: 500, battery: 0 }));
  mocks.history.mockResolvedValue([[
    { entity_id: 'sensor.epex_price_prediction', state: '2.319', last_updated: new Date(DAY_START).toISOString() },
    { entity_id: 'sensor.epex_price_prediction', state: '5.458', last_updated: new Date(DAY_START + 11_000).toISOString() },
  ]]);

  const result = await getDayActuals(new Date(DAY_START + 15 * 60_000), '2026-10-27');

  expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({
    entityIds: ['sensor.epex_price_prediction'],
    startTime: new Date(DAY_START).toISOString(),
  }));
  expect(result.quality.missingImportPriceMs).toBe(0);
  expect(result.totals.costs_cents).toBeCloseTo(0.75 * 19.50399);
});

it('prices historical export from HA EPEX history using OptiVolt all-in settings', async () => {
  const starts = [DAY_START, DAY_START + 300_000, DAY_START + 600_000];
  mocks.stats.mockResolvedValue(rawFor(starts, { grid: [-1000, -1000, -1000], pv: 500, battery: 0 }));
  mocks.history.mockResolvedValue([[
    { entity_id: 'sensor.epex_price_prediction', state: '5.458', last_updated: new Date(DAY_START + 11_000).toISOString() },
  ]]);

  const result = await getDayActuals(new Date(DAY_START + 15 * 60_000), '2026-10-27');

  expect(result.totals.revenue_cents).toBeCloseTo(0.75 * 18.95949);
  expect(result.quality.missingExportPriceMs).toBe(0);
});
