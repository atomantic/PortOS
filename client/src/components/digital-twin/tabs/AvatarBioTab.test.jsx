import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getAvatarBio: vi.fn(),
  polishAvatarBio: vi.fn(),
}));
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: null, selectedModel: null, availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
  }),
}));
vi.mock('../../ProviderModelSelector', () => ({ default: () => null }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import AvatarBioTab from './AvatarBioTab';
import { getAvatarBio } from '../../../services/apiDigitalTwin.js';

const BIO = {
  combined: 'Combined bio',
  sections: { whoIAm: 'Identity text', howISpeak: 'Speech text', whatIKnow: 'Knowledge text' },
};

const renderTab = () => render(<MemoryRouter><AvatarBioTab /></MemoryRouter>);

describe('AvatarBioTab draft load failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAvatarBio.mockResolvedValue(BIO);
  });

  it('shows a retryable error in place of the Draft when the bio read fails', async () => {
    getAvatarBio.mockRejectedValueOnce(new Error('bio offline'));
    renderTab();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load avatar bio draft.*bio offline/i);
    expect(screen.queryByText('Draft')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Identity text')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
