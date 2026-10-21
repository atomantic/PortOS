import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getDigitalTwinEnrichProgress: vi.fn(),
  getProviders: vi.fn(),
  analyzeWritingSamples: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));
vi.mock('../ListEnrichment', () => ({ default: () => null }));

import * as api from '../../../services/api';
import EnrichTab from './EnrichTab';

describe('EnrichTab provider list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinEnrichProgress.mockResolvedValue({ categories: {} });
  });

  it('shows an error with Retry instead of an empty picker when the provider list fails', async () => {
    api.getProviders
      .mockRejectedValueOnce(new Error('providers down'))
      .mockResolvedValueOnce({ providers: [{ id: 'example', enabled: true, defaultModel: 'm' }] });
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Analyze Your Writing/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    expect(screen.queryByTestId('picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('picker')).toHaveTextContent('example'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
