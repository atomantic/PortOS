import { Fragment } from 'react';

export function plotBounds(size, margin = {}, leftAxis = {}, rightAxis, legend) {
  const left = Math.min(size.width * 0.35, (margin.left ?? 4) + (leftAxis.width ?? 54));
  const rightSpace = rightAxis ? rightAxis.width ?? 54 : 0;
  const right = Math.max(left + 1, size.width - rightSpace - (margin.right ?? 8));
  const top = margin.top ?? 8;
  const bottom = Math.max(top + 1, size.height - (margin.bottom ?? 2) - 24 - (legend ? 18 : 0));
  return { left, right, top, bottom };
}

export function PlotAxis({ axis, direction, bounds, ticks, grid }) {
  const { left, right, top, bottom } = bounds;
  const isX = direction === 'x';
  const opposite = axis.orientation === 'right';
  const edge = opposite ? right : left;
  const axisColor = axis.tick?.fill ?? 'rgb(var(--port-text-muted))';
  const label = axis.label;
  const axisX = isX ? (left + right) / 2 : edge + (opposite ? 1 : -1) * ((axis.width ?? 54) - 8);
  const axisY = isX ? bottom + 32 : (top + bottom) / 2;
  return <g fill={axisColor} fontSize={axis.tick?.fontSize ?? 11}>
    <line x1={isX ? left : edge} x2={isX ? right : edge} y1={isX ? bottom : top} y2={bottom} stroke={axisColor} />
    {ticks.map(({ value, pos }, i) => <Fragment key={i}>
      {grid && <line className="port-chart-grid" x1={isX ? pos : left} x2={isX ? pos : right} y1={isX ? top : pos} y2={isX ? bottom : pos} stroke={grid.stroke ?? 'rgb(var(--port-border))'} strokeDasharray={grid.strokeDasharray} />}
      <text x={isX ? pos : edge + (opposite ? 4 : -4)} y={isX ? bottom + 14 : pos + 3}
        textAnchor={isX ? i === ticks.length - 1 && ticks.length > 1 ? 'end' : i === 0 && pos === left ? 'start' : 'middle' : opposite ? 'start' : 'end'}>
        {axis.tickFormatter ? axis.tickFormatter(value) : value}{axis.unit}
      </text>
    </Fragment>)}
    {label && <text x={axisX} y={axisY} fill={label.fill ?? axisColor} fontSize={label.fontSize ?? 11}
      transform={label.angle ? `rotate(${label.angle} ${axisX} ${axisY})` : undefined} textAnchor="middle">{label.value}</text>}
  </g>;
}

export const axisTicks = (axis, project) => axis.ticks.map(value => ({ value, pos: project(value) }));
