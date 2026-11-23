import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModelPersonalityHistory: vi.fn(),
  getModelPersonalitySettings: vi.fn(),
  updateModelPersonalitySettings: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../../../services/apiModelPersonality.js', () => ({
  getModelPersonalityHistory: api.getModelPersonalityHistory,
  getModelPersonalitySettings: api.getModelPersonalitySettings,
  updateModelPersonalitySettings: api.updateModelPersonalitySettings,
}));
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

describe('PersonalityTab Run gating on saved Options', () => {
  const setup = async () => {
    api.getProviders.mockResolvedValue({ providers: [{ id: 'example', name: 'Example', type: 'api', enabled: true, defaultModel: 'm1', models: ['m1'] }] });
    api.getModelPersonalityHistory.mockResolvedValue([]);
    api.getModelPersonalitySettings.mockResolvedValue({ historyCap: 200, defaultIncludeAlignment: true });
    render(<MemoryRouter><PersonalityTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => expect(screen.getByLabelText('History cap')).toHaveValue(200));
    // Select a model so the run button is otherwise enabled.
    const model = await screen.findByRole('button', { name: 'm1' });
    fireEvent.click(model);
    return screen.getByRole('button', { name: /Run Personality Test/ });
  };

  it('disables Run while Options are dirty, re-enables on Revert, and while the save is in flight', async () => {
    const run = await setup();
    expect(run).toBeEnabled();

    fireEvent.change(screen.getByLabelText('History cap'), { target: { value: '300' } });
    expect(run).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Save or revert/);

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('History cap')).toHaveValue(200);
    expect(run).toBeEnabled();

    fireEvent.change(screen.getByLabelText('History cap'), { target: { value: '300' } });
    let finish;
    api.updateModelPersonalitySettings.mockReturnValue(new Promise((res) => { finish = res; }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Options' }));
    expect(run).toBeDisabled();
    finish({ historyCap: 300, defaultIncludeAlignment: true });
    await waitFor(() => expect(run).toBeEnabled());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
