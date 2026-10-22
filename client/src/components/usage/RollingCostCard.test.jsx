import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RollingCostCard from './RollingCostCard';

const rollingCost = {
  windowDays: 30,
  instanceCount: 3,
  points: [
    { date: '2026-10-20', cost: 10 },
    { date: '2026-10-21', cost: 25.5 },
    { date: '2026-10-22', cost: 40.25 },
  ],
};

describe('RollingCostCard', () => {
  it('headlines today and reads a tapped day', () => {
    render(<RollingCostCard rollingCost={rollingCost} />);
    expect(screen.getByText('$40.25')).toBeTruthy();
    expect(screen.getByText('3 instances')).toBeTruthy();

    const chart = screen.getByRole('img');
    chart.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 96 });
    fireEvent.pointerDown(chart, { clientX: 150, pointerId: 1 });
    expect(screen.getByText('$25.50')).toBeTruthy();
    expect(screen.getByText('Oct 21')).toBeTruthy();
  });

  it('renders nothing without a series', () => {
    const { container } = render(<RollingCostCard rollingCost={{ points: [] }} />);
    expect(container.innerHTML).toBe('');
  });
});
