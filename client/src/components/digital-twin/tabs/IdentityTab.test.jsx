import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiGoals.js', () => ({
  getIdentityStatus: vi.fn(),
  getChronotype: vi.fn(),
  getLongevity: vi.fn(),
  getGoals: vi.fn(),
  getCrossInsights: vi.fn(),
  deriveChronotype: vi.fn(),
  deriveLongevity: vi.fn(),
}));
vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getTasteProfile: vi.fn(),
}));

import {
  getIdentityStatus,
  getChronotype,
  getLongevity,
  getGoals,
  getCrossInsights,
} from '../../../services/apiGoals.js';
import { getTasteProfile } from '../../../services/apiDigitalTwin.js';
import IdentityTab from './IdentityTab';

const renderTab = () => render(<MemoryRouter><IdentityTab /></MemoryRouter>);

describe('IdentityTab load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIdentityStatus.mockResolvedValue({ sections: { genome: { status: 'active' }, goals: { status: 'active' } } });
    getChronotype.mockResolvedValue(null);
    getLongevity.mockResolvedValue(null);
    getTasteProfile.mockResolvedValue(null);
    getGoals.mockResolvedValue({ goals: [] });
    getCrossInsights.mockResolvedValue(null);
  });

  it('reports failed reads with Retry instead of "0/5 sections active" and setup prompts', async () => {
    getIdentityStatus.mockRejectedValueOnce(new Error('offline'));
    getGoals.mockRejectedValueOnce(new Error('offline'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load identity status, goals/);
    expect(screen.queryByText(/sections active/)).toBeNull();
    expect(screen.queryByText(/No goals set yet/)).toBeNull();
    expect(screen.getByText('Could not load goals.')).toBeInTheDocument();
    expect(getIdentityStatus).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2/5 sections active')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText(/No goals set yet/)).toBeInTheDocument();
  });

  it('keeps the setup copy when every read succeeds with nothing set up', async () => {
    renderTab();
    expect(await screen.findByText(/Derive your chronotype/)).toBeInTheDocument();
    expect(screen.getByText(/Complete the taste questionnaire/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
