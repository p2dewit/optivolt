import type { Settings } from '../types.ts';

const HIGH_POWER_FRACTION = 0.75;
// User-supplied taper regions. These are recognition hints, not measured BMS limits.
const CHARGE_TAPER_SOC = 85;
const DISCHARGE_TAPER_SOC = 15;
const POWER_NOISE_W = 1;
export type Direction = 'charge' | 'discharge';
export type PowerRow = { g2b: number; pv2b: number; b2l?: number; b2g?: number; b2ev?: number };
type BlockRow = PowerRow & { timestampMs: number; dess: { socTarget_percent: number } };
type Limits = Pick<Settings, 'maxChargePower_W' | 'maxDischargePower_W'> & Partial<Pick<Settings, 'idleDrain_W' | 'chargeEfficiency_percent'>>;

export function chargingPower(row: PowerRow): number {
  return Math.max(0, row.g2b + row.pv2b);
}
export function dischargingPower(row: PowerRow): number {
  return Math.max(0, (row.b2l ?? 0) + (row.b2g ?? 0) + (row.b2ev ?? 0));
}
function directionOf(row: PowerRow, settings: Limits): Direction | null {
  const charge = chargingPower(row);
  const discharge = dischargingPower(row);
  if (!Number.isFinite(charge) || !Number.isFinite(discharge)) return null;
  // A maintenance charge can merely offset inverter standby loss. It must
  // not connect an idle slot to a later high-power charging block.
  const efficiency = (settings.chargeEfficiency_percent ?? 100) / 100;
  const idleDrain = Math.max(0, settings.idleDrain_W ?? 0);
  const c = charge * efficiency - idleDrain > POWER_NOISE_W;
  const d = discharge > POWER_NOISE_W;
  // Never bridge an idle slot or a slot with simultaneous charge and discharge.
  return c === d ? null : c ? 'charge' : 'discharge';
}

/** Only inspects the four represented schedule slots, starting at the active slot. */
export function detectLiveBlock(rows: readonly BlockRow[], index: number, soc: number, settings: Limits, stepMs: number) {
  const direction = rows[index] ? directionOf(rows[index], settings) : null;
  let end = index;
  if (index < 0 || index >= 4 || !Number.isFinite(stepMs) || stepMs <= 0) {
    return { direction: null, end, recognized: false, basis: 'none' as const, taperRegion: false };
  }
  if (direction) {
    while (end + 1 < Math.min(rows.length, 4)
      && rows[end + 1].timestampMs === rows[end].timestampMs + stepMs
      && directionOf(rows[end + 1], settings) === direction) end++;
  }
  const limit = direction === 'charge' ? settings.maxChargePower_W : settings.maxDischargePower_W;
  const limitValid = Number.isFinite(limit) && limit > 0;
  const high = direction != null && limitValid && rows.slice(index, end + 1).some(row =>
    (direction === 'charge' ? chargingPower(row) : dischargingPower(row)) >= limit * HIGH_POWER_FRACTION);
  // The caller supplies observed SoC for an active block; future previews use planned start SoC.
  const taperRegion = Number.isFinite(soc) && (direction === 'charge' ? soc >= CHARGE_TAPER_SOC
    : direction === 'discharge' ? soc <= DISCHARGE_TAPER_SOC : false);
  const recognized = direction != null && limitValid && (high || taperRegion);
  const basis = high ? 'high-power' as const : recognized ? 'soc-taper-region' as const : 'none' as const;
  return { direction, end, recognized, basis, taperRegion };
}

export function describeLiveBlock(rows: readonly BlockRow[], index: number, soc: number, settings: Limits, stepMs: number) {
  const activeBlock = detectLiveBlock(rows, index, soc, settings, stepMs);
  let block = activeBlock;
  let startIndex = index;
  let recognitionSoc = soc;
  // Future recognition is display-only. Do not bridge a gap in the represented schedule.
  if (!activeBlock.recognized && index >= 0 && index < 4 && Number.isFinite(stepMs) && stepMs > 0) {
    for (let next = index + 1; next < Math.min(rows.length, 4); next++) {
      if (rows[next].timestampMs !== rows[next - 1].timestampMs + stepMs) break;
      const plannedStartSoc = rows[next - 1].dess.socTarget_percent;
      const candidate = detectLiveBlock(rows, next, plannedStartSoc, settings, stepMs);
      if (candidate.recognized) {
        block = candidate;
        startIndex = next;
        recognitionSoc = plannedStartSoc;
        break;
      }
    }
  }
  return {
    isFuture: startIndex > index,
    activeDirection: activeBlock.direction,
    socBasis: startIndex > index ? 'planned' : 'observed',
    recognitionSoc_percent: recognitionSoc,
    recognized: block.recognized,
    direction: block.direction,
    basis: block.basis,
    taperRegion: block.taperRegion,
    taperThreshold_percent: block.direction === 'charge' ? CHARGE_TAPER_SOC : DISCHARGE_TAPER_SOC,
    startIndex,
    endIndex: block.end,
    slots: rows.slice(0, 4).map((row, slotIndex) => {
      const charge = chargingPower(row), discharge = dischargingPower(row);
      return {
        index: slotIndex,
        startMs: row.timestampMs,
        endMs: row.timestampMs + stepMs,
        chargePower_W: Number.isFinite(charge) ? charge : 0,
        dischargePower_W: Number.isFinite(discharge) ? discharge : 0,
        socTarget_percent: row.dess.socTarget_percent,
        active: slotIndex === index,
        inBlock: block.recognized && slotIndex >= startIndex && slotIndex <= block.end,
      };
    }),
  };
}
