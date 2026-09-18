import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ exportPersistentMindBundle: vi.fn() }));
vi.mock('../../services/api', () => api);

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/downloadBlob.js', () => ({ downloadBlob }));

const PersistentMindPortabilityPanel = (await import('./PersistentMindPortabilityPanel.jsx')).default;

const PASSPHRASE = 'an example bundle passphrase';

const fillPassphrase = async (user, value = PASSPHRASE) => {
  await user.type(screen.getByLabelText('Passphrase'), value);
  await user.type(screen.getByLabelText('Confirm passphrase'), value);
};

beforeEach(() => {
  vi.clearAllMocks();
  api.exportPersistentMindBundle.mockResolvedValue('portos-mind-bundle/1\n{}\nAAAA\nBBBB\n');
});

describe('PersistentMindPortabilityPanel', () => {
  it('defaults to profile + appearance, with protected memories opt-in', () => {
    render(<PersistentMindPortabilityPanel />);
    expect(screen.getByLabelText('Profile')).toBeChecked();
    expect(screen.getByLabelText('Appearance')).toBeChecked();
    expect(screen.getByLabelText('Protected memories')).not.toBeChecked();
  });

  it('keeps the download disabled until a confirmed passphrase is long enough', async () => {
    const user = userEvent.setup();
    render(<PersistentMindPortabilityPanel />);
    const button = screen.getByRole('button', { name: /Download sealed bundle/ });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Passphrase'), 'too short');
    await user.type(screen.getByLabelText('Confirm passphrase'), 'too short');
    expect(await screen.findByText(/shorter than 12 characters/)).toBeInTheDocument();
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText('Passphrase'));
    await user.clear(screen.getByLabelText('Confirm passphrase'));
    await user.type(screen.getByLabelText('Passphrase'), PASSPHRASE);
    await user.type(screen.getByLabelText('Confirm passphrase'), 'a different passphrase');
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('exports only the selected scopes and hands the bytes to the browser download', async () => {
    const user = userEvent.setup();
    render(<PersistentMindPortabilityPanel />);
    await user.click(screen.getByLabelText('Appearance'));
    await user.click(screen.getByLabelText('Protected memories'));
    await fillPassphrase(user);
    await user.click(screen.getByRole('button', { name: /Download sealed bundle/ }));

    await waitFor(() => expect(api.exportPersistentMindBundle).toHaveBeenCalledWith({
      scopes: ['profile', 'memories'],
      passphrase: PASSPHRASE,
    }));
    expect(downloadBlob).toHaveBeenCalledWith(
      'portos-mind-bundle/1\n{}\nAAAA\nBBBB\n',
      expect.stringMatching(/^portos-mind-.+\.portos-mind$/),
    );
    expect(await screen.findByText(/Bundle downloaded/)).toBeInTheDocument();
  });

  it('clears the passphrase fields once the bundle is sealed', async () => {
    const user = userEvent.setup();
    render(<PersistentMindPortabilityPanel />);
    await fillPassphrase(user);
    await user.click(screen.getByRole('button', { name: /Download sealed bundle/ }));

    await waitFor(() => expect(screen.getByLabelText('Passphrase')).toHaveValue(''));
    expect(screen.getByLabelText('Confirm passphrase')).toHaveValue('');
  });

  it('warns before a memories export that it quotes private conversation', async () => {
    const user = userEvent.setup();
    render(<PersistentMindPortabilityPanel />);
    expect(screen.queryByText(/quote things you told this Mind in private/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Protected memories'));
    expect(await screen.findByText(/quote things you told this Mind in private/)).toBeInTheDocument();
  });

  it('surfaces the server\'s named refusal inline, and downloads nothing', async () => {
    api.exportPersistentMindBundle.mockRejectedValue(new Error('Mind bundle export refused: could not read memories (memory backend is unavailable)'));
    const user = userEvent.setup();
    render(<PersistentMindPortabilityPanel />);
    await fillPassphrase(user);
    await user.click(screen.getByRole('button', { name: /Download sealed bundle/ }));

    expect(await screen.findByText(/could not read memories/)).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
