/** Owned charts expose their title and description directly on the interactive SVG. */
import { describe, it, expect } from 'vitest';
import { trackedJsxFiles, maskedSourceOf, forEachOpeningTag, lineOf } from '../../a11yScanCore.js';
import { attributeValue, normalizedAttributeValue } from '../../a11yScanNames.js';

const CHART_NAMES = ['LineChart', 'BarChart', 'ComposedChart', 'ScatterChart', 'RadarChart'];

const hasAttr = (tag, name) => new RegExp(`\\s${name}\\s*=`).test(tag);

// Offenders for one source: charts without a title, and charts sitting inside
// a role="img" element (found by balancing that element's own tag name).
const chartOffenders = (src) => {
  if (!/from\s+['"][^'"]*ui\/charts['"]/.test(src)) return [];
  const charts = [];
  for (const name of CHART_NAMES) {
    for (const node of forEachOpeningTag(src, name)) charts.push({ ...node, name });
  }
  const out = [];
  for (const c of charts) {
    if (!hasAttr(c.tag, 'desc')) out.push(`${lineOf(src, c.index)}: <${c.name}> has no desc=`);
    if (!hasAttr(c.tag, 'title')) out.push(`${lineOf(src, c.index)}: <${c.name}> has no title=`);
  }
  for (const node of forEachOpeningTag(src)) {
    if (normalizedAttributeValue(attributeValue(node.tag, 'role')) !== 'img' || !node.name) continue;
    const re = new RegExp(`<(/?)${node.name}(?=[\\s>/])[^>]*?(/?)>`, 'g');
    re.lastIndex = node.index + 1;
    let depth = 1;
    let end = src.length;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (m[2]) continue;
      depth += m[1] ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    for (const c of charts) {
      if (c.index > node.index && c.index < end) out.push(`${lineOf(src, c.index)}: <${c.name}> sits inside role="img" (line ${lineOf(src, node.index)})`);
    }
  }
  return out;
};

describe('a11y conventions: owned charts', () => {
  it('probe: the walk rejects unnamed charts and role="img" wrappers', () => {
    const base = "import { LineChart } from '../ui/charts';\n";
    expect(chartOffenders(`${base}<LineChart data={d} />`)).toHaveLength(2);
    expect(chartOffenders(`${base}<LineChart title="T" desc="D" data={d} />`)).toEqual([]);
    expect(chartOffenders(`${base}<div role="img" aria-label="x"><div><LineChart title="T" desc="D" /></div></div>`)).toHaveLength(1);
    expect(chartOffenders(`${base}<div role="img" aria-label="x"><p /></div><LineChart title="T" desc="D" />`)).toEqual([]);
    expect(chartOffenders('<LineChart data={d} />')).toEqual([]);
  });

  it('names every chart and never wraps one in role="img"', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      for (const o of chartOffenders(maskedSourceOf(file))) offenders.push(`${file}:${o}`);
    }
    expect(offenders, 'Pass title=/desc= to each chart and drop the role="img" wrapper (#17322)').toEqual([]);
  });
});
