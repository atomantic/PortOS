import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMeatspace.js', () => ({
  getEpigeneticInterventions: vi.fn(),
  getEpigeneticRecommendations: vi.fn(),
  getEpigeneticCompliance: vi.fn(),
  updateEpigeneticIntervention: vi.fn().mockResolvedValue({}),
  deleteEpigeneticIntervention: vi.fn(),
}));

import {
  getEpigeneticInterventions,
  getEpigeneticCompliance,
  getEpigeneticRecommendations,
  deleteEpigeneticIntervention,
} from '../../services/apiMeatspace.js';
import EpigeneticTracker from './EpigeneticTracker';
import toast from '../ui/Toast';

vi.mock('../ui/Toast');

const CATEGORIES = [];
const REC = { id: 'omega3', name: 'Omega-3', category: 'supplement', evidence: 'strong' };

beforeEach(() => {
  getEpigeneticInterventions.mockResolvedValue({ interventions: {} });
  getEpigeneticCompliance.mockResolvedValue(null);
});
afterEach(cleanup);

describe('EpigeneticTracker recommendations load', () => {
  it('shows a retryable error — not an absent section — when recommendations fail, then lists them', async () => {
    getEpigeneticRecommendations.mockRejectedValueOnce(new Error('boom'));
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recommended interventions');
    expect(screen.queryByText(/Recommended Interventions/)).toBeNull();

    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [REC] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Recommended Interventions (1)')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('EpigeneticTracker tracked-list load (#17353)', () => {
  const TRACKED = { omega3: { id: 'omega3', name: 'Omega-3', category: 'supplement', active: true, logs: [] } };

  it('shows a retryable alert and no Start Tracking when the tracked read fails, then recovers', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [REC] });
    getEpigeneticInterventions.mockRejectedValueOnce(new Error('down'));
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tracked interventions');
    expect(screen.queryByText(/Recommended Interventions/)).toBeNull();

    getEpigeneticInterventions.mockResolvedValue({ interventions: TRACKED });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Tracking (1)')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a previously shown tracked row when a later read fails', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
    getEpigeneticInterventions.mockResolvedValueOnce({ interventions: TRACKED });
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    await screen.findByText('Tracking (1)');

    getEpigeneticInterventions.mockRejectedValue(new Error('down'));
    fireEvent.click(screen.getByRole('button', { name: /Omega-3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tracked interventions');
    expect(screen.getByText('Tracking (1)')).toBeTruthy();
  });

  it('shows no alert for a successful empty list', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    await waitFor(() => expect(screen.getByText(/These recommendations are informational/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('EpigeneticTracker delete (#17354)', () => {
  const TRACKED = { omega3: { id: 'omega3', name: 'Omega-3', category: 'supplement', active: true, logs: [] } };
  const openAndConfirmDelete = async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
    getEpigeneticInterventions.mockResolvedValue({ interventions: TRACKED });
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    await screen.findByText('Tracking (1)');
    fireEvent.click(screen.getByRole('button', { name: /Omega-3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  };

  beforeEach(() => { toast.success.mockClear(); deleteEpigeneticIntervention.mockReset(); });

  it('does not toast success when the delete rejects, and keeps the row', async () => {
    deleteEpigeneticIntervention.mockRejectedValueOnce(new Error('boom'));
    await openAndConfirmDelete();
    await waitFor(() => expect(deleteEpigeneticIntervention).toHaveBeenCalledWith('omega3'));
    await new Promise(r => setTimeout(r, 0));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Tracking (1)')).toBeTruthy();
  });

  it('toasts success and refetches when a 204 delete resolves null', async () => {
    deleteEpigeneticIntervention.mockResolvedValueOnce(null);
    await openAndConfirmDelete();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Removed Omega-3'));
  });
});

it('shows and announces Paused only on paused interventions', async () => {
  getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
  getEpigeneticInterventions.mockResolvedValue({ interventions: {
    a: { name: 'Intervention A', active: false },
    b: { name: 'Intervention B', active: true },
  } });
  render(<EpigeneticTracker markerCategories={CATEGORIES} />);

  expect(await screen.findByRole('button', { name: 'Intervention A Paused' })).toBeInTheDocument();
  expect(screen.getByText('Paused')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Intervention B' })).toBeInTheDocument();
});
