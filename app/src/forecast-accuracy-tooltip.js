function renderForecastAccuracy(host, result) {
  host.replaceChildren();
  const heading = document.createElement('strong');
  heading.className = 'guard-block-heading';
  heading.textContent = 'DA reliability — day-ahead price forecast';
  host.append(heading);
  const add = text => { const p = document.createElement('p'); p.textContent = text; p.style.marginTop = '8px'; host.append(p); };
  const valid = Number.isFinite(result?.scorePercent);
  add(valid
    ? `The current score is ${Math.round(result.scorePercent)}%, calculated over ${result.days} complete delivery days (${result.slots} quarter-hours).`
    : 'No score can be calculated yet. Only complete days with both forecast and actual prices are included.');
  add('For each quarter-hour, the absolute difference between the forecast and actual import price is measured. WAPE = 100% × the sum of these absolute differences / the sum of the absolute actual prices. Score = the greater of 0% and (100% − WAPE).');
  add(valid && result.scorePercent > 0
    ? `At ${Math.round(result.scorePercent)}%, the total absolute deviation is about ${Math.round(100 - result.scorePercent)}% of the sum of the absolute actual prices. Higher is better; 100% means no deviation in the measured quarter-hours.`
    : 'Higher is better; 100% means no deviation. An error of 100% or more is shown as a 0% score. The score cannot be calculated when the sum of the absolute actual prices is zero.');
  add('This is neither a probability nor the percentage of quarter-hours forecast correctly. It also does not mean that the forecast for the entire coming week has this accuracy.');
  add(`Up to the last ${result?.windowDays || 30} recorded complete delivery days are included; they are not necessarily consecutive calendar days. The forecast saved before all day-ahead prices were received is compared with the actual prices. Small absolute prices can increase the relative error.`);
  add('Click this tooltip to close it.');
}

export function mountForecastAccuracyTooltip(anchor) {
  if (!anchor) return { update: () => {} };
  const tooltip = document.createElement('div');
  tooltip.id = 'forecast-accuracy-tooltip';
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
  renderForecastAccuracy(tooltip, null);
  return { update(status) { renderForecastAccuracy(tooltip, status); if (!tooltip.hidden) position(); } };
}
