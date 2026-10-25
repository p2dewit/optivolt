import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ store: null }));
vi.mock('../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/test-data',
  readJson: vi.fn(async () => structuredClone(memory.store)),
  writeJson: vi.fn(async (_path, value) => { memory.store = structuredClone(value); }),
}));

import {
  rememberForecastAccuracyCandidates,
  reconcileForecastAccuracy,
} from '../../api/services/forecast-accuracy-service.ts';

const cases = [
  ['2026-03-28', '2026-03-27T23:00:00Z', 96],
  ['2026-03-29', '2026-03-28T23:00:00Z', 92],
  ['2026-03-30', '2026-03-29T22:00:00Z', 96],
  ['2026-10-24', '2026-10-23T22:00:00Z', 96],
  ['2026-10-25', '2026-10-24T22:00:00Z', 100],
  ['2026-10-26', '2026-10-25T23:00:00Z', 96],
  ['2027-03-28', '2027-03-27T23:00:00Z', 92],
  ['2027-10-31', '2027-10-30T22:00:00Z', 100],
  ['2028-02-29', '2028-02-28T23:00:00Z', 96],
];

describe('forecast accuracy delivery-day length in Amsterdam', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    memory.store = { days: [], pendingForecasts: [] };
  });
  afterEach(() => vi.useRealTimers());

  it.each(cases)('records and scores the complete day %s (%s, %i quarters)', async (date, start, count) => {
    vi.setSystemTime(new Date(Date.parse(start) - 12 * 60 * 60_000));
    const forecast = { start, step: 15, values: Array(count).fill(10) };
    const before = { importPriceForecast: forecast };
    const existing = { date: '2020-01-01', count: 1, absoluteError: 1, absoluteActual: 2, points: [{ predicted: 1, actual: 2 }] };
    memory.store.days.push(structuredClone(existing));

    await rememberForecastAccuracyCandidates(before);
    expect(memory.store.pendingForecasts).toHaveLength(1);
    expect(memory.store.pendingForecasts[0].date).toBe(date);
    expect(memory.store.pendingForecasts[0].points).toHaveLength(count);

    await reconcileForecastAccuracy(before, {
      ...before,
      importPrice: { start, step: 15, values: Array(count).fill(12) },
    });
    expect(memory.store.days.find(day => day.date === date)).toMatchObject({
      count, absoluteError: count * 2, absoluteActual: count * 12,
    });
    expect(memory.store.days.find(day => day.date === existing.date)).toEqual(existing);
    expect(memory.store.pendingForecasts).toHaveLength(0);
  });

  it.each(cases)('rejects an incomplete delivery day %s (%s, %i quarters required)', async (_date, start, count) => {
    vi.setSystemTime(new Date(Date.parse(start) - 12 * 60 * 60_000));
    const before = { importPriceForecast: { start, step: 15, values: Array(count - 1).fill(10) } };
    await rememberForecastAccuracyCandidates(before);
    expect(memory.store.pendingForecasts).toHaveLength(0);
    await reconcileForecastAccuracy(before, {
      ...before,
      importPrice: { start, step: 15, values: Array(count - 1).fill(12) },
    });
    expect(memory.store.days).toHaveLength(0);
  });
});
