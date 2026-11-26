import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiCommands.js', () => ({
  applyProcessAction: vi.fn(),
  getProcessesList: vi.fn(),
}));

vi.mock('../../../hooks/useProcessSnapshot', () => ({
  useProcessSnapshot: vi.fn(),
}));

vi.mock('../../../hooks/useProcessLogs', () => ({
  useProcessLogs: vi.fn(() => ({ logs: [], status: 'connecting', retry: vi.fn(), clear: vi.fn() })),
}));

vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../../BrailleSpinner', () => ({ default: () => null }));
vi.mock('../../ui/FormField', () => ({ FormField: ({ children }) => children }));
vi.mock('../../ui/ProcessLogLines', () => ({ default: () => null, LogStreamBadge: () => null }));
// `formatCount` is deliberately NOT stubbed — a stub that returns the raw
// number would make the "N lines" assertions blind to a grouping regression.
vi.mock('../../../utils/formatters', async (importOriginal) => ({
  ...(await importOriginal()),
  formatBytes: vi.fn(() => '0 B'),
  formatDurationMs: vi.fn(),
  formatTimeOfDaySeconds: vi.fn((timestamp) => `time-${timestamp}`),
}));

import { applyProcessAction } from '../../../services/apiCommands.js';
import { PORTOS_APP_ID } from '../../../lib/appIdentity.js';
import { useProcessLogs } from '../../../hooks/useProcessLogs';
import { useProcessSnapshot } from '../../../hooks/useProcessSnapshot';
import { copyToClipboard } from '../../../lib/clipboard';
import ProcessesTab from './ProcessesTab';

const PROCESS = { name: 'example-api', status: 'online', pid: 1, cpu: 0, memory: 0, uptime: null, restarts: 0, pm_id: 1 };

