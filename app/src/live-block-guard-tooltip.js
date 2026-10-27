const SVG_NS = 'http://www.w3.org/2000/svg';
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const kw = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const finite = value => typeof value === 'number' && Number.isFinite(value);

function svgElement(tag, attributes, label) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (label !== undefined) element.textContent = label;
  return element;
}

/** Render only server-reported recognition; never reconstruct a more optimistic block in the UI. */
export function renderGuardBlockPreview(host, status) {
  host.replaceChildren();
  const heading = document.createElement('strong');
  heading.className = 'guard-block-heading';
  const preview = status?.blockPreview;
  const slots = Array.isArray(preview?.slots) ? preview.slots.slice(0, 4).filter(slot =>
    finite(slot.startMs) && finite(slot.endMs) && slot.endMs > slot.startMs
    && finite(slot.chargePower_W) && slot.chargePower_W >= 0
    && finite(slot.dischargePower_W) && slot.dischargePower_W >= 0) : [];
  heading.textContent = preview?.recognized
    ? `${preview.isFuture ? 'Future' : 'Recognized'} ${preview.direction === 'charge' ? 'charging' : 'discharging'} block`
    : 'No block recognized';
  host.append(heading);
  if (!slots.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No current slot data available.';
    host.append(empty);
    return;
  }
  const note = document.createElement('p');
  note.className = 'guard-block-note';
  note.textContent = preview.basis === 'soc-taper-region'
    ? `Lower-power block recognized at ${preview.direction === 'charge' ? 'high' : 'low'} SoC (${preview.taperThreshold_percent}%). This is a taper assumption, not a BMS measurement.`
    : preview.recognized ? 'Consecutive slots in the same direction, including lower-power slots.'
      : 'These slots do not form a qualifying block from the active slot.';
  if (preview.isFuture) {
    const first = slots.find(slot => slot.index === preview.startIndex);
    const last = slots.find(slot => slot.index === preview.endIndex);
    const timing = first && last ? `${time.format(first.startMs)}–${time.format(last.endMs)}. ` : '';
    note.textContent = timing + 'Preview only: targets are not adjusted before this block starts. '
      + (preview.basis === 'soc-taper-region'
        ? `Lower-power recognition uses the planned SoC at the start of this block (${Math.round(preview.recognitionSoc_percent)}%), not a live BMS measurement.`
        : 'Consecutive planned slots in the same direction.');
  }
  host.append(note);
  const maxPower = Math.max(1, ...slots.flatMap(slot => [slot.chargePower_W, slot.dischargePower_W]));
  const svg = svgElement('svg', { viewBox: '0 0 380 214', role: 'img', 'aria-label': 'Planned battery power per schedule slot. Charging above zero, discharging below zero.' });
  const baseline = 92, scale = 60 / maxPower, start = 52, stride = 78, width = 42;
  svg.append(svgElement('line', { x1: 43, y1: baseline, x2: 372, y2: baseline, class: 'guard-block-axis' }));
  svg.append(svgElement('text', { x: 2, y: 29, class: 'guard-block-scale' }, `+${kw.format(maxPower / 1000)}`));
  svg.append(svgElement('text', { x: 2, y: 96, class: 'guard-block-scale' }, '0 kW'));
  svg.append(svgElement('text', { x: 2, y: 160, class: 'guard-block-scale' }, `−${kw.format(maxPower / 1000)}`));
  slots.forEach((slot, index) => {
    const x = start + index * stride;
    if (slot.active) svg.append(svgElement('rect', { x: x - 8, y: 15, width: 58, height: 151, rx: 7, class: 'guard-block-active' }));
    for (const [direction, power] of [['charge', slot.chargePower_W], ['discharge', slot.dischargePower_W]]) {
      if (power <= 0) continue;
      const height = power * scale;
      const rect = svgElement('rect', {
        x, y: direction === 'charge' ? baseline - height : baseline,
        width, height, rx: 2,
        class: slot.inBlock ? `guard-block-${direction}` : 'guard-block-outside',
      });
      rect.append(svgElement('title', {}, `${time.format(slot.startMs)}–${time.format(slot.endMs)}: ${direction} ${kw.format(power / 1000)} kW`));
      svg.append(rect);
    }
    const charge = slot.chargePower_W, discharge = slot.dischargePower_W;
    const value = charge > 0 && discharge > 0
      ? `+${kw.format(charge / 1000)}/−${kw.format(discharge / 1000)}`
      : charge > 0 ? `+${kw.format(charge / 1000)}` : discharge > 0 ? `−${kw.format(discharge / 1000)}` : '0';
    svg.append(svgElement('text', { x: x + width / 2, y: 180, 'text-anchor': 'middle', class: 'guard-block-label' }, time.format(slot.startMs)));
    svg.append(svgElement('text', { x: x + width / 2, y: 194, 'text-anchor': 'middle', class: 'guard-block-label' }, `${value} kW`));
    svg.append(svgElement('text', { x: x + width / 2, y: 208, 'text-anchor': 'middle', class: 'guard-block-scale' }, slot.active ? 'Current slot' : `Slot ${slot.index + 1}`));
  });
  host.append(svg);
  const legend = document.createElement('p');
  legend.className = 'guard-block-note';
  legend.textContent = 'Blue: charging · Orange: discharging · Grey: outside block. Bar heights show planned power, not live measurements.';
  host.append(legend);
  if (preview.recognized && !preview.isFuture) {
    const written = finite(status?.writtenTarget_percent);
    const target = written ? status.writtenTarget_percent : status?.proposedTarget_percent;
    if (finite(target)) {
      const targetLine = document.createElement('p');
      targetLine.className = 'guard-block-detail';
      const label = written ? 'Applied SoC target' : status.adjustmentDue === false
        ? 'Estimated next SoC target' : 'Proposed SoC target';
      const value = document.createElement('strong');
      value.textContent = `${label}: ${Math.round(target)}%`;
      targetLine.append(value);
      const current = finite(status.activeTarget_percent) ? status.activeTarget_percent : status.plannedTarget_percent;
      if (!written && finite(current)) {
        const action = target < current ? 'Lower' : target > current ? 'Raise' : 'Keep';
        targetLine.append(document.createTextNode(` — ${action} from ${Math.round(current)}% to ${Math.round(target)}%.`));
      }
      if (!written && status.adjustmentDue === false) {
        targetLine.append(document.createTextNode(' Estimate only; recalculated before any adjustment.'));
      }
      host.append(targetLine);
    }
  }
  const detail = document.createElement('p');
  detail.className = 'guard-block-detail';
  detail.textContent = status?.reason || '';
  host.append(detail);
}

