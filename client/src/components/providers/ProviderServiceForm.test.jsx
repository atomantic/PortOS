import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getProviderServiceDefinitions: vi.fn(),
  createProviderService: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import ProviderServiceForm from './ProviderServiceForm';

const DEFINITION = {
  id: 'lmstudio', label: 'LM Studio', family: 'local', plans: ['local'], envVars: [], transports: { openai: { defaultBaseUrl: null } },
};

describe('ProviderServiceForm definitions read', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a retryable error rather than an empty service list when the read fails', async () => {
    api.getProviderServiceDefinitions.mockRejectedValueOnce(new Error('server down'));
    api.getProviderServiceDefinitions.mockResolvedValue({ definitions: [DEFINITION] });
    render(<ProviderServiceForm onClose={() => {}} onCreated={() => {}} />);

    expect(await screen.findByText(/Could not load the service definitions/)).toBeInTheDocument();
    expect(screen.queryByText(/declares no service definitions/)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'LM Studio' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'LM Studio' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getProviderServiceDefinitions).toHaveBeenCalledWith({ silent: true });
  });
});
