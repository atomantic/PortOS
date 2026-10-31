import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getIdentityStatus: vi.fn(),
  getChronotype: vi.fn(),
  getLongevity: vi.fn(),
  getTasteProfile: vi.fn(),
  getGoals: vi.fn(),
  getCrossInsights: vi.fn(),
  deriveChronotype: vi.fn(),
  deriveLongevity: vi.fn(),
}));

import * as api from '../../../services/api';
import IdentityTab from './IdentityTab';

const renderTab = () => render(<MemoryRouter><IdentityTab /></MemoryRouter>);

describe('IdentityTab load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getIdentityStatus.mockResolvedValue({ sections: { genome: { status: 'active' }, goals: { status: 'active' } } });
    api.getChronotype.mockResolvedValue(null);
    api.getLongevity.mockResolvedValue(null);
    api.getTasteProfile.mockResolvedValue(null);
    api.getGoals.mockResolvedValue({ goals: [] });
    api.getCrossInsights.mockResolvedValue(null);
  });

  it('reports failed reads with Retry instead of "0/5 sections active" and setup prompts', async () => {
    api.getIdentityStatus.mockRejectedValueOnce(new Error('offline'));
    api.getGoals.mockRejectedValueOnce(new Error('offline'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load identity status, goals/);
    expect(screen.queryByText(/sections active/)).toBeNull();
    expect(screen.queryByText(/No goals set yet/)).toBeNull();
    expect(screen.getByText('Could not load goals.')).toBeInTheDocument();
    expect(api.getIdentityStatus).toHaveBeenCalledWith({ silent: true });

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
