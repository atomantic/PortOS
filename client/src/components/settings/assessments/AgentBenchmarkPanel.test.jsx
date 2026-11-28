import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentBenchmarkPanel from './AgentBenchmarkPanel';

const { cancelOpenCodeAgentBenchmark, getMtplxServerStatus, runOpenCodeAgentBenchmark } = vi.hoisted(() => ({
  cancelOpenCodeAgentBenchmark: vi.fn(),
  getMtplxServerStatus: vi.fn(),
  runOpenCodeAgentBenchmark: vi.fn(),
}));

vi.mock('../../../services/apiLocalLlm.js', () => ({ cancelOpenCodeAgentBenchmark, getMtplxServerStatus, runOpenCodeAgentBenchmark }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const renderPanel = () => render(<MemoryRouter><AgentBenchmarkPanel active /></MemoryRouter>);

describe('AgentBenchmarkPanel', () => {
  beforeEach(() => {
    getMtplxServerStatus.mockReset().mockResolvedValue({ supported: true, cachedModelRows: [], cacheError: null });
    runOpenCodeAgentBenchmark.mockReset();
    cancelOpenCodeAgentBenchmark.mockReset();
  });

  it('does not prompt for MTPLX checkpoints when the host is unsupported', async () => {
    getMtplxServerStatus.mockResolvedValue({ supported: false, cachedModelRows: [], cacheError: null });
    renderPanel();

    await waitFor(() => expect(screen.queryByText(/Add a complete checkpoint/)).not.toBeInTheDocument());
  });

  it('shows Running only on the active target while disabling siblings', async () => {
    let finish;
    runOpenCodeAgentBenchmark.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Run task check' });
    fireEvent.click(buttons[0]);

    await screen.findByRole('button', { name: 'Running…' });
    expect(screen.getAllByRole('button', { name: 'Run task check' }).every((button) => button.disabled)).toBe(true);
    finish({ completed: false, error: 'stopped' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Run task check' }).every((button) => !button.disabled)).toBe(true));
  });

  it('cancels the active task and keeps its previous result', async () => {
    runOpenCodeAgentBenchmark.mockResolvedValueOnce({ completed: true, elapsedMs: 42 });
    const { promise: run, resolve: finish } = Promise.withResolvers();
    runOpenCodeAgentBenchmark.mockReturnValueOnce(run);
    cancelOpenCodeAgentBenchmark.mockImplementationOnce(async () => {
      finish({ cancelled: true, completed: false });
      return { cancelled: true };
    });

    renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Run task check' })[0]);
    await screen.findByText('sentinel complete');
    fireEvent.click(screen.getAllByRole('button', { name: 'Run task check' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task check' }));

    expect(cancelOpenCodeAgentBenchmark).toHaveBeenCalledExactlyOnceWith({ silent: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel task check' })).not.toBeInTheDocument());
    expect(screen.getByText('sentinel complete')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Run task check' })[0]).toBeEnabled();
  });
});
