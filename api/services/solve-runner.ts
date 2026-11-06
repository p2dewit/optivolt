import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { HighsSolution } from '../../lib/parse-solution.ts';

/**
 * Runs HiGHS solves on a persistent worker thread (see solve-worker.ts), so a
 * long MILP no longer blocks the event loop. One worker, one solve at a time:
 * calls are queued, preserving the serialization the old synchronous solve
 * gave for free. A solve error discards the worker — a throwing WASM solve may
 * leave the heap corrupted (the old lazy-instance code reset for the same
 * reason) — and the next call starts a fresh one, paying init again.
 */

interface PendingSolve {
  resolve(result: HighsSolution): void;
  reject(err: Error): void;
  onStarted?: () => void;
  queuedAt: number;
  startedAt?: number;
  model: { sha256: string; lpBytes: number; constraintRows: number; binaryColumns: number };
  warmStartColumnsSent: number;
  solverSettings: { multiThreadingEnabled: boolean; maxThreads: number };
  options: Record<string, unknown>;
  context: SolveContext;
}

export interface SolveContext {
  purpose?: 'plan' | 'find-optimum' | 'other';
  strategy?: string;
  horizonDays?: number;
  slots?: number;
  runLabel?: string;
}

let worker: Worker | undefined;
const pending = new Map<number, PendingSolve>();
let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();

function modelSummary(lpText: string): PendingSolve['model'] {
  const binarySection = lpText.match(/\nBinaries\s*\n([\s\S]*?)\nEnd\s*$/i)?.[1] ?? '';
  return {
    sha256: createHash('sha256').update(lpText).digest('hex'),
    lpBytes: Buffer.byteLength(lpText, 'utf8'),
    constraintRows: (lpText.match(/^[ \t]*c_[\w]+:/gm) ?? []).length,
    binaryColumns: binarySection.trim() ? binarySection.trim().split(/\s+/).length : 0,
  };
}

function logSolve(id: number, pendingSolve: PendingSolve, result?: HighsSolution, error?: Error): void {
  const finishedAt = performance.now();
  const diagnostics = result?.Diagnostics;
  console.info('[solver] solve', {
    id,
    ...pendingSolve.context,
    modelSha256: pendingSolve.model.sha256,
    lpBytes: pendingSolve.model.lpBytes,
    constraintRows: pendingSolve.model.constraintRows,
    binaryColumns: pendingSolve.model.binaryColumns,
    solverBackend: diagnostics?.backend ?? 'unknown',
    highsVersion: diagnostics?.highsVersion ?? null,
    threads: diagnostics?.threads ?? (pendingSolve.solverSettings.multiThreadingEnabled ? pendingSolve.solverSettings.maxThreads : 1),
    parallel: diagnostics?.parallel ?? pendingSolve.solverSettings.multiThreadingEnabled,
    solverSettings: pendingSolve.solverSettings,
    options: pendingSolve.options,
    warmStartColumnsSent: pendingSolve.warmStartColumnsSent,
    queueWaitMs: pendingSolve.startedAt == null ? null : Math.round(pendingSolve.startedAt - pendingSolve.queuedAt),
    solveMs: pendingSolve.startedAt == null ? null : Math.round(finishedAt - pendingSolve.startedAt),
    totalMs: Math.round(finishedAt - pendingSolve.queuedAt),
    modelRows: diagnostics?.numRows ?? null,
    modelColumns: diagnostics?.numColumns ?? null,
    modelNonzeros: diagnostics?.numNonzeros ?? null,
    mipNodeCount: diagnostics?.mipNodeCount ?? null,
    mipGap: diagnostics?.mipGap ?? null,
    mipDualBound: diagnostics?.mipDualBound ?? null,
    objectiveValue: result?.ObjectiveValue ?? null,
    status: result?.Status ?? 'Error',
    error: error?.message,
  });
}

function createWorker(): Worker {
  const w = new Worker(new URL('./solve-worker.ts', import.meta.url));
  // Only an in-flight solve should keep the process alive, not the idle worker.
  w.unref();

  const discard = (err?: Error) => {
    if (worker === w) worker = undefined;
    void w.terminate();
    if (err) {
      const failed = [...pending.values()];
      pending.clear();
      for (const p of failed) p.reject(err);
    }
  };

  w.on('message', ({ id, result, error, started }: { id: number; result?: HighsSolution; error?: string; started?: boolean }) => {
    if (started) {
      const p = pending.get(id);
      if (p) {
        p.startedAt = performance.now();
        p.onStarted?.();
      }
      return;
    }
    const p = pending.get(id);
    pending.delete(id);
    if (pending.size === 0) w.unref();
    if (error != null) {
      if (p) logSolve(id, p, undefined, new Error(error));
      discard();
      p?.reject(new Error(error));
    } else {
      if (p) logSolve(id, p, result);
      p?.resolve(result!);
    }
  });
  w.on('error', (err: Error) => discard(err));
  w.on('exit', (code) => {
    if (worker === w) discard(new Error(`Solver worker exited unexpectedly with code ${code}`));
  });

  return w;
}

export function solveLp(
  lpText: string,
  options: Record<string, unknown>,
  warmColumns?: Record<string, number>,
  solverSettings = { multiThreadingEnabled: true, maxThreads: 4 },
  onSolveStarted?: () => void,
  context: SolveContext = {},
): Promise<HighsSolution> {
  const queuedAt = performance.now();
  const model = modelSummary(lpText);
  const run = queue.then(() => new Promise<HighsSolution>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve, reject, onStarted: onSolveStarted, queuedAt, model,
      warmStartColumnsSent: Object.keys(warmColumns ?? {}).length,
      solverSettings, options, context,
    });
    if (!worker) worker = createWorker();
    worker.ref();
    worker.postMessage({ id, lpText, options, warmColumns, solverSettings });
  }));
  queue = run.catch(() => {});
  return run;
}
