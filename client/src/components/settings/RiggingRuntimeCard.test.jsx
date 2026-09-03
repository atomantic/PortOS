import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({ getRiggingReadiness: vi.fn() }));
vi.mock('../../services/api', () => mock);

const copyToClipboard = vi.hoisted(() => vi.fn());
vi.mock('../../lib/clipboard.js', () => ({ copyToClipboard }));

import RiggingRuntimeCard from './RiggingRuntimeCard';

const READY = {
  ready: true,
  reason: null,
  detail: 'bpy 4.2.0 imports from /opt/conda/envs/rigging/bin/python.',
  interpreter: '/opt/conda/envs/rigging/bin/python',
  module: 'bpy',
  moduleVersion: '4.2.0',
  modulePin: 'bpy==4.2.0',
  installCommand: null,
};

const HALF_INSTALLED = {
  ready: false,
  reason: 'module-unimportable',
  detail: '/opt/conda/envs/rigging/bin/python exists, but importing bpy failed: ImportError: bad magic number.',
  interpreter: '/opt/conda/envs/rigging/bin/python',
  module: 'bpy',
  moduleVersion: null,
  modulePin: 'bpy==4.2.0',
  installCommand: 'conda create -y -n rigging python=3.11 && conda run -n rigging pip install "bpy==4.2.0"',
};

describe('RiggingRuntimeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getRiggingReadiness.mockResolvedValue(READY);
  });

  it('reports a ready runtime with its interpreter and module version, and offers no remedy', async () => {
    render(<RiggingRuntimeCard />);
    expect(await screen.findByText('Runtime installed')).toBeInTheDocument();
    expect(screen.getByText(READY.interpreter)).toBeInTheDocument();
    expect(screen.getByText('4.2.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
  });

  // The failure this lane exists to name: an env that resolves but cannot import.
  // Rendering it as ready would be the silent-success bug.
  it('names a half-installed runtime and prints the pinned install command', async () => {
    mock.getRiggingReadiness.mockResolvedValue(HALF_INSTALLED);
    render(<RiggingRuntimeCard />);

    expect(await screen.findByText('The rigging runtime is only half installed')).toBeInTheDocument();
    expect(screen.getByText(HALF_INSTALLED.detail)).toBeInTheDocument();
    // The version must read as unknown, never as an empty-but-fine value.
    expect(screen.getByText('Not reported (pinned to bpy==4.2.0)')).toBeInTheDocument();
    expect(screen.getByText(HALF_INSTALLED.installCommand)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(copyToClipboard).toHaveBeenCalledWith(HALF_INSTALLED.installCommand, 'Install command copied');
  });

  it('probes on mount without a refresh, and forces one only on an explicit recheck', async () => {
    render(<RiggingRuntimeCard />);
    await screen.findByText('Runtime installed');
    expect(mock.getRiggingReadiness).toHaveBeenCalledWith({ refresh: false, silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Recheck runtime' }));
    await waitFor(() => expect(mock.getRiggingReadiness).toHaveBeenCalledWith({ refresh: true, silent: true }));
  });

  it('reports a failed read inline rather than blanking the card', async () => {
    mock.getRiggingReadiness.mockRejectedValue(new Error('readiness unavailable'));
    render(<RiggingRuntimeCard />);
    expect(await screen.findByText('readiness unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
