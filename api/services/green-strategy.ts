import type { GreenSocTarget } from '../../lib/types.ts';

const SOLAR_ACTIVITY_THRESHOLD_W = 50;
const GRID_COVER_SLOTS = 2;

interface GreenSocTargetInput {
  load_W: number[];
  pv_W: number[];
  startMs: number;
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  dischargeEfficiency_percent: number;
  idleDrain_W: number;
}

/** Build soft reserve targets from the load and PV forecasts used by the optimizer. */
export function buildGreenSocTargets(input: GreenSocTargetInput): GreenSocTarget[] {
  const { load_W, pv_W, startMs, stepSize_m, batteryCapacity_Wh, minSoc_percent, maxSoc_percent, dischargeEfficiency_percent, idleDrain_W } = input;
  const length = Math.min(load_W.length, pv_W.length);
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
  const targets: GreenSocTarget[] = [];
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
      targets.push({ slot: day.first - 1, soc_Wh: Math.min(maxWh, minWh + energyNeed(day.first, Math.min(length - 1, morningRecovery - 1))), boundary: 'sunrise' });
    }
    if (next && next.first > day.last) {
      const end = Math.min(length - 1, next.first + 48);
      const morningRecovery = recovery(next.first, end);
      targets.push({ slot: day.last, soc_Wh: Math.min(maxWh, minWh + energyNeed(day.last + 1, Math.min(length - 1, morningRecovery - 1))), boundary: 'sunset' });
    }
  }
  return targets;
}
