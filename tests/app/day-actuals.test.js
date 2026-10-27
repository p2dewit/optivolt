import { describe, expect, it } from 'vitest';
import { plannedDayTotals, plannedRangeTotals } from '../../app/src/day-actuals.js';

const HOUR = 60 * 60_000;
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
