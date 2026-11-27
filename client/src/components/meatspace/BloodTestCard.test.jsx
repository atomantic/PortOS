import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import BloodTestCard from './BloodTestCard';

afterEach(cleanup);

it('shows out-of-range badges and exposes each known status once to assistive technology', () => {
  render(<BloodTestCard test={{ date: '2026-01-01', glucose: 105, hemoglobin: 12, na: 140 }} />);

  for (const status of ['High', 'Low']) {
    const badge = screen.getByText(status, { exact: true });
    expect(badge).toBeVisible();
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(`(${status})`)).toHaveClass('sr-only');
  }
  expect(screen.getByText('(Normal)')).toHaveClass('sr-only');
});
