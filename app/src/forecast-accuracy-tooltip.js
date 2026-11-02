function renderForecastAccuracy(host, result) {
  host.replaceChildren();
  const heading = document.createElement('strong');
  heading.className = 'guard-block-heading';
  heading.textContent = 'Price forecast reliability — DA and 2DA';
  host.append(heading);

  const add = (text, className = '') => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    paragraph.style.marginTop = '8px';
    if (className) paragraph.className = className;
    host.append(paragraph);
  };
  const scoreLine = (label, score) => Number.isFinite(score?.scorePercent)
    ? `${label}: ${Math.round(score.scorePercent)}% across ${score.days} complete delivery days (${score.slots} quarter-hours).`
    : `${label}: no score yet. OptiVolt needs a complete forecast and actual price series for a delivery day.`;

  add(scoreLine('DA reliability', result));
  add(scoreLine('2DA reliability', result?.twoDayAhead));
  add('For both scores, OptiVolt compares each forecast quarter-hour with the actual EPEX import price for the same interval. WAPE = 100% × sum of absolute errors / sum of absolute actual prices. Reliability = max(0%, 100% − WAPE). Higher is better; 100% means no measured deviation.');
  add('DA uses the forecast preserved before all day-ahead prices for the delivery day were received. For 2DA, OptiVolt freezes the latest complete forecast available on the Amsterdam calendar date two days before delivery. Each is compared with actual prices once the full delivery-day price series is available.');
  add(`Each score uses up to its latest ${result?.windowDays || 30} complete delivery days; they are not necessarily consecutive. A score is neither a probability nor the percentage of quarter-hours predicted correctly. Small absolute prices can increase relative error.`);
}

export function mountForecastAccuracyTooltip(anchors) {
  const triggerElements = (Array.isArray(anchors) ? anchors : [anchors]).filter(Boolean);
  if (!triggerElements.length) return { update: () => {} };

  const tooltip = document.createElement('div');
  tooltip.id = 'forecast-accuracy-tooltip';
  tooltip.className = 'guard-block-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);

  let closeTimer;
  let activeAnchor = triggerElements[0];
  function position() {
    const rect = activeAnchor.getBoundingClientRect();
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const above = rect.top - height - 8;
    tooltip.style.top = `${Math.max(12, above >= 12 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`;
  }
  function hide() { clearTimeout(closeTimer); tooltip.hidden = true; }
  function show(anchor) { clearTimeout(closeTimer); activeAnchor = anchor; tooltip.hidden = false; position(); }
  function delayedHide() { clearTimeout(closeTimer); closeTimer = setTimeout(hide, 150); }

  for (const anchor of triggerElements) {
    anchor.tabIndex = 0;
    anchor.classList.add('guard-block-trigger');
    anchor.setAttribute('aria-describedby', tooltip.id);
    anchor.addEventListener('mouseenter', () => show(anchor));
    anchor.addEventListener('mouseleave', delayedHide);
    anchor.addEventListener('focus', () => show(anchor));
    anchor.addEventListener('blur', hide);
    anchor.addEventListener('click', () => show(anchor));
    anchor.addEventListener('keydown', event => {
      if (event.key === 'Escape') hide();
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(anchor); }
    });
  }

  tooltip.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  tooltip.addEventListener('mouseleave', delayedHide);
  tooltip.addEventListener('click', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('pointerdown', event => {
    if (!triggerElements.some(anchor => anchor.contains(event.target)) && !tooltip.contains(event.target)) hide();
  });
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide);
  renderForecastAccuracy(tooltip, null);
  return { update(result) { renderForecastAccuracy(tooltip, result); if (!tooltip.hidden) position(); } };
}
