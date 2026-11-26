import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addServiceCredentialPoolKey,
  getServiceCredentialPool,
  removeServiceCredentialPoolKey,
  resetServiceCredentialPoolCooldowns,
  updateServiceCredentialPool,
  updateServiceCredentialPoolKey,
} from '../../services/apiProviders.js';
import ProviderCredentialPool from './ProviderCredentialPool';

vi.mock('../../services/apiProviders.js', () => ({
  addServiceCredentialPoolKey: vi.fn(),
  getServiceCredentialPool: vi.fn(),
  removeServiceCredentialPoolKey: vi.fn(),
  resetServiceCredentialPoolCooldowns: vi.fn(),
  updateServiceCredentialPool: vi.fn(),
  updateServiceCredentialPoolKey: vi.fn(),
}));
vi.mock('../ui/Toast');

const SERVICE = { id: 'service-id', slug: 'example-service', definition: { envVars: ['EXAMPLE_API_KEY'] } };
const PRIMARY = { id: 'primary', source: 'stored', label: 'Primary key', fingerprint: '••••1234', enabled: true, cooledModels: [], uses: 0 };
const BACKUP = { ...PRIMARY, id: 'key-2', label: 'Backup key', fingerprint: '••••5678' };
const ENV_KEY = { ...BACKUP, id: 'key-3', source: 'env', envVar: 'EXAMPLE_API_KEY_BACKUP', fingerprint: '••••9999' };

function pool(entries = [PRIMARY, BACKUP], overrides = {}) {
  return { entries, strategy: 'fill_first', active: entries.length > 1, revision: 4, ...overrides };
}

async function renderPool(snapshot = pool()) {
  getServiceCredentialPool.mockResolvedValue(snapshot);
  const onRevision = vi.fn();
  render(<ProviderCredentialPool service={SERVICE} onRevision={onRevision} />);
  await screen.findByRole('region', { name: /Credential pool/ });
  return onRevision;
}

const moveBackupUp = () => screen.getByRole('button', { name: 'Move Backup key ••••5678 up' });
const backupRow = () => within(screen.getAllByRole('listitem').find((item) => within(item).queryByText('Backup key')));

