import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModelPersonalityHistory: vi.fn(),
  getModelPersonalitySettings: vi.fn(),
  deleteModelPersonalityResult: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../../../services/apiModelPersonality.js', () => ({
  getModelPersonalityHistory: api.getModelPersonalityHistory,
  getModelPersonalitySettings: api.getModelPersonalitySettings,
  deleteModelPersonalityResult: api.deleteModelPersonalityResult,
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useChartColors.js', () => ({ default: () => ({}) }));

import PersonalityTab from './PersonalityTab.jsx';

const RUN = { runId: 'run-1', providerId: 'p1', model: 'model-a', timestamp: '2026-01-01T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviders.mockResolvedValue({ providers: [] });
  api.getModelPersonalityHistory.mockResolvedValue([RUN]);
  api.getModelPersonalitySettings.mockResolvedValue({ historyCap: 100, defaultIncludeAlignment: true });
});

describe('PersonalityTab Past Runs delete confirmation', () => {
  it('does not delete on the trash click; Cancel keeps the run', async () => {
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete model-a/ }));

    expect(api.deleteModelPersonalityResult).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this personality run? This cannot be undone.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Delete this personality run/)).not.toBeInTheDocument();
    expect(api.deleteModelPersonalityResult).not.toHaveBeenCalled();
  });

  it('deletes once on "Delete Run" and removes the row', async () => {
    api.deleteModelPersonalityResult.mockResolvedValue({});
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete model-a/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Run' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^Delete model-a/ })).not.toBeInTheDocument());
    expect(api.deleteModelPersonalityResult).toHaveBeenCalledTimes(1);
    expect(api.deleteModelPersonalityResult).toHaveBeenCalledWith('run-1');
  });
});