export function mountGuardBlockTooltip(anchor) {
  if (!anchor) return { update: () => {} };
  const tooltip = document.createElement('div');
  tooltip.id = 'live-block-guard-tooltip';
  tooltip.className = 'guard-block-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);
  anchor.tabIndex = 0;
  anchor.classList.add('guard-block-trigger');
  anchor.setAttribute('aria-describedby', tooltip.id);
  let closeTimer;
  function position() {
    const rect = anchor.getBoundingClientRect();
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const above = rect.top - height - 8;
    tooltip.style.top = `${Math.max(12, above >= 12 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`;
  }
  function hide() { clearTimeout(closeTimer); tooltip.hidden = true; }
  function show() { clearTimeout(closeTimer); tooltip.hidden = false; position(); }
  function delayedHide() { clearTimeout(closeTimer); closeTimer = setTimeout(hide, 150); }
  anchor.addEventListener('mouseenter', show);
  anchor.addEventListener('mouseleave', delayedHide);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('blur', hide);
  anchor.addEventListener('click', show);
  anchor.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); }
  });
  tooltip.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  tooltip.addEventListener('mouseleave', delayedHide);
  tooltip.addEventListener('click', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('pointerdown', event => {
    if (!anchor.contains(event.target) && !tooltip.contains(event.target)) hide();
  });
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide);
  renderGuardBlockPreview(tooltip, null);
  return { update(status) { renderGuardBlockPreview(tooltip, status); if (!tooltip.hidden) position(); } };
}
