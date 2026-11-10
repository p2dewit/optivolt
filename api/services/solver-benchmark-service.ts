import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { applyPredictionAdjustmentsToData } from './prediction-adjustments.ts';
import { buildSolverConfigFromSettings } from './config-builder.ts';
import { getSolverInputs, selectSolveOptions } from './planner-service.ts';
import { readNativeSolverCapabilities } from './solver-runtime.ts';
import { solveLp } from './solve-runner.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import { HttpError } from '../http-errors.ts';
import type { Strategy } from '../../lib/types.ts';

type BenchmarkStatus = 'running' | 'completed' | 'failed';
type BenchmarkRun = {
  multiThreadingEnabled: boolean;
  maxThreads: number;
  label: string;
  elapsedMs: number;
  solverStatus: string;
  hasSolution: boolean;
  objectiveValue?: number;
  error?: string;
};
type BenchmarkRecommendation = Pick<BenchmarkRun, 'multiThreadingEnabled' | 'maxThreads' | 'label' | 'elapsedMs' | 'solverStatus'>
  & { basis: 'fastest-optimal' | 'fastest-feasible' };
export interface SolverBenchmarkJob {
  id: string;
  strategy: Strategy;
  status: BenchmarkStatus;
  phase: 'preparing' | 'solving' | 'complete';
  completed: number;
  total: number | null;
  current: string | null;
  runs: BenchmarkRun[];
  recommendation: BenchmarkRecommendation | null;
  message: string | null;
  createdAt: number;
}

const jobs = new Map<string, SolverBenchmarkJob>();
const MAX_RETAINED_JOBS = 20;
const JOB_RETENTION_MS = 30 * 60_000;
const MAX_THREADS = 64;

function publicJob(job: SolverBenchmarkJob): SolverBenchmarkJob {
  return { ...job, runs: job.runs.map(run => ({ ...run })), recommendation: job.recommendation ? { ...job.recommendation } : null };
}

function pruneJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
  while (jobs.size >= MAX_RETAINED_JOBS) {
    const oldest = jobs.keys().next().value as string | undefined;
    if (!oldest) break;
    jobs.delete(oldest);
  }
}

export async function startSolverBenchmark(requestedStrategy?: Strategy): Promise<SolverBenchmarkJob> {
  if ([...jobs.values()].some(job => job.status === 'running')) {
    throw new HttpError(409, 'A solver benchmark is already running. Wait for it to finish before starting another.');
  }
  const capabilities = await readNativeSolverCapabilities();
  if (!capabilities) {
    throw new HttpError(503, 'Find optimum requires the native HiGHS bridge with configurable thread support. Rebuild native/highs before running the benchmark.');
  }

  const inputs = await getSolverInputs();
  const strategy = requestedStrategy ?? inputs.settings.solverBenchmarkStrategy;
  const strategyLabel = strategy === 'aggressive' ? 'Trade' : strategy === 'winter' ? 'Winter mode' : 'Green';
  pruneJobs();
  const job: SolverBenchmarkJob = {
    id: randomUUID(), strategy, status: 'running', phase: 'preparing', completed: 0, total: null,
    current: `Preparing ${strategyLabel} model`, runs: [], recommendation: null, message: null, createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  void runBenchmark(job, inputs, strategy).catch(error => {
    job.status = 'failed';
    job.phase = 'complete';
    job.current = null;
    job.message = error instanceof Error ? error.message : String(error);
  });
  return publicJob(job);
}

export function getSolverBenchmark(id: string): SolverBenchmarkJob | null {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

async function runBenchmark(job: SolverBenchmarkJob, inputs: Awaited<ReturnType<typeof getSolverInputs>>, strategy: Strategy): Promise<void> {
  const benchmarkSettings = { ...inputs.settings, strategy };
  const adjustedData = applyPredictionAdjustmentsToData(inputs.data);
  const { cfg } = buildSolverConfigFromSettings(benchmarkSettings, adjustedData, inputs.timing.startMs, inputs.evState);
  const lpText = buildLP(cfg);
  const solveOptions = selectSolveOptions(
    cfg,
    inputs.settings.solverTimeLimit_s,
    inputs.settings.solverMipGapPercentByStrategy[strategy],
  );
  const maxThreads = Math.max(1, Math.min(MAX_THREADS, inputs.settings.solverMaxThreads, availableParallelism()));
  const configurations = [
    { multiThreadingEnabled: false, maxThreads: 1, label: 'Single-threaded' },
    ...Array.from({ length: Math.max(0, maxThreads - 1) }, (_, index) => {
      const count = index + 2;
      return { multiThreadingEnabled: true, maxThreads: count, label: `Multi-threaded · ${count} threads` };
    }),
  ];

  job.phase = 'solving';
  job.total = configurations.length;
  for (const config of configurations) {
    job.current = config.label;
    let startedAt = performance.now();
    try {
      const result = await solveLp(lpText, solveOptions, undefined, {
        multiThreadingEnabled: config.multiThreadingEnabled,
        maxThreads: config.maxThreads,
      }, () => { startedAt = performance.now(); }, {
        purpose: 'find-optimum',
        strategy,
        horizonDays: inputs.settings.extendedHorizonDays,
        slots: cfg.load_W.length,
        runLabel: config.label,
      });
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      let hasSolution = false;
      let validationError: string | undefined;
      try {
        parseSolution(result, cfg, { startMs: inputs.timing.startMs, stepMin: inputs.timing.stepMin });
        hasSolution = true;
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
      }
      job.runs.push({
        ...config, elapsedMs, solverStatus: result.Status ?? 'Unknown', hasSolution,
        ...(Number.isFinite(result.ObjectiveValue) ? { objectiveValue: result.ObjectiveValue } : {}),
        ...(!hasSolution && validationError ? { error: validationError } : {}),
      });
    } catch (error) {
      job.runs.push({
        ...config, elapsedMs: Math.max(0, performance.now() - startedAt), solverStatus: 'Error', hasSolution: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    job.completed += 1;
  }

  const optimal = job.runs.filter(run => run.hasSolution && run.solverStatus === 'Optimal');
  const feasible = job.runs.filter(run => run.hasSolution);
  const candidates = optimal.length ? optimal : feasible;
  const best = [...candidates].sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  if (best) {
    job.recommendation = {
      multiThreadingEnabled: best.multiThreadingEnabled,
      maxThreads: best.maxThreads,
      label: best.label,
      elapsedMs: best.elapsedMs,
      solverStatus: best.solverStatus,
      basis: optimal.length ? 'fastest-optimal' : 'fastest-feasible',
    };
    if (!optimal.length) job.message = 'No configuration proved optimal within the solver time limit; the recommendation is the fastest feasible solution.';
  } else {
    const strategyLabel = strategy === 'aggressive' ? 'Trade' : strategy === 'winter' ? 'Winter mode' : 'Green';
    job.message = `No configuration produced a valid ${strategyLabel} solution.`;
  }
  job.status = 'completed';
  job.phase = 'complete';
  job.current = null;
}
