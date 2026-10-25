import { loadSettings } from './settings-store.ts';
import { readVictronActiveDynamicEssTarget, readVictronSocPercent, writeDynamicEssSlotSocTarget } from './mqtt-service.ts';
import { getLastPlan, isLastPlanPushedToVictron } from './planner-service.ts';
import type { Settings } from '../types.ts';

const POLL_MS = 60_000;
const HIGH_POWER_FRACTION = 0.75;
const SOC_TRIGGER_MARGIN = 1;
const SOC_EPSILON = 0.5;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
type Direction = 'charge' | 'discharge';
let lastAdjustment: { planAt: number; blockEnd: number; direction: Direction; target: number } | null = null;
const state: Record<string, unknown> = {
  mode: 'off', soc_percent: null, activeTarget_percent: null, plannedTarget_percent: null, observedAt: null, status: 'Off',
  reason: null, proposedTarget_percent: null, writtenTarget_percent: null,
  direction: null, triggerTarget_percent: null, blockEndAt: null,
};

type MonitorPlanRow = {
  timestampMs: number;
  g2b: number;
  pv2b: number;
  b2l: number;
  b2g: number;
  b2ev: number;
  dess: { socTarget_percent: number };
};
type MonitorPlan = {
  computedAtMs: number;
  timing: { startMs: number; stepMin: number };
  result: { Status: 'Optimal' };
  rows: MonitorPlanRow[];
};
let uiMonitorPlan: { plan: MonitorPlan; receivedAtMs: number } | null = null;
let uiMonitorPlanReportedAtMs: number | null = null;

function parseMonitorPlan(input: unknown): MonitorPlan | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const timing = value.timing as Record<string, unknown> | null;
  if (value.solverStatus !== 'Optimal' || !Number.isFinite(value.computedAtMs)
    || !timing || !Number.isFinite(timing.startMs) || !Number.isFinite(timing.stepMin)
    || Number(timing.stepMin) <= 0 || Number(timing.stepMin) > 60
    || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 4) return null;
  const rows: MonitorPlanRow[] = [];
  for (const raw of value.rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const dess = row.dess as Record<string, unknown> | null;
    if (!Number.isFinite(row.timestampMs) || !Number.isFinite(row.g2b) || !Number.isFinite(row.pv2b)
      || !dess || !Number.isFinite(dess.socTarget_percent)
      || Number(dess.socTarget_percent) < 0 || Number(dess.socTarget_percent) > 100) return null;
    for (const key of ['b2l', 'b2g', 'b2ev']) {
      if (row[key] !== undefined && !Number.isFinite(row[key])) return null;
    }
    rows.push({
      timestampMs: Number(row.timestampMs), g2b: Number(row.g2b), pv2b: Number(row.pv2b),
      b2l: Number(row.b2l ?? 0), b2g: Number(row.b2g ?? 0), b2ev: Number(row.b2ev ?? 0),
      dess: { socTarget_percent: Number(dess.socTarget_percent) },
    });
  }
  return {
    computedAtMs: Number(value.computedAtMs),
    timing: { startMs: Number(timing.startMs), stepMin: Number(timing.stepMin) },
    result: { Status: 'Optimal' }, rows,
  };
}

function getUiMonitorPlan(): MonitorPlan | undefined {
  if (!uiMonitorPlan) return undefined;
  if (Date.now() - uiMonitorPlan.receivedAtMs > 10 * 60_000) {
    uiMonitorPlan = null;
    return undefined;
  }
  const plan = uiMonitorPlan.plan;
  const last = plan.rows[plan.rows.length - 1];
  if (Date.now() < plan.timing.startMs || Date.now() >= last.timestampMs + plan.timing.stepMin * 60_000) {
    uiMonitorPlan = null;
    return undefined;
  }
  return plan;
}

