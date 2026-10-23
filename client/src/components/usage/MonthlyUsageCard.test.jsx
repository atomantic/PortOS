import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MonthlyUsageCard from './MonthlyUsageCard';

const history = [
  { month: '2026-09', tokens: 1250000, partial: false },
  { month: '2026-10', tokens: 0, partial: true },
];

describe('monthly usage', () => {
  it('labels configured dollar budgets honestly and exposes exact token totals without hover', () => {
    render(<MemoryRouter><MonthlyUsageCard history={history} savings={{ configured: true, totals: { monthlyCost: 220 } }} /></MemoryRouter>);
    expect(screen.getByText(/not historical invoices/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('September 2026$220.001,250,000');
    expect(rows[2]).toHaveTextContent('October 2026 (partial)$220.000');
    expect(screen.getByRole('img')).toHaveAccessibleName(/token trend/);
  });

  it('keeps missing prices distinct from zero while retaining the token series', () => {
    render(<MemoryRouter><MonthlyUsageCard history={history} savings={{ configured: false }} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Set subscription prices' })).toHaveAttribute('href', '/models/subscriptions');
    expect(screen.getAllByText('Not configured')).toHaveLength(2);
    expect(screen.getByText('1,250,000')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});
