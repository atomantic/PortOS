import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Bar, BarChart, Cell, ComposedChart, Legend, Line, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ReferenceLine, Tooltip, XAxis, YAxis } from './index';

const rows = [{ name: 'Alpha', values: [1, 2], cost: 50 }, { name: 'Beta', values: [2, 1], cost: null }];

it('renders stacked indexed bars, a second numeric axis, a gapped line and reference', () => {
  render(<ComposedChart data={rows} title="Usage" desc="Units and cost">
    <XAxis dataKey="name" /><YAxis yAxisId="units" domain={[0, 3]} /><YAxis yAxisId="cost" domain={[0, 100]} orientation="right" />
    <ReferenceLine yAxisId="cost" y={60} label={{ value: 'Threshold' }} />
    <Bar yAxisId="units" dataKey="values[0]" stackId="a" /><Bar yAxisId="units" dataKey="values[1]" stackId="a" />
    <Line yAxisId="cost" dataKey="cost" dot /><Tooltip content={({ label, payload }) => <span>{label} cost {payload.at(-1).value}</span>} />
  </ComposedChart>);
  const svg = screen.getByRole('img', { name: 'Usage' });
  expect(svg).toHaveAccessibleDescription('Units and cost');
  expect(screen.getByText('100')).toBeInTheDocument();
  expect(screen.getByText('Threshold')).toBeInTheDocument();
  const bars = svg.querySelectorAll('rect');
  expect(bars).toHaveLength(4);
  expect(Number(bars[2].getAttribute('y')) + Number(bars[2].getAttribute('height'))).toBeCloseTo(Number(bars[0].getAttribute('y')));
  expect(svg.querySelectorAll('circle')).toHaveLength(1);
  fireEvent.focus(svg);
  expect(screen.getByText('Alpha cost 50')).toBeInTheDocument();
});

it('places horizontal bars in category rows with per-datum fills', () => {
  render(<BarChart layout="vertical" title="Grades" desc="By group" data={rows}><XAxis domain={[0, 100]} /><YAxis dataKey="name" /><Bar dataKey="cost"><Cell fill="red" /></Bar></BarChart>);
  const rect = screen.getByRole('img', { name: 'Grades' }).querySelector('rect');
  expect(rect).toHaveAttribute('fill', 'red');
  expect(Number(rect.getAttribute('width'))).toBeGreaterThan(Number(rect.getAttribute('height')));
});

it('draws radar polygons, named traits, radii, legend and selected trait values', () => {
  render(<RadarChart title="Traits" desc="Two runs" data={rows}>
    <PolarGrid /><PolarAngleAxis dataKey="name" /><PolarRadiusAxis domain={[0, 100]} />
    <Radar dataKey="values[0]" name="First" fill="blue" /><Radar dataKey="values[1]" name="Second" fill="red" />
    <Legend /><Tooltip />
  </RadarChart>);
  const svg = screen.getByRole('img', { name: 'Traits' });
  expect(svg).toHaveAccessibleDescription('Two runs');
  expect(svg.querySelectorAll('polygon[fill="blue"],polygon[fill="red"]')).toHaveLength(2);
  expect(screen.getByText('Second')).toBeInTheDocument();
  fireEvent.focus(svg);
  expect(screen.getByRole('status')).toHaveTextContent('AlphaFirst: 1Second: 2');
});
