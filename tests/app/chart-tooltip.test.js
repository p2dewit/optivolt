// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTooltipHandler } from '../../app/src/chart-tooltip.js';

describe('shared chart tooltip touch behavior', () => {
  it('ignores the closing tap and reopens on the next intentional chart tap', () => {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'offsetWidth', { value: 320 });
    parent.append(canvas);
    document.body.append(parent);

    const handler = createTooltipHandler({ renderContent: index => `Point ${index}` });
    const chart = { canvas };
    const activeTooltip = {
      opacity: 1,
      dataPoints: [{ dataIndex: 0 }],
      caretX: 24,
      caretY: 32,
    };

    handler({ chart, tooltip: activeTooltip });
    const tooltip = parent.querySelector('.ov-tt');
    expect(tooltip.classList.contains('is-visible')).toBe(true);

    const touchDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    tooltip.dispatchEvent(touchDown);
    expect(touchDown.defaultPrevented).toBe(true);
    expect(tooltip.classList.contains('is-visible')).toBe(false);
    expect(tooltip.style.opacity).toBe('0');

    // Compatibility click and trailing chart updates from the same touch
    // must not reopen the tooltip.
    tooltip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    handler({ chart, tooltip: activeTooltip });
    expect(tooltip.classList.contains('is-visible')).toBe(false);

    // A new gesture on the chart clears the dismissal guard.
    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    handler({ chart, tooltip: activeTooltip });
    expect(tooltip.classList.contains('is-visible')).toBe(true);
    expect(tooltip.style.opacity).toBe('1');
  });

  it('removes the visible state when Chart.js reports a closed tooltip', () => {
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    const handler = createTooltipHandler({ renderContent: () => 'Point' });
    const chart = { canvas };

    handler({ chart, tooltip: { opacity: 1, dataPoints: [{ dataIndex: 1 }], caretX: 8, caretY: 8 } });
    handler({ chart, tooltip: { opacity: 0, dataPoints: [], caretX: 8, caretY: 8 } });

    expect(parent.querySelector('.ov-tt').classList.contains('is-visible')).toBe(false);
  });
});
