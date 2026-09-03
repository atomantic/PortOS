import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// LocalSetupPanel consumes useInstallStream directly rather than through either
// install modal, so it needs its own coverage for the shared investigation
// action (#5981). The stream itself has its own suite.
vi.mock('../../hooks/useInstallStream.js', () => ({
  useInstallStream: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  checkImageGenSetup: vi.fn(),
  detectImageGenPython: vi.fn(),
  createImageGenVenv: vi.fn(),
  addCosTask: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

import { useInstallStream } from '../../hooks/useInstallStream.js';
import { checkImageGenSetup } from '../../services/api';
import LocalSetupPanel from './LocalSetupPanel';

const streamState = (overrides = {}) => ({
  logs: [],
  currentStage: null,
  done: false,
  error: null,
  streamStarted: false,
  logsEndRef: { current: null },
  close: vi.fn(),
  ...overrides,
});

const renderPanel = () => render(
  <LocalSetupPanel pythonPath="/usr/local/bin/python3" onPythonPathChange={vi.fn()} />,
);

beforeEach(() => {
  vi.clearAllMocks();
  checkImageGenSetup.mockResolvedValue({
    required: ['torch'],
    installed: [],
    missing: ['torch'],
    missingPip: ['torch'],
  });
});

describe('LocalSetupPanel install failure', () => {
  it('offers the investigation action when the pip install stream errors', async () => {
    useInstallStream.mockReturnValue(streamState({
      streamStarted: true,
      error: 'pip exited 1',
      currentStage: 'install',
      logs: [{ kind: 'error', text: 'pip exited 1' }],
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy());
  });

  it('shows no investigation action before an install has failed', async () => {
    useInstallStream.mockReturnValue(streamState());
    renderPanel();
    await waitFor(() => expect(screen.getByText(/install 1 missing package/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
  });
});
