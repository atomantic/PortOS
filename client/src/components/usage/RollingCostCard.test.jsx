import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RollingCostCard, { niceTicks } from './RollingCostCard';

const api = vi.hoisted(() => ({ getUsageRollingCost: vi.fn() }));
vi.mock('../../services/api', () => api);

const payload = {
  range: '3m',
  windowDays: 30,
  instanceCount: 3,
  series: [{ key: 'claude', label: 'Claude Code' }, { key: 'codex', label: 'Codex' }],
  points: [
    { date: '2026-10-20', cost: 10, values: [6, 4] },
    { date: '2026-10-21', cost: 25.5, values: [20, 5.5] },
    { date: '2026-10-22', cost: 40.25, values: [30, 10.25] },
  ],
};

beforeEach(() => {
  localStorage.clear();
  api.getUsageRollingCost.mockReset().mockResolvedValue(payload);
});

const plot = () => screen.getByRole('group', { name: /pin/ });
const tapAt = (clientX) => {
  plot().getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 160 });
  fireEvent.click(plot(), { clientX });
};

describe('RollingCostCard', () => {
  it('stacks plans with a legend and pins tapped days until tapped again', async () => {
    render(<RollingCostCard />);
    await screen.findByText('$40.25');
    expect(screen.getByText('3 instances')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('$10.25')).toBeTruthy();

    tapAt(150);
    expect(screen.getByText('Oct 21 · $25.5')).toBeTruthy();
    // The legend follows the newest pin.
    expect(screen.getByText('$5.50')).toBeTruthy();
    tapAt(0);
    expect(screen.getByText('Oct 20 · $10')).toBeTruthy();
    expect(screen.getByText('Oct 21 · $25.5')).toBeTruthy();

    tapAt(152);
    expect(screen.queryByText('Oct 21 · $25.5')).toBeNull();
    expect(screen.getByText('Oct 20 · $10')).toBeTruthy();
  });

  it('pins from the keyboard', async () => {
    render(<RollingCostCard />);
    await screen.findByText('$40.25');
    const group = screen.getByRole('group', { name: /pin/ });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(screen.getByText('Oct 21 · $25.5')).toBeTruthy();
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(screen.queryByText('Oct 21 · $25.5')).toBeNull();
  });

  it('remembers the chosen range', async () => {
    const { unmount } = render(<RollingCostCard />);
    await screen.findByText('$40.25');
    expect(api.getUsageRollingCost).toHaveBeenLastCalledWith({ range: '3m' }, { silent: true });
    fireEvent.click(screen.getByRole('button', { name: '1Y' }));
    await waitFor(() => expect(api.getUsageRollingCost).toHaveBeenLastCalledWith({ range: '1y' }, { silent: true }));
    unmount();

    render(<RollingCostCard />);
    await screen.findByText('$40.25');
    expect(api.getUsageRollingCost).toHaveBeenLastCalledWith({ range: '1y' }, { silent: true });
  });
});

describe('niceTicks', () => {
  it('rounds the axis top up to a friendly step from zero', () => {
    expect(niceTicks(9428.45)).toEqual([0, 2500, 5000, 7500, 10000]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});
