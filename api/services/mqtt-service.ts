import { VictronMqttClient } from './victron-mqtt-client.ts';
import type { PlanRowWithDess } from '../types.ts';
import { getMqttEnv } from '../env.ts';

let victronClient: VictronMqttClient | null = null;

function getVictronClient(): VictronMqttClient {
  if (!victronClient) {
    victronClient = new VictronMqttClient(getMqttEnv());
  }

  return victronClient;
}

export async function getVictronSerial(): Promise<string> {
  const client = getVictronClient();
  return client.getSerial();
}

export async function readVictronSetting(relativePath: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<unknown> {
  const client = getVictronClient();
  return client.readSetting(relativePath, { timeoutMs });
}

/**
 * Reads the Dynamic ESS target of the slot active at now. TargetSoc is preferred;
 * Soc is a compatibility fallback for Venus versions that expose only that key.
 */
export async function readVictronActiveDynamicEssTarget(nowMs = Date.now()): Promise<number | null> {
  const client = getVictronClient();
  const serial = await client.getSerial();
  const asPercent = (payload: unknown): number | null => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const raw = (payload as { value?: unknown }).value;
    if (raw == null || raw === '' || Array.isArray(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  };

  // Venus publishes the currently active Dynamic ESS target separately from
  // the configured schedule. Prefer that runtime value to inferencing a slot.
  try {
    const runtimeTarget = await client.readSetting('system/0/DynamicEss/TargetSoc', { serial });
    const parsed = asPercent(runtimeTarget);
    if (parsed != null && parsed > 0) return parsed;
  } catch {
    // Older Venus versions may not publish this runtime path; inspect slots below.
  }

  const slots = await Promise.all(Array.from({ length: 4 }, async (_, slotIndex) => {
    const base = 'settings/0/Settings/DynamicEss/Schedule/' + slotIndex;
    const [start, duration] = await Promise.all([
      client.readSetting(base + '/Start', { serial }),
      client.readSetting(base + '/Duration', { serial }),
    ]) as [unknown, unknown];
    const getValue = (payload: unknown) => payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Number((payload as { value?: unknown }).value) : NaN;
    return { base, start: getValue(start), duration: getValue(duration) };
  }));
  const now = nowMs / 1000;
  const active = slots.filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.duration)
    && slot.duration > 0 && slot.start <= now && now < slot.start + slot.duration)
    .sort((a, b) => b.start - a.start)[0];
  if (!active) return null;
  const [targetSoc, soc] = await Promise.all([
    client.readSetting(active.base + '/TargetSoc', { serial }),
    client.readSetting(active.base + '/Soc', { serial }),
  ]);
  return asPercent(targetSoc) ?? asPercent(soc);
}

export async function writeVictronSetting(relativePath: string, value: unknown): Promise<void> {
  const client = getVictronClient();
  await client.writeSetting(relativePath, value);
}

/**
 * Read the current battery SoC (%) from MQTT.
 * Returns a number in [0, 100] or null if unavailable.
 */
export async function readVictronSocPercent({ timeoutMs }: { timeoutMs?: number } = {}): Promise<number | null> {
  const client = getVictronClient();
  const res = await client.readSocPercent({ timeoutMs });
  return res.soc_percent;
}

/**
 * Read ESS SoC limits (min/max %) from MQTT.
 * Returns { minSoc_percent: number | null, maxSoc_percent: number | null }.
 */
export async function readVictronSocLimits({ timeoutMs }: { timeoutMs?: number } = {}): Promise<{ minSoc_percent: number | null; maxSoc_percent: number | null }> {
  const client = getVictronClient();
  const res = await client.readSocLimitsPercent({ timeoutMs });
  return { minSoc_percent: res.minSoc_percent, maxSoc_percent: res.maxSoc_percent };
}

/**
 * High-level Dynamic ESS schedule builder.
 *
 * rows: optimizer rows with DESS slot data
 * slotCount: how many slots to push (starting from rows[0])
 * stepSeconds: slot duration; falls back to the row spacing (needs >= 2 rows) when omitted.
 */
export async function setDynamicEssSchedule(rows: PlanRowWithDess[], slotCount: number, stepSeconds?: number): Promise<{ serial: string; slotsWritten: number }> {
  const client = getVictronClient();
  const serial = await client.getSerial();

  const nSlots = Math.min(slotCount, rows.length);
  const tasks = [];
  // Prefer the explicit slot duration; only fall back to the row delta when there are
  // >= 2 rows, so a single-slot plan (end of the data horizon) doesn't crash on rows[1].
  const slotSeconds = stepSeconds ?? (rows.length >= 2 ? (rows[1].timestampMs - rows[0].timestampMs) / 1000 : 900);

  for (let i = 0; i < nSlots; i += 1) {
    const row = rows[i];

    const slot = {
      startEpoch: Math.round(row.timestampMs / 1000),
      durationSeconds: slotSeconds,
      strategy: row.dess.strategy,
      flags: row.dess.flags,
      socTarget: Math.round(row.dess.socTarget_percent),
      restrictions: row.dess.restrictions,
      allowGridFeedIn: row.dess.feedin,
    };
    tasks.push(client.writeScheduleSlot(i, slot, { serial }));
  }

  await Promise.all(tasks);

  return { serial, slotsWritten: nSlots };
}

export async function writeDynamicEssSlotSocTarget(slotIndex: number, targetPercent: number): Promise<void> {
  const client = getVictronClient();
  const serial = await client.getSerial();
  const base = `settings/0/Settings/DynamicEss/Schedule/${slotIndex}`;
  await Promise.all([
    client.writeSetting(`${base}/Soc`, Math.round(targetPercent), { serial }),
    client.writeSetting(`${base}/TargetSoc`, Math.round(targetPercent), { serial }),
  ]);
}

export async function shutdownVictronClient(): Promise<void> {
  if (!victronClient) return;
  await victronClient.close();
  victronClient = null;
}
