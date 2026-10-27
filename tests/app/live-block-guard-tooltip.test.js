// @vitest-environment jsdom
import { beforeEach, it, expect } from 'vitest';
import { mountGuardBlockTooltip, renderGuardBlockPreview } from '../../app/src/live-block-guard-tooltip.js';
const state = { reason: 'Waiting for target', blockPreview: { recognized: true, direction: 'charge', basis: 'high-power',
  slots: [4000, 2000, 0, -3000].map((p, i) => ({ index: i, startMs: 1800000000000 + i * 900000, endMs: 1800000900000 + i * 900000,
    chargePower_W: Math.max(0, p), dischargePower_W: Math.max(0, -p), active: i === 0, inBlock: i < 2 })) } };
beforeEach(() => { document.body.innerHTML = '<p id="status">Monitor only</p>'; });
it('preserves bar proportions and greys out slots beyond the recognized block', () => {
  const host = document.createElement('div'); renderGuardBlockPreview(host, state);
  const bars = host.querySelectorAll('.guard-block-charge');
  expect(Number(bars[0].getAttribute('height'))).toBe(2 * Number(bars[1].getAttribute('height')));
  expect(host.querySelectorAll('.guard-block-outside')).toHaveLength(1);
  expect(host.querySelectorAll('.guard-block-active')).toHaveLength(1);
  expect(host.textContent).toContain('planned power');
});
it('opens on hover/focus, closes on Escape, and clears stale bars after an error', () => {
  const anchor = document.getElementById('status'), handle = mountGuardBlockTooltip(anchor);
  handle.update(state); const tooltip = document.getElementById('live-block-guard-tooltip');
  expect(tooltip.hidden).toBe(true);
  anchor.dispatchEvent(new Event('mouseenter')); expect(tooltip.hidden).toBe(false);
  anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(tooltip.hidden).toBe(true);
  anchor.focus(); expect(tooltip.hidden).toBe(false);
  handle.update(null); expect(tooltip.querySelector('svg')).toBeNull();
});
it('renders server explanation as text and marks taper recognition as an assumption', () => {
  const host = document.createElement('div');
  renderGuardBlockPreview(host, { ...state, reason: '<img src=x onerror=alert(1)>', blockPreview: { ...state.blockPreview, basis: 'soc-taper-region', taperThreshold_percent: 85 } });
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('not a BMS measurement');
});
it('labels a future block and distinguishes it from the current slot', () => {
  const host = document.createElement('div');
  renderGuardBlockPreview(host, { ...state, blockPreview: { ...state.blockPreview, isFuture: true, startIndex: 1, endIndex: 2,
    slots: state.blockPreview.slots.map((slot, i) => ({ ...slot, inBlock: i === 1 || i === 2 })) } });
  expect(host.querySelector('strong').textContent).toBe('Future charging block');
  expect(host.textContent).toContain('targets are not adjusted before this block starts');
  expect(host.querySelectorAll('.guard-block-active')).toHaveLength(1);
});
it('closes when clicking inside the tooltip, including its chart', () => {
  const anchor = document.getElementById('status'), handle = mountGuardBlockTooltip(anchor);
  handle.update(state); anchor.dispatchEvent(new Event('mouseenter'));
  const tooltip = document.getElementById('live-block-guard-tooltip');
  tooltip.querySelector('svg').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(tooltip.hidden).toBe(true);
  handle.update(state); expect(tooltip.hidden).toBe(true);
});
it('shows the proposed lowered target and distinguishes an early estimate', () => {
  const host = document.createElement('div');
  renderGuardBlockPreview(host, { ...state, activeTarget_percent: 53, proposedTarget_percent: 46, adjustmentDue: true });
  expect(host.textContent).toContain('Proposed SoC target: 46%');
  expect(host.textContent).toContain('Lower from 53% to 46%');
  renderGuardBlockPreview(host, { ...state, activeTarget_percent: 53, proposedTarget_percent: 46, adjustmentDue: false });
  expect(host.textContent).toContain('Estimated next SoC target: 46%');
  expect(host.textContent).toContain('recalculated before any adjustment');
});
it('does not show a stale target for a future block, and labels a written target as applied', () => {
  const host = document.createElement('div');
  renderGuardBlockPreview(host, { ...state, proposedTarget_percent: 46, blockPreview: { ...state.blockPreview, isFuture: true } });
  expect(host.textContent).not.toContain('SoC target: 46%');
  renderGuardBlockPreview(host, { ...state, writtenTarget_percent: 46 });
  expect(host.textContent).toContain('Applied SoC target: 46%');
});
