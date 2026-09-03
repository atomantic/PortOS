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
  });
});
