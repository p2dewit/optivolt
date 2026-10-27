import { loadSettings } from './settings-store.ts';
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

export async function readVictronDynamicEssMode({
  timeoutMs = 2000
}: { timeoutMs?: number } = {}): Promise<number | null> {
  const client = getVictronClient();
  const serial = await client.getSerial();
  const payload = await client.readSetting(
    'settings/0/Settings/DynamicEss/Mode',
    { serial, timeoutMs }
  );
  if (!payload || typeof payload !== 'object'
      || Array.isArray(payload) || !('value' in payload)) {
    return null;
  }
  const raw = (payload as { value?: unknown }).value;
  if (raw == null || raw === '') return null;
  const mode = Number(raw);
  return mode === 1 || mode === 4 ? mode : null;
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
// Serialize ownership changes, schedule pushes and guard writes. A release waits
// for an existing write, while queued writes re-check the persisted switch.
let writeQueue: Promise<unknown> = Promise.resolve();
function queueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {});
  return result;
}

async function setModeVerified(client: VictronMqttClient, serial: string, mode: 1 | 4): Promise<void> {
  // A successful MQTT publish is not proof that Venus accepted the setting.
  const modePath = 'settings/0/Settings/DynamicEss/Mode';
  try {
    await client.writeSetting(modePath, mode, { serial });
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const payload = await client.readSetting(modePath, { serial, timeoutMs: 2000 });
        if (payload && typeof payload === 'object' && 'value' in payload
          && (payload.value === mode || payload.value === String(mode))) {
          confirmed = true;
          break;
        }
      } catch {
        // Retry a missing acknowledgement before failing the entire push.
      }
    }
    if (!confirmed) throw new Error(`Victron did not confirm Dynamic ESS mode ${mode}`);
  } catch (error) {
    throw new Error(`Unable to set and verify Dynamic ESS mode ${mode}: ${error instanceof Error ? error.message : String(error)}`);
  }

}

export async function ensureDynamicEssMode4(): Promise<void> {
  return queueWrite(async () => {
    if (!(await loadSettings()).pushToVictronEnabled) {
      throw new Error('Push to Victron is disabled');
    }
    const client = getVictronClient();
    await setModeVerified(client, await client.getSerial(), 4);
  });
}

export async function releaseDynamicEssToVrm(): Promise<void> {
  return queueWrite(async () => {
    if ((await loadSettings()).pushToVictronEnabled) throw new Error('Push was re-enabled; VRM handover cancelled');
    const client = getVictronClient();
    await setModeVerified(client, await client.getSerial(), 1);
  });
}

