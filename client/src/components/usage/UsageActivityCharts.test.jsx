import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import UsageActivityCharts from './UsageActivityCharts';

it('summarizes hourly activity and exposes every count through a keyboard-focusable disclosure', async () => {
  const counts = Array.from({ length: 24 }, (_, hour) => hour === 18 ? 1200 : hour);
  const user = userEvent.setup();
  render(<UsageActivityCharts activity={[]} hourlyActivity={counts} />);
  expect(screen.getByRole('img', { name: 'Hourly distribution, 1,458 sessions. Peak at 18:00 with 1,200 sessions.' })).toBeInTheDocument();

  const summary = screen.getByText('View session counts by hour');
  await user.tab();
  expect(summary).toHaveFocus();
  // Happy DOM does not perform the native summary activation on Enter.
  await user.click(summary);
  const details = summary.closest('details');
  expect(details).toHaveAttribute('open');
  const hours = within(details).getAllByRole('listitem');
  expect(hours).toHaveLength(24);
  expect(hours[0]).toHaveTextContent('0:00: 0');
  expect(hours[18]).toHaveTextContent('18:00: 1,200');
  expect(hours[23]).toHaveTextContent('23:00: 23');
});

it('distinguishes unavailable hourly activity from zero sessions', () => {
  const { rerender } = render(<UsageActivityCharts activity={[]} hourlyActivity={null} />);
  expect(screen.getByText('Hourly data is unavailable for this period.')).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();

  rerender(<UsageActivityCharts activity={[]} hourlyActivity={Array(24).fill(0)} />);
  expect(screen.getByRole('img', { name: 'Hourly distribution, 0 sessions.' })).toBeInTheDocument();
});