export async function setLiveBlockGuardMonitorPlan(input: unknown): Promise<boolean> {
  uiMonitorPlanReportedAtMs = Date.now();
  const candidate = parseMonitorPlan(input);
  if (!candidate) {
    const hadPlan = uiMonitorPlan != null;
    uiMonitorPlan = null;
    if (hadPlan) await tick();
    return false;
  }
  const changed = uiMonitorPlan?.plan.computedAtMs !== candidate.computedAtMs
    || uiMonitorPlan?.plan.rows[0]?.timestampMs !== candidate.rows[0]?.timestampMs;
  uiMonitorPlan = { plan: candidate, receivedAtMs: Date.now() };
  if (changed) await tick();
  return true;
}

export function getLiveBlockGuardStatus() { return { ...state }; }

export async function refreshLiveBlockGuard(): Promise<void> {
  await tick();
}

type PowerRow = { g2b: number; pv2b: number; b2l?: number; b2g?: number; b2ev?: number };

function chargingPower(row: PowerRow): number {
  return Math.max(0, row.g2b + row.pv2b);
}

function dischargingPower(row: PowerRow): number {
  return Math.max(0, (row.b2l ?? 0) + (row.b2g ?? 0) + (row.b2ev ?? 0));
}

function highPower(row: PowerRow, direction: Direction, settings: Settings): boolean {
  const limit = direction === 'charge' ? settings.maxChargePower_W : settings.maxDischargePower_W;
  const power = direction === 'charge' ? chargingPower(row) : dischargingPower(row);
  return Number.isFinite(limit) && limit > 0 && power > 0 && power >= limit * HIGH_POWER_FRACTION;
}

