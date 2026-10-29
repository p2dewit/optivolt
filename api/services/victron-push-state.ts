import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';

const STATE_PATH = path.join(resolveDataDir(), 'victron-push-state.json');

interface VictronPushState {
  lastPushAtMs: number;
}

let cachedLastPushAtMs: number | null | undefined;

/** The most recent successful schedule push, including pushes from HA automations. */
export async function getLastVictronPushAtMs(): Promise<number | null> {
  if (cachedLastPushAtMs !== undefined) return cachedLastPushAtMs;

  try {
    const state = await readJson<Partial<VictronPushState>>(STATE_PATH);
    cachedLastPushAtMs = Number.isFinite(state.lastPushAtMs) ? Number(state.lastPushAtMs) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[victron-schedule] failed to read last-push state:', error instanceof Error ? error.message : String(error));
    }
    cachedLastPushAtMs = null;
  }

  return cachedLastPushAtMs;
}

/** Record only after the Victron schedule write has been confirmed. */
export async function recordSuccessfulVictronPush(): Promise<number> {
  const lastPushAtMs = Date.now();
  cachedLastPushAtMs = lastPushAtMs;

  try {
    await writeJson(STATE_PATH, { lastPushAtMs });
  } catch (error) {
    // The successful MQTT write remains successful even if this small status
    // file cannot be saved. Keep the timestamp available for this process.
    console.warn('[victron-schedule] failed to persist last-push state:', error instanceof Error ? error.message : String(error));
  }

  return lastPushAtMs;
}
