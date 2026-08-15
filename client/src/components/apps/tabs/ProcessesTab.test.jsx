import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  executeCommand: vi.fn(),
  getProcessesList: vi.fn(),
}));

vi.mock('../../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: () => ({
    data: [{ name: 'example-api', status: 'online', pid: 1, cpu: 0, memory: 0, uptime: null, restarts: 0, pm_id: 1 }],
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useProcessLogs', () => ({
  useProcessLogs: vi.fn(() => ({ logs: [], subscribed: false, clear: vi.fn() })),
}));

vi.mock('../../BrailleSpinner', () => ({ default: () => null }));
vi.mock('../../ui/FormField', () => ({ FormField: ({ children }) => children }));
vi.mock('../../ui/ProcessLogLines', () => ({ default: () => null }));
vi.mock('../../../utils/formatters', () => ({ formatBytes: vi.fn(() => '0 B'), formatDurationMs: vi.fn() }));

import { useProcessLogs } from '../../../hooks/useProcessLogs';
import ProcessesTab from './ProcessesTab';

describe('ProcessesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes its app id to the expanded process log subscription', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));

    expect(useProcessLogs).toHaveBeenLastCalledWith('example-api', { lines: 500, appId: 'app-1' });
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

    // Exiting fullscreen tears the portaled overlay back down.
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(document.body.querySelector('.fixed.inset-0')).toBeNull();
  });
});
