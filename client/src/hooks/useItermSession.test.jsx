import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { handlers, emitted, socketMock, terminalHarness } = vi.hoisted(() => {
  const handlers = new Map();
  const emitted = [];
  const terminal = {
    options: {},
    cols: 80,
    rows: 24,
    reset: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    resize: vi.fn(function resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
    }),
    focus: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
  };
  const terminalHarness = {
    terminal,
    createShellTerminal: vi.fn(() => terminal),
  };
  const socketMock = {
    connected: true,
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  };
  return { handlers, emitted, socketMock, terminalHarness };
});
vi.mock('../services/socket', () => ({ default: socketMock, getSocket: () => socketMock }));
vi.mock('../components/ThemeContext', () => ({
  useThemeContext: () => ({ themeId: 'test', theme: { mode: 'night' } }),
}));
vi.mock('../components/shell/createShellTerminal', () => ({
  createShellTerminal: terminalHarness.createShellTerminal,
  readTerminalTheme: vi.fn(() => ({})),
  TERMINAL_SCROLLBACK_LINES: 5000,
}));

import { useItermSession } from './useItermSession.js';

// Invented fixtures only.
const session = (id, over = {}) => ({
  id, windowIndex: 1, tabIndex: 1, paneIndex: 1, paneCount: 1, label: id, cols: 100, rows: 30, ...over,
});
const LIST = { status: { state: 'connected' }, sessions: [session('iterm-AAAA'), session('iterm-BBBB', { tabIndex: 2 })] };

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
const emitsOf = (event) => emitted.filter(([e]) => e === event);

let location;
const renderAt = (path) => renderHook(() => {
  location = useLocation();
  return useItermSession({ itermSessionId: location.pathname.split('/')[3], enabled: true });
}, {
  wrapper: ({ children }) => (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="*" element={children} /></Routes>
    </MemoryRouter>
  ),
});

const MountedTerminal = () => {
  location = useLocation();
  const state = useItermSession({ itermSessionId: location.pathname.split('/')[3], enabled: true });
  return <div ref={state.terminalRef} />;
};
const renderWithTerminal = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="*" element={<MountedTerminal />} /></Routes>
  </MemoryRouter>
);

