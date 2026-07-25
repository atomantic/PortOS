import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const handlers = new Map();
const emitted = [];
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  },
}));

import DesktopLaunchProgress from './DesktopLaunchProgress';
import { DESKTOP_TYPES, isDesktopType } from './constants';

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });

const renderPanel = (props = {}) => render(
  <DesktopLaunchProgress
    appId="app-1"
    processName="game"
    online={false}
    onDismiss={() => {}}
    {...props}
  />
);

describe('DesktopLaunchProgress', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; });
  afterEach(cleanup);

  it('subscribes to the process log scoped to the app (custom PM2_HOME)', () => {
    renderPanel();
    expect(emitted).toContainEqual([
      'logs:subscribe', { processName: 'game', lines: 200, appId: 'app-1' },
    ]);
  });

  it('reads as in-progress while the build runs, so a slow launch is not "hung"', () => {
    renderPanel({ online: false });
    expect(screen.getByText(/Launching — game/)).toBeInTheDocument();
    expect(screen.getByText(/Building and importing assets/)).toBeInTheDocument();
  });

  it('streams build output as it arrives', () => {
    renderPanel();
    fire('logs:subscribed', { processName: 'game' });
    fire('logs:line', { processName: 'game', line: 'Importing assets…', type: 'stdout', timestamp: 1 });

    expect(screen.getByText('Importing assets…')).toBeInTheDocument();
  });

  it('distinguishes not-yet-connected from connected-but-silent', () => {
    renderPanel();
    expect(screen.getByText(/Connecting to log stream/)).toBeInTheDocument();

    fire('logs:subscribed', { processName: 'game' });
    expect(screen.getByText(/Waiting for output/)).toBeInTheDocument();
  });

  it('flips to running once the process is up, and frames a quit as normal', () => {
    renderPanel({ online: true });
    expect(screen.getByText(/Running — game/)).toBeInTheDocument();
    // A closed window is a clean exit for a desktop app, not a crash — the copy
    // must not read as an error (issue #2991).
    expect(screen.getByText(/normal exit, not a crash/)).toBeInTheDocument();
  });

  it('dismisses without stopping the app', () => {
    const onDismiss = vi.fn();
    renderPanel({ onDismiss });

    fireEvent.click(screen.getByLabelText('Hide launch output'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Dismiss is presentation-only — it never emits a stop/kill.
    expect(emitted.map(([e]) => e)).not.toContain('logs:kill');
  });

  it('unsubscribes when the panel unmounts', () => {
    const { unmount } = renderPanel();
    unmount();
    expect(emitted).toContainEqual(['logs:unsubscribe', { processName: 'game' }]);
  });
});

describe('desktop type mirror', () => {
  // The client mirrors DESKTOP_TYPES from server/services/streamingDetect.js.
  // A server-side addition that never reaches this set silently regresses the
  // portless UI branches (Open UI hidden, launch panel) back to the web-app path.
  it('matches the server set', async () => {
    const server = await import('../../../../server/services/streamingDetect.js');
    expect([...DESKTOP_TYPES].sort()).toEqual([...server.DESKTOP_TYPES].sort());
  });

  it('classifies desktop apps and not web apps', () => {
    expect(isDesktopType('desktop')).toBe(true);
    expect(isDesktopType('express')).toBe(false);
    expect(isDesktopType(undefined)).toBe(false);
  });
});
