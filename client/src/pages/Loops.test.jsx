import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../services/apiLoops.js', () => ({
  getLoops: vi.fn(() => Promise.resolve([])),
  getLoopProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  createLoop: vi.fn(() => Promise.resolve({})),
  stopLoop: vi.fn(() => Promise.resolve({})),
  resumeLoop: vi.fn(() => Promise.resolve({})),
  deleteLoop: vi.fn(() => Promise.resolve({})),
  triggerLoop: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../services/socket', () => ({
  default: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../components/ui/Toast');

import Loops from './Loops';
import socket from '../services/socket';
import { createLoop, deleteLoop, getLoops, stopLoop } from '../services/apiLoops.js';
import toast from '../components/ui/Toast';

describe('Loops action feedback (#8621)', () => {
  const runningLoop = {
    id: 'loop-1', name: 'Example loop', isRunning: true, intervalMs: 60_000,
    currentIteration: 0, lastRun: null,
  };

  it('requires confirmation before deleting a loop and leaves its details collapsed', async () => {
    getLoops.mockResolvedValueOnce([runningLoop]);
    render(<Loops />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteLoop).not.toHaveBeenCalled();
    expect(screen.queryByText('Live Output')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteLoop).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteLoop).toHaveBeenCalledExactlyOnceWith('loop-1');
    expect(screen.queryByText('Live Output')).not.toBeInTheDocument();
  });

  it('does not report success when a rendered action request fails', async () => {
    getLoops.mockResolvedValueOnce([runningLoop]);
    stopLoop.mockRejectedValueOnce(new Error('Request failed'));
    toast.success.mockClear();
    render(<Loops />);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(stopLoop).toHaveBeenCalledWith('loop-1'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports success after a rendered action request resolves', async () => {
    getLoops.mockResolvedValueOnce([runningLoop]);
    stopLoop.mockResolvedValueOnce({});
    toast.success.mockClear();
    render(<Loops />);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Loop stopped'));
  });
});

describe('Loops reconnect resubscribe (#8110)', () => {
  // The server rebuilds an empty per-socket subscriber Set on every reconnect
  // (restart, self-update, sleep, a network blip). Without a reconnect-driven
  // re-subscribe, the live output and status streams went silent for the rest
  // of the tab's life after the first reconnect.
  it('re-subscribes loops:* and refetches the list on a socket reconnect', async () => {
    render(<Loops />);
    await screen.findByText('No loops yet');
    expect(socket.emit).toHaveBeenCalledWith('loops:subscribe');
    const getLoopsCalls = getLoops.mock.calls.length;

    const connectHandler = socket.on.mock.calls.find(([event]) => event === 'connect')?.[1];
    expect(connectHandler).toBeTypeOf('function');
    socket.emit.mockClear();
    await act(async () => connectHandler());

    expect(socket.emit).toHaveBeenCalledWith('loops:subscribe');
    await waitFor(() => expect(getLoops.mock.calls.length).toBeGreaterThan(getLoopsCalls));
  });
});

describe('Loops new-loop form label associations', () => {
  it('pairs the Interval label with the custom-interval input via explicit htmlFor/id', async () => {
    render(<Loops />);
    const input = await screen.findByLabelText('Interval');
    const label = screen.getByText('Interval');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('placeholder')).toBe('custom');
    // Prove the explicit htmlFor/id pairing (not merely an aria-label match).
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });
});

it('preserves the submitted prompt and prevents whitespace-only submissions', async () => {
  const user = userEvent.setup();
  render(<Loops />);
  const input = await screen.findByLabelText('Loop prompt');
  const start = screen.getByRole('button', { name: 'Start Loop' });

  await user.click(input);
  await user.paste('  \t\n');
  expect(start).toBeDisabled();
  await user.click(start);
  expect(createLoop).not.toHaveBeenCalled();

  const prompt = '    example\n\n';
  await user.clear(input);
  await user.paste(prompt);
  await user.click(start);
  expect(createLoop).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
});

describe('Loops index empty state', () => {
  it('offers a call to action that focuses the new-loop prompt', async () => {
    render(<Loops />);
    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Describe your first loop' });
    await userEvent.click(cta);
    expect(screen.getByLabelText('Loop prompt')).toHaveFocus();
  });
});

describe('Loops initial list loading', () => {
  it('keeps the create form hidden until the first list read succeeds', async () => {
    let resolveLoops;
    getLoops.mockReturnValueOnce(new Promise(resolve => { resolveLoops = resolve; }));
    render(<Loops />);

    expect(screen.getByText('Loading loops...')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loop prompt')).not.toBeInTheDocument();

    await act(async () => resolveLoops([]));
    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Loop prompt')).toBeInTheDocument();
  });

  it('shows a retryable error instead of inviting a new loop, then recovers on retry', async () => {
    getLoops.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce([]);
    toast.error.mockClear();
    render(<Loops />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load loops — Network unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No loops yet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Loop prompt')).not.toBeInTheDocument();
    expect(getLoops).toHaveBeenCalledWith({ silent: true });
    expect(toast.error).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Loop prompt')).toBeInTheDocument();
  });

  it('renders cards after a successful non-empty list load', async () => {
    getLoops.mockResolvedValueOnce([{
      id: 'loop-loaded', name: 'Loaded loop', isRunning: false, intervalMs: 60_000,
      currentIteration: 0, lastRun: null,
    }]);
    render(<Loops />);

    expect(await screen.findByText('Loaded loop')).toBeInTheDocument();
    expect(screen.queryByText('No loops yet')).not.toBeInTheDocument();
  });
});


describe('Loops refresh errors with retained data', () => {
  it('keeps the form and previously loaded list visible while showing a refresh error', async () => {
    getLoops.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Refresh failed'));
    render(<Loops />);

    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Loop prompt')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load loops — Refresh failed');
    expect(screen.getByText('No loops yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Loop prompt')).toBeInTheDocument();
  });
});
