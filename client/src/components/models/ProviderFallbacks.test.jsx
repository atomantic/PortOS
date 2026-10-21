import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getProviders: vi.fn(),
  getProviderFallbacks: vi.fn(),
  saveProviderFallbacks: vi.fn(),
}));

import * as api from '../../services/api';
import ProviderFallbacks from './ProviderFallbacks';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProviderFallbacks', () => {
  it('shows a failed read as a retryable error, never as "No fallback list yet"', async () => {
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getProviderFallbacks.mockRejectedValueOnce(new Error('boom'));
    api.getProviderFallbacks.mockResolvedValue({ entries: [] });
    render(<ProviderFallbacks />);

    expect(await screen.findByText(/Could not load the fallback list/)).toBeInTheDocument();
    expect(screen.queryByText('No fallback list yet.')).not.toBeInTheDocument();
    expect(api.getProviderFallbacks).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No fallback list yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load the fallback list/)).not.toBeInTheDocument();
  });
});
