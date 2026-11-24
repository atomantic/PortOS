import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock('../../services/apiFeaturePriorities.js', () => ({
  getFeaturePriorities: mock.get,
  setFeaturePriorityPin: mock.set,
}));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import socket from '../../services/socket';
import { FeaturePrioritiesSection } from './FeaturePrioritiesSection';

const area = (overrides) => ({
  areaId: 'brain', label: 'Brain', instanceFeatureId: null, tier: 'P0', source: 'learned', activeDays30: 12, lastActiveDay: '2026-11-20', ...overrides,
});
const payload = (areas, evidenceDays = 30) => ({ areas, evidenceDays, minEvidenceDays: 14 });

const rowOf = (label) => screen.getByRole('heading', { name: label }).closest('li');
const emit = (event, data) => act(() => {
  for (const [name, handler] of socket.on.mock.calls) if (name === event) handler(data);
});

beforeEach(() => {
  vi.clearAllMocks();
  mock.get.mockResolvedValue(payload([area(), area({ areaId: 'beeper', label: 'Beeper', tier: 'P3', source: 'feature-off', activeDays30: 0, lastActiveDay: null })]));
});

describe('FeaturePrioritiesSection', () => {
  it('shows tier, source and recent activity per area', async () => {
    render(<FeaturePrioritiesSection />);
    await screen.findByText('Brain');
    const brain = rowOf('Brain');
    expect(within(brain).getByTestId('tier-brain').textContent).toBe('P0');
    expect(within(brain).getByText('Learned')).toBeTruthy();
    expect(within(brain).getByText(/Active 12 of the last 30 days, last /)).toBeTruthy();
    const beeper = rowOf('Beeper');
    expect(within(beeper).getByText('Feature off')).toBeTruthy();
    expect(within(beeper).getByRole('button', { name: 'Beeper: Auto' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Security, privacy and data-safety audits always cover everything/)).toBeTruthy();
  });

  it('says it is still learning before the evidence threshold', async () => {
    mock.get.mockResolvedValue(payload([area({ tier: 'P1', source: 'default', activeDays30: 0, lastActiveDay: null })], 3));
    render(<FeaturePrioritiesSection />);
    await screen.findByText(/Still learning: every enabled area is treated as P1/);
    expect(within(rowOf('Brain')).getByText('Still learning')).toBeTruthy();
    expect(screen.queryByText(/Active 0 of the last 30 days/)).toBeNull();
  });

  it('pins a tier from the PUT response without refetching, and Auto clears it with one reload', async () => {
    mock.set.mockResolvedValueOnce({ areaId: 'brain', tier: 'P3' });
    render(<FeaturePrioritiesSection />);
    await screen.findByText('Brain');
    fireEvent.click(within(rowOf('Brain')).getByRole('button', { name: 'Brain: P3' }));
    await waitFor(() => expect(within(rowOf('Brain')).getByText('Pinned')).toBeTruthy());
    expect(mock.set).toHaveBeenCalledWith('brain', 'P3');
    expect(within(rowOf('Brain')).getByTestId('tier-brain').textContent).toBe('P3');
    expect(mock.get).toHaveBeenCalledTimes(1);

    mock.set.mockResolvedValueOnce({ areaId: 'brain', tier: null });
    mock.get.mockResolvedValueOnce(payload([area({ tier: 'P0', source: 'learned' }), area({ areaId: 'beeper', label: 'Beeper', tier: 'P3', source: 'feature-off' })]));
    fireEvent.click(within(rowOf('Brain')).getByRole('button', { name: 'Brain: Auto' }));
    await waitFor(() => expect(within(rowOf('Brain')).getByText('Learned')).toBeTruthy());
    expect(mock.set).toHaveBeenLastCalledWith('brain', null);
    expect(within(rowOf('Brain')).getByTestId('tier-brain').textContent).toBe('P0');
    expect(mock.get).toHaveBeenCalledTimes(2);
  });

  it('applies a pin announced by another tab and reloads when it announces a clear', async () => {
    render(<FeaturePrioritiesSection />);
    await screen.findByText('Brain');
    emit('feature-priorities:updated', { areaId: 'brain', tier: 'P2' });
    expect(within(rowOf('Brain')).getByTestId('tier-brain').textContent).toBe('P2');
    expect(within(rowOf('Brain')).getByText('Pinned')).toBeTruthy();
    expect(mock.get).toHaveBeenCalledTimes(1);

    mock.get.mockResolvedValueOnce(payload([area({ tier: 'P1', source: 'default' })]));
    emit('feature-priorities:updated', { areaId: 'brain', tier: null });
    await waitFor(() => expect(within(rowOf('Brain')).getByText('Default')).toBeTruthy());
    expect(mock.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous value when a save fails', async () => {
    mock.set.mockRejectedValueOnce(new Error('boom'));
    render(<FeaturePrioritiesSection />);
    await screen.findByText('Brain');
    const button = within(rowOf('Brain')).getByRole('button', { name: 'Brain: P2' });
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(within(rowOf('Brain')).getByTestId('tier-brain').textContent).toBe('P0');
    expect(within(rowOf('Brain')).getByText('Learned')).toBeTruthy();
  });

  it('shows a load failure with a retry that recovers', async () => {
    mock.get.mockRejectedValueOnce(new Error('offline'));
    render(<FeaturePrioritiesSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Brain');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps showing rows when a later reload fails', async () => {
    render(<FeaturePrioritiesSection />);
    await screen.findByText('Brain');
    mock.get.mockRejectedValueOnce(new Error('offline'));
    mock.set.mockResolvedValueOnce({ areaId: 'brain', tier: null });
    emit('feature-priorities:updated', { areaId: 'brain', tier: 'P1' });
    emit('feature-priorities:updated', { areaId: 'brain', tier: null });
    await screen.findByRole('alert');
    expect(within(rowOf('Brain')).getByTestId('tier-brain').textContent).toBe('P1');
  });
});
