import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HarnessesTab from './HarnessesTab';

const getHarnesses = vi.fn();
const refreshHarnessModels = vi.fn();
vi.mock('../../services/api', () => ({
  getHarnesses: (...a) => getHarnesses(...a),
  refreshHarnessModels: (...a) => refreshHarnessModels(...a),
}));

// Stub the shared install modal — the real one opens a stream. Assert only the
// runtime and action it was opened with, which is the whole contract this page
// has with it.
vi.mock('../install/RuntimeInstallModal', () => ({
  default: ({ open, runtime, params, title, onComplete }) => (open ? (
    <div data-testid="install-modal">
      {title} · {runtime} · {params?.action}
      <button type="button" data-testid="complete" onClick={onComplete}>complete</button>
    </div>
  ) : null),
}));

const harness = (overrides = {}) => ({
  id: 'opencode',
  label: 'OpenCode CLI',
  command: 'opencode',
  installed: true,
  version: '1.18.27',
  latestVersion: '1.18.27',
  updateAvailable: false,
  updatable: true,
  removable: true,
  listsModels: true,
  installable: true,
  blockedReason: null,
  package: 'opencode-ai',
  docsUrl: 'https://example.invalid/docs',
  providers: [{ id: 'opencode-zen-cli', name: 'OpenCode Zen CLI', type: 'cli', enabled: true, usesHarnessCatalog: true }],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getHarnesses.mockResolvedValue({ harnesses: [harness()] });
});

describe('HarnessesTab', () => {
  it('shows the installed and latest versions', async () => {
    render(<HarnessesTab />);
    expect(await screen.findByText('OpenCode CLI')).toBeInTheDocument();
    expect(screen.getByText(/Installed 1\.18\.27/)).toBeInTheDocument();
    expect(screen.getByText(/Latest 1\.18\.27/)).toBeInTheDocument();
  });

  it('flags a stale install and still offers Update on a current one', async () => {
    getHarnesses.mockResolvedValue({ harnesses: [harness({ updateAvailable: true, latestVersion: '1.19.0' })] });
    render(<HarnessesTab />);
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update/ })).toBeInTheDocument();
  });

  // A version the banner could not parse must not read as "out of date" — the
  // row says what it knows and nothing more.
  it('says version unknown rather than implying staleness', async () => {
    getHarnesses.mockResolvedValue({ harnesses: [harness({ version: null, latestVersion: null })] });
    render(<HarnessesTab />);
    expect(await screen.findByText(/version unknown/)).toBeInTheDocument();
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
  });

  it('opens the shared stream modal with the chosen action', async () => {
    render(<HarnessesTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Update/ }));
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('opencode · update');
  });

  it('offers Install, not Update, when the harness is missing', async () => {
    getHarnesses.mockResolvedValue({ harnesses: [harness({ installed: false, version: null })] });
    render(<HarnessesTab />);
    expect(await screen.findByRole('button', { name: /Install/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refresh models/ })).not.toBeInTheDocument();
  });

  it('disables Install and explains why when the host cannot run one', async () => {
    getHarnesses.mockResolvedValue({ harnesses: [harness({
      installed: false, installable: false, blockedReason: 'npm is not on PortOS\'s PATH.',
    })] });
    render(<HarnessesTab />);
    expect(await screen.findByRole('button', { name: /Install/ })).toBeDisabled();
    expect(screen.getByText(/npm is not on PortOS/)).toBeInTheDocument();
  });

  // Removing a harness takes providers offline, so it asks first — inline, per
  // the no-`window.confirm` convention.
  it('confirms a removal inline before opening the stream', async () => {
    render(<HarnessesTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Remove/ }));
    expect(screen.queryByTestId('install-modal')).not.toBeInTheDocument();
    expect(screen.getByText(/1 provider use/)).toBeInTheDocument();

    // Two "Remove" buttons are on screen once the row opens (the trigger and the
    // confirm) — take the one inside the confirmation row.
    const [, confirm] = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(confirm);
    expect(await screen.findByTestId('install-modal')).toHaveTextContent('opencode · uninstall');
  });

  it('reports how many providers a model refresh updated, without re-reading the list', async () => {
    refreshHarnessModels.mockResolvedValue({ models: ['opencode/a', 'opencode/b'], updated: ['opencode-zen-cli'] });
    render(<HarnessesTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Refresh models/ }));

    expect(await screen.findByText(/2 models from opencode → 1 provider updated/)).toBeInTheDocument();
    // The refresh writes `models`/`defaultModel`; this page shows neither, so a
    // reload would spend a probe sweep to render identical rows.
    expect(getHarnesses).toHaveBeenCalledTimes(1);
  });

  it('re-reads the list after a lifecycle action, without forcing a registry read', async () => {
    render(<HarnessesTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Update/ }));
    fireEvent.click(screen.getByTestId('complete'));

    // `fresh` bypasses the npm-registry cache too, and clicking Update cannot
    // have changed what npm has published.
    await waitFor(() => expect(getHarnesses).toHaveBeenCalledTimes(2));
    expect(getHarnesses).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: false }));
    // The modal's terminal frame IS the result ("…is up to date (1.19.0)").
    // Unmounting it on completion makes a removal and a no-op update look
    // identical — a modal that blinks shut with nothing said.
    expect(screen.getByTestId('install-modal')).toBeInTheDocument();
  });

  it('renders a refusal reason verbatim instead of a generic failure', async () => {
    refreshHarnessModels.mockRejectedValue(new Error('Sign in to OpenCode CLI in a terminal.'));
    render(<HarnessesTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Refresh models/ }));

    expect(await screen.findByText('Sign in to OpenCode CLI in a terminal.')).toBeInTheDocument();
  });

  it('renders a load failure with a retry', async () => {
    getHarnesses.mockRejectedValue(new Error('Could not reach the server.'));
    render(<HarnessesTab />);
    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();

    getHarnesses.mockResolvedValue({ harnesses: [harness()] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('OpenCode CLI')).toBeInTheDocument();
  });
});
