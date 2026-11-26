import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ScatterPlot from './ScatterPlot';
import { CartesianGrid, LabelList, Scatter, Tooltip, XAxis, YAxis } from './chartElements';

const props = { title: 'Score versus cost', desc: 'Published results' };
const rows = [{ id: 'a', price: 1, score: 50 }, { id: 'b', price: 100, score: 90 }];
function Chart({ data = rows }) {
  return <ScatterPlot {...props}>
    <CartesianGrid /><XAxis dataKey="price" scale="log" domain={[1, 100]} ticks={[1, 10, 100]} tickFormatter={value => `$${value}`} />
    <YAxis dataKey="score" domain={[0, 100]} />
    <Scatter name="Example" data={data} line fill="red"><LabelList dataKey="id" /></Scatter>
    <Tooltip content={({ payload }) => <span>Selected {payload[0].payload.id}</span>} />
  </ScatterPlot>;
}

it('exposes a named image, ticks, series line and the nearest pointer or keyboard datum', () => {
  const { container } = render(<Chart />);
  const svg = screen.getByRole('img', { name: props.title });
  expect(svg).toHaveAccessibleDescription(props.desc);
  expect(screen.getByText('$10')).toBeInTheDocument();
  expect(svg.querySelectorAll('circle')).toHaveLength(2);
  expect(svg.querySelector('polyline')).toBeInTheDocument();
  const lastPoint = svg.querySelectorAll('circle')[1];
  fireEvent.pointerMove(svg, { clientX: Number(lastPoint.getAttribute('cx')), clientY: Number(lastPoint.getAttribute('cy')) });
  expect(screen.getByText('Selected b')).toBeInTheDocument();
  const control = container.querySelector('[tabindex="0"]');
  fireEvent.focus(control);
  fireEvent.keyDown(control, { key: 'ArrowRight' });
  expect(screen.getByText('Selected b')).toBeInTheDocument();
  fireEvent.keyDown(control, { key: 'Escape' });
  expect(screen.queryByText('Selected b')).toBeNull();
});

it('renders an empty image and projects a single observation', () => {
  const { rerender } = render(<Chart data={[]} />);
  expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(0);
  rerender(<Chart data={[rows[0]]} />);
  expect(Number.isFinite(Number(screen.getByRole('img').querySelector('circle').getAttribute('cx')))).toBe(true);
});
