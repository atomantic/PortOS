import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getTwinEvidence: vi.fn(),
  getProviders: vi.fn(),
  recomputeTwinEvidence: vi.fn(),
  interpretTwinConsumption: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('./TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));

import * as api from '../../services/api';
import ObservedTasteEvidence from './ObservedTasteEvidence';

const EVIDENCE = { taste: { windows: { month: {}, week: {} } } };
const PROVIDERS = { providers: [{ id: 'example', name: 'Example', enabled: true, defaultModel: 'm' }] };

describe('ObservedTasteEvidence failed reads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an error with Retry, not "No observed evidence yet", when the evidence read fails', async () => {
    api.getTwinEvidence.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(EVIDENCE);
    api.getProviders.mockResolvedValue(PROVIDERS);
    render(<ObservedTasteEvidence />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load observed evidence.*offline/i);
    expect(screen.queryByText(/No observed evidence yet/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByRole('button', { name: /What does this say about me/i })).toBeInTheDocument();
  });

  it('shows an error with Retry, not "No AI provider configured", when the provider list fails', async () => {
    api.getTwinEvidence.mockResolvedValue(EVIDENCE);
    api.getProviders.mockRejectedValueOnce(new Error('providers down')).mockResolvedValueOnce(PROVIDERS);
    render(<ObservedTasteEvidence />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    expect(screen.queryByText(/No AI provider configured/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('picker')).toHaveTextContent('example');
  });

  it('keeps the empty copy for a genuinely empty evidence profile and provider list', async () => {
    api.getTwinEvidence.mockResolvedValue({});
    api.getProviders.mockResolvedValue({ providers: [] });
    render(<ObservedTasteEvidence />);
    expect(await screen.findByText(/No observed evidence yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
