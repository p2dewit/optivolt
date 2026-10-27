import { fetchDayActuals } from './api/api.js';
import { drawFlowsBarStackSigned } from './charts.js';
import { aggregateRowsHourly, resolveFlowsResolution } from './plan-view.js';
import { mountViewToggles, subscribeViewToggles } from './view-toggles.js';
import { getPlan, subscribePlan } from './plan-store.js';

const REVENUE_KEY = 'optivolt:showActualRevenueLine';
const ACTIVE = 'rounded-full px-2.5 py-1 text-xs font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all';
const INACTIVE = 'rounded-full px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all';
const SLOT_MS = 15 * 60_000;

function setToggle(button, active) {
  if (!button) return;
  button.className = active ? ACTIVE : INACTIVE;
  button.setAttribute('aria-pressed', String(active));
}
function euro(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '—';
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(cents) / 100);
}
function setFinancialValue(element, cents) {
  if (!element) return;
  const value = cents != null && Number.isFinite(Number(cents)) ? Number(cents) : null;
  element.textContent = euro(value);
  element.classList.toggle('financial-positive', value !== null && value > 0);
  element.classList.toggle('financial-negative', value !== null && value < 0);
}
function setNeutralFinancialValue(element, cents) {
  if (!element) return;
  element.textContent = euro(cents);
  element.classList.remove('financial-positive', 'financial-negative');
}
function formatMinutes(milliseconds) {
  if (!(milliseconds > 0)) return null;
  return `${Math.ceil(milliseconds / 60_000)} min`;
}
function addDays(key, amount) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function dateKeyAt(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function planAt(planRows, timestampMs) {
  if (!planRows?.length) return null;
  let stepMs = 15 * 60_000;
  for (let i = 1; i < planRows.length; i += 1) {
    const gap = planRows[i].timestampMs - planRows[i - 1].timestampMs;
    if (gap > 0) { stepMs = gap; break; }
  }
  const row = [...planRows].reverse().find(r => r.timestampMs <= timestampMs && timestampMs < r.timestampMs + stepMs);
  if (!row) return null;
  return { ...row, stepMs };
}

export function plannedRangeTotals(startMs, endMs, planRows) {
  const durationMs = endMs - startMs;
  if (!Array.isArray(planRows) || planRows.length === 0 || !(durationMs > 0)) {
    return { complete: false, coverage: 0, coveredMs: 0, totals: null };
  }
  const sorted = [...planRows].sort((a, b) => a.timestampMs - b.timestampMs);
  const stepMs = sorted.slice(1).map((row, i) => row.timestampMs - sorted[i].timestampMs).find(gap => gap > 0) ?? SLOT_MS;
  const totals = { costs_cents: 0, revenue_cents: 0, batteryCosts_cents: 0 };
  let coveredMs = 0;
  for (const row of sorted) {
    const overlapMs = Math.max(0, Math.min(endMs, row.timestampMs + stepMs) - Math.max(startMs, row.timestampMs));
    if (!overlapMs) continue;
    const fraction = overlapMs / stepMs;
    const fields = [row.importCost_cents, row.exportCost_cents, row.batteryWearCost_cents];
    if (!fields.every(value => Number.isFinite(Number(value)))) return { complete: false, coverage: coveredMs / durationMs, coveredMs, totals: null };
    totals.costs_cents += Number(row.importCost_cents) * fraction;
    totals.revenue_cents += Number(row.exportCost_cents) * fraction;
    totals.batteryCosts_cents += Number(row.batteryWearCost_cents) * fraction;
    coveredMs += overlapMs;
  }
  const complete = coveredMs >= durationMs - 1;
  return {
    complete,
    coverage: Math.min(1, coveredMs / durationMs),
    coveredMs,
    totals: coveredMs > 0 ? {
      ...totals,
      result_cents: totals.revenue_cents - totals.costs_cents - totals.batteryCosts_cents,
    } : null,
  };
}

export function plannedDayTotals(startMs, endMs, planRows) {
  const range = plannedRangeTotals(startMs, endMs, planRows);
  return range.complete ? { complete: true, totals: range.totals } : { complete: false, totals: null };
}

function addActualAndPlanned(actual, planned) {
  if (!actual) return planned?.totals ?? null;
  if (!planned?.totals) return actual;
  const costs = Number.isFinite(actual.costs_cents) ? actual.costs_cents + planned.totals.costs_cents : null;
  const revenue = Number.isFinite(actual.revenue_cents) ? actual.revenue_cents + planned.totals.revenue_cents : null;
  const batteryCosts = Number.isFinite(actual.batteryCosts_cents) ? actual.batteryCosts_cents + planned.totals.batteryCosts_cents : null;
  return {
    costs_cents: costs,
    revenue_cents: revenue,
    batteryCosts_cents: batteryCosts,
    result_cents: costs === null || revenue === null || batteryCosts === null ? null : revenue - costs - batteryCosts,
  };
}

export function initDayActuals(els) {
  if (!els.actualFlows) return;
  let payload = null;
  let plan = getPlan();
  let todayPayload = null;
  let dayOffset = 0;
  let revenue = false;
  try { revenue = localStorage.getItem(REVENUE_KEY) === 'true'; } catch { /* Storage can be unavailable in private mode. */ }
  setToggle(els.showActualRevenue, revenue);
  const toggles = mountViewToggles(els.actualViewToggles);

  function updateNavigation() {
    const names = ['Yesterday', 'Today', 'Tomorrow'];
    const selected = names[dayOffset + 1];
    if (els.dayActualsPrev) { els.dayActualsPrev.textContent = `← ${names[dayOffset] ?? 'Yesterday'}`; els.dayActualsPrev.hidden = dayOffset <= -1; }
    if (els.dayActualsNext) { els.dayActualsNext.textContent = `${names[dayOffset + 2] ?? 'Tomorrow'} →`; els.dayActualsNext.hidden = dayOffset >= 1; }
    if (els.dayActualsDay) els.dayActualsDay.textContent = selected;
  }

  function chartRows() {
    const start = new Date(payload.start).getTime();
    const end = new Date(payload.end).getTime();
    const now = new Date(payload.observedAt).getTime();
    const actuals = new Map(payload.rows.map(row => [Math.floor(row.timestampMs / SLOT_MS) * SLOT_MS, row]));
    const rows = [];
    let netCents = 0;
    for (let timestampMs = start; timestampMs < end; timestampMs += SLOT_MS) {
      const actual = actuals.get(timestampMs);
      const actualUntil = Math.max(0, Math.min(SLOT_MS, now - timestampMs));
      const remaining = SLOT_MS - actualUntil;
      const useActual = dayOffset <= 0 && actualUntil > 0;
      const planned = dayOffset >= 0 && remaining > 0 ? planAt(plan?.rows, timestampMs + actualUntil) : null;
      const row = { timestampMs, tIdx: rows.length, soc_percent: null, ic: null, ec: null };
      const keys = ['load', 'pv', 'imp', 'exp', 'pv2l', 'pv2b', 'pv2g', 'b2l', 'b2g', 'g2l', 'g2b', 'g2ev', 'pv2ev', 'b2ev'];
      for (const key of keys) {
        const actualPower = useActual && actual ? Number(actual[key]) || 0 : 0;
        const planPower = planned ? Number(planned[key]) || 0 : 0;
        // Actual rows already encode their observed energy as an equivalent
        // 15-minute power value; keep that energy whole, then add only the
        // planned share after Now for a quarter that straddles the boundary.
        row[key] = actualPower + planPower * (planned ? remaining : 0) / SLOT_MS;
      }
      const actualNet = useActual && actual
        ? (Number(actual.exportCost_cents) || 0) - (Number(actual.importCost_cents) || 0) - (Number(actual.batteryWearCost_cents) || 0)
        : 0;
      const planShare = planned ? remaining / planned.stepMs : 0;
      row.source = useActual && planned ? 'mixed' : planned ? 'planned' : 'actual';
      const planNet = planned ? ((Number(planned.exportCost_cents) || 0) - (Number(planned.importCost_cents) || 0) - (Number(planned.batteryWearCost_cents) || 0)) * planShare : 0;
      netCents += actualNet + planNet;
      row.importCost_cents = (Number(actual?.importCost_cents) || 0) + (Number(planned?.importCost_cents) || 0) * planShare;
      row.exportCost_cents = (Number(actual?.exportCost_cents) || 0) + (Number(planned?.exportCost_cents) || 0) * planShare;
      row.batteryWearCost_cents = (Number(actual?.batteryWearCost_cents) || 0) + (Number(planned?.batteryWearCost_cents) || 0) * planShare;
      row.cumulativeNetCents = netCents;
      rows.push(row);
    }
    return rows;
  }

  function render() {
    if (!payload) return;
    updateNavigation();
    const rows = chartRows();
    const resolution = resolveFlowsResolution(24);
    const visibleRows = resolution === '60' ? aggregateRowsHourly(rows, 15) : rows;
    toggles.update({ hasExtended: false, resolution });
    const marker = dayOffset === 0 ? { timestampMs: new Date(payload.observedAt).getTime(), startMs: new Date(payload.start).getTime(), stepMs: resolution === '60' ? 3_600_000 : SLOT_MS } : null;
    drawFlowsBarStackSigned(els.actualFlows, visibleRows, resolution === '60' ? 60 : 15, null, null, revenue, marker);

    const dayStart = new Date(payload.start).getTime();
    const dayEnd = new Date(payload.end).getTime();
    const observedAt = new Date(payload.observedAt).getTime();
    const plannedTotals = dayOffset > 0
      ? plannedDayTotals(dayStart, dayEnd, plan?.rows)
      : null;
    const plannedRest = dayOffset === 0
      ? plannedRangeTotals(Math.max(dayStart, observedAt), dayEnd, plan?.rows)
      : null;
    const totals = dayOffset === 0
      ? addActualAndPlanned(todayPayload?.totals, plannedRest)
      : dayOffset < 0 ? payload.totals : plannedTotals?.totals;
    setFinancialValue(els.dayResult, totals?.result_cents);
    setNeutralFinancialValue(els.dayCosts, totals?.costs_cents);
    setFinancialValue(els.dayRevenue, totals?.revenue_cents);
    setNeutralFinancialValue(els.dayBatteryCosts, totals?.batteryCosts_cents);
    const date = payload.dateKey;
    const label = dayOffset === 0 ? 'Today' : dayOffset < 0 ? 'Yesterday' : 'Tomorrow';
    const at = new Intl.DateTimeFormat('nl-NL', { timeZone: payload.timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(payload.observedAt));
    if (dayOffset > 0) {
      els.dayActualsStatus.textContent = !plan?.rows?.length
        ? `No planned power flows available for ${label.toLowerCase()} (${date}).`
        : plannedTotals.complete
          ? `Planned power flows and daily costs for ${label.toLowerCase()} (${date}).`
          : `Partial plan for ${label.toLowerCase()} (${date}); daily totals appear when the plan covers the full day.`;
      return;
    }
    const quality = payload.quality;
    const gaps = [['grid', formatMinutes(quality.missingGridMs)], ['battery', formatMinutes(quality.missingBatteryMs)], ['PV', formatMinutes(quality.missingPvMs)], ['import price', formatMinutes(quality.missingImportPriceMs)], ['export price', formatMinutes(quality.missingExportPriceMs)]].filter(([, duration]) => duration).map(([name, duration]) => `${name}: ${duration}`);
    const prefix = dayOffset < 0 ? `Actual power flows for ${label.toLowerCase()} (${date}).` : `Today (${date}): actual through ${at}, planned after Now (${payload.timeZone}).`;
    const planNote = dayOffset === 0 && observedAt < dayEnd
      ? plannedRest.coverage === 1 ? ' Planned costs and revenue through midnight included.'
        : plannedRest.coverage > 0 ? ` Planned costs and revenue included for ${Math.round(plannedRest.coverage * 100)}% of the remaining time.`
          : ' No planned costs or revenue available for the remaining time yet.'
      : '';
    els.dayActualsStatus.textContent = gaps.length ? `${prefix} Partial data — ${gaps.join(', ')}.${planNote}` : `${prefix}${planNote}`;
  }

  async function refresh() {
    try {
      const timeZone = payload?.timeZone ?? todayPayload?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Amsterdam';
      const todayDate = dateKeyAt(new Date(), timeZone);
      const requestedDate = dayOffset === 0 ? undefined : addDays(todayDate, dayOffset);
      const nextPayload = await fetchDayActuals(requestedDate);
      payload = nextPayload;
      plan = getPlan();
      if (dayOffset === 0) todayPayload = nextPayload;
      render();
    } catch (error) { els.dayActualsStatus.textContent = `Day actuals unavailable: ${error.message}`; }
  }
  function changeDay(offset) { dayOffset = Math.max(-1, Math.min(1, offset)); payload = null; void refresh(); }
  els.dayActualsPrev?.addEventListener('click', () => changeDay(dayOffset - 1));
  els.dayActualsNext?.addEventListener('click', () => changeDay(dayOffset + 1));
  els.dayActualsDay?.addEventListener('click', () => changeDay(0));
  els.showActualRevenue?.addEventListener('click', () => {
    revenue = !revenue; setToggle(els.showActualRevenue, revenue);
    try { localStorage.setItem(REVENUE_KEY, String(revenue)); } catch { /* Keep the in-memory choice. */ }
    render();
  });
  subscribeViewToggles(render);
  subscribePlan(nextPlan => { plan = nextPlan; render(); });
  void refresh();
  setInterval(() => { void refresh(); }, 60_000);
}
