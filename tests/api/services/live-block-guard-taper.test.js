import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ loadSettings: vi.fn(), soc: vi.fn(), target: vi.fn(), write: vi.fn(), ensureMode4: vi.fn(), plan: vi.fn(), pushed: vi.fn() }));
vi.mock('../../../api/services/settings-store.ts', () => ({ loadSettings: mocks.loadSettings }));
vi.mock('../../../api/services/mqtt-service.ts', () => ({ readVictronSocPercent: mocks.soc, readVictronActiveDynamicEssTarget: mocks.target, writeDynamicEssSlotSocTarget: mocks.write, ensureDynamicEssMode4: mocks.ensureMode4 }));
vi.mock('../../../api/services/planner-service.ts', () => ({ getLastPlan: mocks.plan, isLastPlanPushedToVictron: mocks.pushed }));
let guard, settings, plan;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  settings = { liveBlockGuardMode: 'automatic', pushToVictronEnabled: true, maxChargePower_W: 5000, maxDischargePower_W: 5000,
    batteryCapacity_Wh: 10000, chargeEfficiency_percent: 95, dischargeEfficiency_percent: 95, idleDrain_W: 0, minSoc_percent: 10, maxSoc_percent: 95 };
  plan = { computedAtMs: Date.now(), timing: { startMs: Date.now(), stepMin: 15 }, result: { Status: 'Optimal' },
    rows: [1000, 800, 600, 400].map((p, i) => ({ timestampMs: Date.now() + i * 900000, g2b: p, pv2b: 0, b2l: 0, b2g: 0, b2ev: 0, dess: { socTarget_percent: 86 + i } })) };
  mocks.loadSettings.mockImplementation(async () => settings); mocks.plan.mockImplementation(() => plan);
  mocks.soc.mockResolvedValue(85); mocks.target.mockResolvedValue(86); mocks.pushed.mockReturnValue(true); mocks.write.mockResolvedValue(); mocks.ensureMode4.mockResolvedValue();
  guard = await import('../../../api/services/live-block-guard.ts');
});
afterEach(() => vi.useRealTimers());
it('allows a taper block at the one-point margin, respects the ceiling and avoids duplicate writes', async () => {
  await guard.refreshLiveBlockGuard();
  expect(mocks.write).toHaveBeenCalledTimes(4);
  expect(guard.getLiveBlockGuardStatus().blockPreview.basis).toBe('soc-taper-region');
  for (const [, target] of mocks.write.mock.calls) expect(target).toBeLessThanOrEqual(95);
  await guard.refreshLiveBlockGuard(); expect(mocks.write).toHaveBeenCalledTimes(4);
});
it('monitor proposes but never writes', async () => {
  settings.liveBlockGuardMode = 'monitor';
  await guard.refreshLiveBlockGuard();
  expect(guard.getLiveBlockGuardStatus().proposedTarget_percent).toBeGreaterThan(86);
  expect(mocks.write).not.toHaveBeenCalled();
});
it('retains discharge reserve and minimum SoC near empty', async () => {
  mocks.soc.mockResolvedValue(14); mocks.target.mockResolvedValue(13);
  plan.rows.forEach((r, i) => { r.g2b = 0; r.b2l = 500; r.dess.socTarget_percent = 13 - i; });
  await guard.refreshLiveBlockGuard();
  expect(mocks.write).toHaveBeenCalledTimes(4);
  for (const [, target] of mocks.write.mock.calls) expect(target).toBe(10);
});
it('does not write without push permission or a confirmed plan', async () => {
  settings.pushToVictronEnabled = false; await guard.refreshLiveBlockGuard();
  settings.pushToVictronEnabled = true; mocks.pushed.mockReturnValue(false); await guard.refreshLiveBlockGuard();
  expect(mocks.write).not.toHaveBeenCalled();
});
it('does not raise a target when the maximum SoC has already been reached', async () => {
  mocks.soc.mockResolvedValue(95); await guard.refreshLiveBlockGuard(); expect(mocks.write).not.toHaveBeenCalled();
});
it('shows a future block in automatic mode without writing any target', async () => {
  mocks.soc.mockResolvedValue(50); mocks.target.mockResolvedValue(50);
  plan.rows.forEach((r, i) => { r.g2b = i === 0 ? 0 : 5000; r.dess.socTarget_percent = 50 + i; });
  await guard.refreshLiveBlockGuard();
  const status = guard.getLiveBlockGuardStatus();
  expect(status.blockPreview).toMatchObject({ isFuture: true, startIndex: 1, endIndex: 3 });
  expect(status.proposedTarget_percent).toBeNull();
  expect(status.status).toContain('future charging block');
  expect(mocks.write).not.toHaveBeenCalled();
});
it('waits for the SoC trigger before extending the active block', async () => {
  mocks.soc.mockResolvedValue(80);
  plan.rows[0].g2b = 5000;
  plan.rows[1].g2b = 5000;
  plan.rows[2].g2b = 4800;
  plan.rows[3].g2b = 0;

  await guard.refreshLiveBlockGuard();

  const before = guard.getLiveBlockGuardStatus();
  expect(before.adjustmentDue).toBe(false);
  expect(before.proposedTarget_percent).toEqual(expect.any(Number));
  expect(before.writtenTarget_percent).toBeNull();
  expect(mocks.ensureMode4).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();

  const trigger = before.triggerTarget_percent;
  expect(trigger).toEqual(expect.any(Number));

  // Reach the configured one-percentage-point trigger margin.
  mocks.soc.mockResolvedValue(trigger - 0.5);
  await guard.refreshLiveBlockGuard();

  const after = guard.getLiveBlockGuardStatus();
  expect(after.adjustmentDue).toBe(true);
  expect(after.writtenTarget_percent).toEqual(expect.any(Number));
  expect(after.writtenTarget_percent).toBeLessThanOrEqual(95);
  expect(mocks.ensureMode4).toHaveBeenCalledTimes(1);
  expect(mocks.write.mock.calls.map(([slot]) => slot)).toEqual([0, 1, 2]);
});

