import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/apiHealth.js', () => ({
  getAppleHealthMetrics: vi.fn(),
  getLatestHealthMetrics: vi.fn(),
}));
vi.mock('./MetricCard', () => ({
  default: ({ config, data }) => <div data-testid="metric-card">{config.label}:{data.length}</div>,
}));
vi.mock('./SleepCard', () => ({ default: () => null }));

import { getLatestHealthMetrics, getAppleHealthMetrics } from '../../services/apiHealth.js';
import HealthCategorySection from './HealthCategorySection';

const category = { label: 'Activity', metrics: [{ key: 'steps', label: 'Steps' }, { key: 'flights', label: 'Flights' }] };
const renderSection = () => render(
  <HealthCategorySection
    category={category}
    from="2026-03-01"
    to="2026-03-07"
    expanded
    onToggle={() => {}}
    availableMetrics={new Set(['steps', 'flights'])}
  />,
);

beforeEach(() => {
  getLatestHealthMetrics.mockResolvedValue({});
});
afterEach(cleanup);

describe('HealthCategorySection metric loads', () => {
  it('names the metric whose read failed instead of drawing it as "no data", and retries it', async () => {
    getAppleHealthMetrics.mockImplementation((key) => (key === 'steps'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([{ date: '2026-03-01', value: 3 }])));
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Steps');
    expect(screen.getAllByTestId('metric-card').map(n => n.textContent)).toEqual(['Flights:1']);

    getAppleHealthMetrics.mockResolvedValue([{ date: '2026-03-01', value: 3 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getAllByTestId('metric-card')).toHaveLength(2);
  });
});

it('keeps the disclosure under a heading and associates it with its metric panel', async () => {
  getAppleHealthMetrics.mockResolvedValue([{ date: '2026-03-01', value: 3 }]);
  const availableMetrics = new Set(['steps']);
  const props = { category, from: '2026-03-01', to: '2026-03-07', availableMetrics };
  const { rerender } = render(<HealthCategorySection {...props} expanded={false} />);

  const heading = screen.getByRole('heading', { level: 2, name: /Activity/ });
  const button = within(heading).getByRole('button', { expanded: false });
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  expect(panel).toHaveAttribute('hidden');
  expect(screen.queryByTestId('metric-card')).toBeNull();

  rerender(<HealthCategorySection {...props} expanded />);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(panel).not.toHaveAttribute('hidden');
  expect(await within(panel).findByText('Steps:1')).toBeVisible();
});
