import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
  getProviderFallbacks: vi.fn(),
  saveProviderFallbacks: vi.fn(),
}));

import { getProviders, getProviderFallbacks } from '../../services/apiProviders.js';
import ProviderFallbacks from './ProviderFallbacks';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProviderFallbacks', () => {
  it('shows a failed read as a retryable error, never as "No fallback list yet"', async () => {
    getProviders.mockResolvedValue({ providers: [] });
    getProviderFallbacks.mockRejectedValueOnce(new Error('boom'));
    getProviderFallbacks.mockResolvedValue({ entries: [] });
    render(<ProviderFallbacks />);

    expect(await screen.findByText(/Could not load the fallback list/)).toBeInTheDocument();
    expect(screen.queryByText('No fallback list yet.')).not.toBeInTheDocument();
    expect(getProviderFallbacks).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No fallback list yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load the fallback list/)).not.toBeInTheDocument();
  });
});