describe('useItermSession', () => {
  beforeEach(() => {
    handlers.clear();
    emitted.length = 0;
    socketMock.connected = true;
    terminalHarness.createShellTerminal.mockClear();
    terminalHarness.terminal.reset.mockClear();
    terminalHarness.terminal.write.mockClear();
    terminalHarness.terminal.writeln.mockClear();
    terminalHarness.terminal.resize.mockClear();
    terminalHarness.terminal.rows = 24;
  });
  afterEach(cleanup);

  it('lists iTerm2 sessions and never speaks the PortOS shell protocol', () => {
    const { unmount } = renderAt('/shell/iterm');
    expect(emitted).toContainEqual(['iterm:list']);
    fire('iterm:sessions', LIST);
    unmount();
    expect(emitted.some(([event]) => event.startsWith('shell:'))).toBe(false);
    expect(emitted).toContainEqual(['iterm:unlist']);
  });

  it('auto-selects the first session when the URL names none', () => {
    renderAt('/shell/iterm');
    fire('iterm:sessions', LIST);
    expect(location.pathname).toBe('/shell/iterm/iterm-AAAA');
    expect(emitsOf('iterm:attach')).toEqual([['iterm:attach', { id: 'iterm-AAAA' }]]);
  });

  it('deep-links to the session in the URL, drops a stale attach reply, and types into it', () => {
    const { result } = renderAt('/shell/iterm/iterm-BBBB');
    fire('iterm:sessions', LIST);
    expect(emitsOf('iterm:attach')).toEqual([['iterm:attach', { id: 'iterm-BBBB' }]]);

    fire('iterm:attached', { id: 'iterm-AAAA', cols: 100, rows: 30, bufferedOutput: '' });
    expect(result.current.connected).toBe(false);

    fire('iterm:attached', { id: 'iterm-BBBB', cols: 100, rows: 30, bufferedOutput: 'x' });
    expect(result.current.connected).toBe(true);
    expect(result.current.activeSession.id).toBe('iterm-BBBB');

    act(() => result.current.sendCtrlC());
    act(() => result.current.sendNavKey({ code: 'A' }));
    expect(emitsOf('iterm:input')).toEqual([
      ['iterm:input', { id: 'iterm-BBBB', data: '\x03' }],
      ['iterm:input', { id: 'iterm-BBBB', data: '\x1b[A' }],
    ]);
    // iTerm2 owns the size: nothing here ever asks for a resize.
    expect(emitted.some(([event]) => event.includes('resize'))).toBe(false);
  });

  it('falls back to the view root when the deep-linked session is gone', () => {
    renderAt('/shell/iterm/iterm-GONE');
    fire('iterm:sessions', LIST);
    expect(location.pathname).toBe('/shell/iterm/iterm-AAAA');
  });

  it('switching sessions detaches the previous one', () => {
    const { result } = renderAt('/shell/iterm/iterm-AAAA');
    fire('iterm:sessions', LIST);
    fire('iterm:attached', { id: 'iterm-AAAA', cols: 100, rows: 30, bufferedOutput: '' });
    act(() => result.current.selectSession('iterm-BBBB'));
    expect(location.pathname).toBe('/shell/iterm/iterm-BBBB');
    expect(emitsOf('iterm:detach')).toEqual([['iterm:detach', { id: 'iterm-AAAA' }]]);
    expect(emitsOf('iterm:attach').at(-1)).toEqual(['iterm:attach', { id: 'iterm-BBBB' }]);
    // Selecting is navigation only: the list subscription is never torn down.
    expect(emitsOf('iterm:list')).toHaveLength(1);
    expect(emitsOf('iterm:unlist')).toHaveLength(0);
  });

  it('detaches a superseded in-flight attach so its session stops streaming', () => {
    const { result } = renderAt('/shell/iterm/iterm-AAAA');
    fire('iterm:sessions', LIST);
    act(() => result.current.selectSession('iterm-BBBB')); // A never replied
    expect(emitsOf('iterm:detach')).toEqual([['iterm:detach', { id: 'iterm-AAAA' }]]);
    fire('iterm:attached', { id: 'iterm-AAAA', cols: 100, rows: 30, bufferedOutput: '' });
    expect(result.current.connected).toBe(false);
  });

  it('re-attaches the viewed session after the socket reconnects', () => {
    renderAt('/shell/iterm/iterm-AAAA');
    fire('iterm:sessions', LIST);
    fire('iterm:attached', { id: 'iterm-AAAA', cols: 100, rows: 30, bufferedOutput: '' });
    fire('disconnect');
    fire('connect');
    fire('iterm:sessions', LIST);
    expect(emitsOf('iterm:attach')).toEqual([
      ['iterm:attach', { id: 'iterm-AAAA' }],
      ['iterm:attach', { id: 'iterm-AAAA' }],
    ]);
  });

  it('keeps the URL through an iTerm2 reconnect and falls back only once a live list drops the session', () => {
    renderAt('/shell/iterm/iterm-BBBB');
    fire('iterm:sessions', LIST);
    fire('iterm:attached', { id: 'iterm-BBBB', cols: 100, rows: 30, bufferedOutput: '' });
    // The bridge lost iTerm2: exit + an empty, non-authoritative list.
    fire('iterm:exit', { id: 'iterm-BBBB' });
    fire('iterm:sessions', { status: { state: 'disconnected' }, sessions: [] });
    expect(location.pathname).toBe('/shell/iterm/iterm-BBBB');
    fire('iterm:sessions', LIST);
    expect(emitsOf('iterm:attach').at(-1)).toEqual(['iterm:attach', { id: 'iterm-BBBB' }]);
    // Now it really closes.
    fire('iterm:sessions', { status: { state: 'connected' }, sessions: [session('iterm-AAAA')] });
    expect(location.pathname).toBe('/shell/iterm/iterm-AAAA');
  });

  it('restores seeded scrollback and advances it with newly scrolled rows', () => {
    renderWithTerminal('/shell/iterm/iterm-AAAA');
    expect(terminalHarness.createShellTerminal).toHaveBeenCalledWith(expect.anything(), {
      scrollback: 5000,
      cursorBlink: false,
    });
    fire('iterm:sessions', LIST);
    fire('iterm:attached', { id: 'iterm-AAAA', cols: 100, rows: 30, bufferedOutput: '' });

    fire('iterm:output', { id: 'iterm-AAAA', data: 'history + screen snapshot', reset: true });
    expect(terminalHarness.terminal.reset).toHaveBeenCalledTimes(3);
    expect(terminalHarness.terminal.write).toHaveBeenLastCalledWith('history + screen snapshot');

    fire('iterm:output', { id: 'iterm-AAAA', data: 'live frame', scrollbackRows: 2 });
    expect(terminalHarness.terminal.write).toHaveBeenLastCalledWith('\x1b[30;1H\n\nlive frame');
  });
});
