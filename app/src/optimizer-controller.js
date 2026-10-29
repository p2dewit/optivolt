import { mountGuardBlockTooltip } from "./live-block-guard-tooltip.js";
import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./charts.js";
import { renderTable } from "./table.js";
import { debounce } from "./utils.js";
import { saveConfig } from "./config-store.js";
import { fetchLastPlan, requestRemoteSolve } from "./api/api.js";
import { updateEvPanel, collectEvSettings, initEvPanelToggles } from "./ev-tab.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
  updatePlanCostsUI,
} from "./state.js";
import { resolvePlanView, storeViewRange, storeFlowsResolution } from "./plan-view.js";
import {
  beginPlanRequest,
  getPlan,
  isCurrentPlanRequest,
  setPlan,
  subscribePlan,
} from "./plan-store.js";
import { mountViewToggles, subscribeViewToggles } from "./view-toggles.js";
import { renderNowPanel, startNowPanelTicker } from "./now-panel.js";
import { fetchLiveBlockGuardStatus, refreshLiveBlockGuard as requestLiveBlockGuardRefresh, updateLiveBlockGuardMonitorPlan } from "./api/api.js";

const CHART_PLACEHOLDER_IDLE = "Run the optimizer to see results";
const NET_REVENUE_LINE_KEY = "optivolt:showNetRevenueLine";
const SEG_ACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all";
const SEG_INACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all";
const PLACEHOLDER_SELECTOR = "#panel-optimizer .chart-empty span, #panel-ev .chart-empty span";

function setNetRevenueToggleState(button, active) {
  if (!button) return;
  button.className = active ? SEG_ACTIVE : SEG_INACTIVE;
  button.setAttribute("aria-pressed", String(active));
}

/** Text of the not-yet-drawn chart overlays on the plan-driven tabs. */
function setChartPlaceholders(text) {
  for (const span of document.querySelectorAll(PLACEHOLDER_SELECTOR)) {
    span.textContent = text;
  }
}

