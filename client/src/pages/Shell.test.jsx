import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mocks = vi.hoisted(() => ({ shell: vi.fn(), iterm: vi.fn() }));
vi.mock('../hooks/useShellSession', () => ({
  MAX_SESSIONS: 20,
  useShellSession: (...args) => {
    mocks.shell(...args);
    return { terminalRef: { current: null }, connected: false, sessions: [], interactiveCount: 0, liveRunCount: 0 };
  },
}));
vi.mock('../hooks/useItermSession', () => ({
  useItermSession: (...args) => {
    mocks.iterm(...args);
    return { terminalRef: { current: null }, sessions: [], listed: false, status: null, activeSession: null, connected: false };
  },
}));
vi.mock('../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ features: [], isFeatureEnabled: () => true }),
}));
vi.mock('../services/api', () => ({
  getApps: vi.fn(async () => []),
  getItermStatus: vi.fn(() => new Promise(() => {})),
}));

import Shell from './Shell';

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
  afterEach(() => { cleanup(); mocks.shell.mockClear(); mocks.iterm.mockClear(); });

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
