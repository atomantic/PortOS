// Keep provider colors consistent across the rolling and calendar-month charts.
const FAMILY_COLORS = {
  claude: 'rgb(var(--port-chart-3))',
  codex: 'rgb(var(--port-chart-2))',
  agy: 'rgb(var(--port-chart-1))',
  grok: 'rgb(var(--port-chart-4))',
};
const SPARE_COLORS = ['rgb(var(--port-accent-2))', 'rgb(var(--port-chart-1))', 'rgb(var(--port-chart-2))', 'rgb(var(--port-chart-4))'];
const OTHER_COLOR = 'rgb(156 163 175)';

export function seriesColors(series) {
  const used = new Set();
  const fixed = series.map((s) => {
    const color = s.key === 'other' ? OTHER_COLOR : FAMILY_COLORS[s.key];
    if (color) used.add(color);
    return color;
  });
  const spare = SPARE_COLORS.filter((c) => !used.has(c));
  return fixed.map((color) => color || spare.shift() || OTHER_COLOR);
}
