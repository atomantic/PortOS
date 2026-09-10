import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMessageSelectors: vi.fn(),
  testMessageSelectors: vi.fn(),
  addCosTask: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
}));
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socket }));

const SyncTab = (await import('./SyncTab')).default;

const renderTab = () => render(<SyncTab accounts={[]} onRefresh={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.getMessageSelectors.mockResolvedValue({});
});

describe('SyncTab DOM selector test', () => {
  it('reports success with no investigate button when every selector matches', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'teams',
      status: 'ok',
      results: { messageItem: { selector: "[role='listitem']", matches: 8 } },
    });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[1]); // teams card

    await waitFor(() => expect(screen.getByText(/all selectors matched/i)).toBeTruthy());
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
  });

  it('reports failure and offers to queue an investigation agent', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'no-browser',
      results: {},
      error: 'Failed to open a browser tab — is portos-browser running?',
    });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]); // outlook card

    await waitFor(() => expect(screen.getByText(/no browser tab available/i)).toBeTruthy());
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy();
  });

  it('queues a CoS investigation task naming the failing provider and status', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'partial',
      results: { messageRow: { selector: "[role='listbox'] [role='option']", matches: 0 } },
    });
    api.addCosTask.mockResolvedValue({ id: 'task-1' });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]);
    await waitFor(() => expect(screen.getByText(/some selectors matched zero elements/i)).toBeTruthy());
    expect(screen.getByText(/messageRow: 0 matches/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledTimes(1));
    const [task, options] = api.addCosTask.mock.calls[0];
    expect(task.isInvestigation).toBe(true);
    expect(task.description).toMatch(/outlook/i);
    expect(task.prompt).toContain('partial');
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(screen.getByRole('button', { name: /agent queued/i })).toBeTruthy());
  });
});
