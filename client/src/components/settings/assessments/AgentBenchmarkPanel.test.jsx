import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentBenchmarkPanel from './AgentBenchmarkPanel';

const { getMtplxServerStatus, runOpenCodeAgentBenchmark } = vi.hoisted(() => ({
  getMtplxServerStatus: vi.fn(),
  runOpenCodeAgentBenchmark: vi.fn(),
}));

vi.mock('../../../services/apiLocalLlm.js', () => ({ getMtplxServerStatus, runOpenCodeAgentBenchmark }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), warning: vi.fn() } }));

const renderPanel = () => render(<MemoryRouter><AgentBenchmarkPanel active /></MemoryRouter>);

describe('AgentBenchmarkPanel', () => {
  beforeEach(() => {
    getMtplxServerStatus.mockReset().mockResolvedValue({ supported: true, cachedModelRows: [], cacheError: null });
    runOpenCodeAgentBenchmark.mockReset();
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
});
