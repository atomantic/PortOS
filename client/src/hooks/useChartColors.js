import { useState, useEffect } from 'react';

// recharts renders colors as SVG presentation attributes (fill/stroke), which
// cannot read CSS custom properties — `stroke="var(--port-accent)"` is ignored
// by the SVG renderer. This hook resolves the `--port-*` theme tokens to
// concrete color strings via getComputedStyle so chart cards follow the active
// theme instead of hardcoding hex values, and re-resolves when the theme
// switches (useTheme sets `data-port-theme` on <html>).

// Theme tokens are stored as space-separated RGB triples ("59 130 246").
const CHART_VARS = {
  accent: '--port-accent',
  success: '--port-success',
  warning: '--port-warning',
  error: '--port-error',
  chart1: '--port-chart-1',
  chart2: '--port-chart-2',
  chart3: '--port-chart-3',
  chart4: '--port-chart-4',
  grid: '--port-chart-grid',
  axis: '--port-text-muted',
  tooltipBg: '--port-card',
  tooltipBorder: '--port-border',
  text: '--port-text',
};

// Classic Midnight defaults — used in non-browser/test environments and when a
// stylesheet hasn't applied the tokens yet, so charts still render sensibly.
const FALLBACKS = {
  accent: '#3b82f6',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  chart1: '#3b82f6',
  chart2: '#22c55e',
  chart3: '#f59e0b',
  chart4: '#ec4899',
  grid: '#404040',
  axis: '#a3a3a3',
  tooltipBg: '#1a1a1a',
  tooltipBorder: '#2a2a2a',
  text: '#e5e5e5',
};

// "59 130 246" -> "rgb(59, 130, 246)". Comma form is the most broadly accepted
// syntax for SVG presentation attributes. Returns the fallback for an empty or
// malformed value.
export const tripleToRgb = (triple, fallback) => {
  const parts = (triple || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return fallback;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
};

const resolveChartColors = () => {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return { ...FALLBACKS };
  }
  const styles = getComputedStyle(document.documentElement);
  const out = {};
  for (const [key, varName] of Object.entries(CHART_VARS)) {
    out[key] = tripleToRgb(styles.getPropertyValue(varName), FALLBACKS[key]);
  }
  return out;
};

export default function useChartColors() {
  const [colors, setColors] = useState(resolveChartColors);

  useEffect(() => {
    setColors(resolveChartColors());
    if (typeof MutationObserver !== 'function') return undefined;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setColors(resolveChartColors()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-port-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}
