import { chartValue, numericAxis } from '../../../lib/chartScales';
import ChartFrame, { useFrameSize } from './ChartFrame';
import { elements, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, Tooltip } from './chartElements';

export default function RadarPlot({ title, desc, data = [], outerRadius = '70%', children }) {
  const { width, height } = useFrameSize();
  const [angle] = elements(children, PolarAngleAxis);
  const [radiusAxis] = elements(children, PolarRadiusAxis);
  const [grid] = elements(children, PolarGrid);
  const [legend] = elements(children, Legend);
  const [tooltip] = elements(children, Tooltip);
  const series = elements(children, Radar);
  const scale = numericAxis(radiusAxis, data.flatMap(row => series.map(item => chartValue(row, item.dataKey))));
  const cy = (height - (legend ? 20 : 0)) / 2;
  const cx = width / 2;
  const radius = Math.min(cx, cy) * Number.parseFloat(outerRadius) / 100;
  const position = (i, distance) => {
    const theta = i * 2 * Math.PI / data.length - Math.PI / 2;
    return [cx + Math.cos(theta) * distance, cy + Math.sin(theta) * distance];
  };
  const polygon = radii => radii.map((r, i) => position(i, r).join(',')).join(' ');
  const points = data.map((row, i) => {
    const [x, y] = position(i, radius);
    return { x, y, label: chartValue(row, angle.dataKey), payload: series.flatMap(item => {
      const value = chartValue(row, item.dataKey);
      return Number.isFinite(value) ? [{ dataKey: item.dataKey, name: item.name, value, payload: row, color: item.stroke }] : [];
    }) };
  });
  return <ChartFrame title={title} desc={desc} points={points} tooltip={tooltip} legend={legend} series={series}>
    {scale.ticks.map(value => <g key={value}>
      <polygon className="port-chart-grid" points={polygon(data.map(() => radius * scale.project(value)))} fill="none" stroke={grid?.stroke} />
      <text x={cx + 2} y={cy - radius * scale.project(value)} {...radiusAxis.tick}>{value}</text>
    </g>)}
    {points.map(({ x, y, label }, i) => {
      const [tx, ty] = position(i, radius + 10);
      return <g key={label}><line className="port-chart-grid" x1={cx} y1={cy} x2={x} y2={y} stroke={grid?.stroke} />
        <text x={tx} y={ty} textAnchor={Math.abs(tx - cx) < 1 ? 'middle' : tx < cx ? 'end' : 'start'} {...angle.tick}>{label}</text></g>;
    })}
    {series.map(item => <polygon key={item.dataKey} stroke={item.stroke} fill={item.fill} fillOpacity={item.fillOpacity}
      points={polygon(data.map(row => radius * scale.project(chartValue(row, item.dataKey) ?? 0)))} />)}
  </ChartFrame>;
}