describe('ProviderCredentialPool', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads the service pool and applies the strategy and revision returned from a change', async () => {
    const onRevision = await renderPool();
    const strategy = screen.getByRole('combobox', { name: 'Strategy' });
    expect(strategy).toHaveValue('fill_first');
    expect(getServiceCredentialPool).toHaveBeenCalledWith(SERVICE.slug, { silent: true });
    updateServiceCredentialPool.mockResolvedValue(pool(undefined, { strategy: 'round_robin', revision: 5 }));

    fireEvent.change(strategy, { target: { value: 'round_robin' } });

    await waitFor(() => expect(onRevision).toHaveBeenCalledExactlyOnceWith(5));
    expect(updateServiceCredentialPool).toHaveBeenCalledWith(SERVICE.slug, { strategy: 'round_robin' });
    expect(strategy).toHaveValue('round_robin');
  });

  it('adds a stored key and displays only its masked fingerprint after saving', async () => {
    await renderPool(pool([PRIMARY]));
    addServiceCredentialPoolKey.mockResolvedValue(pool());
    const keyInput = screen.getByLabelText('Additional key');
    const label = screen.getByRole('textbox', { name: 'Label (optional)' });
    const add = screen.getByRole('button', { name: 'Add to pool' });
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(add).toBeDisabled();
    fireEvent.change(keyInput, { target: { value: '  example-key-5678  ' } });
    fireEvent.change(label, { target: { value: '  Backup key  ' } });
    fireEvent.click(add);

    expect(await screen.findByText('••••5678')).toBeVisible();
    expect(addServiceCredentialPoolKey).toHaveBeenCalledWith(SERVICE.slug, { apiKey: 'example-key-5678', label: 'Backup key' });
    expect(screen.queryByText(/example-key-5678/)).not.toBeInTheDocument();
    expect(keyInput).toHaveValue('');
    expect(label).toHaveValue('');
  });

  it('adds an environment reference without sending a previously entered stored key', async () => {
    await renderPool();
    addServiceCredentialPoolKey.mockResolvedValue(pool([PRIMARY, BACKUP, ENV_KEY]));
    fireEvent.change(screen.getByLabelText('Additional key'), { target: { value: 'example-key-5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reference an env variable' }));
    expect(screen.queryByLabelText('Additional key')).not.toBeInTheDocument();

    const variable = screen.getByRole('textbox', { name: 'Env variable' });
    const add = screen.getByRole('button', { name: 'Add to pool' });
    fireEvent.change(variable, { target: { value: 'example-key' } });
    expect(add).toBeDisabled();
    fireEvent.change(variable, { target: { value: 'example_api_key_backup' } });
    expect(variable).toHaveValue('EXAMPLE_API_KEY_BACKUP');
    fireEvent.click(add);

    expect(await screen.findByText('EXAMPLE_API_KEY_BACKUP')).toBeVisible();
    expect(addServiceCredentialPoolKey).toHaveBeenCalledWith(SERVICE.slug, { envVar: 'EXAMPLE_API_KEY_BACKUP' });
    expect(screen.queryByText('••••9999')).not.toBeInTheDocument();
  });

  it('persists the full reordered priority list and disables movement past either boundary', async () => {
    await renderPool();
    updateServiceCredentialPool.mockResolvedValue(pool([BACKUP, PRIMARY]));
    expect(screen.getByRole('button', { name: 'Move Primary key ••••1234 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Backup key ••••5678 down' })).toBeDisabled();
    fireEvent.click(moveBackupUp());

    await waitFor(() => expect(moveBackupUp()).toBeDisabled());
    expect(updateServiceCredentialPool).toHaveBeenCalledWith(SERVICE.slug, { order: [BACKUP.id, PRIMARY.id] });
    expect(within(screen.getAllByRole('listitem')[0]).getByText('Backup key')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move Primary key ••••1234 down' })).toBeDisabled();
  });

  it('turns an extra key off and back on using the returned status', async () => {
    await renderPool();
    updateServiceCredentialPoolKey
      .mockResolvedValueOnce(pool([PRIMARY, { ...BACKUP, enabled: false, withheld: 'disabled' }]))
      .mockResolvedValueOnce(pool());
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    const turnOff = screen.getByRole('switch', { name: 'Turn off Backup key ••••5678' });
    expect(turnOff).toBeChecked();
    fireEvent.click(turnOff);

    const turnOn = await screen.findByRole('switch', { name: 'Turn on Backup key ••••5678' });
    expect(turnOn).not.toBeChecked();
    fireEvent.click(turnOn);

    expect(await screen.findByRole('switch', { name: 'Turn off Backup key ••••5678' })).toBeChecked();
    expect(updateServiceCredentialPoolKey).toHaveBeenNthCalledWith(1, SERVICE.slug, BACKUP.id, { enabled: false });
    expect(updateServiceCredentialPoolKey).toHaveBeenNthCalledWith(2, SERVICE.slug, BACKUP.id, { enabled: true });
  });

  it('explicitly rebinds a stored key withheld after the service endpoint moves', async () => {
    await renderPool(pool([PRIMARY, { ...BACKUP, withheld: 'origin-mismatch', boundOrigin: 'https://old.example.com' }]));
    updateServiceCredentialPoolKey.mockResolvedValue(pool());

    expect(backupRow().getByText('Withheld: endpoint moved')).toBeVisible();
    expect(backupRow().getByText(/Added for https:\/\/old\.example\.com/)).toBeVisible();
    expect(backupRow().queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(backupRow().getByRole('button', { name: 'Re-bind to current endpoint' }));

    expect(await backupRow().findByText('Ready')).toBeVisible();
    expect(updateServiceCredentialPoolKey).toHaveBeenCalledWith(SERVICE.slug, BACKUP.id, { rebindOrigin: true });
    expect(backupRow().queryByText(/Withheld/)).not.toBeInTheDocument();
  });

  it('clears one key cooldown independently before clearing the whole pool', async () => {
    const dead = { ...PRIMARY, dead: true };
    const cooling = { ...BACKUP, cooledModels: [{ model: 'example-model', until: Date.UTC(2026, 0, 1) }] };
    await renderPool(pool([dead, cooling]));
    resetServiceCredentialPoolCooldowns.mockResolvedValueOnce(pool([dead, BACKUP])).mockResolvedValueOnce(pool());

    expect(backupRow().getByText(/Cooling per model: example-model/)).toBeVisible();
    fireEvent.click(backupRow().getByRole('button', { name: 'Reset cooldown' }));
    await waitFor(() => expect(backupRow().queryByText(/Cooling per model/)).not.toBeInTheDocument());
    expect(resetServiceCredentialPoolCooldowns).toHaveBeenNthCalledWith(1, SERVICE.slug, { credentialId: BACKUP.id });
    expect(screen.getByText(/Rejected/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Reset all cooldowns' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset all cooldowns' })).not.toBeInTheDocument());
    expect(resetServiceCredentialPoolCooldowns).toHaveBeenNthCalledWith(2, SERVICE.slug);
    expect(screen.queryByText(/Rejected/)).not.toBeInTheDocument();
  });

  it('keeps the key when inline removal is canceled and removes it only on confirmation', async () => {
    await renderPool();
    removeServiceCredentialPoolKey.mockResolvedValue(pool([PRIMARY]));
    const remove = () => backupRow().getByRole('button', { name: 'Remove' });
    const confirmation = () => within(backupRow().getByRole('group', { name: 'Confirm removing Backup key ••••5678' }));

    fireEvent.click(remove());
    expect(confirmation().getByText('Remove Backup key ••••5678 from the pool?')).toBeVisible();
    expect(removeServiceCredentialPoolKey).not.toHaveBeenCalled();
    fireEvent.click(confirmation().getByRole('button', { name: 'Cancel' }));
    expect(removeServiceCredentialPoolKey).not.toHaveBeenCalled();
    expect(screen.getByText('Backup key')).toBeVisible();

    fireEvent.click(remove());
    fireEvent.click(confirmation().getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(screen.queryByText('Backup key')).not.toBeInTheDocument());
    expect(removeServiceCredentialPoolKey).toHaveBeenCalledExactlyOnceWith(SERVICE.slug, BACKUP.id);
    expect(screen.getByRole('region', { name: 'Credential pool (1 key)' })).toBeVisible();
  });
});
