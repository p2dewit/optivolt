import {
  createTooltipHandler, fmtKwh, getChartAnimations,
  ttHeader, ttRow, ttSection, ttDivider, ttPrices,
} from '../chart-tooltip.js';
import { SOLUTION_COLORS, dim, toRGBA } from './colors.js';
import { buildTimeAxisFromTimestamps, dsBar, getBaseOptions, getChartTheme, renderChart } from './core.js';
import { makeEvArrivalPlugin, makeEvAwayBandPlugin, makeEvDeparturePlugin, makeEvTargetPlugin } from './ev-annotations.js';
import {
  BUY_PRICE_STRIP_TICK_PADDING,
  makeBuyPriceStripPlugin,
  makeNegativePriceInjectionPlugin,
  makeRebalancingPlugin,
} from './overlays.js';

const FLOWS_TOOLTIP_LABELS = {
  pv2l:  "Solar → Load",
  pv2ev: "Solar → EV",
  pv2b:  "Solar → Battery",
  pv2g:  "Solar → Grid",
  b2g:   "Battery → Grid",
  b2l:   "Battery → Load",
  b2ev:  "Battery → EV",
  g2l:   "Grid → Load",
  g2ev:  "Grid → EV",
  g2b:   "Grid → Battery",
};

function makeFlowsTooltip(rows, flowSpecs, h, showNetRevenue = false, cumulativeNetEuro = []) {
  const W2kWh = (x) => (x || 0) * h / 1000;

  return createTooltipHandler({
    renderContent: (idx, tooltip) => {
      const row = rows[idx];
      const time = tooltip.title?.[0] ?? "";

      const posRows = flowSpecs.filter(s => s.sign === 1  && (row[s.key] || 0) !== 0);
      const negRows = flowSpecs.filter(s => s.sign === -1 && (row[s.key] || 0) !== 0);

      const meta = Number.isFinite(row.soc_percent)
        ? `SoC <strong>${Math.round(row.soc_percent)}%</strong>`
        : row.source === 'planned' ? 'Planned' : row.source === 'mixed' ? 'Actual + Planned' : 'Realized';
      let html = ttHeader(time, meta);

      if (posRows.length) {
        html += ttSection("↑ Sources");
        for (const s of posRows) {
          html += ttRow(s.color, FLOWS_TOOLTIP_LABELS[s.key] ?? s.label, `${fmtKwh(W2kWh(row[s.key]))} kWh`);
        }
      }

      if (posRows.length && negRows.length) html += ttDivider();

      if (negRows.length) {
        html += ttSection("↓ Draws");
        for (const s of negRows) {
          html += ttRow(s.color, FLOWS_TOOLTIP_LABELS[s.key] ?? s.label, `${fmtKwh(W2kWh(row[s.key]))} kWh`);
        }
      }

      if (showNetRevenue) {
        const netRevenueEuro = cumulativeNetEuro[idx] ?? 0;
        html += ttDivider();
        html += ttRow(SOLUTION_COLORS.b2g, "Revenue", new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(netRevenueEuro));
      }
      html += ttDivider();
      const buyPrice = Number.isFinite(row.ic) ? `${row.ic.toFixed(1)}¢` : '—';
      const sellPrice = Number.isFinite(row.ec) ? `${row.ec.toFixed(1)}¢` : '—';
      html += ttPrices(buyPrice, sellPrice);
      return html;
    },
  });
}

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15, rebalanceWindow = null, evSettings = null, showNetRevenue = false, nowMarker = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);
  const mobileChart = (canvas.clientWidth || canvas.width) <= 640;
  const axisTickFontSize = mobileChart ? 8 : 12;
  const axisTitleFontSize = mobileChart ? 9 : 12;
  const legendFontSize = mobileChart ? 9 : 12;

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const stackId = "flows";

  const flowSpecs = [
    { key: "pv2l",  color: SOLUTION_COLORS.pv2l,  label: "Solar → Load",     sign: 1 },
    { key: "pv2ev", color: SOLUTION_COLORS.pv2ev, label: "Solar → EV",       sign: 1 },
    { key: "pv2b",  color: SOLUTION_COLORS.pv2b,  label: "Solar → Battery",  sign: 1 },
    { key: "pv2g",  color: SOLUTION_COLORS.pv2g,  label: "Solar → Grid",     sign: 1 },
    { key: "b2g",   color: SOLUTION_COLORS.b2g,   label: "Battery → Grid",   sign: 1 },
    { key: "b2l",   color: SOLUTION_COLORS.b2l,   label: "Battery → Load",   sign: -1 },
    { key: "b2ev",  color: SOLUTION_COLORS.b2ev,  label: "Battery → EV",     sign: -1 },
    { key: "g2l",   color: SOLUTION_COLORS.g2l,   label: "Grid → Load",      sign: -1 },
    { key: "g2ev",  color: SOLUTION_COLORS.g2ev,  label: "Grid → EV",        sign: -1 },
    { key: "g2b",   color: SOLUTION_COLORS.g2b,   label: "Grid → Battery",   sign: -1 },
  ];

  const nonZeroKeys = new Set();
  for (const r of rows) for (const { key } of flowSpecs) if ((r[key] || 0) !== 0) nonZeroKeys.add(key);
  const datasets = flowSpecs
    .filter(spec => nonZeroKeys.has(spec.key))
    .map(spec =>
      dsBar(
        spec.label,
        rows.map(r => spec.sign * Math.abs(W2kWh(r[spec.key]))),
        spec.color,
        stackId
      )
    );

  const cumulativeNetEuro = [];
  let cumulativeNetCents = 0;
  for (const row of rows) {
    if (Number.isFinite(row.cumulativeNetCents)) cumulativeNetCents = row.cumulativeNetCents;
    else cumulativeNetCents += (row.exportCost_cents || 0) - (row.importCost_cents || 0) - (row.batteryWearCost_cents || 0);
    cumulativeNetEuro.push(cumulativeNetCents / 100);
  }

  if (showNetRevenue) {
    const revenueScale = 3; // €3 positive = green, €3 negative = red
    const revenueStops = [
      { at: -1, rgb: [220, 38, 38] },
      { at: -0.5, rgb: [249, 115, 22] },
      { at: 0, rgb: [250, 204, 21] },
      { at: 0.5, rgb: [132, 204, 22] },
      { at: 1, rgb: [34, 197, 94] },
    ];
    const revenueColor = value => {
      const position = Math.max(-1, Math.min(1, value / revenueScale));
      let right = revenueStops.findIndex(stop => stop.at >= position);
      if (right <= 0) right = 1;
      const leftStop = revenueStops[right - 1];
      const rightStop = revenueStops[right];
      const mix = (position - leftStop.at) / (rightStop.at - leftStop.at);
      const rgb = leftStop.rgb.map((channel, index) => Math.round(channel + (rightStop.rgb[index] - channel) * mix));
      return `rgb(${rgb.join(", ")})`;
    };

    datasets.push({
      type: "line",
      label: "Revenue",
      data: cumulativeNetEuro,
      yAxisID: "yRevenue",
      borderColor: "rgb(250, 204, 21)",
      segment: {
        borderColor: context => revenueColor((context.p0.parsed.y + context.p1.parsed.y) / 2),
      },
      backgroundColor: SOLUTION_COLORS.b2g,
      borderWidth: context => context.chart.width <= 640 ? 0.8 : 1.5,
      tension: 0.2,
      pointRadius: 0,
      pointHitRadius: 8,
      fill: false,
      clip: false,
    });
  }

  const plugins = rebalanceWindow
    ? [makeRebalancingPlugin(rebalanceWindow.startIdx, rebalanceWindow.endIdx)]
    : [];
  const buyPriceStripPlugin = makeBuyPriceStripPlugin(rows);
  if (buyPriceStripPlugin) plugins.push(buyPriceStripPlugin);
  const negativeInjectionPlugin = makeNegativePriceInjectionPlugin(rows, h);
  if (negativeInjectionPlugin) plugins.push(negativeInjectionPlugin);
  const awayBandPlugin = evSettings?.trips?.length ? makeEvAwayBandPlugin(rows, evSettings.trips) : null;
  if (awayBandPlugin) plugins.push(awayBandPlugin);
  const arrPlugin = evSettings?.arrivals?.length ? makeEvArrivalPlugin(rows, evSettings.arrivals) : null;
  if (arrPlugin) plugins.push(arrPlugin);
  const depPlugin = evSettings?.departures?.length
    ? makeEvDeparturePlugin(rows, evSettings.departures)
    : null;
  if (depPlugin) plugins.push(depPlugin);
  if (nowMarker && Number.isFinite(nowMarker.timestampMs)) {
    plugins.push({
      id: 'dayActualsNowMarker',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.x) return;
        const index = (nowMarker.timestampMs - nowMarker.startMs) / nowMarker.stepMs;
        if (index < 0 || index > rows.length) return;
        const x = scales.x.getPixelForValue(Math.min(index, rows.length - 0.5));
        ctx.save();
        const markerColor = getChartTheme().axisTickColor;
        ctx.strokeStyle = markerColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = markerColor;
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = x > chartArea.right - 48 ? 'right' : 'left';
        ctx.fillText('Now', x + (x > chartArea.right - 48 ? -4 : 4), chartArea.top + 7);
        ctx.restore();
      },
    });
  }

  renderChart(canvas, {
    type: "bar",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "kWh", stacked: true }, {
      ...getChartAnimations('bar', rows.length),
      plugins: {
        legend: { labels: { font: { size: legendFontSize } } },
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: makeFlowsTooltip(rows, flowSpecs, h, showNetRevenue, cumulativeNetEuro),
          callbacks: { title: axis.tooltipTitleCb },
        }
      },
      layout: { padding: { bottom: 0 } },
      scales: {
        x: {
          ticks: { padding: BUY_PRICE_STRIP_TICK_PADDING, font: { size: axisTickFontSize } },
        },
        y: {
          ticks: { font: { size: axisTickFontSize } },
          title: { display: true, text: "kWh", font: { size: axisTitleFontSize } },
        },
        ...(showNetRevenue ? {
          yRevenue: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            stacked: false,
            title: { display: true, text: "Revenue (€)", font: { size: axisTitleFontSize } },
            grid: { drawOnChartArea: false },
            ticks: {
              font: { size: axisTickFontSize },
              callback: value => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
            },
          },
        } : {}),
      },
    }),
    plugins,
  });
  // Mobile browsers do not always synthesize Chart.js' mousemove event for a
  // tap on category charts. Resolve the nearest time slot directly on touch.
  if (!canvas._flowTouchTooltipInstalled) {
    const showNearestSlot = event => {
      if (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const chart = canvas._chart;
      if (!chart?.chartArea || !chart.data.datasets.length) return;
      const x = event.offsetX;
      const y = event.offsetY;
      if (x < chart.chartArea.left || x > chart.chartArea.right || y < chart.chartArea.top || y > chart.chartArea.bottom) return;
      const scale = chart.scales.x;
      let index = 0;
      let minDistance = Infinity;
      for (let i = 0; i < chart.data.labels.length; i += 1) {
        const distance = Math.abs(scale.getPixelForValue(i) - x);
        if (distance < minDistance) { minDistance = distance; index = i; }
      }
      const active = chart.data.datasets.map((_dataset, datasetIndex) => ({ datasetIndex, index }));
      chart.setActiveElements(active);
      chart.tooltip.setActiveElements(active, { x, y });
      chart.update('none');
    };
    canvas.addEventListener('pointerdown', showNearestSlot, { passive: true });
    canvas.addEventListener('pointerup', showNearestSlot, { passive: true });
    canvas._flowTouchTooltipInstalled = true;
  }
}