export function createOptimizerController({
  els,
  services = {},
  getEvEntries = () => [],
  onPlanRows = () => {},
  onForecastsRefreshed = () => {},
  refreshEvEntries = async () => {},
}) {
  const deps = {
    debounce,
    drawFlowsBarStackSigned,
    drawLoadPvGrouped,
    drawPricesStepLines,
    drawSocChart,
    fetchLastPlan,
    renderTable,
    requestRemoteSolve,
    saveConfig,
    snapshotUI,
    updateEvPanel,
    updatePlanMeta,
    updateRebalanceNudgeUI,
    updateSummaryUI,
    ...services,
  };

  const guardTooltip = mountGuardBlockTooltip(els.liveBlockGuardStatus);
  const viewToggles = mountViewToggles(els.optimizerViewToggles);
  if (els.showNetRevenue) {
    let enabled = false;
    try { enabled = localStorage.getItem(NET_REVENUE_LINE_KEY) === "true"; } catch {}
    setNetRevenueToggleState(els.showNetRevenue, enabled);
    els.showNetRevenue.addEventListener("click", () => {
      enabled = els.showNetRevenue.getAttribute("aria-pressed") !== "true";
      setNetRevenueToggleState(els.showNetRevenue, enabled);
      try { localStorage.setItem(NET_REVENUE_LINE_KEY, String(enabled)); } catch {}
      queuePersistSnapshot();
      renderVisuals();
    });
  }
  initEvPanelToggles(els);
  subscribeViewToggles(() => {
    queuePersistSnapshot();
    renderVisuals();
  });

  function hydrateChartPreferences(config) {
    if (config.chartViewRange != null) storeViewRange(config.chartViewRange);
    if (config.chartFlowsResolution != null) storeFlowsResolution(config.chartFlowsResolution);
    if (typeof config.chartShowNetRevenue === "boolean" && els.showNetRevenue) {
      setNetRevenueToggleState(els.showNetRevenue, config.chartShowNetRevenue);
    }
    renderVisuals();
  }

  // Everything the plan drives is painted from the store, so a plan set from
  // anywhere (fresh solve, boot's cached fetch) renders the same way.
  subscribePlan((plan) => {
    renderPlan(plan);
    void refreshLiveBlockGuardStatus();
  });

  // Price/forecast updates may be calculated by Home Assistant while this tab
  // is open. Poll the cached plan and repaint only when it is newer and matches
  // the current server inputs; renderPlan updates the four plan cost amounts.
  let lastSeenPlanAt = getPlan().computedAtMs ?? 0;
  let lastReportedPushAtMs = null;
  setInterval(async () => {
    try {
      const latest = await deps.fetchLastPlan();
      updateLatestPushStatus(latest);
      if (
        latest?.inputsCurrent === true &&
        Array.isArray(latest.rows) &&
        latest.rows.length > 0 &&
        Number(latest.computedAtMs) > lastSeenPlanAt
      ) {
        lastSeenPlanAt = Number(latest.computedAtMs);
        setPlan(latest);
      }
    } catch {
      // No current cached plan yet; the next poll will retry.
    }
  }, 30_000);

  async function refreshLiveBlockGuardStatus(refreshBackend = false) {
    if (!els.liveBlockGuardStatus) return;
    try {
      const current = getPlan();
      const allRows = current.rows;
      const rowStepMin = allRows.length > 1
        ? (allRows[1].timestampMs - allRows[0].timestampMs) / 60_000
        : getVizConfig().stepSize_m;
      const currentRowIndex = allRows.length > 0 && Number.isFinite(rowStepMin) && rowStepMin > 0
        ? Math.max(0, Math.floor((Date.now() - allRows[0].timestampMs) / (rowStepMin * 60_000)))
        : 0;
      const rows = allRows.slice(currentRowIndex, currentRowIndex + 4);
      const monitorPlan = els.liveBlockGuardMode?.value === "monitor"
        && current.solverStatus === "Optimal" && current.inputsCurrent !== false
        && rows.length > 0 && Number.isFinite(rowStepMin) && rowStepMin > 0
        ? {
          solverStatus: current.solverStatus,
          computedAtMs: current.computedAtMs,
          timing: { startMs: rows[0].timestampMs, stepMin: rowStepMin },
          rows,
        }
        : null;
      await updateLiveBlockGuardMonitorPlan(monitorPlan);
      if (refreshBackend) await requestLiveBlockGuardRefresh();
      const status = await fetchLiveBlockGuardStatus();
      guardTooltip.update(status);
      const isPercent = (value) => typeof value === "number" && Number.isFinite(value);
      const roundedPercent = (value) => String(Math.round(value)) + "%";
      const monitorMode = status.mode === "monitor";
      const rawStatus = typeof status.status === "string" ? status.status : "Status unavailable";
      const monitorStatus = rawStatus.replace(/^Monitor:\s*/, "").replace(/^Monitoring SoC;\s*/, "");
      const displayStatus = monitorMode
        ? "Monitor only: " + (/^waiting for the (charging|discharging) target$/.test(monitorStatus)
          ? "monitoring Victron DESS targets" : monitorStatus)
        : rawStatus;
      const soc = isPercent(status.soc_percent) ? " · Current SoC " + roundedPercent(status.soc_percent) : "";
      const victronValue = isPercent(status.activeTarget_percent) ? status.activeTarget_percent : status.writtenTarget_percent;
      const victronTarget = isPercent(victronValue) ? " · Victron SoC target " + roundedPercent(victronValue) : "";
      const planTarget = isPercent(status.plannedTarget_percent) ? " · OptiVolt plan target " + roundedPercent(status.plannedTarget_percent) : "";
      const proposal = monitorMode && isPercent(status.proposedTarget_percent)
        ? " · OptiVolt would " + (status.direction === "discharge" ? "lower" : "raise")
          + " target to " + roundedPercent(status.proposedTarget_percent) : "";
      const reason = status.reason;
      els.liveBlockGuardStatus.textContent = `${displayStatus}${soc}${victronTarget}${planTarget}${proposal}${reason ? ` — ${reason}` : ""}`;
    } catch {
      guardTooltip.update(null);
      els.liveBlockGuardStatus.textContent = "Guard status temporarily unavailable";
    }
  }
  void refreshLiveBlockGuardStatus();
  setInterval(() => { void refreshLiveBlockGuardStatus(); }, 30_000);

  // The "Now" block follows the wall clock, not the plan's first row, so it
  // keeps pointing at the right slot without a page reload.
  startNowPanelTicker(() => renderNowPanel(els, {
    rows: getPlan().rows,
    stepSize_m: getVizConfig().stepSize_m,
    initialSoc_percent: getPlan().initialSoc_percent,
  }));

  const debounceRun = deps.debounce(onRun, 250);
  const persistConfigDebounced = deps.debounce((cfg) => {
    void persistConfig(cfg);
  }, 600);

  // Render everything that derives from the plan: meta, summary, charts,
  // table, Now panel, EV panel.
  function renderPlan(plan) {
    const { rows } = plan;

    // Plan end is the last planned slot's start, not the boundary after it.
    deps.updatePlanMeta(els, plan.tsStart, rows[rows.length - 1]?.timestampMs ?? null);
    deps.updateSummaryUI(els, plan.summary);
    deps.updateRebalanceNudgeUI(els, plan.rebalanceNudge);

    const cfgForViz = getVizConfig();

    renderVisuals();
    renderNowPanel(els, {
      rows,
      stepSize_m: cfgForViz.stepSize_m,
      initialSoc_percent: plan.initialSoc_percent,
    });
    deps.updateEvPanel(els, rows, plan.summary, cfgForViz.stepSize_m, getEvSettings());
    onPlanRows(rows);
  }

  // Show the server's cached plan (if it still covers now) instead of solving
  // on page load. Returns the fetched payload so the caller can judge whether
  // a fresh solve is still warranted, or null — cheaply, without touching the
  // UI — when there is nothing usable to show.
  async function loadLastPlan() {
    const seq = beginPlanRequest();
    let result;
    try {
      result = await deps.fetchLastPlan();
    } catch {
      return null;
    }
    if (!isCurrentPlanRequest(seq)) return null;
    if (!Array.isArray(result?.rows) || result.rows.length === 0) return null;

    setPlan(result);
    if (els.status) {
      els.status.textContent = `Loaded existing plan${formatPlanTime(result.computedAtMs)}`;
      els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
    }
    updateLatestPushStatus(result);
    return result;
  }

  async function onRun() {
    if (typeof persistConfigDebounced.cancel === "function") {
      persistConfigDebounced.cancel();
    }

    const seq = beginPlanRequest();

    if (els.status) {
      els.status.textContent = "Calculating…";
      els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
    }
    // Until the first plan lands the charts are bare placeholders reading
    // "Run the optimizer…", which contradicts the status line while a solve is
    // actually in flight. renderChart hides them for good once it draws.
    setChartPlaceholders("Calculating…");

    const runBtn = els.run;
    if (runBtn) {
      runBtn.classList.add('loading');
      runBtn.disabled = true;
    }

    try {
      await persistConfig();

      const updateData = !!els.updateDataBeforeRun?.checked;
      const writeToVictron = !!els.pushToVictron?.checked;
      const result = await deps.requestRemoteSolve({ updateData, writeToVictron });
      if (!isCurrentPlanRequest(seq)) return;

      // The solve prunes EV schedule entries that have played out (an arrival the car has
      // made, a departed trip). The entries this page holds are the ones it fetched on load,
      // so without a re-read the charts keep drawing annotations for events the server has
      // already dropped. Refresh before painting, so the plan and its annotations agree.
      // A failed refresh must not turn a solved plan into an error: keep the entries we have.
      try {
        await refreshEvEntries();
      } catch (evError) {
        console.error("Failed to refresh EV schedule entries", evError);
      }
      if (!isCurrentPlanRequest(seq)) return;

      const solverStatus =
        typeof result?.solverStatus === "string" ? result.solverStatus : "OK";

      // The plan is solved by now — and, when writeToVictron is set, already written over MQTT.
      // A throw while drawing it is a display failure, not a planning failure, so it must not
      // fall through to the outer catch and wipe a summary that computed fine.
      try {
        updateRunStatus(solverStatus, writeToVictron, result?.computedAtMs, result?.lastVictronPushAtMs);
        setPlan(result);
      } catch (renderError) {
        console.error("Failed to render plan", renderError);
        if (els.status) {
          els.status.textContent = `Plan calculated, but display failed${formatPlanTime(result?.computedAtMs)}: ${renderError.message}`;
          els.status.className = "text-sm font-medium text-amber-600 dark:text-amber-400";
        }
      }
    } catch (err) {
      console.error(err);
      if (!isCurrentPlanRequest(seq)) return;
      if (els.status) {
        els.status.textContent = `Error: ${err.message}`;
        els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
      }
      setChartPlaceholders(CHART_PLACEHOLDER_IDLE);
      deps.updateSummaryUI(els, null);
    } finally {
      // A superseded run leaves the button alone: the run that replaced it is
      // still in flight and owns the spinner.
      if (runBtn && isCurrentPlanRequest(seq)) {
        runBtn.classList.remove('loading');
        runBtn.disabled = false;
      }
    }
  }

  function onTableDisplayChange() {
    queuePersistSnapshot();
    renderScheduleTable();
  }

  // What the current plan looks like through the view toggles: visible rows,
  // bar resolution, and the rebalance window remapped onto whatever gets drawn.
  function currentPlanView() {
    const plan = getPlan();
    return resolvePlanView({
      rows: plan.rows,
      stepSize_m: getVizConfig().stepSize_m,
      standardEndMs: plan.standardWindowEndMs,
      rebalanceWindow: plan.rebalanceWindow,
    });
  }

  function renderScheduleTable(planView = currentPlanView()) {
    if (!planView.rows.length) return false;
    deps.renderTable({
      rows: planView.rows,
      cfg: getVizConfig(),
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      showDess: !!els.tableDess?.checked,
      rebalanceWindow: planView.rebalanceWindow,
      evSettings: getEvSettings(),
    });
    return true;
  }

  // Re-render charts + table from the stored plan (no solve).
  function renderVisuals() {
    const planView = currentPlanView();
    updatePlanCostsUI(els, planView.rows, els.strategy?.value);
    if (!planView.rows.length) return false;
    const { rows, chartRows, chartStepSize_m, chartRebalanceWindow } = planView;
    const cfg = getVizConfig();
    const evSettings = getEvSettings();

    viewToggles.update(planView);

    deps.drawFlowsBarStackSigned(
      els.flows, chartRows, chartStepSize_m, chartRebalanceWindow, evSettings, els.showNetRevenue?.getAttribute("aria-pressed") === "true",
    );
    deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
    deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m, getPlan().pricesKnownUntilMs);
    deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
    renderScheduleTable(planView);
    return true;
  }

  async function persistConfig(cfg = deps.snapshotUI(els)) {
    try {
      const result = await deps.saveConfig(cfg);
      // Changing the horizon makes the server regenerate the load/PV forecasts.
      // The Predictions tab caches those series, so it has to re-read them or
      // it keeps charting the old window until a manual run or a reload.
      if (result?.forecastsRefreshed) await onForecastsRefreshed();
      if (els.status) {
        if (result?.victronModeConfirmed === 1) {
          els.status.textContent =
            "Push disabled · Victron DESS mode 1 (VRM) confirmed";
        } else if (result?.victronModeConfirmed === 4) {
          els.status.textContent =
            "Victron DESS mode 4 confirmed · Preparing plan push…";
        }
      }
      return true;
    } catch (error) {
      console.error("Failed to persist settings", error);
      if (els.status) els.status.textContent = `Settings error: ${error.message}`;
      return false;
    }
  }

  function queuePersistSnapshot() {
    persistConfigDebounced(deps.snapshotUI(els));
  }

  async function onGuardSettingsChange(event) {
    const pushEnabled =
      event?.currentTarget === els.pushToVictron &&
      els.pushToVictron.checked === true;

    if (els.liveBlockGuardStatus) {
      els.liveBlockGuardStatus.textContent = "Updating guard status…";
    }

    if (typeof persistConfigDebounced.cancel === "function") {
      persistConfigDebounced.cancel();
    }

    const saved = await persistConfig();
    if (!saved) return;

    await refreshLiveBlockGuardStatus(true);

    // Only enabling Push triggers an automatic recompute.
    // OFF keeps the existing mode-1 handover behavior.
    if (pushEnabled && els.pushToVictron.checked) {
      await onRun();
    }
  }

  function updateRunStatus(solverStatus, writeToVictron, computedAtMs, lastVictronPushAtMs) {
    if (!els.status) return;

    if (writeToVictron && Number.isFinite(lastVictronPushAtMs)) {
      updateLatestPushStatus({ lastVictronPushAtMs });
      return;
    }

    const nonOptimal =
      typeof solverStatus === "string" &&
      solverStatus.toLowerCase() !== "optimal";

    let label;
    let colorClass = "text-emerald-600 dark:text-emerald-400";

    if (nonOptimal) {
      label = `Plan status: ${solverStatus}${formatPlanTime(computedAtMs)}`;
      colorClass = "text-amber-600 dark:text-amber-400";
    } else {
      // A successful local recompute is not a new Victron push. Preserve the
      // last confirmed push time when one is already known.
      if (lastReportedPushAtMs !== null) return;
      label = `Plan updated${formatPlanTime(computedAtMs)}`;
    }
    els.status.textContent = label;
    els.status.className = `text-sm font-medium ${colorClass}`;
  }

  function updateLatestPushStatus(plan) {
    const pushedAtMs = Number(plan?.lastVictronPushAtMs);
    if (!els.status || !Number.isFinite(pushedAtMs) || pushedAtMs <= 0) return;
    if (lastReportedPushAtMs !== null && pushedAtMs <= lastReportedPushAtMs) return;

    lastReportedPushAtMs = pushedAtMs;
    els.status.textContent = `Plan updated and sent to Victron${formatPlanTime(pushedAtMs)}`;
    els.status.className = "text-sm font-medium text-emerald-600 dark:text-emerald-400";
  }

  function formatPlanTime(timestampMs) {
    if (!Number.isFinite(timestampMs)) return "";
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(timestampMs));
    return ` (${time})`;
  }

  function getVizConfig() {
    return {
      stepSize_m: Number(els.step?.value),
      batteryCapacity_Wh: Number(els.cap?.value),
    };
  }

  function getEvSettings() {
    if (!els.evEnabled?.checked) return null;
    return collectEvSettings(getEvEntries());
  }

  return {
    debounceRun,
    loadLastPlan,
    onRun,
    onTableDisplayChange,
    hydrateChartPreferences,
    onGuardSettingsChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    renderVisuals,
  };
}