it('never proposes or writes an early target for standby slots ahead of slot four', async () => {
  settings.idleDrain_W = 40; settings.maxChargePower_W = 17000;
  mocks.soc.mockResolvedValue(25); mocks.target.mockResolvedValue(26);
  plan.rows.forEach((r, i) => { r.g2b = i === 3 ? 16999.965 : 42.105; r.dess.socTarget_percent = i === 3 ? 38.4 : 25; });
  for (const mode of ['monitor', 'automatic']) {
    settings.liveBlockGuardMode = mode;
    await guard.refreshLiveBlockGuard();
    expect(guard.getLiveBlockGuardStatus()).toMatchObject({ proposedTarget_percent: null, blockPreview: { isFuture: true, startIndex: 3 } });
    expect(mocks.write).not.toHaveBeenCalled();
  }
});

it('shows the same future block in monitor and automatic even before a confirmed push', async () => {
  mocks.pushed.mockReturnValue(false);
  mocks.soc.mockResolvedValue(50);
  plan.rows.forEach((r, i) => { r.g2b = i < 2 ? 0 : 5000; });
  settings.liveBlockGuardMode = 'monitor';
  await guard.refreshLiveBlockGuard();
  const preview = guard.getLiveBlockGuardStatus().blockPreview;
  settings.liveBlockGuardMode = 'automatic';
  await guard.refreshLiveBlockGuard();
  expect(guard.getLiveBlockGuardStatus().blockPreview).toEqual(preview);
  expect(preview).toMatchObject({ isFuture: true, startIndex: 2 });
  expect(mocks.write).not.toHaveBeenCalled();
});
it('uses the server plan in both modes even when the browser reports a different block', async () => {
  settings.liveBlockGuardMode = 'monitor';
  const browser = { ...plan, solverStatus: 'Optimal', rows: plan.rows.map(r => ({ ...r, g2b: 0, b2l: 5000 })) };
  await guard.setLiveBlockGuardMonitorPlan(browser);
  await guard.refreshLiveBlockGuard();
  const preview = guard.getLiveBlockGuardStatus().blockPreview;
  settings.liveBlockGuardMode = 'automatic';
  await guard.refreshLiveBlockGuard();
  expect(guard.getLiveBlockGuardStatus().blockPreview).toEqual(preview);
  expect(preview.direction).toBe('charge');
});
it('browser-only recognition never authorizes automatic writes', async () => {
  mocks.plan.mockReturnValue(undefined);
  mocks.plan.mockImplementation(() => undefined);
  mocks.pushed.mockReturnValue(true);
  await guard.setLiveBlockGuardMonitorPlan({ ...plan, solverStatus: 'Optimal' });
  await guard.refreshLiveBlockGuard();
  expect(guard.getLiveBlockGuardStatus().blockPreview.recognized).toBe(true);
  expect(guard.getLiveBlockGuardStatus().status).toContain('not confirmed');
  expect(mocks.write).not.toHaveBeenCalled();
});
