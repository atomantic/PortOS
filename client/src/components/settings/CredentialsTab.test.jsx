import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getCredentialInventory: vi.fn(),
}));

vi.mock('../../services/api', () => mock);

import CredentialsTab from './CredentialsTab';

const PAYLOAD = {
  headline: 'Most of PortOS works with no key at all.',
  credentials: [
    {
      id: 'huggingface',
      label: 'Hugging Face',
      unlocks: 'Authenticated model downloads.',
      tier: 'free',
      getUrl: 'https://huggingface.co/settings/tokens',
      configurePath: '/media/image?settings=1',
      feature: null,
      configured: true,
      source: 'settings',
      unavailableFeatures: [],
    },
    {
      id: 'jira',
      label: 'JIRA',
      unlocks: 'Sprint boards.',
      tier: 'metered',
      getUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      configurePath: '/devtools/jira',
      feature: 'jira',
      configured: false,
      source: 'none',
      unavailableFeatures: [{ id: 'jira', label: 'JIRA' }],
    },
  ],
};

describe('CredentialsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getCredentialInventory.mockResolvedValue(PAYLOAD);
  });

  it('renders presence and source, never a secret value, and links out to the existing tab', async () => {
    render(
      <MemoryRouter>
        <CredentialsTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Most of PortOS works with no key at all/)).toBeTruthy();
    expect(screen.getByText('Hugging Face')).toBeTruthy();
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Hugging Face settings' })).toHaveAttribute('href', '/media/image?settings=1');
    expect(screen.getByText('Currently unavailable: JIRA')).toBeTruthy();
    expect(screen.queryByText(/hf_/)).toBeNull();
    expect(JSON.stringify(PAYLOAD)).not.toMatch(/hf_this/);
  });

  it('renders verification failures as unknown instead of not configured', async () => {
    mock.getCredentialInventory.mockResolvedValue({
      headline: 'Credential status',
      credentials: [{
        id: 'github',
        label: 'GitHub',
        unlocks: 'Repositories',
        tier: 'free',
        configured: null,
        source: 'none',
        verification: 'unavailable',
        unavailableFeatures: [],
      }],
    });

    render(
      <MemoryRouter>
        <CredentialsTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Could not verify')).toBeInTheDocument();
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument();
  });
});
