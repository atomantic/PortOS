import { chartValue, linePath, numericAxis, stackBars } from '../../../lib/chartScales';
import ChartFrame, { useFrameSize } from './ChartFrame';
import { axisTicks, plotBounds, PlotAxis } from './PlotAxes';
import { Bar, CartesianGrid, Cell, elements, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from './chartElements';

function SeriesLine({ line, data, category, project }) {
  const points = data.map((row, i) => {
    const value = chartValue(row, line.dataKey);
    return Number.isFinite(value) ? [category(i), project(value)] : null;
  });
  return <g stroke={line.stroke}>
    <path fill="none" strokeWidth={line.strokeWidth ?? 1} d={linePath(points, line.type, line.connectNulls)} />
    {line.dot !== false && points.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={line.dot?.r ?? 3} fill={line.stroke} />)}
  </g>;
}

function BarShape({ x, y, width, height, fill, radius }) {
  if (!Array.isArray(radius)) return <rect x={x} y={y} width={width} height={height} rx={radius} fill={fill} />;
  const [tl, tr, br, bl] = radius.map(r => Math.min(r, width / 2, height / 2));
  const right = x + width;
  const bottom = y + height;
  return <path fill={fill} d={`M${x + tl},${y} H${right - tr} Q${right},${y} ${right},${y + tr}
    V${bottom - br} Q${right},${bottom} ${right - br},${bottom}
    H${x + bl} Q${x},${bottom} ${x},${bottom - bl}
    V${y + tl} Q${x},${y} ${x + tl},${y} Z`} />;
}

function SeriesBars({ bars, stacked, category, scales, band, vertical }) {
  const groupKeys = bars.map(bar => JSON.stringify([bar.yAxisId, bar.stackId ?? bar.dataKey]));
  const groups = [...new Set(groupKeys)];
  const groupWidth = band * 0.8 / groups.length;
  return bars.map((bar, j) => {
    const project = scales.get(bar.yAxisId).project;
    const cells = elements(bar.children, Cell);
    const thickness = Math.min(groupWidth, bar.maxBarSize ?? Infinity);
    const offset = (groups.indexOf(groupKeys[j]) + 0.5 - groups.length / 2) * groupWidth - thickness / 2;
    return <g key={bar.dataKey} fill={bar.fill} opacity={bar.opacity}>
      {stacked.map((row, i) => {
        if (!row[j]) return null;
        const [start, end] = row[j].map(project);
        const pos = category(i) + offset;
        const lo = Math.min(start, end);
        const length = Math.abs(end - start);
        return <BarShape key={i} x={vertical ? lo : pos} y={vertical ? pos : lo} width={vertical ? length : thickness}
          height={vertical ? thickness : length} radius={bar.radius} fill={cells[i]?.fill} />;
      })}
    </g>;
  });
}

export default function CartesianChart({ title, desc, data = [], layout, margin, children }) {
  const size = useFrameSize();
  const vertical = layout === 'vertical';
  const [xAxis] = elements(children, XAxis);
  const yAxes = elements(children, YAxis);
  const [grid] = elements(children, CartesianGrid);
  const [legend] = elements(children, Legend);
  const [tooltip] = elements(children, Tooltip);
  const references = elements(children, ReferenceLine);
  const lines = elements(children, Line);
  const bars = elements(children, Bar);
  const stacked = stackBars(data, bars);
  const series = [...bars, ...lines];
  const bounds = plotBounds(size, margin, yAxes[0], yAxes[1], legend);
  const { left, right, top, bottom } = bounds;
  const categoryAxis = vertical ? yAxes[0] : xAxis;
  const span = vertical ? bottom - top : right - left;
  const band = span / Math.max(1, data.length);
  const category = i => (vertical ? top : left) + (bars.length || data.length <= 1 ? band * (i + 0.5) : span * i / (data.length - 1));
  const stride = Number.isInteger(categoryAxis.interval) ? categoryAxis.interval + 1 : Math.max(1, Math.ceil((vertical ? 12 : 45 + (categoryAxis.minTickGap ?? 4)) / band));
  const last = data.length - 1;
  const categoryTicks = data.flatMap((row, i) => {
    const preserveEnds = categoryAxis.interval === 'preserveStartEnd';
    const visible = preserveEnds && i === last || i % stride === 0 && (!preserveEnds || i === 0 || i <= last - stride);
    return visible ? [{ value: chartValue(row, categoryAxis.dataKey), pos: category(i) }] : [];
  });
  const scales = new Map((vertical ? [xAxis] : yAxes).map(axis => {
    const values = [];
    lines.filter(line => line.yAxisId === axis.yAxisId).forEach(line => {
      for (const row of data) values.push(chartValue(row, line.dataKey));
    });
    bars.forEach((bar, j) => {
      if (bar.yAxisId === axis.yAxisId) for (const row of stacked) if (row[j]) values.push(...row[j]);
    });
    const scale = numericAxis(axis, values);
    const project = vertical ? value => left + (right - left) * scale.project(value) : value => bottom - (bottom - top) * scale.project(value);
    return [axis.yAxisId, { axis, project, ticks: axisTicks(scale, project) }];
  }));
  const points = data.map((row, i) => {
    const payload = series.map(item => ({ dataKey: item.dataKey, name: item.name ?? item.dataKey, value: chartValue(row, item.dataKey), color: item.stroke ?? item.fill, payload: row }))
      .filter(item => item.value != null);
    return { label: chartValue(row, categoryAxis.dataKey), payload, x: vertical ? left : category(i), y: vertical ? category(i) : bottom, trackX: !vertical, trackY: vertical };
  });
  const xGrid = grid?.vertical === false ? undefined : grid;
  const yGrid = grid?.horizontal === false ? undefined : grid;
  return <ChartFrame title={title} desc={desc} points={points} tooltip={tooltip} legend={legend} series={series}>
    <PlotAxis axis={categoryAxis} direction={vertical ? 'y' : 'x'} bounds={bounds} ticks={categoryTicks} grid={vertical ? yGrid : xGrid} />
    {[...scales.values()].map(({ axis, ticks }, i) => <PlotAxis key={axis.yAxisId ?? i} axis={axis} direction={vertical ? 'x' : 'y'} bounds={bounds} ticks={ticks} grid={i ? undefined : vertical ? xGrid : yGrid} />)}
    {references.map(ref => {
      const y = scales.get(ref.yAxisId)?.project(ref.y);
      if (y == null || y < top || y > bottom) return null;
      return <g key={ref.y}><line x1={left} x2={right} y1={y} y2={y} stroke={ref.stroke} strokeOpacity={ref.strokeOpacity} strokeDasharray={ref.strokeDasharray} />
        {ref.label && <text x={right} y={y - 2} textAnchor="end" fill={ref.label.fill} fontSize={ref.label.fontSize}>{ref.label.value}</text>}</g>;
    })}
    {bars.length > 0 && <SeriesBars bars={bars} stacked={stacked} scales={scales} category={category} band={band} vertical={vertical} />}
    {lines.map(line => <SeriesLine key={line.dataKey} line={line} data={data} category={category} project={scales.get(line.yAxisId).project} />)}
  </ChartFrame>;
}
