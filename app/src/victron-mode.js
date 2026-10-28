import { fetchVictronMode, fetchVictronPlanStatus } from './api/api.js';

export function initVictronModeIndicator(els) {
  if (!els.victronMode) return;

  let currentMode = null;
  let checking = true;
  let planReady = null;
  let checkingPlan = true;
  let requestId = 0;

  const expectedMode = () =>
    els.pushToVictron?.checked === true ? 4 : 1;

  function paint() {
    const confirmed = currentMode === expectedMode() && !checking;

    const symbol = checking ? '…' : confirmed ? '✓' : '✗';

    const color = checking
      ? 'text-amber-600 dark:text-amber-400'
      : confirmed
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400';

    els.victronMode.textContent = `Mode ${currentMode ?? '—'}`;

    els.victronMode.className = 'w-24 shrink-0 whitespace-nowrap text-right text-sm font-medium text-slate-700 dark:text-slate-300';

    if (els.victronPlanStatus) {
      const planSymbol = checkingPlan ? '…' : planReady ? '✓' : '✗';
      const planColor = checkingPlan
        ? 'text-amber-600 dark:text-amber-400'
        : planReady
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-red-600 dark:text-red-400';
      els.victronPlanStatus.textContent = 'Correct plan';
      els.victronPlanStatus.className = 'w-24 shrink-0 whitespace-nowrap text-right text-sm font-medium text-slate-700 dark:text-slate-300';
      if (els.victronPlanIndicator) {
        els.victronPlanIndicator.textContent = planSymbol;
        els.victronPlanIndicator.className = `w-4 shrink-0 text-center text-sm font-bold ${planColor}`;
      }
    }
    if (els.victronModeIndicator) {
      els.victronModeIndicator.textContent = symbol;
      els.victronModeIndicator.className = `w-4 shrink-0 text-center text-sm font-bold ${color}`;
    }
  }

  async function refresh() {
    const id = ++requestId;
    try {
      const [modeResult, planResult] = await Promise.allSettled([
        fetchVictronMode(),
        fetchVictronPlanStatus(),
      ]);
      if (id !== requestId) return;
      const value = modeResult.status === 'fulfilled' ? modeResult.value?.mode : null;
      currentMode = value == null || value === '' ? null : Number(value);
      if (!Number.isFinite(currentMode)) currentMode = null;
      planReady = planResult.status === 'fulfilled'
        && planResult.value?.ready === true;
    } catch {
      if (id !== requestId) return;
      currentMode = null;
      planReady = false;
    }
    if (id !== requestId) return;
    checking = false;
    checkingPlan = false;
    paint();
  }

  els.pushToVictron?.addEventListener('change', () => {
    requestId++;
    checking = true;
    checkingPlan = true;
    paint();

    let attempts = 0;
    const poll = async () => {
      attempts++;
      await refresh();
      if (currentMode !== expectedMode() && attempts < 8) {
        setTimeout(poll, 2000);
      }
    };
    setTimeout(poll, 750);
  });

  paint();
  void refresh();
  setInterval(() => { void refresh(); }, 30_000);
}
