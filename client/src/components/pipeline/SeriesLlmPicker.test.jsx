import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getProviders: vi.fn(),
  updatePipelineSeries: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));

import { getProviders, updatePipelineSeries } from '../../services/api';
import SeriesLlmPicker from './SeriesLlmPicker';

const PROVIDERS = [
  { id: 'p1', name: 'Provider One', models: ['m1', 'm2'] },
  { id: 'p2', name: 'Provider Two', models: ['m3'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue({ providers: PROVIDERS, activeProvider: 'p2' });
  updatePipelineSeries.mockResolvedValue({ id: 's1', llm: { provider: 'p1', model: null } });
});

const renderPicker = (series = { id: 's1', llm: undefined }, onSeriesUpdate = vi.fn()) =>
  render(<SeriesLlmPicker series={series} onSeriesUpdate={onSeriesUpdate} />);

describe('SeriesLlmPicker', () => {
  it('shows the active-provider fallback option labeled with the active provider name', async () => {
    renderPicker();
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    const providerSelect = screen.getAllByRole('combobox')[0];
    const firstOption = providerSelect.querySelector('option');
    expect(firstOption.value).toBe('');
    expect(firstOption.textContent).toBe('Active provider (Provider Two)');
    // unset series.llm.provider binds to the empty option, not the active provider
    expect(providerSelect.value).toBe('');
  });

  it('always renders the model select with a "Default model" sentinel', async () => {
    renderPicker();
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    const modelSelect = screen.getAllByRole('combobox')[1];
    expect(modelSelect.querySelector('option').textContent).toBe('Default model');
  });

  it('saves { provider, model: null } and propagates the updated series on provider change', async () => {
    const onSeriesUpdate = vi.fn();
    renderPicker({ id: 's1', llm: undefined }, onSeriesUpdate);
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    // Wait for the provider option to render before selecting it (its options
    // come from the async getProviders result — same populate race as above).
    await screen.findByRole('option', { name: 'Provider One' });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'p1' } });
    await waitFor(() => expect(updatePipelineSeries).toHaveBeenCalledWith('s1', { llm: { provider: 'p1', model: null } }, { silent: true }));
    await waitFor(() => expect(onSeriesUpdate).toHaveBeenCalledWith({ id: 's1', llm: { provider: 'p1', model: null } }));
  });

  it('clears the provider (null) when the active-provider option is chosen', async () => {
    renderPicker({ id: 's1', llm: { provider: 'p1', model: 'm1' } });
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '' } });
    await waitFor(() => expect(updatePipelineSeries).toHaveBeenCalledWith('s1', { llm: { provider: null, model: null } }, { silent: true }));
  });

  it('disables the model select when the resolved provider has no models', async () => {
    getProviders.mockResolvedValue({ providers: [{ id: 'p3', name: 'No Models', models: [] }], activeProvider: 'p3' });
    renderPicker();
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    expect(screen.getAllByRole('combobox')[1]).toBeDisabled();
  });

  it('preserves the chosen provider when only the model changes', async () => {
    renderPicker({ id: 's1', llm: { provider: 'p1', model: '' } });
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    // The model <select>'s options are populated from the async getProviders
    // result. Wait for the target option to actually exist before changing the
    // value — firing the change before the provider's models render leaves the
    // picker mid-populate and saves the wrong (empty) provider (flaky in CI).
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'm2' } });
    await waitFor(() => expect(updatePipelineSeries).toHaveBeenCalledWith('s1', { llm: { provider: 'p1', model: 'm2' } }, { silent: true }));
  });
});
