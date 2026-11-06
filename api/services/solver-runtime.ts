import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const nativeSolverPath = process.env.OPTIVOLT_HIGHS_NATIVE_PATH
  ?? fileURLToPath(new URL('../../native/highs/bin/highs-native-bridge', import.meta.url));

export interface NativeSolverCapabilities {
  highsVersion: string;
  configurableThreads: boolean;
}

/** Returns null when the bridge is missing, stale, or cannot be executed here. */
export async function readNativeSolverCapabilities(): Promise<NativeSolverCapabilities | null> {
  if (!existsSync(nativeSolverPath)) return null;
  try {
    const { stdout } = await execFileAsync(nativeSolverPath, ['--capabilities'], {
      timeout: 5_000,
      encoding: 'utf8',
    });
    const value = JSON.parse(String(stdout)) as Partial<NativeSolverCapabilities>;
    if (typeof value.highsVersion !== 'string' || value.configurableThreads !== true) return null;
    return { highsVersion: value.highsVersion, configurableThreads: true };
  } catch {
    return null;
  }
}
