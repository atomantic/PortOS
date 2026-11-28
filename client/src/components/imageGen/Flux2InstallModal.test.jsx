import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The SSE stream has its own suite; this pins that the FLUX.2 surface offers the
// shared install-failure investigation action (#5981) and only on failure.
vi.mock('../../hooks/useInstallStream', () => ({
  useInstallStream: vi.fn(),
}));
vi.mock('../../services/apiAgents.js', () => ({
  addCosTask: vi.fn(),
}));
vi.mock('../ui/Toast');

import { useInstallStream } from '../../hooks/useInstallStream';
import Flux2InstallModal from './Flux2InstallModal';

const streamState = (overrides = {}) => ({
  logs: [],
  currentStage: null,
  done: false,
  error: null,
  streamStarted: true,
  logsEndRef: { current: null },
  close: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// The server gates "already installed" on the selected model's pipeline class,
// so a modal that omits the id gets "nothing to do" for a runtime the banner
// just called unavailable.
describe('Flux2InstallModal install target', () => {
  it('scopes the install stream to the selected model', () => {
    useInstallStream.mockReturnValue(streamState());
    render(<Flux2InstallModal open onClose={vi.fn()} onComplete={vi.fn()} modelId="qwen-image-2.1" />);
    expect(useInstallStream).toHaveBeenCalledWith(
      '/api/image-gen/setup/flux2-install?modelId=qwen-image-2.1',
      expect.objectContaining({ enabled: true, method: 'POST', maxLogLines: 1000, flushMs: 100 }),
    );
  });
});

describe('Flux2InstallModal live progress', () => {
  it('renders five stages, marks the current step and highlights stage output', () => {
    useInstallStream.mockReturnValue(streamState({
      currentStage: 'install',
      logs: [{ kind: 'stage', text: 'Installing torch' }],
    }));

    render(<Flux2InstallModal open onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Installing FLUX.2 Runtime' })).toBeInTheDocument();
    for (const label of ['Detect Python', 'Create venv', 'Upgrade pip', 'Install packages', 'Verify']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Install packages').closest('[aria-current]')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('▸ Installing torch')).toBeInTheDocument();
  });

  it.each([null, 'verify'])('confirms before aborting a running install at stage %s', (currentStage) => {
    const state = streamState({ currentStage });
    const onClose = vi.fn();
    useInstallStream.mockReturnValue(state);
    render(<Flux2InstallModal open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close installer' }));
    expect(state.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    expect(state.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('Flux2InstallModal failure footer', () => {
  it('offers the investigation action once the install reports an error', () => {
    useInstallStream.mockReturnValue(streamState({
      error: 'pip install torch failed',
      currentStage: 'install',
      logs: [{ kind: 'error', text: 'pip install torch failed' }],
    }));
    render(<Flux2InstallModal open onClose={vi.fn()} onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeTruthy();
  });

  it('shows no investigation action on a successful install', () => {
    useInstallStream.mockReturnValue(streamState({ done: true, currentStage: 'verify' }));
    render(<Flux2InstallModal open onClose={vi.fn()} onComplete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^done$/i })).toBeTruthy();
    expect(useInstallStream).toHaveBeenCalledWith(
      '/api/image-gen/setup/flux2-install',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
