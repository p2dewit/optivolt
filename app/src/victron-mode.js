import { fetchVictronMode } from './api/api.js';

export function initVictronModeIndicator(els) {
  if (!els.victronMode) return;

  let currentMode = null;
  let checking = true;
  let requestId = 0;

  const expectedMode = () =>
    els.pushToVictron?.checked === true ? 4 : 1;

  function paint() {
    const expected = expectedMode();
    const confirmed = currentMode === expected && !checking;

    const symbol = checking ? '…' : confirmed ? '✓' : '✗';
    const status = checking ? 'Controleren…' : symbol;

    const color = checking
      ? 'text-amber-600 dark:text-amber-400'
      : confirmed
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400';

    els.victronMode.textContent =
      `Mode: ${currentMode ?? '—'} ${status}`;

    els.victronMode.className = `text-sm font-medium ${color}`;
  }

  async function refresh() {
    const id = ++requestId;
    try {
      const value = (await fetchVictronMode())?.mode;
      if (id !== requestId) return;
      currentMode =
        value == null || value === '' ? null : Number(value);
      if (!Number.isFinite(currentMode)) currentMode = null;
    } catch {
      if (id !== requestId) return;
      currentMode = null;
    }
    if (id !== requestId) return;
    checking = false;
    paint();
  }

  els.pushToVictron?.addEventListener('change', () => {
    requestId++;
    checking = true;
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