function blockDirection(row: PowerRow, settings: Settings): Direction | null {
  const charge = highPower(row, 'charge', settings);
  const discharge = highPower(row, 'discharge', settings);
  // A simultaneous high charge/discharge row has no unambiguous block target.
  return charge === discharge ? null : charge ? 'charge' : 'discharge';
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await loadSettings();
    state.mode = settings.liveBlockGuardMode;
    state.proposedTarget_percent = null;
    state.writtenTarget_percent = null;
    state.plannedTarget_percent = null;
    state.direction = null;
    state.triggerTarget_percent = null;
    state.blockEndAt = null;
    if (settings.liveBlockGuardMode !== 'automatic' || !settings.pushToVictronEnabled) lastAdjustment = null;
    if (settings.liveBlockGuardMode === 'off') {
      state.status = 'Off'; state.reason = null;
      state.soc_percent = null; state.activeTarget_percent = null; state.plannedTarget_percent = null; state.observedAt = null;
      return;
    }

    const soc = await readVictronSocPercent();
    state.soc_percent = soc;
    try { state.activeTarget_percent = await readVictronActiveDynamicEssTarget(); }
    catch (error) {
      state.activeTarget_percent = null;
      console.warn('[live-block-guard] Victron schedule target read failed:', error instanceof Error ? error.message : String(error));
    }
    state.observedAt = new Date().toISOString();
    if (soc == null) { state.status = 'SoC unavailable'; state.reason = 'No current SoC received from Victron MQTT'; return; }

    const hasRecentUiReport = uiMonitorPlanReportedAtMs != null
      && Date.now() - uiMonitorPlanReportedAtMs <= 10 * 60_000;
    const plan = settings.liveBlockGuardMode === 'monitor' && hasRecentUiReport
      ? getUiMonitorPlan()
      : getLastPlan();
    if (!plan || plan.result.Status !== 'Optimal') {
      if (settings.liveBlockGuardMode === 'monitor') {
        state.status = 'Monitor: no valid OptiVolt plan';
        state.reason = 'A proposal will be shown when an optimal plan covers the current quarter-hour';
      } else {
        state.status = 'Monitoring SoC; no valid plan'; state.reason = 'Waiting for a current optimal plan';
      }
      return;
    }
    if (!isLastPlanPushedToVictron()) {
      lastAdjustment = null;
      if (settings.liveBlockGuardMode !== 'monitor') {
        state.status = 'Monitoring SoC; plan not sent to Victron';
        state.reason = 'There is no confirmed schedule write for this plan';
        return;
      }
      // Monitor mode evaluates the current optimizer plan even when no schedule
      // was pushed; this path never writes to Victron.
    }

    const stepMs = plan.timing.stepMin * 60_000;
    const now = Date.now();
    const index = Math.floor((now - plan.timing.startMs) / stepMs);
    const row = plan.rows[index];
    if (!row || index < 0 || index >= 4 || now < row.timestampMs || now >= row.timestampMs + stepMs) {
      state.status = 'Monitoring SoC; no active schedule slot'; state.reason = 'The current time is outside the four schedule slots sent to Victron'; return;
    }
    state.plannedTarget_percent = row.dess.socTarget_percent;
    const currentTarget = Math.round(row.dess.socTarget_percent);
    const victronTarget = state.activeTarget_percent;
    const direction = blockDirection(row, settings);
    state.direction = direction ?? (dischargingPower(row) > chargingPower(row) ? 'discharge'
      : chargingPower(row) > dischargingPower(row) ? 'charge' : 'idle');
    if (direction == null) {
      state.status = 'Monitoring SoC; no unambiguous high-power block';
      state.reason = 'The guard requires at least 75% of the configured charging or discharging limit in one direction';
      return;
    }
    const label = direction === 'charge' ? 'charging' : 'discharging';

    let blockEnd = index;
    while (blockEnd + 1 < plan.rows.length && blockEnd + 1 < 4
      && blockDirection(plan.rows[blockEnd + 1], settings) === direction) blockEnd += 1;
    state.blockEndAt = new Date(plan.rows[blockEnd].timestampMs + stepMs).toISOString();
    if (blockEnd === index) {
      state.status = `Monitoring SoC; the ${label} block ends in this slot`;
      state.reason = `There is no consecutive high-power ${label} slot; the planned end target is retained`;
      return;
    }

    const activeTarget = typeof victronTarget === 'number' && Number.isFinite(victronTarget)
      ? victronTarget : currentTarget;
    // Respond to whichever target can interrupt the block first. The live DESS
    // target may differ from the optimizer's current slot target.
    const triggerTarget = direction === 'charge' ? Math.min(currentTarget, activeTarget) : Math.max(currentTarget, activeTarget);
    state.triggerTarget_percent = triggerTarget;
    if (direction === 'charge' ? soc < triggerTarget - SOC_TRIGGER_MARGIN : soc > triggerTarget + SOC_TRIGGER_MARGIN) {
      state.status = `Monitoring SoC; waiting for the ${label} target`;
      state.reason = `No adjustment is due until SoC comes within ${SOC_TRIGGER_MARGIN} percentage point of ${Math.round(triggerTarget)}%; the guard would ${direction === 'charge' ? 'raise' : 'lower'} the target to continue this block`;
      return;
    }

    const capacityWh = settings.batteryCapacity_Wh;
    const chargeEfficiency = settings.chargeEfficiency_percent / 100;
    const dischargeEfficiency = settings.dischargeEfficiency_percent / 100;
    const minTarget = Math.ceil(settings.minSoc_percent);
    const maxTarget = Math.floor(settings.maxSoc_percent);
    if (!Number.isFinite(capacityWh) || capacityWh <= 0 || !Number.isFinite(chargeEfficiency)
      || chargeEfficiency <= 0 || chargeEfficiency > 1 || !Number.isFinite(dischargeEfficiency)
      || dischargeEfficiency <= 0 || dischargeEfficiency > 1
      || !Number.isFinite(minTarget) || !Number.isFinite(maxTarget) || minTarget > maxTarget) {
      state.status = 'Guard unavailable: invalid battery settings';
      state.reason = 'A positive battery capacity, efficiencies and a valid SoC range are required';
      return;
    }

    // Re-estimate only the remaining duration from live SoC. Discharge includes
    // output to home, grid and EV, efficiency loss and inverter idle drain.
    let remainingWh = 0;
    const nowInSlot = Math.max(0, Math.min(stepMs, now - row.timestampMs));
    for (let i = index; i <= blockEnd; i += 1) {
      const r = plan.rows[i];
      const durationHours = (i === index ? stepMs - nowInSlot : stepMs) / 3_600_000;
      const batteryPower = direction === 'charge' ? chargingPower(r) * chargeEfficiency
        : Math.max(0, dischargingPower(r) / dischargeEfficiency - chargingPower(r) * chargeEfficiency + settings.idleDrain_W);
      remainingWh += batteryPower * durationHours;
    }
    const remainingPercent = remainingWh / capacityWh * 100;
    const dischargeFloor = Math.max(minTarget, Math.round(plan.rows[blockEnd].dess.socTarget_percent));
    const target = direction === 'charge'
      ? Math.min(maxTarget, Math.max(currentTarget, Math.ceil(soc + remainingPercent)))
      : Math.max(dischargeFloor, Math.min(currentTarget, Math.floor(soc - remainingPercent)));
    const wouldExtend = direction === 'charge'
      ? target > Math.min(currentTarget, activeTarget) && target > soc + SOC_EPSILON
      : target < Math.max(currentTarget, activeTarget) && target < soc - SOC_EPSILON && target <= currentTarget;
    if (!Number.isFinite(target) || target < minTarget || target > maxTarget || !wouldExtend) {
      state.status = `No further ${label} target adjustment is due`;
      state.reason = direction === 'charge'
        ? `The plan target or maximum SoC leaves no higher target for this block`
        : `The plan target, block end reserve or minimum SoC leaves no lower target for this block`;
      return;
    }

    state.proposedTarget_percent = target;
    if (settings.liveBlockGuardMode !== 'automatic') {
      state.status = `Monitor: would ${direction === 'charge' ? 'raise' : 'lower'} the target for the ${label} block`;
      state.reason = `Plan target ${currentTarget}% → proposed target ${target}% through the end of the ${label} block; nothing is written in monitor mode`;
      return;
    }
    if (!settings.pushToVictronEnabled) {
      state.status = 'Automatic adjustment blocked: Push schedule to Victron is off';
      state.reason = `Proposed target ${Math.round(target)}%; nothing was written to Victron`;
      return;
    }

    const prior = lastAdjustment;
    if (prior?.planAt === plan.computedAtMs && prior.blockEnd === blockEnd && prior.direction === direction
      && (direction === 'charge' ? target <= prior.target : target >= prior.target)) {
      state.status = 'Automatic guard active'; state.reason = `SoC target ${prior.target}% is set for the consecutive ${label} block`;
      state.writtenTarget_percent = prior.target; return;
    }
    const latestSettings = await loadSettings();
    if (latestSettings.liveBlockGuardMode !== 'automatic' || !latestSettings.pushToVictronEnabled
      || getLastPlan()?.computedAtMs !== plan.computedAtMs || !isLastPlanPushedToVictron()
      || target < Math.ceil(latestSettings.minSoc_percent) || target > Math.floor(latestSettings.maxSoc_percent)
      || Math.floor((Date.now() - plan.timing.startMs) / stepMs) !== index) {
      state.status = 'Adjustment deferred: mode, plan or active slot changed';
      state.reason = 'No targets were written; the guard will re-evaluate the current block';
      return;
    }
    // Only update the active and remaining slots in this contiguous block.
    for (let i = index; i <= blockEnd; i += 1) await writeDynamicEssSlotSocTarget(i, target);
    lastAdjustment = { planAt: plan.computedAtMs, blockEnd, direction, target };
    state.status = `SoC target adjusted for the current ${label} block`;
    state.reason = `Slots ${index + 1}–${blockEnd + 1}: target ${target}%`;
    state.writtenTarget_percent = target;
  } catch (error) {
    state.status = 'Guard could not make an adjustment';
    state.reason = error instanceof Error ? error.message : String(error);
    console.warn('[live-block-guard]', state.reason);
  } finally { running = false; }
}

export function startLiveBlockGuard(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
}
