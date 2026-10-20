import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModelPersonalityHistory: vi.fn(),
  getModelPersonalitySettings: vi.fn(),
  updateModelPersonalitySettings: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useChartColors.js', () => ({ default: () => ({}) }));

import PersonalityTab from './PersonalityTab.jsx';

describe('PersonalityTab settings load failure', () => {
  it('blocks Save Options after a failed settings read and shows stored values after Retry', async () => {
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getModelPersonalityHistory.mockResolvedValue([]);
    api.getModelPersonalitySettings.mockRejectedValueOnce(new Error('offline'));

    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));

    expect(screen.getByRole('button', { name: 'Save Options' })).toBeDisabled();
    expect(api.updateModelPersonalitySettings).not.toHaveBeenCalled();

    api.getModelPersonalitySettings.mockResolvedValue({ historyCap: 1000, defaultIncludeAlignment: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByLabelText('History cap')).toHaveValue(1000));
    expect(screen.getByRole('button', { name: 'Save Options' })).toBeEnabled();
  });
});
