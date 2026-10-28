import { describe, expect, it } from 'vitest';
import { actualTotalsByCoverage, dayActualsTooltipPrices, daySelectorLabel, plannedDayTotals, plannedRangeTotals } from '../../app/src/day-actuals.js';

const HOUR = 60 * 60_000;

describe('DAY ACTUALS date selector label', () => {
  it('shows the day and month for today, yesterday, and tomorrow', () => {
    expect(daySelectorLabel('2026-10-28', '2026-10-28', 'Europe/Amsterdam')).toBe('Today 28 Okt');
    expect(daySelectorLabel('2026-10-27', '2026-10-28', 'Europe/Amsterdam')).toBe('Yesterday 27 Okt');
    expect(daySelectorLabel('2026-10-29', '2026-10-28', 'Europe/Amsterdam')).toBe('Tomorrow 29 Okt');
  });

  it('uses the full localized date for older days', () => {
    expect(daySelectorLabel('2026-10-20', '2026-10-28', 'Europe/Amsterdam')).toBe('di 20 okt 2026');
  });
});

function planRow(timestampMs, importCost_cents, exportCost_cents, batteryWearCost_cents) {
  return { timestampMs, importCost_cents, exportCost_cents, batteryWearCost_cents };
}

describe('planned DAY ACTUALS totals', () => {
  it('sums planned costs for a fully covered selected day and calculates result', () => {
    const result = plannedDayTotals(0, 2 * HOUR, [
      planRow(0, 50, 100, 10),
      planRow(HOUR, 50, 100, 10),
    ]);

    expect(result).toEqual({
      complete: true,
      totals: { costs_cents: 100, revenue_cents: 200, batteryCosts_cents: 20, result_cents: 80 },
    });
  });

  it('prorates plan slots at the selected day boundaries', () => {
    const result = plannedDayTotals(0, HOUR, [
      planRow(-HOUR / 2, 40, 20, 10),
      planRow(HOUR / 2, 60, 40, 20),
    ]);

    expect(result.complete).toBe(true);
    expect(result.totals).toEqual({ costs_cents: 50, revenue_cents: 30, batteryCosts_cents: 15, result_cents: -35 });
  });

  it('does not present daily totals while the plan covers only part of the day', () => {
    expect(plannedDayTotals(0, 2 * HOUR, [planRow(0, 50, 100, 10)]))
      .toEqual({ complete: false, totals: null });
  });

  it('returns the planned totals for the remaining part of today with its coverage', () => {
    const result = plannedRangeTotals(HOUR, 3 * HOUR, [
      planRow(0, 50, 100, 10),
      planRow(HOUR, 40, 70, 8),
      planRow(2 * HOUR, 30, 80, 6),
    ]);

    expect(result).toEqual({
      complete: true,
      coverage: 1,
      coveredMs: 2 * HOUR,
      totals: { costs_cents: 70, revenue_cents: 150, batteryCosts_cents: 14, result_cents: 66 },
    });
  });
});

describe('historical DAY ACTUALS totals', () => {
  const totals = { costs_cents: 100, revenue_cents: 150, batteryCosts_cents: 20, result_cents: 30 };

  it('keeps independently complete costs visible when another historical input is missing', () => {
    expect(actualTotalsByCoverage(totals, {
      missingGridMs: 0, missingBatteryMs: 0, missingImportPriceMs: 90_000, missingExportPriceMs: 0,
    }, true)).toEqual({
      costs_cents: null, revenue_cents: 150, batteryCosts_cents: 20, result_cents: null,
    });
  });

  it('hides only the battery cost and result when battery coverage is incomplete', () => {
    expect(actualTotalsByCoverage(totals, {
      missingGridMs: 0, missingBatteryMs: 300_000, missingImportPriceMs: 0, missingExportPriceMs: 0,
    }, true)).toEqual({
      costs_cents: 100, revenue_cents: 150, batteryCosts_cents: null, result_cents: null,
    });
  });
});

describe('DAY ACTUALS tooltip prices', () => {
  it('uses realized buy and sell prices for historical quarters', () => {
    expect(dayActualsTooltipPrices({ ic: 18.4, ec: 12.7 }, null)).toEqual({ ic: 18.4, ec: 12.7 });
  });

  it('uses planned prices for tomorrow and the planned remainder of today', () => {
    expect(dayActualsTooltipPrices(null, { ic: 21.3, ec: 15.2 })).toEqual({ ic: 21.3, ec: 15.2 });
  });

  it('falls back to the plan when an actual price is missing and preserves missing prices', () => {
    expect(dayActualsTooltipPrices({ ic: null, ec: 9.5 }, { ic: 17.6, ec: 14.1 }))
      .toEqual({ ic: 17.6, ec: 9.5 });
    expect(dayActualsTooltipPrices(null, null)).toEqual({ ic: null, ec: null });
  });
});
