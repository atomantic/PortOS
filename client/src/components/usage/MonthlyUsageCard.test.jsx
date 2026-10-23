import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MonthlyUsageCard from './MonthlyUsageCard';

const history = [
  { month: '2026-09', estimatedCost: 123.45, tokens: 1250000, partial: false },
  { month: '2026-10', estimatedCost: 0, tokens: 0, partial: true },
];

describe('monthly usage', () => {
  it('shows each month’s API cost and exact token totals without hover, including zero and partial months', () => {
    render(<MonthlyUsageCard history={history} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Monthly estimated API cost & tokens');
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('September 2026$123.451,250,000');
    expect(rows[2]).toHaveTextContent('October 2026 (partial)$0.000');
    expect(screen.getByRole('img')).toHaveAccessibleName(/token trend/);
  });

  it('shows an empty state when no monthly history is available', () => {
    render(<MonthlyUsageCard />);
    expect(screen.getByText('No monthly usage recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
