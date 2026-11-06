// Worker-thread entry point for HiGHS solves. The WASM solve is synchronous
// and can run for tens of seconds; running it here keeps the main event loop
// (and every HTTP request) responsive. See solve-runner.ts for the caller.
import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import type { HighsSolution } from '../../lib/parse-solution.ts';
import { existsSync } from 'node:fs';
import { nativeSolverPath } from './solver-runtime.ts';
// @ts-expect-error — no .d.ts alongside the vendor build artifact
import highsFactory from '../../vendor/highs-build/highs.js';

interface SolveRequest {
  id: number;
  lpText: string;
  options: Record<string, unknown>;
  /** Optional partial starting solution ({column name: value}); see lib/warm-start.ts. */
  warmColumns?: Record<string, number>;
  solverSettings?: { multiThreadingEnabled: boolean; maxThreads: number };
}

const useNativeSolver = existsSync(nativeSolverPath);
let highsPromise: ReturnType<typeof highsFactory> | undefined;

function solveNative(request: Omit<SolveRequest, 'id'>): Promise<HighsSolution> {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeSolverPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`Native HiGHS exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as HighsSolution);
      } catch (err) {
        reject(new Error(`Native HiGHS returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    child.stdin.once('error', reject);
    child.stdin.end(JSON.stringify(request));
  });
}

if (useNativeSolver) {
  console.info(`Using native HiGHS solver at ${nativeSolverPath}`);
}

parentPort!.on('message', async ({ id, lpText, options, warmColumns, solverSettings }: SolveRequest) => {
  parentPort!.postMessage({ id, started: true });
  try {
    let result: HighsSolution;
    if (useNativeSolver) {
      result = await solveNative({ lpText, options, warmColumns, solverSettings });
      result.Diagnostics = { ...result.Diagnostics, backend: 'native' };
    } else {
      highsPromise ??= highsFactory({});
      const highs = await highsPromise;
      result = highs.solve(lpText, options, warmColumns);
      result.Diagnostics = { backend: 'wasm' };
    }
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
