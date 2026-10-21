import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModelPersonalityHistory: vi.fn(),
  getModelPersonalitySettings: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useChartColors.js', () => ({ default: () => ({}) }));

import PersonalityTab from './PersonalityTab.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  api.getModelPersonalityHistory.mockResolvedValue([]);
  api.getModelPersonalitySettings.mockResolvedValue({ historyCap: 200, defaultIncludeAlignment: true });
});

describe('PersonalityTab provider list (#12783)', () => {
  it('shows a retryable error, not "No enabled AI providers", when the provider read fails', async () => {
    const user = userEvent.setup();
    api.getProviders
      .mockRejectedValueOnce(new Error('providers offline'))
      .mockResolvedValueOnce({ providers: [{ id: 'p1', name: 'Example Provider', enabled: true, models: ['alpha'], defaultModel: 'alpha' }] });
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load AI providers — providers offline');
    expect(screen.queryByText(/No enabled AI providers/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the "No enabled AI providers" copy for a genuinely empty list', async () => {
    api.getProviders.mockResolvedValue({ providers: [] });
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);

    expect(await screen.findByText(/No enabled AI providers/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