export async function setDynamicEssSchedule(rows: PlanRowWithDess[], slotCount: number, stepSeconds?: number): Promise<{ serial: string; slotsWritten: number }> {
  return queueWrite(async () => {
    if (!(await loadSettings()).pushToVictronEnabled) throw new Error('Schedule not sent: Push to Victron is disabled');
    try {
      return await writeSchedule(rows, slotCount, stepSeconds);
    } catch (error) {
      console.error('[victron-schedule] push failed', {
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Schedule not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// Verify every populated slot field, not just publish acknowledgements.
// Venus might accept a start time yet reject a strategy or restriction.
async function confirmScheduleSlot(client: VictronMqttClient, serial: string, index: number,
  expected: { startEpoch: number; durationSeconds: number; socTarget: number;
    strategy?: number; flags?: number; restrictions?: number; allowGridFeedIn?: number }): Promise<void> {
  const base = `settings/0/Settings/DynamicEss/Schedule/${index}`;
  const fields = [
    { path: 'Start', expected: expected.startEpoch },
    { path: 'Duration', expected: expected.durationSeconds },
    { path: 'Soc', expected: expected.socTarget },
    { path: 'TargetSoc', expected: expected.socTarget },
    { path: 'Strategy', expected: expected.strategy },
    { path: 'Flags', expected: expected.flags },
    { path: 'Restrictions', expected: expected.restrictions },
    { path: 'AllowGridFeedIn', expected: expected.allowGridFeedIn },
  ].filter((field): field is { path: string; expected: number } => field.expected !== undefined);
  for (const field of fields) {
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const payload = await client.readSetting(`${base}/${field.path}`, { serial, timeoutMs: 2000 });
        const raw = payload && typeof payload === 'object' && !Array.isArray(payload) && 'value' in payload
          ? (payload as { value?: unknown }).value : null;
        if (raw !== null && raw !== '' && !Array.isArray(raw) && Number(raw) === field.expected) {
          confirmed = true;
          break;
        }
      } catch { /* Transient MQTT read failure: retry. */ }
    }
    if (!confirmed) throw new Error(`Victron did not confirm schedule slot ${index} ${field.path}=${field.expected}`);
  }
}

function validateSchedule(rows: PlanRowWithDess[], slotCount: number, stepSeconds: number, nowMs: number): void {
  if (slotCount !== 4 || rows.length < 4) {
    throw new Error(`Expected four DESS schedule slots, received ${slotCount} of ${rows.length}`);
  }
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0 || !Number.isInteger(stepSeconds)) {
    throw new Error('Invalid DESS slot duration');
  }
  const stepMs = stepSeconds * 1000;
  for (let i = 0; i < 4; i++) {
    const row = rows[i];
    if (!Number.isFinite(row.timestampMs) || !Number.isInteger(row.timestampMs / 1000)
      || !row.dess || !Number.isFinite(row.dess.socTarget_percent)
      || row.dess.socTarget_percent < 0 || row.dess.socTarget_percent > 100) {
      throw new Error(`Invalid DESS schedule slot ${i}`);
    }
    if (i > 0 && row.timestampMs !== rows[i - 1].timestampMs + stepMs) {
      throw new Error(`DESS schedule slots ${i - 1} and ${i} are not consecutive`);
    }
  }
  const firstMs = rows[0].timestampMs;
  if (nowMs < firstMs || nowMs >= firstMs + 4 * stepMs) {
    throw new Error('DESS schedule does not cover the current time');
  }
}

async function writeSchedule(rows: PlanRowWithDess[], slotCount: number, stepSeconds?: number): Promise<{ serial: string; slotsWritten: number }> {
  const nSlots = Math.min(slotCount, rows.length);
  const slotSeconds = stepSeconds ?? (rows.length >= 2 ? (rows[1].timestampMs - rows[0].timestampMs) / 1000 : 900);
  validateSchedule(rows, nSlots, slotSeconds, Date.now());

  const client = getVictronClient();
  const serial = await client.getSerial();
  const plannedStart = new Date(rows[0].timestampMs).toISOString();
  const plannedEnd = new Date(rows[3].timestampMs + slotSeconds * 1000).toISOString();
  const started = Date.now();
  console.info('[victron-schedule] push started', { timestamp: new Date(started).toISOString(), slots: nSlots, plannedStart, plannedEnd });

  // Preserve the existing mode-before-slots order until the Venus firmware
  // behavior for live slot replacement has been validated on this installation.
  await setModeVerified(client, serial, 4);
  const slots = rows.slice(0, 4).map(row => ({
    startEpoch: Math.round(row.timestampMs / 1000),
    durationSeconds: slotSeconds,
    strategy: row.dess.strategy,
    flags: row.dess.flags,
    socTarget: Math.round(row.dess.socTarget_percent),
    restrictions: row.dess.restrictions,
    allowGridFeedIn: row.dess.feedin,
  }));
  // Write complete slot objects, then verify every populated slot field.
  await Promise.all(slots.map((slot, i) => client.writeScheduleSlot(i, slot, { serial })));
  for (let i = 0; i < slots.length; i++) {
    await confirmScheduleSlot(client, serial, i, slots[i]);
  }
  // A quarter-hour boundary can occur during the MQTT operation. Confirm
  // the newly written schedule still covers the time at verification end.
  const verifiedAt = Date.now();
  const endMs = rows[3].timestampMs + slotSeconds * 1000;
  if (verifiedAt < rows[0].timestampMs || verifiedAt >= endMs) {
    throw new Error('DESS schedule no longer covers the current time after verification');
  }
  const activeSlotIndex = Math.floor((verifiedAt - rows[0].timestampMs) / (slotSeconds * 1000));
  // Slot validation above ensures this is a legitimate index 0..3.
  // Slot writes can affect Venus's DESS state: verify the mode once more.
  const observedMode = await client.readSetting('settings/0/Settings/DynamicEss/Mode', { serial, timeoutMs: 2000 });
  if (!observedMode || typeof observedMode !== 'object' || !('value' in observedMode)
    || Number((observedMode as { value?: unknown }).value) !== 4) {
    throw new Error('Victron mode 4 was not retained after schedule push');
  }
  console.info('[victron-schedule] push verified', {
    timestamp: new Date().toISOString(), slots: nSlots, plannedStart, plannedEnd,
    durationMs: Date.now() - started, mode: 4, activeSlotIndex,
    remainingMs: endMs - verifiedAt,
  });
  return { serial, slotsWritten: nSlots };
}

export async function writeDynamicEssSlotSocTarget(slotIndex: number, targetPercent: number): Promise<void> {
  return queueWrite(async () => {
  if (!(await loadSettings()).pushToVictronEnabled) return;
  const client = getVictronClient();
  const serial = await client.getSerial();
  const base = `settings/0/Settings/DynamicEss/Schedule/${slotIndex}`;
  await Promise.all([
    client.writeSetting(`${base}/Soc`, Math.round(targetPercent), { serial }),
    client.writeSetting(`${base}/TargetSoc`, Math.round(targetPercent), { serial }),
  ]);
  });
}

export async function shutdownVictronClient(): Promise<void> {
  if (!victronClient) return;
  await victronClient.close();
  victronClient = null;
}
