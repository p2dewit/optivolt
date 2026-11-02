import type { GreenSocTarget } from '../../lib/types.ts';

const SOLAR_ACTIVITY_THRESHOLD_W = 50;
const GRID_COVER_SLOTS = 2;
export const GREEN_PRICE_LOOKAHEAD_HOURS = 24;

export interface GreenPriceThresholds {
  buy_cents_per_kWh: number[];
  sell_cents_per_kWh: number[];
}

function percentile(values: number[], percentilePercent: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.POSITIVE_INFINITY;
  const position = (sorted.length - 1) * Math.max(0, Math.min(100, percentilePercent)) / 100;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Per-slot rolling, forward-looking thresholds from the optimizer's all-in prices. */
export function buildGreenPriceThresholds(input: {
  importPrice_cents_per_kWh: number[];
  exportPrice_cents_per_kWh: number[];
  stepSize_m: number;
  buyPercentile_percent: number;
  sellPercentile_percent: number;
  maximumBuySafetyCap_cents_per_kWh: number;
}): GreenPriceThresholds {
  const length = Math.min(input.importPrice_cents_per_kWh.length, input.exportPrice_cents_per_kWh.length);
  const lookaheadSlots = Math.max(1, Math.ceil(GREEN_PRICE_LOOKAHEAD_HOURS * 60 / input.stepSize_m));
  const buy_cents_per_kWh: number[] = [];
  const sell_cents_per_kWh: number[] = [];
  for (let slot = 0; slot < length; slot++) {
    const end = Math.min(length, slot + lookaheadSlots);
    const buys = input.importPrice_cents_per_kWh.slice(slot, end);
    const sells = input.exportPrice_cents_per_kWh.slice(slot, end);
    buy_cents_per_kWh.push(Math.min(
      input.maximumBuySafetyCap_cents_per_kWh,
      percentile(buys, input.buyPercentile_percent),
    ));
    sell_cents_per_kWh.push(percentile(sells, input.sellPercentile_percent));
  }
  return { buy_cents_per_kWh, sell_cents_per_kWh };
}

interface GreenSocTargetInput {
  load_W: number[];
  pv_W: number[];
  importPrice_cents_per_kWh: number[];
  buyPriceThreshold_cents_per_kWh: number[];
  startMs: number;
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  dischargeEfficiency_percent: number;
  chargeEfficiency_percent: number;
  maxChargePower_W: number;
  idleDrain_W: number;
}

/** Build soft reserve targets from the load and PV forecasts used by the optimizer. */
export function buildGreenSocTargets(input: GreenSocTargetInput): GreenSocTarget[] {
  const { load_W, pv_W, importPrice_cents_per_kWh, buyPriceThreshold_cents_per_kWh, startMs, stepSize_m, batteryCapacity_Wh, minSoc_percent, maxSoc_percent, dischargeEfficiency_percent, chargeEfficiency_percent, maxChargePower_W, idleDrain_W } = input;
  const length = Math.min(load_W.length, pv_W.length, importPrice_cents_per_kWh.length, buyPriceThreshold_cents_per_kWh.length);
  if (!length || stepSize_m <= 0 || dischargeEfficiency_percent <= 0) return [];
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, number[]>();
  for (let slot = 0; slot < length; slot++) {
    const key = dateFmt.format(startMs + slot * stepSize_m * 60_000);
    const slots = days.get(key) ?? [];
    slots.push(slot);
    days.set(key, slots);
  }
  const solarDays: Array<{ first: number; last: number }> = [];
  for (const slots of days.values()) {
    const active = slots.filter(slot => pv_W[slot] >= SOLAR_ACTIVITY_THRESHOLD_W);
    if (active.length) solarDays.push({ first: active[0], last: active[active.length - 1] });
  }
  const minWh = batteryCapacity_Wh * minSoc_percent / 100;
  const maxWh = batteryCapacity_Wh * maxSoc_percent / 100;
  const hours = stepSize_m / 60;
  const efficiency = dischargeEfficiency_percent / 100;
  const targetBySlot = new Map<number, GreenSocTarget>();
  const addTarget = (target: GreenSocTarget) => {
    const previous = targetBySlot.get(target.slot);
    if (!previous || target.soc_Wh > previous.soc_Wh) targetBySlot.set(target.slot, target);
  };
  const recovery = (start: number, end: number): number => {
    for (let slot = start; slot + GRID_COVER_SLOTS - 1 <= end; slot++) {
      let covered = true;
      for (let j = 0; j < GRID_COVER_SLOTS; j++) if (pv_W[slot + j] < load_W[slot + j]) { covered = false; break; }
      if (covered) return slot;
    }
    return end + 1;
  };
  const energyNeed = (start: number, end: number): number => {
    let need = 0;
    for (let slot = Math.max(0, start); slot <= Math.min(length - 1, end); slot++) {
      need += (Math.max(0, load_W[slot] - pv_W[slot]) / efficiency + idleDrain_W) * hours;
    }
    return need;
  };
  for (let i = 0; i < solarDays.length; i++) {
    const day = solarDays[i], next = solarDays[i + 1];
    if (day.first > 0) {
      const end = Math.min(length - 1, day.first + 48);
      const morningRecovery = recovery(day.first, end);
      addTarget({ slot: day.first - 1, soc_Wh: Math.min(maxWh, minWh + energyNeed(day.first, Math.min(length - 1, morningRecovery - 1))), boundary: 'sunrise' });
    }
    if (next && next.first > day.last) {
      const end = Math.min(length - 1, next.first + 48);
      const morningRecovery = recovery(next.first, end);
      const target = { slot: day.last, soc_Wh: Math.min(maxWh, minWh + energyNeed(day.last + 1, Math.min(length - 1, morningRecovery - 1))), boundary: 'sunset' as const };
      addTarget(target);
    }
  }
  // Reserve enough battery energy after each slot to cover forecast net demand
  // until the next slot whose all-in import price meets Green's buy threshold.
  // PV surplus is credited (subject to the configured charge power and efficiency).
  const chargeEfficiency = input.chargeEfficiency_percent / 100;
  for (let slot = 0; slot < length; slot++) {
    let nextAffordable = -1;
    for (let candidate = slot + 1; candidate < length; candidate++) {
      if (importPrice_cents_per_kWh[candidate] <= buyPriceThreshold_cents_per_kWh[candidate]) {
        nextAffordable = candidate;
        break;
      }
    }
    const end = nextAffordable >= 0 ? nextAffordable - 1 : length - 1;
    let reserveWh = minWh;
    for (let future = end; future > slot; future--) {
      const deficitWh = Math.max(0, load_W[future] - pv_W[future]) * hours / efficiency;
      const pvChargeWh = Math.min(maxChargePower_W, Math.max(0, pv_W[future] - load_W[future])) * hours * chargeEfficiency;
      reserveWh = Math.max(minWh, Math.min(maxWh, reserveWh + deficitWh + idleDrain_W * hours - pvChargeWh));
    }
    const target = { slot, soc_Wh: reserveWh, boundary: 'next-charge' as const };
    addTarget(target);
  }
  return [...targetBySlot.values()].sort((a, b) => a.slot - b.slot);
}
