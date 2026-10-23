import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MonthlyUsageCard from './MonthlyUsageCard';

const history = [
  { month: '2026-09', estimatedCost: 123.45, values: [100, 23.45], tokens: 1250000, partial: false },
  { month: '2026-10', estimatedCost: 0, values: [0, 0], tokens: 0, partial: true },
];
const series = [{ key: 'claude', label: 'Claude Code' }, { key: 'codex', label: 'Codex' }];

describe('monthly usage', () => {
  it('shows each month’s API cost and exact token totals without hover, including zero and partial months', () => {
    render(<MonthlyUsageCard history={history} series={series} instanceCount={3} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Monthly estimated API cost & tokens');
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('MonthClaude Code (USD)Codex (USD)Est. cost (USD)Tokens');
    expect(rows[1]).toHaveTextContent('September 2026$100.00$23.45$123.451,250,000');
    expect(rows[2]).toHaveTextContent('October 2026 (partial)$0.00$0.00$0.000');
    expect(screen.getByRole('img')).toHaveAccessibleName(/stacked by provider with token trend/);
    expect(screen.getByText(/3 instances/)).toHaveTextContent('Calendar months differ from a trailing 30-day window');
  });

  it('shows an empty state when no monthly history is available', () => {
    render(<MonthlyUsageCard />);
    expect(screen.getByText('No monthly usage recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
