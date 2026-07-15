import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CityFocusPanel from './CityFocusPanel';

const app = {
  id: 'alpha',
  name: 'Alpha Service',
  overallStatus: 'online',
  processes: [{ name: 'web' }, { name: 'worker' }],
  pm2Status: {
    web: { status: 'online' },
    worker: { status: 'errored' },
  },
};

describe('CityFocusPanel', () => {
  it('renders app name, status, process summary and unhealthy processes', () => {
    render(<CityFocusPanel app={app} agents={[]} />);
    expect(screen.getByText('Alpha Service')).toBeTruthy();
    // Status pill reads ONLINE (unique — the process stat block uses RUNNING).
    expect(screen.getByText('ONLINE')).toBeTruthy();
    expect(screen.getByText('RUNNING')).toBeTruthy();
    // The unhealthy worker process is listed.
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('errored')).toBeTruthy();
  });

  it('lists active/failed agents assigned to the app', () => {
    const agents = [
      { agentId: 'a1', status: 'running', task: 'Refactor module' },
      { agentId: 'a2', status: 'completed', task: 'Old done task' },
    ];
    render(<CityFocusPanel app={app} agents={agents} />);
    expect(screen.getByText('Refactor module')).toBeTruthy();
    // A completed (non-active) agent is filtered out.
    expect(screen.queryByText('Old done task')).toBeNull();
  });

  it('fires onOpenApp with the app id from the explicit Open app action', () => {
    const onOpenApp = vi.fn();
    render(<CityFocusPanel app={app} agents={[]} onOpenApp={onOpenApp} />);
    fireEvent.click(screen.getByTitle('Open the app detail page'));
    expect(onOpenApp).toHaveBeenCalledWith('alpha');
  });

  it('fires onClose from the close and back actions', () => {
    const onClose = vi.fn();
    render(<CityFocusPanel app={app} agents={[]} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close focus and return to overview'));
    fireEvent.click(screen.getByTitle('Return to the city overview'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders the not-found fallback with a return-to-overview action', () => {
    const onClose = vi.fn();
    render(<CityFocusPanel app={null} notFound onClose={onClose} />);
    expect(screen.getByText('BUILDING NOT FOUND')).toBeTruthy();
    fireEvent.click(screen.getByText(/RETURN TO OVERVIEW/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
