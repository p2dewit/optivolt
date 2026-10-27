import { describe, it, expect } from 'vitest';
import { detectLiveBlock, describeLiveBlock } from '../../../api/services/live-block-detection.ts';
const step = 900000;
const limits = { maxChargePower_W: 5000, maxDischargePower_W: 5000 };
const rows = powers => powers.map((p, i) => ({ timestampMs: 1800000000000 + i * step,
  g2b: Math.max(0, p), pv2b: 0, b2l: Math.max(0, -p), b2g: 0, b2ev: 0,
  dess: { socTarget_percent: 50 } }));
describe('Four-slot block recognition', () => {
  it('includes partial lead-in and taper tail around a later high-power slot', () => {
    expect(detectLiveBlock(rows([800, 5000, 2000, 400]), 0, 50, limits, step)).toMatchObject({ recognized: true, end: 3, basis: 'high-power' });
  });
  it('accepts lower-power charging at 85% and discharging at 15%', () => {
    expect(detectLiveBlock(rows([1200, 900, 500, 200]), 0, 85, limits, step)).toMatchObject({ recognized: true, end: 3, basis: 'soc-taper-region' });
    expect(detectLiveBlock(rows([-1200, -900, -500, -200]), 0, 15, limits, step)).toMatchObject({ recognized: true, end: 3, basis: 'soc-taper-region' });
  });
  it('does not assume every low-power block is tapering, nor infer taper from a future target', () => {
    const plan = rows([1200, 900, 500, 200]); plan[3].dess.socTarget_percent = 90;
    expect(detectLiveBlock(plan, 0, 84, limits, step).recognized).toBe(false);
    expect(detectLiveBlock(rows([-1200, -900]), 0, 16, limits, step).recognized).toBe(false);
  });
  it('stops at a pause, reversal, ambiguous flow or timestamp gap', () => {
    for (const powers of [[5000, 0, 5000], [5000, -100, 5000]]) {
      expect(detectLiveBlock(rows(powers), 0, 50, limits, step).end).toBe(0);
    }
    const mixed = rows([5000, 3000, 5000]); mixed[1].b2l = 500;
    expect(detectLiveBlock(mixed, 0, 50, limits, step).end).toBe(0);
    const gap = rows([5000, 5000]); gap[1].timestampMs += step;
    expect(detectLiveBlock(gap, 0, 50, limits, step).end).toBe(0);
  });
  it('never reaches beyond the four schedule slots or across an elapsed high-power slot', () => {
    expect(detectLiveBlock(rows([500, 500, 500, 500, 5000]), 0, 50, limits, step).recognized).toBe(false);
    expect(detectLiveBlock(rows([5000, 500, 500, 500]), 1, 50, limits, step).recognized).toBe(false);
    expect(detectLiveBlock(rows([5000, 5000, 5000, 5000, 5000]), 2, 50, limits, step).end).toBe(3);
  });
  it('rejects nonfinite power and disabled limits even within taper regions', () => {
    expect(detectLiveBlock(rows([NaN, 5000]), 0, 90, limits, step).recognized).toBe(false);
    expect(detectLiveBlock(rows([500, 500]), 0, 90, { ...limits, maxChargePower_W: 0 }, step).recognized).toBe(false);
  });
  it('reports all four bars with the correct recognized subset and current slot', () => {
    const preview = describeLiveBlock(rows([5000, 2500, 0, -5000]), 0, 50, limits, step);
    expect(preview.slots.map(s => s.inBlock)).toEqual([true, true, false, false]);
    expect(preview.slots.map(s => s.active)).toEqual([true, false, false, false]);
    expect(preview.slots.map(s => s.chargePower_W)).toEqual([5000, 2500, 0, 0]);
  });
});

it('previews slots 2–4 when the current slot is idle', () => {
  const p = describeLiveBlock(rows([0, 1000, 5000, 2000]), 0, 50, limits, step);
  expect(p).toMatchObject({ recognized: true, isFuture: true, startIndex: 1, endIndex: 3, socBasis: 'planned' });
  expect(p.slots.map(s => s.inBlock)).toEqual([false, true, true, true]);
  expect(p.slots.map(s => s.active)).toEqual([true, false, false, false]);
});
it('uses planned SoC for a future taper block and observed SoC once active', () => {
  const plan = rows([0, 1000, 500, 300]); plan[0].dess.socTarget_percent = 87;
  expect(describeLiveBlock(plan, 0, 50, limits, step)).toMatchObject({ isFuture: true, basis: 'soc-taper-region', recognitionSoc_percent: 87 });
  expect(describeLiveBlock(plan, 1, 87, limits, step)).toMatchObject({ isFuture: false, recognized: true, socBasis: 'observed' });
  plan[0].dess.socTarget_percent = 50;
  expect(describeLiveBlock(plan, 0, 95, limits, step).recognized).toBe(false);
});
it('prioritizes an active block and does not invent future blocks across pauses or gaps', () => {
  expect(describeLiveBlock(rows([5000, 5000, -5000, -5000]), 0, 50, limits, step)).toMatchObject({ isFuture: false, startIndex: 0, endIndex: 1 });
  expect(describeLiveBlock(rows([0, 5000, 0, 5000]), 0, 50, limits, step)).toMatchObject({ isFuture: true, startIndex: 1, endIndex: 1 });
  const gap = rows([0, 5000, 5000]); gap[1].timestampMs += step; gap[2].timestampMs += step;
  expect(describeLiveBlock(gap, 0, 50, limits, step).recognized).toBe(false);
});

it('does not bridge standby compensation into a high-power fourth slot', () => {
  const plan = rows([42.105, 42.105, 42.105, 16999.965]);
  const settings = { maxChargePower_W: 17000, maxDischargePower_W: 17000, idleDrain_W: 40, chargeEfficiency_percent: 95 };
  expect(describeLiveBlock(plan, 0, 25, settings, step)).toMatchObject({ isFuture: true, startIndex: 3, endIndex: 3, activeDirection: null });
  expect(describeLiveBlock(plan, 3, 25, settings, step)).toMatchObject({ isFuture: false, startIndex: 3 });
});
