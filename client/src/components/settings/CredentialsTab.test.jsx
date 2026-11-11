import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getCredentialInventory: vi.fn(),
  saveCredential: vi.fn(),
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

  it('orders the service cards alphabetically by name', async () => {
    mock.getCredentialInventory.mockResolvedValue({ ...PAYLOAD, credentials: [...PAYLOAD.credentials].reverse() });
    render(<MemoryRouter><CredentialsTab /></MemoryRouter>);
    await screen.findByText('JIRA');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Hugging Face', 'JIRA']);
  });

  it('lays credential cards out in a responsive two-column grid without a width clamp', async () => {
    const { container } = render(
      <MemoryRouter>
        <CredentialsTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Hugging Face')).toBeTruthy();
    const grid = container.querySelector('.grid.grid-cols-1.lg\\:grid-cols-2');
    expect(grid).toBeTruthy();
    expect(container.querySelector('.max-w-3xl')).toBeNull();
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

it('saves and clears a write-only key with immediate feedback and no displayed stored value', async () => {
  const row = { ...PAYLOAD.credentials[0], editable: true };
  mock.getCredentialInventory.mockResolvedValue({ ...PAYLOAD, credentials: [row] });
  mock.saveCredential.mockResolvedValue(row);
  render(<MemoryRouter><CredentialsTab /></MemoryRouter>);
  const input = await screen.findByLabelText('New Hugging Face key');
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'hf_example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  expect(screen.getByRole('status').textContent).toBe('Saving…');
  await waitFor(() => expect(input.value).toBe(''));
  expect(mock.saveCredential).toHaveBeenCalledWith('huggingface', 'hf_example', { silent: true });
  fireEvent.click(screen.getByRole('button', { name: 'Clear saved key' }));
  await waitFor(() => expect(mock.saveCredential).toHaveBeenCalledWith('huggingface', '', { silent: true }));
});

it('loads a downloaded key file into the write-only draft and saves its contents', async () => {
  const row = { ...PAYLOAD.credentials[0], id: 'example-cloud', label: 'Example Cloud', editable: true, keyFile: '.json' };
  mock.getCredentialInventory.mockResolvedValue({ ...PAYLOAD, credentials: [row] });
  mock.saveCredential.mockResolvedValue(row);
  render(<MemoryRouter><CredentialsTab /></MemoryRouter>);
  const input = await screen.findByLabelText('New Example Cloud key');
  const keyJson = '{"type":"service_account","project_id":"example-project"}';
  const file = new File([`${keyJson}\n`], 'example-key.json', { type: 'application/json' });
  fireEvent.change(document.getElementById('credential-example-cloud-file'), { target: { files: [file] } });
  await waitFor(() => expect(input.value).toBe(keyJson));
  expect(screen.getByRole('status').textContent).toMatch(/Loaded example-key\.json/);
  expect(screen.queryByText(/example-project/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  await waitFor(() => expect(mock.saveCredential).toHaveBeenCalledWith('example-cloud', keyJson, { silent: true }));
});
