import { fetchSolverBenchmark, startSolverBenchmark } from './api/api.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

export function initSolverBenchmark() {
  const button = document.getElementById('solver-find-optimum');
  const status = document.getElementById('solver-benchmark-status');
  const results = document.getElementById('solver-benchmark-results');
  if (!button || !status || !results) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = 'Preparing the Green model…';
    results.replaceChildren();
    results.classList.add('hidden');
    try {
      let job = await startSolverBenchmark();
      while (job.status === 'running') {
        const progress = job.total == null
          ? 'Preparing the Green model…'
          : `Benchmarking Green · ${Math.min(job.completed + 1, job.total)} of ${job.total}: ${job.current ?? 'starting'}…`;
        status.textContent = progress;
        await sleep(1000);
        job = await fetchSolverBenchmark(job.id);
      }

      if (job.status === 'failed') throw new Error(job.message || 'The benchmark failed.');
      const recommendation = job.recommendation;
      if (recommendation) {
        const threading = recommendation.multiThreadingEnabled
          ? `Multi-threading on, maximum ${recommendation.maxThreads} ${recommendation.maxThreads === 1 ? 'thread' : 'threads'}`
          : 'Multi-threading off, one thread';
        const quality = recommendation.basis === 'fastest-optimal'
          ? 'HiGHS optimal status reached within the configured MIP gap'
          : 'feasible solution; configured gap not reached';
        status.textContent = `Recommended: ${threading} · ${seconds(recommendation.elapsedMs)} (${quality}).`;
      } else {
        status.textContent = job.message || 'No valid Green solution was found.';
      }
      if (job.message) {
        const note = document.createElement('p');
        note.className = 'mb-2 text-amber-700 dark:text-amber-300';
        note.textContent = job.message;
        results.append(note);
      }
      const list = document.createElement('ul');
      list.className = 'space-y-1 text-slate-600 dark:text-slate-300';
      for (const run of job.runs) {
        const item = document.createElement('li');
        const label = run.multiThreadingEnabled
          ? `Parallel on · ${run.maxThreads} ${run.maxThreads === 1 ? 'thread' : 'threads'}`
          : 'Single-threaded';
        item.textContent = `${label}: ${run.solverStatus} · ${seconds(run.elapsedMs)}${run.hasSolution ? '' : ' · no solution'}`;
        list.append(item);
      }
      results.append(list);
      results.classList.remove('hidden');
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
}
