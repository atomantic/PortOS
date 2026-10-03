import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mocks = vi.hoisted(() => ({ shell: vi.fn(), iterm: vi.fn(), state: {}, itermEnabled: true, restart: vi.fn(), stop: vi.fn(), start: vi.fn() }));
vi.mock('../hooks/useShellSession', () => ({
  MAX_SESSIONS: 20,
  useShellSession: (...args) => {
    mocks.shell(...args);
    return mocks.state;
  },
}));
vi.mock('../hooks/useItermSession', () => ({
  useItermSession: (...args) => {
    mocks.iterm(...args);
    return { terminalRef: { current: null }, sessions: [], listed: false, status: null, activeSession: null, connected: false };
  },
}));
vi.mock('../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ features: [], isFeatureEnabled: (id) => id !== 'iterm' || mocks.itermEnabled }),
}));
vi.mock('../services/api', () => ({
  getApps: vi.fn(async () => []),
  getItermStatus: vi.fn(() => new Promise(() => {})),
}));

import Shell from './Shell';

beforeEach(() => {
  mocks.itermEnabled = true;
  mocks.state = {
    terminalRef: { current: null }, connected: false, sessions: [],
    interactiveCount: 0, liveRunCount: 0, isLiveRun: false,
    restartSession: mocks.restart, stopSession: mocks.stop, startNewSession: mocks.start,
  };
});
afterEach(cleanup);

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/shell" element={<Shell />} />
      <Route path="/shell/iterm" element={<Shell />} />
      <Route path="/shell/iterm/:itermSessionId" element={<Shell />} />
      <Route path="/shell/:sessionId" element={<Shell />} />
    </Routes>
  </MemoryRouter>
);

// The two sources are separate views: the PortOS view (and its tab strip)
// never subscribes to iTerm2 sessions, and the iTerm2 view never lists,
// auto-starts or navigates PortOS shells.
describe('Shell page source routing (#8114)', () => {
  it('renders only the PortOS view at /shell and /shell/:sessionId', async () => {
    renderAt('/shell');
    renderAt('/shell/abc123');
    await act(async () => {}); // settle the app-folder fetch
    expect(mocks.shell).toHaveBeenCalled();
    expect(mocks.iterm).not.toHaveBeenCalled();
  });

  it('renders only the iTerm2 view at /shell/iterm/:itermSessionId', () => {
    renderAt('/shell/iterm/iterm-EXAMPLE');
    expect(mocks.iterm).toHaveBeenCalledWith(expect.objectContaining({ itermSessionId: 'iterm-EXAMPLE' }));
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});

// These rendered interactions pin the lifecycle guards while the header wraps;
// the browser companion test pins actual geometry, which happy-dom cannot do.
describe('Shell conditional session controls (#9710)', () => {
  it.each([
    { iterm: false, connected: true, live: false, badge: false },
    { iterm: true, connected: true, live: false, badge: true },
    { iterm: false, connected: true, live: true, badge: true },
    { iterm: true, connected: true, live: true, badge: true },
    { iterm: true, connected: false, live: false, badge: false },
  ])('preserves controls for %j', async ({ iterm, connected, live, badge }) => {
    mocks.itermEnabled = iterm;
    mocks.state = {
      ...mocks.state, connected, isLiveRun: live, liveRunCount: badge ? 1 : 0,
      interactiveCount: live ? 0 : 1, activeSessionId: 'example-session',
      sessions: [{ sessionId: 'example-session', label: 'Example session', external: live, createdAt: 0 }],
    };
    renderAt('/shell/example-session');
    await act(async () => {});
    expect(screen.queryByRole('tablist', { name: 'Terminal source' }) !== null).toBe(iterm);
    expect(screen.getByText(connected ? 'Connected' : 'Disconnected', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'About live TUI runs' }) !== null).toBe(badge);
    if (badge) {
      fireEvent.click(screen.getByRole('button', { name: 'About live TUI runs' }));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Stop to end it');
    }
    const controls = screen.getByRole('group', { name: 'Session controls' });
    expect(controls.querySelector('[title="Restart session (kill + new)"]') !== null).toBe(connected && !live);
    expect(controls.querySelector('[title="Stop this TUI run"], [title="Kill current session"]') !== null).toBe(connected);
    if (connected && !live) fireEvent.click(screen.getByRole('button', { name: 'Restart', exact: true }));
    if (connected) fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'New', exact: true }));
    expect(mocks.restart).toHaveBeenCalledTimes(connected && !live ? 1 : 0);
    expect(mocks.stop).toHaveBeenCalledTimes(connected ? 1 : 0);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen terminal' }));
    expect(screen.getByRole('dialog', { name: 'Terminal fullscreen view' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(screen.getByRole('group', { name: 'Session controls' })).toBeInTheDocument();
  });
});
