import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  previewPersistentMindBundle: vi.fn(),
  applyPersistentMindBundle: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const PersistentMindImportPanel = (await import('./PersistentMindImportPanel.jsx')).default;

const PASSPHRASE = 'an example bundle passphrase';
const BUNDLE_TEXT = 'portos-mind-bundle/1\n{}\nAAAA\nBBBB\n';

// An obviously-fake preview. Never a record read out of a live install.
const PREVIEW = {
  createdAt: '2026-09-18T14:05:06.789Z',
  scopes: ['profile', 'memories'],
  groups: [
    {
      group: 'identity',
      scope: 'profile',
      additive: false,
      identical: false,
      incoming: { chosenName: 'Other Example Mind' },
      current: { chosenName: 'Example Mind' },
    },
    {
      group: 'memories',
      scope: 'memories',
      additive: true,
      identical: false,
      incoming: { total: 3, importable: 2, alreadyHere: 1, memories: [] },
      current: { protectedCount: 4 },
    },
  ],
};

const bundleFile = () => new File([BUNDLE_TEXT], 'example.portos-mind', { type: 'text/plain' });

const openBundle = async (user) => {
  await user.upload(screen.getByLabelText('Bundle file'), bundleFile());
  await user.type(screen.getByLabelText('Bundle passphrase'), PASSPHRASE);
  await user.click(screen.getByRole('button', { name: /Open bundle/ }));
  await screen.findByRole('button', { name: /Apply these choices/ });
};

beforeEach(() => {
  vi.clearAllMocks();
  api.previewPersistentMindBundle.mockResolvedValue(PREVIEW);
  api.applyPersistentMindBundle.mockResolvedValue({ applied: ['identity'], kept: ['memories'], memories: { imported: 0, skipped: 0 } });
});

describe('PersistentMindImportPanel', () => {
  it('keeps the open action disabled until a file and a long-enough passphrase exist', async () => {
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);
    const open = screen.getByRole('button', { name: /Open bundle/ });
    expect(open).toBeDisabled();

    await user.upload(screen.getByLabelText('Bundle file'), bundleFile());
    await waitFor(() => expect(screen.getByText(/Ready: example\.portos-mind/)).toBeInTheDocument());
    expect(open).toBeDisabled();

    await user.type(screen.getByLabelText('Bundle passphrase'), 'too short');
    expect(open).toBeDisabled();

    await user.clear(screen.getByLabelText('Bundle passphrase'));
    await user.type(screen.getByLabelText('Bundle passphrase'), PASSPHRASE);
    expect(open).toBeEnabled();
  });

  it('defaults every group to keep-mine, so a confirm with no choices cannot overwrite anything', async () => {
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);
    await openBundle(user);

    expect(screen.getByRole('radio', { name: /Keep mine/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Use imported/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Skip them/ })).toBeChecked();
    // Nothing to apply means the confirm is unavailable, not a silent no-op.
    expect(screen.getByRole('button', { name: /Apply these choices/ })).toBeDisabled();
    expect(api.applyPersistentMindBundle).not.toHaveBeenCalled();
  });

  it('sends exactly the per-group choices the user made', async () => {
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);
    await openBundle(user);

    await user.click(screen.getByRole('radio', { name: /Use imported/ }));
    await user.click(screen.getByRole('button', { name: /Apply these choices/ }));

    await waitFor(() => expect(api.applyPersistentMindBundle).toHaveBeenCalledWith({
      bundle: BUNDLE_TEXT,
      passphrase: PASSPHRASE,
      choices: { identity: 'use-imported', memories: 'keep-mine' },
    }));
    expect(await screen.findByText(/Used the imported identity/)).toBeInTheDocument();
  });

  it('reports skipped memories even when nothing new was added', async () => {
    api.applyPersistentMindBundle.mockResolvedValue({ applied: ['memories'], kept: [], memories: { imported: 0, skipped: 3 } });
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);
    await openBundle(user);

    await user.click(screen.getByRole('radio', { name: /Import them/ }));
    await user.click(screen.getByRole('button', { name: /Apply these choices/ }));

    // An all-duplicate import adds nothing; saying only "used the imported
    // memories" would read as though records had arrived.
    expect(await screen.findByText(/3 were already here and were skipped/)).toBeInTheDocument();
  });

  it('discards the open preview when the passphrase changes, so a confirm cannot apply a stale one', async () => {
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);
    await openBundle(user);

    await user.type(screen.getByLabelText('Bundle passphrase'), 'x');
    expect(screen.queryByRole('button', { name: /Apply these choices/ })).not.toBeInTheDocument();
  });

  it('shows the server refusal instead of a generic failure, and offers nothing to apply', async () => {
    api.previewPersistentMindBundle.mockRejectedValue(new Error('Mind bundle container version 99 is not supported by this install (expected 1)'));
    const user = userEvent.setup();
    render(<PersistentMindImportPanel />);

    await user.upload(screen.getByLabelText('Bundle file'), bundleFile());
    await user.type(screen.getByLabelText('Bundle passphrase'), PASSPHRASE);
    await user.click(screen.getByRole('button', { name: /Open bundle/ }));

    expect(await screen.findByText(/container version 99 is not supported/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply these choices/ })).not.toBeInTheDocument();
  });
});
