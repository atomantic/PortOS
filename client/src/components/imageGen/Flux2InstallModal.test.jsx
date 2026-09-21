import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The SSE stream has its own suite; this pins that the FLUX.2 surface offers the
// shared install-failure investigation action (#5981) and only on failure.
vi.mock('../../hooks/useInstallStream', () => ({
  useInstallStream: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  addCosTask: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

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
      expect.objectContaining({ method: 'POST' }),
    );
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