export function drawSocChart(canvas, rows, _stepSize_m = 15, evSettings = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const hasEvSoc = rows.some(r => (r.ev_soc_percent ?? 0) > 0);

  const makeSocGradient = (color) => (context) => {
    const { chart } = context;
    const { ctx, chartArea } = chart;
    if (!chartArea) return toRGBA(color, 0.15);
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, toRGBA(color, 0.25));
    gradient.addColorStop(1, toRGBA(color, 0));
    return gradient;
  };

  const datasets = [{
    label: "Battery SoC (%)",
    data: rows.map(r => r.soc_percent),
    borderColor: SOLUTION_COLORS.soc,
    backgroundColor: makeSocGradient(SOLUTION_COLORS.soc),
    fill: 'origin',
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
    hoverBorderColor: dim(SOLUTION_COLORS.soc),
    clip: false
  }];

  if (hasEvSoc) {
    datasets.push({
      label: "EV SoC (%)",
      data: rows.map(r => r.ev_soc_percent ?? 0),
      borderColor: SOLUTION_COLORS.ev_charge,
      backgroundColor: makeSocGradient(SOLUTION_COLORS.ev_charge),
      fill: 'origin',
      borderWidth: 2,
      tension: 0.2,
      pointRadius: 0,
      hoverBorderColor: dim(SOLUTION_COLORS.ev_charge),
      clip: false
    });
  }

  const evPlugins = [
    makeEvAwayBandPlugin(rows, evSettings?.trips),
    makeEvArrivalPlugin(rows, evSettings?.arrivals),
    makeEvDeparturePlugin(rows, evSettings?.departures),
    makeEvTargetPlugin(rows),
  ].filter(Boolean);

  renderChart(canvas, {
    type: "line",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "%" }, {
      ...getChartAnimations('line', rows.length),
      plugins: {
        ...(hasEvSoc ? {} : { legend: { display: false } }),
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${Math.round(pt.raw)}%`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
      layout: hasEvSoc ? undefined : { padding: { bottom: 0 } },
      scales: { y: { max: 100 } }
    }),
    plugins: evPlugins,
  });
}

function makePriceZeroLinePlugin() {
  return {
    id: 'priceZeroLine',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const yScale = scales.y;
      if (!chartArea || !yScale || yScale.min > 0 || yScale.max < 0) return;

      const y = yScale.getPixelForValue(0);
      if (y < chartArea.top || y > chartArea.bottom) return;

      ctx.save();
      ctx.strokeStyle = getChartTheme().majorGridColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.restore();
    }
  };
}

/**
 * Shade the part of the chart where prices are forecast (beyond the last
 * published actual) and label it, so predicted prices are never mistaken for
 * real ones.
 */
function makeForecastZonePlugin(boundaryIdx) {
  return {
    id: 'priceForecastZone',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xFrom = Math.max(chartArea.left, scales.x.getPixelForValue(boundaryIdx));
      if (xFrom >= chartArea.right) return;

      ctx.save();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.fillRect(xFrom, chartArea.top, chartArea.right - xFrom, chartArea.bottom - chartArea.top);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(xFrom, chartArea.top);
      ctx.lineTo(xFrom, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = getChartTheme().axisTickColor;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('forecast', xFrom + 6, chartArea.top + 4);
      ctx.restore();
    }
  };
}

export function drawPricesStepLines(canvas, rows, _stepSize_m = 15, pricesKnownUntilMs = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);
  const strokeW = (axis.labels.length > 48) ? 1 : 2;

  // First slot whose prices come from the forecast feed rather than
  // published actuals (-1 when the whole window is actual).
  const boundaryIdx = pricesKnownUntilMs != null
    ? timestampsMs.findIndex(ms => ms >= pricesKnownUntilMs)
    : -1;

  const commonLine = {
    stepped: true,
    borderWidth: strokeW,
    pointRadius: 0,
    pointHitRadius: 8,
    ...(boundaryIdx >= 0 ? {
      segment: {
        borderDash: (ctx) => (ctx.p0DataIndex >= boundaryIdx ? [4, 3] : undefined),
      },
    } : {}),
  };

  renderChart(canvas, {
    type: "line",
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: "Buy price",
          data: rows.map(r => r.ic),
          borderColor: "#ef4444",
          backgroundColor: "#ef4444",
          ...commonLine
        },
        {
          label: "Sell price",
          data: rows.map(r => r.ec),
          borderColor: "#22c55e",
          backgroundColor: "#22c55e",
          ...commonLine
        }
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: "c€/kWh" }, {
      ...getChartAnimations('line', rows.length),
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              const isForecast = boundaryIdx >= 0 && idx >= boundaryIdx;
              let html = ttHeader(time, isForecast ? 'forecast' : '');
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${pt.raw.toFixed(1)} c€/kWh`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [
      makePriceZeroLinePlugin(),
      ...(boundaryIdx >= 0 ? [makeForecastZonePlugin(boundaryIdx)] : []),
    ]
  });
}

