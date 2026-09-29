import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const state = vi.hoisted(() => ({ featuresLoaded: true, enabled: true, hook: null }));
vi.mock('../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({
    features: state.featuresLoaded ? [] : null,
    isFeatureEnabled: (id) => (id === 'iterm' ? state.enabled : false),
  }),
}));
vi.mock('../../hooks/useItermSession', () => ({ useItermSession: () => state.hook }));
vi.mock('../../services/api', () => ({ getItermStatus: vi.fn(() => new Promise(() => {})) }));

import ItermShellView from './ItermShellView';
import ShellSourceSwitch from './ShellSourceSwitch';
import { itermHintText } from './ItermStatusHint';

// Invented fixtures only.
const session = (id, over = {}) => ({
  id, windowIndex: 1, tabIndex: 1, paneIndex: 1, paneCount: 1, label: id, cwd: '/tmp/example-app', cols: 245, rows: 59, ...over,
});
const SESSIONS = [
  session('iterm-A', { paneIndex: 1, paneCount: 2, label: 'vim' }),
  session('iterm-B', { paneIndex: 2, paneCount: 2, label: 'claude' }),
  session('iterm-C', { windowIndex: 2, label: 'htop' }),
];
const hookState = (over = {}) => ({
  terminalRef: { current: null },
  sessions: SESSIONS,
  listed: true,
  status: { state: 'connected' },
  activeSession: SESSIONS[0],
  connected: true,
  selectSession: vi.fn(),
  emitInput: vi.fn(),
  sendCtrlB: vi.fn(),
  sendCtrlC: vi.fn(),
  sendEsc: vi.fn(),
  sendNavKey: vi.fn(),
  ...over,
});

let location;
const LocationProbe = () => { location = useLocation(); return null; };
const renderAt = (path, element) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
    <Routes>
      <Route path="/shell/iterm" element={element} />
      <Route path="/shell/iterm/:itermSessionId" element={element} />
      <Route path="*" element={element} />
    </Routes>
  </MemoryRouter>
);

describe('ShellSourceSwitch', () => {
  beforeEach(() => { state.enabled = true; });
  afterEach(cleanup);

  it('is absent while the iterm feature is off', () => {
    state.enabled = false;
    renderAt('/shell', <ShellSourceSwitch source="portos" />);
    expect(screen.queryByRole('tab', { name: /iTerm2/ })).toBeNull();
  });

  it('navigates between the PortOS and iTerm2 views', () => {
    renderAt('/shell', <ShellSourceSwitch source="portos" />);
    fireEvent.click(screen.getByRole('tab', { name: /iTerm2/ }));
    expect(location.pathname).toBe('/shell/iterm');
    fireEvent.click(screen.getByRole('tab', { name: /PortOS/ }));
    expect(location.pathname).toBe('/shell');
  });
});

describe('ItermShellView', () => {
  beforeEach(() => {
    state.featuresLoaded = true;
    state.enabled = true;
    state.hook = hookState();
  });
  afterEach(cleanup);

  it('offers input helpers but no PortOS lifecycle controls', () => {
    renderAt('/shell/iterm/iterm-A', <ItermShellView />);
    expect(screen.getByRole('button', { name: /Send Ctrl\+C/ })).toBeTruthy();
    for (const name of [/^New$/, /Start new session/, /Stop/, /Restart/, /cd to app/, /Kill session/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByTestId('iterm-geometry').textContent).toBe('245×59 · sized by iTerm');
  });

  it('groups sessions window › tab › pane and selects through the URL callback', () => {
    renderAt('/shell/iterm/iterm-A', <ItermShellView />);
    const tabs = screen.getAllByTestId('iterm-session-tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('title')).toContain('Window 1 › Tab 1 › Pane 1/2');
    expect(tabs[2].getAttribute('title')).toContain('Window 2 › Tab 1');
    expect(screen.getByText('W2')).toBeTruthy();
    fireEvent.click(within(tabs[1]).getByText('claude'));
    expect(state.hook.selectSession).toHaveBeenCalledWith('iterm-B');
  });

  it('shows a turned-off notice with a way back when the feature is off', () => {
    state.enabled = false;
    renderAt('/shell/iterm', <ItermShellView />);
    expect(screen.getByText(/iTerm2 sessions are turned off/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to PortOS shells/ }).getAttribute('href')).toBe('/shell');
  });

  it('fullscreen is a modal dialog: focus moves in, Escape exits, focus returns to the toggle', () => {
    state.hook = hookState();
    renderAt('/shell/iterm', <ItermShellView />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Fullscreen terminal' });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Terminal fullscreen view' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Escape typed inside the terminal belongs to the program running there.
    fireEvent.keyDown(screen.getByTestId('iterm-terminal'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exit fullscreen' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen terminal' }));
  });

  it('names the fix for each status', () => {
    expect(itermHintText({ state: 'api-disabled' })).toMatch(/Enable Python API/);
    expect(itermHintText({ state: 'not-running' })).toMatch(/isn’t running/);
    expect(itermHintText({ state: 'auth-failed' })).toMatch(/Automation/);
    expect(itermHintText({ state: 'connected', sessionCount: 0 })).toBe('No iTerm2 sessions open.');
    expect(itermHintText({ state: 'connected', sessionCount: 2 })).toBeNull();

    state.hook = hookState({ sessions: [], activeSession: null, connected: false, status: { state: 'not-running' } });
    renderAt('/shell/iterm', <ItermShellView />);
    expect(screen.getByRole('status').textContent).toMatch(/iTerm2 isn’t running/);
  });
});
