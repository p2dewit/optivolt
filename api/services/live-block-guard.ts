import { loadSettings } from './settings-store.ts';
import { ensureDynamicEssMode4, readVictronActiveDynamicEssTarget, readVictronSocPercent, writeDynamicEssSlotSocTarget } from './mqtt-service.ts';
import { getLastPlan, isLastPlanPushedToVictron } from './planner-service.ts';
import { chargingPower, dischargingPower, describeLiveBlock, type Direction } from './live-block-detection.ts';

const POLL_MS = 60_000;
const SOC_TRIGGER_MARGIN = 2;
const SOC_EPSILON = 0.5;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastAdjustment: { planAt: number; blockEnd: number; direction: Direction; target: number } | null = null;
let qualifiedBlock: { startAt: number; endAt: number; direction: Direction } | null = null;
const state: Record<string, unknown> = {
  mode: 'off', soc_percent: null, activeTarget_percent: null, plannedTarget_percent: null, observedAt: null, status: 'Off',
  reason: null, proposedTarget_percent: null, writtenTarget_percent: null, adjustmentDue: null,
  direction: null, triggerTarget_percent: null, blockEndAt: null, blockPreview: null,
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

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await loadSettings();
    state.mode = settings.liveBlockGuardMode;
    state.proposedTarget_percent = null;
    state.adjustmentDue = null;
    state.writtenTarget_percent = null;
    state.plannedTarget_percent = null;
    state.direction = null;
    state.triggerTarget_percent = null;
    state.blockEndAt = null;
    state.blockPreview = null;
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

    // Both modes recognize the same plan. Prefer the authoritative server
    // plan when its represented four slots still cover now. Browser fallback
    // is display-only and can never authorize a physical target write.
    const serverPlan = getLastPlan();
    const coversNow = (candidate: MonitorPlan | undefined | null) => {
      if (!candidate || candidate.result.Status !== 'Optimal') return false;
      const step = candidate.timing.stepMin * 60_000;
      const slot = Math.floor((Date.now() - candidate.timing.startMs) / step);
      const row = candidate.rows[slot];
      return step > 0 && slot >= 0 && slot < 4 && row != null
        && Date.now() >= row.timestampMs && Date.now() < row.timestampMs + step;
    };
    const plan = coversNow(serverPlan as MonitorPlan | undefined)
      ? serverPlan : getUiMonitorPlan();
    if (!plan || plan.result.Status !== 'Optimal') {
      if (settings.liveBlockGuardMode === 'monitor') {
        state.status = 'Monitor: no valid OptiVolt plan';
        state.reason = 'A proposal will be shown when an optimal plan covers the current quarter-hour';
      } else {
        state.status = 'Monitoring SoC; no valid plan'; state.reason = 'Waiting for a current optimal plan';
      }
      return;
    }
    const confirmedServerPlan = plan === serverPlan && isLastPlanPushedToVictron();
    if (!confirmedServerPlan) lastAdjustment = null;

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
    let block = describeLiveBlock(plan.rows, index, soc, settings, stepMs);
    const activeStartAt = row.timestampMs;
    const activeDirection = block.activeDirection;
    const plannedEndRow = plan.rows[block.endIndex];
    const plannedBlockEndAt = plannedEndRow ? plannedEndRow.timestampMs + stepMs : Number.NaN;

    // Qualify a block from its original first slot, then retain that decision
    // through contiguous lower-power slots and plan refreshes.
    const startsAtHighPower = !block.isFuture && block.startedHighPower;
    if (startsAtHighPower && activeDirection && Number.isFinite(plannedBlockEndAt)) {
      if (!block.recognized || block.basis !== 'high-power') {
        block = {
          ...block,
          recognized: true,
          basis: 'high-power',
          startIndex: block.blockStartIndex,
          slots: block.slots.map(slot => ({
            ...slot,
            inBlock: slot.index >= block.blockStartIndex && slot.index <= block.endIndex,
          })),
        };
      }
      qualifiedBlock = {
        startAt: plan.rows[block.blockStartIndex]?.timestampMs ?? row.timestampMs,
        endAt: plannedBlockEndAt,
        direction: activeDirection,
      };
    } else if (qualifiedBlock && activeDirection === qualifiedBlock.direction
      && activeStartAt >= qualifiedBlock.startAt && activeStartAt < qualifiedBlock.endAt
      && Number.isFinite(plannedBlockEndAt)) {
      qualifiedBlock = { ...qualifiedBlock, endAt: Math.max(qualifiedBlock.endAt, plannedBlockEndAt) };
      block = {
        ...block,
        recognized: true,
        basis: 'high-power',
        startIndex: block.blockStartIndex,
        slots: block.slots.map(slot => ({
          ...slot,
          inBlock: slot.index >= block.blockStartIndex && slot.index <= block.endIndex,
        })),
      };
    } else {
      qualifiedBlock = null;
    }
    state.blockPreview = block;
    const direction = block.direction;
    state.direction = block.activeDirection ?? 'idle';
    // A future preview must never change the active or future Victron targets.
    if (block.isFuture) {
      const futureLabel = direction === 'charge' ? 'charging' : 'discharging';
      state.status = `Monitoring SoC; future ${futureLabel} block recognized`;
      state.reason = `Slots ${block.startIndex + 1}–${block.endIndex + 1} form a future ${futureLabel} block; preview only until the block becomes active`;
      return;
    }
    if (!block.recognized || block.basis !== 'high-power' || direction == null) {
      state.status = 'Monitoring SoC; no qualifying continuous block';
      state.reason = direction == null
        ? 'The active slot is idle or has simultaneous charging and discharging'
        : 'The continuous block did not start with a high-power slot';
      return;
    }
    const label = direction === 'charge' ? 'charging' : 'discharging';
    const blockEnd = block.endIndex;
    state.blockEndAt = new Date(plan.rows[blockEnd].timestampMs + stepMs).toISOString();
    if (blockEnd === index) {
      state.status = `Monitoring SoC; the ${label} block ends in this slot`;
      state.reason = `There is no consecutive ${label} slot; the planned end target is retained`;
      return;
    }

    const activeTarget = typeof victronTarget === 'number' && Number.isFinite(victronTarget)
      ? victronTarget : currentTarget;
    // Respond to whichever target can interrupt the block first. The live DESS
    // target may differ from the optimizer's current slot target.
    const triggerTarget = direction === 'charge' ? Math.min(currentTarget, activeTarget) : Math.max(currentTarget, activeTarget);
    state.triggerTarget_percent = triggerTarget;
    const socTriggerDue = direction === 'charge'
      ? soc >= triggerTarget - SOC_TRIGGER_MARGIN : soc <= triggerTarget + SOC_TRIGGER_MARGIN;

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
    let activeSlotRemainingWh = 0;
    const nowInSlot = Math.max(0, Math.min(stepMs, now - row.timestampMs));
    for (let i = index; i <= blockEnd; i += 1) {
      const r = plan.rows[i];
      const durationHours = (i === index ? stepMs - nowInSlot : stepMs) / 3_600_000;
      const batteryPower = direction === 'charge' ? chargingPower(r) * chargeEfficiency
        : Math.max(0, dischargingPower(r) / dischargeEfficiency - chargingPower(r) * chargeEfficiency + settings.idleDrain_W);
      remainingWh += batteryPower * durationHours;
      if (i === index) activeSlotRemainingWh = batteryPower * durationHours;
    }
    const activeSlotRemainingPercent = activeSlotRemainingWh / capacityWh * 100;
    const targetReachedBySlotEnd = direction === 'charge'
      ? soc + activeSlotRemainingPercent >= triggerTarget - SOC_EPSILON
      : soc - activeSlotRemainingPercent <= triggerTarget + SOC_EPSILON;
    const adjustmentDue = socTriggerDue && targetReachedBySlotEnd;
    state.adjustmentDue = adjustmentDue;
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
    if (!socTriggerDue) {
      state.status = `Monitoring SoC; waiting for the ${label} target`;
      state.reason = `No adjustment is due until SoC comes within ${SOC_TRIGGER_MARGIN} percentage points of ${Math.round(triggerTarget)}%; estimated next target ${target}%, recalculated when the guard next checks`;
      return;
    }
    if (!targetReachedBySlotEnd) {
      state.status = 'Monitoring SoC; slot target is not at risk';
      state.reason = `Planned power in the active slot is not enough to reach ${Math.round(triggerTarget)}% before the slot ends`;
      return;
    }
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

    if (!confirmedServerPlan) {
      state.status = 'Automatic adjustment blocked: plan not confirmed as sent to Victron';
      state.reason = `Block recognition and proposed target ${Math.round(target)}% are preview only; no targets were written`;
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
    // Automatic mode extends the target as soon as the active block is known.
    // Waiting until the old target is almost reached leaves a race at a slot
    // boundary: Venus may go idle before the next one-minute guard tick.
    await ensureDynamicEssMode4();
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