export function aggregateLoadPvBuckets(rows, stepSize_m = 15) {
  const stepHours = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * stepHours / 1000;

  const hourMap = new Map();

  for (const row of rows) {
    // Absolute-hour bucketing (epoch floor): local wall-clock would collapse
    // the repeated hour at the autumn DST transition into one bucket.
    const hourMs = Math.floor(row.timestampMs / 3_600_000) * 3_600_000;

    if (!hourMap.has(hourMs)) {
      hourMap.set(hourMs, {
        dtHour: new Date(hourMs),
        loadKWh: 0,
        pvKWh: 0,
        originalLoadKWh: 0,
        originalPvKWh: 0,
        hasOriginalLoad: false,
        hasOriginalPv: false,
      });
    }
    const bucket = hourMap.get(hourMs);
    bucket.loadKWh += W2kWh(row.load);
    bucket.pvKWh += W2kWh(row.pv);
    bucket.originalLoadKWh += W2kWh(row.originalLoad ?? row.load);
    bucket.originalPvKWh += W2kWh(row.originalPv ?? row.pv);
    bucket.hasOriginalLoad ||= row.originalLoad != null;
    bucket.hasOriginalPv ||= row.originalPv != null;
  }

  return [...hourMap.values()].sort((a, b) => a.dtHour - b.dtHour);
}

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  const buckets = aggregateLoadPvBuckets(rows, stepSize_m);
  const axis = buildTimeAxisFromTimestamps(buckets.map(b => b.dtHour.getTime()));

  const stripe = (c) => window.pattern?.draw("diagonal", c) || c;
  const ds = (label, data, color, series) => ({
    label, data,
    series,
    backgroundColor: stripe(color),
    borderColor: color,
    borderWidth: 1,
    hoverBackgroundColor: stripe(dim(color))
  });

  renderChart(canvas, {
    type: "bar",
    data: {
      labels: axis.labels,
      datasets: [
        ds("Consumption forecast", buckets.map(b => b.loadKWh), SOLUTION_COLORS.g2l, "load"),
        ds("Solar forecast", buckets.map(b => b.pvKWh), SOLUTION_COLORS.pv2g, "pv")
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: "kWh" }, {
      ...getChartAnimations('bar', buckets.length),
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                if (pt.raw == null) continue;
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${fmtKwh(pt.raw)} kWh`);
                const bucket = buckets[pt.dataIndex];
                const original = pt.dataset.series === "pv" ? bucket?.originalPvKWh : bucket?.originalLoadKWh;
                const hasOriginal = pt.dataset.series === "pv" ? bucket?.hasOriginalPv : bucket?.hasOriginalLoad;
                if (hasOriginal && original != null && Math.abs(original - pt.raw) > 0.001) {
                  html += ttRow(
                    toRGBA(pt.dataset.borderColor, 0.45),
                    `Original ${pt.dataset.label.toLowerCase()}`,
                    `${fmtKwh(original)} kWh`,
                  );
                }
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    })
  });
}
