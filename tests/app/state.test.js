// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateUI, snapshotUI, updatePlanCostsUI, updatePlanMeta, updateRebalanceNudgeUI, updateSummaryUI } from '../../app/src/state.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('settings state', () => {
  it('round-trips optimizer quick settings through hydrate and snapshot', () => {
    const optimizerQuickSettingsSelection = document.createElement('input');
    const terminal = document.createElement('select');
    terminal.innerHTML = '<option value="zero">zero</option>';
    const terminalCustom = document.createElement('input');

    const els = {
      optimizerQuickSettingsSelection,
      terminal,
      terminalCustom,
    };

    hydrateUI(els, {
      optimizerQuickSettings: ['minSoc_percent', 'blockFeedInOnNegativePrices'],
      terminalSocValuation: 'zero',
      terminalSocCustomPrice_cents_per_kWh: 0,
    });

    expect(optimizerQuickSettingsSelection.value).toBe('["minSoc_percent","blockFeedInOnNegativePrices"]');
    expect(snapshotUI(els).optimizerQuickSettings).toEqual(['minSoc_percent', 'blockFeedInOnNegativePrices']);
  });

  it('round-trips the EV trip SoC buffer through hydrate and snapshot', () => {
    const evTripSocBuffer = document.createElement('input');
    evTripSocBuffer.type = 'number';
    const els = { evTripSocBuffer };

    hydrateUI(els, { evTripSocBuffer_percent: 25 });
    expect(snapshotUI(els).evTripSocBuffer_percent).toBe(25);
  });

  it('persists and restores the DESS table toggle', () => {
    const tableDess = document.createElement('input');
    tableDess.type = 'checkbox';
    tableDess.checked = true;

    expect(snapshotUI({ tableDess }).tableShowDess).toBe(true);

    tableDess.checked = false;
    hydrateUI({ tableDess }, { tableShowDess: true });

    expect(tableDess.checked).toBe(true);
  });

  it('renders and clears the financial plan totals', () => {
    const els = {
      importCost: document.createElement('div'),
      exportRevenue: document.createElement('div'),
      batteryWearCost: document.createElement('div'),
      netRevenue: document.createElement('div'),
    };

    updatePlanCostsUI(els, [
      {
        importCost_cents: 10,
        exportCost_cents: 20,
        batteryWearCost_cents: 2,
      },
    ], 'green');

    expect(els.importCost.textContent).not.toBe('');
    expect(els.exportRevenue.textContent).not.toBe('');
    expect(els.batteryWearCost.textContent).not.toBe('');
    expect(els.netRevenue.textContent).not.toBe('');
    expect(els.netRevenue.classList.contains('financial-positive')).toBe(true);

    updatePlanCostsUI(els, null, 'green');

    expect(els.netRevenue.textContent).toBe('—');
  });

  it('shows tooltip text when the last full SoC timestamp is unknown', () => {
    const els = {
      rebalanceToggleLabel: document.createElement('label'),
      rebalanceEnabled: document.createElement('input'),
      rebalanceNudge: document.createElement('p'),
    };
    els.rebalanceEnabled.type = 'checkbox';

    updateRebalanceNudgeUI(els, null);

    expect(els.rebalanceToggleLabel.title).toContain('Last 100% SoC: not recorded yet');
    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(true);
  });

  it('shows the inline rebalance nudge only when recommended and not already enabled', () => {
    const els = {
      rebalanceToggleLabel: document.createElement('label'),
      rebalanceEnabled: document.createElement('input'),
      rebalanceNudge: document.createElement('p'),
    };
    els.rebalanceEnabled.type = 'checkbox';
    els.rebalanceNudge.className = 'hidden';

    updateRebalanceNudgeUI(els, {
      lastFullSocAt: '2024-01-01T00:00:00.000Z',
      daysSinceLastFullSoc: 12,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });

    expect(els.rebalanceToggleLabel.title).toContain('Last 100% SoC:');
    expect(els.rebalanceToggleLabel.title).not.toContain('not recorded yet');
    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(false);
    expect(els.rebalanceNudge.textContent).toContain('12 days ago');

    els.rebalanceEnabled.checked = true;
    updateRebalanceNudgeUI(els, {
      lastFullSocAt: '2024-01-01T00:00:00.000Z',
      daysSinceLastFullSoc: 12,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });

    expect(els.rebalanceNudge.classList.contains('hidden')).toBe(true);
  });
});

describe('plan meta', () => {
  it('formats the plan window, with a weekday only on the end', () => {
    const planTsStart = document.createElement('div');
    const planTsEnd = document.createElement('div');

    // 2026-08-16 is a Sunday; the plan runs to Thursday 2026-08-20.
    updatePlanMeta(
      { planTsStart, planTsEnd },
      new Date('2026-08-16T18:45:00').toISOString(),
      new Date('2026-08-20T23:45:00').getTime(),
    );

    expect(planTsStart.textContent).toBe('16/08 18:45');
    expect(planTsEnd.textContent).toBe('Thu 20/08 23:45');
  });

  it('renders a dash when either end is missing', () => {
    const planTsStart = document.createElement('div');
    const planTsEnd = document.createElement('div');

    updatePlanMeta({ planTsStart, planTsEnd }, null, null);

    expect(planTsStart.textContent).toBe('—');
    expect(planTsEnd.textContent).toBe('—');
  });
});
