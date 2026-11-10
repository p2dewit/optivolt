import type { WinterSocTarget } from '../../lib/types.ts';
import type { Settings } from '../types.ts';

export const WINTER_LOOKAHEAD_DAYS = 7;
export const WINTER_TRAILING_TOLERANCE_MS = 6 * 60 * 60_000;

/** Use the user's configured horizon; Winter applies its own seven-day maximum. */
export function getEffectiveHorizonDays(settings: Pick<Settings, 'strategy' | 'extendedHorizonDays'>): number {
  return settings.extendedHorizonDays;
}

export function getWinterHorizonEndMs(startMs: number, horizonDays = WINTER_LOOKAHEAD_DAYS): number {
  const days = Math.max(0, Math.min(WINTER_LOOKAHEAD_DAYS, horizonDays));
  return startMs + days * 24 * 60 * 60_000;
}

function percentile(values: number[], percentilePercent: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.POSITIVE_INFINITY;
  const position = (sorted.length - 1) * Math.max(0, Math.min(100, percentilePercent)) / 100;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** One all-in import-price threshold over the configured Winter planning horizon. */
export function buildWinterCheapPriceThreshold(
  importPrice_cents_per_kWh: number[],
  buyPercentile_percent: number,
): number {
  return percentile(importPrice_cents_per_kWh, buyPercentile_percent);
}

/**
 * Reserve enough battery energy to serve forecast load until the next cheap
 * price window. A window is a contiguous run of slots at or below the configured
 * percentile threshold. If no later window exists, target maximum SoC. PV
 * surplus is credited as charging.
 */
export function buildWinterSocTargets(input: {
  load_W: number[];
  pv_W: number[];
  importPrice_cents_per_kWh: number[];
  cheapPriceThreshold_cents_per_kWh: number;
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  dischargeEfficiency_percent: number;
  chargeEfficiency_percent: number;
  maxChargePower_W: number;
  idleDrain_W: number;
}): WinterSocTarget[] {
  const length = Math.min(input.load_W.length, input.pv_W.length, input.importPrice_cents_per_kWh.length);
  if (!length || input.stepSize_m <= 0 || input.dischargeEfficiency_percent <= 0) return [];

  const slotsInSevenDays = Math.ceil(WINTER_LOOKAHEAD_DAYS * 24 * 60 / input.stepSize_m);
  const minWh = input.batteryCapacity_Wh * input.minSoc_percent / 100;
  const maxWh = input.batteryCapacity_Wh * input.maxSoc_percent / 100;
  const stepHours = input.stepSize_m / 60;
  const dischargeEfficiency = input.dischargeEfficiency_percent / 100;
  const chargeEfficiency = input.chargeEfficiency_percent / 100;
  const cheapWindowStarts: number[] = [];
  for (let slot = 0; slot < length; slot++) {
    const isCheap = input.importPrice_cents_per_kWh[slot] <= input.cheapPriceThreshold_cents_per_kWh;
    const previousIsCheap = slot > 0
      && input.importPrice_cents_per_kWh[slot - 1] <= input.cheapPriceThreshold_cents_per_kWh;
    if (isCheap && !previousIsCheap) cheapWindowStarts.push(slot);
  }
  const targets: WinterSocTarget[] = [];
  let nextWindowIndex = 0;

  for (let slot = 0; slot < length; slot++) {
    const horizonEnd = Math.min(length, slot + slotsInSevenDays + 1);
    while (nextWindowIndex < cheapWindowStarts.length && cheapWindowStarts[nextWindowIndex] <= slot) nextWindowIndex++;
    const nextCheapWindow = cheapWindowStarts[nextWindowIndex] < horizonEnd
      ? cheapWindowStarts[nextWindowIndex]
      : -1;

    let targetWh = maxWh;
    if (nextCheapWindow >= 0) {
      targetWh = minWh;
      for (let future = slot + 1; future < nextCheapWindow; future++) {
        const netDemandW = input.load_W[future] - input.pv_W[future];
        const batteryEnergyNeeded = Math.max(0, netDemandW) * stepHours / dischargeEfficiency;
        const pvChargeEnergy = Math.min(input.maxChargePower_W, Math.max(0, -netDemandW))
          * stepHours * chargeEfficiency;
        targetWh = Math.min(maxWh, Math.max(minWh,
          targetWh + batteryEnergyNeeded + input.idleDrain_W * stepHours - pvChargeEnergy,
        ));
      }
    }

    targets.push({ slot, soc_Wh: targetWh });
  }
  return targets;
}
