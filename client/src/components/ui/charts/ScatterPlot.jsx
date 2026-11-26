import { chartValue, numericAxis } from '../../../lib/chartScales';
import ChartFrame, { useFrameSize } from './ChartFrame';
import { axisTicks, plotBounds, PlotAxis } from './PlotAxes';
import { CartesianGrid, elements, LabelList, Scatter, Tooltip, XAxis, YAxis } from './chartElements';

export default function ScatterPlot({ title, desc, margin, children }) {
  const [xAxis] = elements(children, XAxis);
  const [yAxis] = elements(children, YAxis);
  const [tooltip] = elements(children, Tooltip);
  const [grid] = elements(children, CartesianGrid);
  const groups = elements(children, Scatter);
  const rows = groups.flatMap(group => group.data);
  const bounds = plotBounds(useFrameSize(), margin);
  const { left, right, top, bottom } = bounds;
  const xScale = numericAxis(xAxis, rows.map(row => chartValue(row, xAxis.dataKey)));
  const yScale = numericAxis(yAxis, rows.map(row => chartValue(row, yAxis.dataKey)));
  const x = value => left + xScale.project(value) * (right - left);
  const y = value => bottom - yScale.project(value) * (bottom - top);
  const series = groups.map(group => ({
    ...group, label: elements(group.children, LabelList)[0],
    points: group.data.flatMap(row => {
      const xv = chartValue(row, xAxis.dataKey);
      const yv = chartValue(row, yAxis.dataKey);
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) return [];
      return [{ x: x(xv), y: y(yv), row, payload: [{ name: group.name, value: yv, payload: row, color: group.fill }] }];
    }),
  }));
  return <ChartFrame title={title} desc={desc} points={series.flatMap(group => group.points)} tooltip={tooltip}>
    <PlotAxis axis={xAxis} direction="x" bounds={bounds} ticks={axisTicks(xScale, x)} grid={grid} />
    <PlotAxis axis={yAxis} direction="y" bounds={bounds} ticks={axisTicks(yScale, y)} grid={grid} />
    {series.map(({ name, points, fill, label, line }) => <g key={name} fill={fill}>
      {line && <polyline fill="none" stroke={fill} strokeDasharray={line.strokeDasharray} strokeWidth={line.strokeWidth} points={points.map(p => `${p.x},${p.y}`).join(' ')} />}
      {points.map(({ x, y, row }, index) => <g key={row.id ?? index}>
        <circle cx={x} cy={y} r={4} />
        {label && <text x={x} y={y - 7} textAnchor="middle" className={label.className} fontSize={label.fontSize} fill={label.fill}>{chartValue(row, label.dataKey)}</text>}
      </g>)}
    </g>)}
  </ChartFrame>;
}