describe('ProcessesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyProcessAction.mockResolvedValue(null);
    useProcessLogs.mockReturnValue({ logs: [], status: 'connecting', retry: vi.fn(), clear: vi.fn() });
    useProcessSnapshot.mockReturnValue({
      data: [PROCESS],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it.each([
    [PORTOS_APP_ID, 'example-api'],
    [undefined, 'portos-server'],
    [undefined, 'portos-ui'],
  ])('confirms before stopping the %s process %s', async (appId, name) => {
    const user = userEvent.setup();
    useProcessSnapshot.mockReturnValue({
      data: [{ ...PROCESS, name }, { ...PROCESS, name: 'other-process', pm_id: 2 }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<ProcessesTab appId={appId} />);

    const [trigger, otherTrigger] = screen.getAllByRole('button', { name: 'Stop' });
    await user.click(trigger);
    expect(applyProcessAction).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Stop PortOS? This shuts down the web UI and requires terminal access to start again.' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(applyProcessAction).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const confirmation = screen.getByRole('group', { name: /^Stop PortOS\?/ });
    await user.click(within(confirmation).getByRole('button', { name: `Stop ${name}` }));
    expect(applyProcessAction).toHaveBeenCalledExactlyOnceWith(name, 'stop', appId);

    if (!appId) {
      await user.click(otherTrigger);
      expect(applyProcessAction).toHaveBeenLastCalledWith('other-process', 'stop', undefined);
    }
  });

  it('stops processes for other managed apps immediately', async () => {
    const user = userEvent.setup();
    render(<ProcessesTab appId="app-1" />);

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(applyProcessAction).toHaveBeenCalledExactlyOnceWith('example-api', 'stop', 'app-1');
    expect(screen.queryByRole('group', { name: /^Stop PortOS\?/ })).toBeNull();
  });

  it('shows Retry after the initial snapshot fails without claiming there are no processes', () => {
    const refetch = vi.fn();
    useProcessSnapshot.mockReturnValue({ data: null, loading: false, error: new Error('offline'), refetch });

    render(<ProcessesTab appId="app-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load process status — offline');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('No PM2 processes found')).toBeNull();
    expect(screen.queryByText(/processes$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps the last snapshot and unavailable warning after a refresh failure', () => {
    useProcessSnapshot.mockReturnValue({
      data: [PROCESS],
      loading: false,
      error: new Error('offline'),
      refetch: vi.fn(),
    });

    render(<ProcessesTab appId="app-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Process status unavailable; showing the last known state.');
    expect(screen.getByText('example-api')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('shows the empty state for a successful empty snapshot', () => {
    useProcessSnapshot.mockReturnValue({ data: [], loading: false, error: null, refetch: vi.fn() });

    render(<ProcessesTab appId="app-1" />);

    expect(screen.getByText('No PM2 processes found')).toBeTruthy();
    expect(screen.getByText('0 processes')).toBeTruthy();
  });

  it('passes its app id to the expanded process log subscription', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));

    expect(useProcessLogs).toHaveBeenLastCalledWith('example-api', { lines: 500, appId: 'app-1' });
  });

  it('copies the current live log snapshot from both viewers in display order', () => {
    useProcessLogs.mockReturnValue({
      logs: [
        { line: 'boot ok', type: 'stdout', timestamp: 100 },
        { line: 'failed once', type: 'stderr', timestamp: 200 },
      ],
      status: 'live',
      clear: vi.fn(),
    });
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy logs' }));

    const expected = '[time-100] [stdout] boot ok\n[time-200] [stderr] failed once';
    expect(copyToClipboard).toHaveBeenLastCalledWith(expected, 'Logs copied');

    fireEvent.click(screen.getByTitle('Fullscreen'));
    const copyButtons = screen.getAllByRole('button', { name: 'Copy logs' });
    fireEvent.click(copyButtons[1]);
    expect(copyToClipboard).toHaveBeenLastCalledWith(expected, 'Logs copied');
    expect(copyToClipboard).toHaveBeenCalledTimes(2);
  });

  it('disables copy actions when the live log snapshot is empty', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    expect(screen.getByRole('button', { name: 'Copy logs' })).toBeDisabled();

    fireEvent.click(screen.getByTitle('Fullscreen'));
    expect(screen.getAllByRole('button', { name: 'Copy logs' })).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true }),
    ]);
  });

  // On "glass" themes a bordered/rounded `.bg-port-card` gets a backdrop-filter,
  // which makes it the containing block for `position:fixed` descendants — an
  // inline overlay would be sized to the card, not the viewport. Portaling to
  // <body> is the escape, so assert the overlay leaves the component's subtree.
  it('portals the fullscreen log overlay to <body> so glass-theme cards cannot trap it', () => {
    const { container } = render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    fireEvent.click(screen.getByTitle('Fullscreen'));

    const overlay = document.body.querySelector('.fixed.inset-0');
    expect(overlay).toBeTruthy();
    // Rendered out of the tab tree entirely, directly under <body>.
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByText('Logs: example-api')).toBeTruthy();
    expect(screen.getByTestId('fullscreen-log-controls')).toHaveClass('flex-wrap');

    // Exiting fullscreen tears the portaled overlay back down.
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(document.body.querySelector('.fixed.inset-0')).toBeNull();
  });

  it('fullscreen log viewer has dialog semantics and ARIA attributes', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    fireEvent.click(screen.getByTitle('Fullscreen'));

    const dialog = screen.getByRole('dialog', { name: 'Logs for example-api' });
    expect(dialog).toBeTruthy();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Logs for example-api');
  });

  it('pressing Escape closes the fullscreen log viewer', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    fireEvent.click(screen.getByTitle('Fullscreen'));

    expect(screen.getByRole('dialog', { name: 'Logs for example-api' })).toBeTruthy();

    // Press Escape to close fullscreen
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Logs for example-api' }), { key: 'Escape' });

    // Dialog should be gone
    expect(screen.queryByRole('dialog', { name: 'Logs for example-api' })).toBeNull();
  });

  it('fullscreen log viewer traps focus within the modal', () => {
    useProcessLogs.mockReturnValue({
      logs: [{ line: 'test', type: 'stdout', timestamp: 100 }],
      status: 'connecting',
      clear: vi.fn(),
    });
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));
    fireEvent.click(screen.getByTitle('Fullscreen'));

    const dialog = screen.getByRole('dialog', { name: 'Logs for example-api' });

    // Focus should be inside the modal (on the exit button or another control)
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
