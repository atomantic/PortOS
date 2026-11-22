import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getWorkouts: vi.fn(),
  removeWorkout: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../services/apiHealth.js', () => ({
  getAvailableHealthMetrics: vi.fn(),
  getAppleHealthCorrelation: vi.fn(),
  getAppleHealthMetrics: vi.fn(),
  getLatestHealthMetrics: vi.fn(),
}));
vi.mock('../../ActivityBloodCorrelation', () => ({ default: () => null }));

import { getWorkouts } from '../../../services/apiMeatspace.js';
import {
  getAvailableHealthMetrics,
  getAppleHealthCorrelation,
  getAppleHealthMetrics,
  getLatestHealthMetrics,
} from '../../../services/apiHealth.js';
import HealthTab from './HealthTab';

const renderTab = () => render(
  <MemoryRouter>
    <HealthTab />
  </MemoryRouter>
);

beforeEach(() => {
  getWorkouts.mockResolvedValue({ workouts: [] });
  getAppleHealthCorrelation.mockResolvedValue(null);
  getAppleHealthMetrics.mockResolvedValue([]);
  getLatestHealthMetrics.mockResolvedValue({});
});
afterEach(cleanup);

describe('HealthTab metric catalog load', () => {
  it('shows a retryable notice instead of an empty-looking page when the catalog read fails', async () => {
    getAvailableHealthMetrics.mockRejectedValueOnce(new Error('boom'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the health metric list');
    expect(screen.queryByText('Core Vitals')).toBeNull();
    expect(screen.getByText('Workouts')).toBeTruthy();

    getAvailableHealthMetrics.mockResolvedValueOnce([{ name: 'heart_rate' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Core Vitals')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no category sections and no alert for a successful empty catalog', async () => {
    getAvailableHealthMetrics.mockResolvedValue([]);
    renderTab();

    await waitFor(() => expect(getAvailableHealthMetrics).toHaveBeenCalled());
    expect(await screen.findByText('Workouts')).toBeTruthy();
    expect(screen.queryByText('Core Vitals')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the workout failure notice unchanged when only workouts fail', async () => {
    getAvailableHealthMetrics.mockResolvedValue([{ name: 'heart_rate' }]);
    getWorkouts.mockRejectedValueOnce(new Error('boom'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load workouts. Retry.');
    expect(await screen.findByText('Core Vitals')).toBeTruthy();
  });
});
