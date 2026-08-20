import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let ptyInstances = [];
let spawnImpl;

vi.mock('node-pty', () => ({
  spawn: vi.fn((...args) => spawnImpl(...args)),
}));

const makeFakePty = () => {
  const fake = {
    _dataHandler: null,
    _exitHandler: null,
    onData: vi.fn((fn) => { fake._dataHandler = fn; }),
    onExit: vi.fn((fn) => { fake._exitHandler = fn; }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (chunk) => fake._dataHandler?.(chunk),
    emitExit: (payload) => fake._exitHandler?.(payload),
  };
  ptyInstances.push(fake);
  return fake;
};

const defaultSpawn = vi.fn(() => makeFakePty());

const makeSocket = (id = 'sock-A') => ({ id, emit: vi.fn() });

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

let shell;

beforeEach(async () => {
  vi.resetModules();
  ptyInstances = [];
  spawnImpl = defaultSpawn;
  defaultSpawn.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  shell = await import('./shell.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createShellSession', () => {
  it('spawns a PTY and returns a session id', () => {
    const socket = makeSocket();
    const id = shell.createShellSession(socket, { shell: '/bin/zsh', cwd: '/tmp', cols: 100, rows: 30 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(ptyInstances).toHaveLength(1);

    const pty = vi.mocked(defaultSpawn);
    expect(pty).toHaveBeenCalledWith('/bin/zsh', [], expect.objectContaining({
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: '/tmp',
      env: expect.objectContaining({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }),
    }));
  });

  it('uses sensible defaults for cols/rows/cwd', () => {
    shell.createShellSession(makeSocket());
    expect(defaultSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cols: 80, rows: 24, cwd: expect.any(String) }),
    );
  });

  it('filters env to safe prefixes and merges caller opt-in env', () => {
    const originalEnv = process.env;
    process.env = {
      HOME: '/home/x',
      PATH: '/usr/bin',
      MY_SECRET_API_KEY: 'leak-me',
    };
    try {
      shell.createShellSession(makeSocket(), { env: { CALLER_KEY: 'explicit' } });
      const env = defaultSpawn.mock.calls[0][2].env;
      expect(env.HOME).toBe('/home/x');
      expect(env.PATH).toBe('/usr/bin');
      expect(env.MY_SECRET_API_KEY).toBeUndefined();
      expect(env.CALLER_KEY).toBe('explicit');
    } finally {
      process.env = originalEnv;
    }
  });

  it('emits shell:error and returns null when max sessions reached', () => {
    for (let i = 0; i < 20; i++) shell.createShellSession(makeSocket(`s${i}`));
    const socket = makeSocket('over');
    const id = shell.createShellSession(socket);
    expect(id).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('shell:error', {
      error: 'Max 20 shell sessions. Kill an existing session first.',
    });
  });

  it('does not throw when over-cap and socket is missing', () => {
    for (let i = 0; i < 20; i++) shell.createShellSession(makeSocket(`s${i}`));
    expect(() => shell.createShellSession(null)).not.toThrow();
  });

  it('returns null and emits when PTY spawn throws', () => {
    spawnImpl = () => { throw new Error('spawn failed'); };
    const socket = makeSocket();
    const id = shell.createShellSession(socket);
    expect(id).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('shell:error', {
      error: 'Failed to spawn shell: spawn failed',
    });
  });

  it('routes PTY output to the attached socket and onData hook', async () => {
    const onData = vi.fn();
    const socket = makeSocket();
    const id = shell.createShellSession(socket, { onData });
    ptyInstances[0].emitData('hello');
    await flushMicrotasks();
    expect(socket.emit).toHaveBeenCalledWith('shell:output', { sessionId: id, data: 'hello' });
    expect(onData).toHaveBeenCalledWith('hello');
  });

  it('buffers output and trims oldest chunks past 50KB', () => {
    const id = shell.createShellSession(makeSocket());
    const oldest = 'A'.repeat(20 * 1024);
    const middle = 'B'.repeat(20 * 1024);
    const newest = 'C'.repeat(20 * 1024);
    ptyInstances[0].emitData(oldest);
    ptyInstances[0].emitData(middle);
    ptyInstances[0].emitData(newest);

    const session = shell.getSession(id);
    expect(session.bufferSize()).toBeLessThanOrEqual(50 * 1024);
    const result = shell.attachSession(id, makeSocket('sock-B'));
    expect(result.bufferedOutput).not.toContain('A');
    expect(result.bufferedOutput).toContain(middle);
    expect(result.bufferedOutput).toContain(newest);
  });

  it('catches synchronous errors from the onData hook without crashing', async () => {
    const onData = vi.fn(() => { throw new Error('hook explodes'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    shell.createShellSession(makeSocket(), { onData });
    ptyInstances[0].emitData('boom');
    await flushMicrotasks();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('onData'));
  });

  it('on PTY exit: deletes session, emits shell:exit, runs onExit hook', async () => {
    const onExit = vi.fn();
    const socket = makeSocket();
    const id = shell.createShellSession(socket, { onExit });
    ptyInstances[0].emitExit({ exitCode: 0 });
    await flushMicrotasks();
    expect(shell.getSession(id)).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('shell:exit', { sessionId: id, code: 0 });
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: null });
  });

  // node-pty reports a signal-terminated shell as exitCode 0 with the signal in a
  // separate field. Forwarding it is what lets the TUI spawner tell "the shell
  // finished" from "pm2 killed the shell out from under a running agent" (#3202).
  it('on PTY exit: forwards node-pty signal to the onExit hook', async () => {
    const onExit = vi.fn();
    const id = shell.createShellSession(makeSocket(), { onExit });
    ptyInstances[0].emitExit({ exitCode: 0, signal: 15 });
    await flushMicrotasks();
    expect(shell.getSession(id)).toBeNull();
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: 15 });
  });

  it('schedules initialCommand write after delay', () => {
    vi.useFakeTimers();
    const id = shell.createShellSession(makeSocket(), { initialCommand: 'ls', initialCommandDelayMs: 50 });
    expect(ptyInstances[0].write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(ptyInstances[0].write).toHaveBeenCalledWith('ls\r');
    expect(shell.getSession(id)).toBeTruthy();
    vi.useRealTimers();
  });

  it('waitForPromptReady: holds initialCommand until the readiness probe round-trips, and fires onInitialCommandSent', () => {
    vi.useFakeTimers();
    const onInitialCommandSent = vi.fn();
    shell.createShellSession(makeSocket(), { initialCommand: 'claude', waitForPromptReady: true, initialCommandDelayMs: 8000, onInitialCommandSent });
    const pty = ptyInstances[0];
    // The probe is written after a short PTY-spawn settle, not immediately.
    expect(pty.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    const probeCall = pty.write.mock.calls.find(([d]) => /printf/.test(d));
    expect(probeCall).toBeTruthy();
    const nonce = probeCall[0].match(/PORTOSRDY''([0-9a-f]+)'/)[1];
    const marker = `PORTOSRDY${nonce}`;
    // Startup noise and the ECHO of the probe command (split marker, so the
    // assembled string never appears contiguously) must NOT trip readiness.
    pty.emitData('instant prompt rendering…');
    pty.emitData(`% printf '%s\\n' 'PORTOSRDY''${nonce}'`);
    expect(pty.write).not.toHaveBeenCalledWith('claude\r');
    expect(onInitialCommandSent).not.toHaveBeenCalled();
    // The assembled marker appears in the OUTPUT → shell proven, command injected.
    pty.emitData(`${marker}\n`);
    expect(pty.write).toHaveBeenCalledWith('claude\r');
    expect(onInitialCommandSent).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('waitForPromptReady: injects the command on the fallback timeout if the probe never round-trips', () => {
    vi.useFakeTimers();
    shell.createShellSession(makeSocket(), { initialCommand: 'claude', waitForPromptReady: true, initialCommandDelayMs: 8000 });
    const pty = ptyInstances[0];
    vi.advanceTimersByTime(50); // probe written
    // Output streams but the assembled marker never appears.
    for (let i = 0; i < 10; i++) { pty.emitData('tick'); vi.advanceTimersByTime(500); }
    expect(pty.write).not.toHaveBeenCalledWith('claude\r');
    // …but the hard fallback (8000ms from creation) injects the command regardless.
    vi.advanceTimersByTime(8000);
    expect(pty.write).toHaveBeenCalledWith('claude\r');
    vi.useRealTimers();
  });

  it('waitForPromptReady: if the shell exits before the probe round-trips, the fallback never injects the command', () => {
    vi.useFakeTimers();
    shell.createShellSession(makeSocket(), { initialCommand: 'claude', waitForPromptReady: true, initialCommandDelayMs: 8000 });
    const pty = ptyInstances[0];
    vi.advanceTimersByTime(50); // probe written
    // The shell dies before the marker round-trips → cancels pending timers.
    pty.emitExit({ exitCode: 1 });
    vi.advanceTimersByTime(8000); // past the (now-cleared) fallback window
    expect(pty.write).not.toHaveBeenCalledWith('claude\r');
    vi.useRealTimers();
  });
});

describe('attachSession', () => {
  it('returns null for unknown session id', () => {
    expect(shell.attachSession('does-not-exist', makeSocket())).toBeNull();
  });

  it('swaps socket and returns buffered output', () => {
    const sock1 = makeSocket('sock-A');
    const id = shell.createShellSession(sock1);
    ptyInstances[0].emitData('saved');
    const sock2 = makeSocket('sock-B');
    const result = shell.attachSession(id, sock2);
    expect(result).toEqual({ sessionId: id, bufferedOutput: 'saved' });
    expect(shell.getSession(id).socket).toBe(sock2);
  });

  it('emits shell:detached on the previous socket when displaced', () => {
    const sock1 = makeSocket('sock-A');
    const id = shell.createShellSession(sock1);
    const sock2 = makeSocket('sock-B');
    shell.attachSession(id, sock2);
    expect(sock1.emit).toHaveBeenCalledWith('shell:detached', { sessionId: id, reason: 'attached-elsewhere' });
  });

  it('claim=true rejects when a different socket holds the session', () => {
    const sock1 = makeSocket('sock-A');
    const id = shell.createShellSession(sock1);
    const sock2 = makeSocket('sock-B');
    const result = shell.attachSession(id, sock2, { claim: true });
    expect(result).toEqual({ claimRejected: true });
    expect(shell.getSession(id).socket).toBe(sock1);
    expect(sock1.emit).not.toHaveBeenCalledWith('shell:detached', expect.anything());
  });

  it('claim=true succeeds when re-attaching the same socket', () => {
    const sock = makeSocket();
    const id = shell.createShellSession(sock);
    const result = shell.attachSession(id, sock, { claim: true });
    expect(result.sessionId).toBe(id);
  });

  it('claim=true succeeds when the session is unbound', () => {
    const sock1 = makeSocket('sock-A');
    const id = shell.createShellSession(sock1);
    shell.detachSocketSessions(sock1);
    const sock2 = makeSocket('sock-B');
    const result = shell.attachSession(id, sock2, { claim: true });
    expect(result.sessionId).toBe(id);
  });
});

describe('listAllSessions', () => {
  it('reports recipient-relative attached: false for the socket holding the session', () => {
    const sock = makeSocket();
    shell.createShellSession(sock);
    const [info] = shell.listAllSessions(sock);
    expect(info.attached).toBe(false);
  });

  it('reports attached: true when a different socket holds the session', () => {
    const sock = makeSocket('sock-A');
    shell.createShellSession(sock);
    const [info] = shell.listAllSessions(makeSocket('sock-B'));
    expect(info.attached).toBe(true);
  });

  it('reports attached: false for unbound sessions (recipient-relative or global)', () => {
    const sock = makeSocket();
    const id = shell.createShellSession(sock);
    shell.detachSocketSessions(sock);
    expect(shell.listAllSessions(makeSocket('any')).find(s => s.sessionId === id).attached).toBe(false);
    expect(shell.listAllSessions().find(s => s.sessionId === id).attached).toBe(false);
  });

  it('returns the globally-attached view when forSocket is omitted', () => {
    const sock = makeSocket();
    shell.createShellSession(sock);
    const [info] = shell.listAllSessions();
    expect(info.attached).toBe(true);
  });

  it('includes the metadata fields callers consume', () => {
    const sock = makeSocket();
    shell.createShellSession(sock, { label: 'task-1', kind: 'agent', agentId: 'a1', command: 'codex' });
    const [info] = shell.listAllSessions(sock);
    expect(info).toMatchObject({ label: 'task-1', kind: 'agent', agentId: 'a1', command: 'codex' });
    expect(typeof info.sessionId).toBe('string');
    expect(typeof info.createdAt).toBe('number');
  });
});

describe('subscribeSessionList / unsubscribeSessionList', () => {
  it('delivers shell:sessions broadcasts to subscribers', () => {
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    shell.createShellSession(makeSocket('owner'));
    const broadcasts = observer.emit.mock.calls.filter(c => c[0] === 'shell:sessions');
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts[broadcasts.length - 1][1]).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    shell.unsubscribeSessionList(observer);
    shell.createShellSession(makeSocket('owner'));
    expect(observer.emit).not.toHaveBeenCalledWith('shell:sessions', expect.anything());
  });
});

describe('writeToSession / resizeSession', () => {
  it('writeToSession writes data and returns true', () => {
    const id = shell.createShellSession(makeSocket());
    expect(shell.writeToSession(id, 'ls\n')).toBe(true);
    expect(ptyInstances[0].write).toHaveBeenCalledWith('ls\n');
  });

  it('writeToSession returns false for missing session', () => {
    expect(shell.writeToSession('missing', 'x')).toBe(false);
  });

  it('resizeSession resizes and returns true', () => {
    const id = shell.createShellSession(makeSocket());
    expect(shell.resizeSession(id, 120, 40)).toBe(true);
    expect(ptyInstances[0].resize).toHaveBeenCalledWith(120, 40);
  });

  it('resizeSession returns false for missing session', () => {
    expect(shell.resizeSession('missing', 80, 24)).toBe(false);
  });
});

describe('changeSessionDirectory', () => {
  it('writes the cd in the dialect of the shell THIS session spawned', () => {
    // A Windows session runs cmd.exe, where the POSIX form the Shell page used to
    // send is both mis-quoted and drive-blind — see lib/shellCd.js. The trailing CR
    // is the other half of the Windows fix; see SUBMIT_KEY.
    const winId = shell.createShellSession(makeSocket('sock-win'), { shell: 'C:\\WINDOWS\\system32\\cmd.exe' });
    expect(shell.changeSessionDirectory(winId, 'I:\\code\\example-app')).toBe(true);
    expect(ptyInstances[0].write).toHaveBeenCalledWith('cd /d "I:\\code\\example-app"\r');

    const posixId = shell.createShellSession(makeSocket('sock-posix'), { shell: '/bin/zsh' });
    expect(shell.changeSessionDirectory(posixId, '/Users/example/my app')).toBe(true);
    expect(ptyInstances[1].write).toHaveBeenCalledWith("cd '/Users/example/my app'\r");
  });

  it('returns false for a missing session', () => {
    expect(shell.changeSessionDirectory('missing', '/tmp')).toBe(false);
  });

  it('moves session.cwd to the new directory so the tab label stops showing the spawn dir', () => {
    const sock = makeSocket('sock-cd');
    const id = shell.createShellSession(sock, { shell: '/bin/zsh', cwd: '/home/user/example' });
    expect(shell.listAllSessions(sock).find(s => s.sessionId === id).cwd).toBe('/home/user/example');

    expect(shell.changeSessionDirectory(id, '/home/user/example-app')).toBe(true);
    expect(shell.listAllSessions(sock).find(s => s.sessionId === id).cwd).toBe('/home/user/example-app');
  });

  it('broadcasts the refreshed session list so open Shell tabs relabel without a reload', () => {
    const observer = makeSocket('obs-cd');
    const id = shell.createShellSession(makeSocket('owner-cd'), { shell: '/bin/zsh', cwd: '/home/user/example' });
    shell.subscribeSessionList(observer);

    shell.changeSessionDirectory(id, '/home/user/example-app');

    const broadcasts = observer.emit.mock.calls.filter(c => c[0] === 'shell:sessions');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0][1].find(s => s.sessionId === id).cwd).toBe('/home/user/example-app');
    shell.unsubscribeSessionList(observer);
  });

  it('leaves an external TUI run cwd pinned to the repo it was spawned in', () => {
    // A cd typed at an agent TUI is text the agent reads, not a shell directory
    // change — and workspaceContext groups runs by the repo they were spawned in.
    const sock = makeSocket('sock-ext');
    const pty = makeFakePty();
    shell.registerExternalSession('run-1', pty, { cwd: '/home/user/example', label: 'Claude Code TUI' });

    expect(shell.changeSessionDirectory('run-1', '/home/user/example-app')).toBe(true);
    expect(shell.listAllSessions(sock).find(s => s.sessionId === 'run-1').cwd).toBe('/home/user/example');
  });

  it('leaves cwd untouched when the session is gone', () => {
    const sock = makeSocket('sock-cd-gone');
    const id = shell.createShellSession(sock, { shell: '/bin/zsh', cwd: '/home/user/example' });
    shell.killSession(id);
    expect(shell.changeSessionDirectory(id, '/home/user/example-app')).toBe(false);
  });

  it('records the shell it spawned when the caller names none', () => {
    // The recorded shell is what picks the cd dialect, so a session started from
    // the default must remember which binary that was rather than leaving
    // detectShellFlavor to guess from the platform. Which binary gets resolved is
    // covered by lib/interactiveShellResolver.test.js.
    const id = shell.createShellSession(makeSocket('sock-default'));
    const spawnedShell = vi.mocked(defaultSpawn).mock.calls[0][0];
    expect(spawnedShell).toBeTruthy();
    expect(shell.getSession(id).shell).toBe(spawnedShell);
  });
});

describe('initialCommand + exitWithCommand', () => {
  it('wraps the command so the shell exits with it, in that shell\'s dialect', () => {
    // The wrapper is rendered here rather than by the caller because only this
    // function knows which shell the session got. Under PowerShell the POSIX
    // `exit $?` would report a successful run as 1 — see lib/shellExit.js.
    vi.useFakeTimers();
    shell.createShellSession(makeSocket('sock-pwsh'), {
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      initialCommand: 'codex',
      exitWithCommand: true,
      initialCommandDelayMs: 10,
    });
    vi.advanceTimersByTime(10);
    expect(ptyInstances[0].write).toHaveBeenCalledWith(
      `$LASTEXITCODE = 1; codex; exit $LASTEXITCODE${shell.SUBMIT_KEY}`,
    );

    shell.createShellSession(makeSocket('sock-zsh'), {
      shell: '/bin/zsh',
      initialCommand: 'codex',
      exitWithCommand: true,
      initialCommandDelayMs: 10,
    });
    vi.advanceTimersByTime(10);
    expect(ptyInstances[1].write).toHaveBeenCalledWith(`codex; exit $?${shell.SUBMIT_KEY}`);
    vi.useRealTimers();
  });

  it('sends the command untouched without the flag, so a user-typed command is never wrapped', () => {
    // socket.js `shell:start` forwards whatever the user asked to run.
    vi.useFakeTimers();
    shell.createShellSession(makeSocket('sock-raw'), {
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      initialCommand: 'npm test',
      initialCommandDelayMs: 10,
    });
    vi.advanceTimersByTime(10);
    expect(ptyInstances[0].write).toHaveBeenCalledWith(`npm test${shell.SUBMIT_KEY}`);
    vi.useRealTimers();
  });
});

describe('submitToSession', () => {
  it('appends the Enter byte, and returns false for a missing session', () => {
    const id = shell.createShellSession(makeSocket('sock-submit'));
    expect(shell.submitToSession(id, 'npm test')).toBe(true);
    expect(ptyInstances[0].write).toHaveBeenCalledWith(`npm test${shell.SUBMIT_KEY}`);
    expect(shell.submitToSession('missing', 'npm test')).toBe(false);
  });
});

describe('pasteToSession', () => {
  let id;
  let pty;
  beforeEach(() => {
    vi.useFakeTimers();
    id = shell.createShellSession(makeSocket());
    pty = ptyInstances[0];
  });

  it('writes one bracketed paste, then submits with repeated Enters', () => {
    const timer = shell.pasteToSession(id, 'line one\nline two');
    expect(timer).toBeTruthy();
    // The paste is a SINGLE write — a multi-line message must not become N submits.
    expect(pty.write).toHaveBeenCalledWith('\x1b[200~line one\nline two\x1b[201~');
    expect(pty.write).toHaveBeenCalledWith('\r');

    vi.advanceTimersByTime(1400);
    expect(pty.write.mock.calls.filter(([data]) => data === '\r')).toHaveLength(3);
  });

  it('cancels pending Enters when the session dies', () => {
    shell.pasteToSession(id, 'hi');
    expect(pty.write.mock.calls.filter(([data]) => data === '\r')).toHaveLength(1);
    shell.killSession(id);
    vi.advanceTimersByTime(1400);
    expect(pty.write.mock.calls.filter(([data]) => data === '\r')).toHaveLength(1);
  });

  it('cancels pending Enters when newer input arrives', () => {
    shell.pasteToSession(id, 'hi');
    expect(pty.write.mock.calls.filter(([data]) => data === '\r')).toHaveLength(1);

    shell.writeToSession(id, 'new input');
    vi.advanceTimersByTime(1400);

    expect(pty.write.mock.calls.filter(([data]) => data === '\r')).toHaveLength(1);
    expect(pty.write).toHaveBeenCalledWith('new input');
  });

  it('returns false and writes nothing for a missing session', () => {
    expect(shell.pasteToSession('missing', 'hi')).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
  });
});

describe('killSession', () => {
  it('kills the PTY, removes the session, fires the onExit hook, broadcasts', async () => {
    const onExit = vi.fn();
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    const id = shell.createShellSession(makeSocket('owner'), { onExit });
    expect(shell.killSession(id)).toBe(true);
    await flushMicrotasks();
    expect(ptyInstances[0].kill).toHaveBeenCalled();
    expect(shell.getSession(id)).toBeNull();
    expect(onExit).toHaveBeenCalledWith({ exitCode: null, killed: true });
    const post = observer.emit.mock.calls.filter(c => c[0] === 'shell:sessions').pop();
    expect(post[1]).toHaveLength(0);
  });

  it('returns false for an unknown session id', () => {
    expect(shell.killSession('nope')).toBe(false);
  });
});

describe('detachSocketSessions', () => {
  it('clears socket binding on matching sessions and returns the count', () => {
    const sock = makeSocket();
    const id1 = shell.createShellSession(sock);
    const id2 = shell.createShellSession(sock);
    shell.createShellSession(makeSocket('other'));
    expect(shell.detachSocketSessions(sock)).toBe(2);
    expect(shell.getSession(id1).socket).toBeNull();
    expect(shell.getSession(id2).socket).toBeNull();
  });

  it('returns 0 when the socket holds nothing', () => {
    shell.createShellSession(makeSocket('owner'));
    expect(shell.detachSocketSessions(makeSocket('stranger'))).toBe(0);
  });

  it('also unsubscribes the socket from session-list broadcasts', () => {
    const sock = makeSocket();
    shell.subscribeSessionList(sock);
    shell.detachSocketSessions(sock);
    shell.createShellSession(makeSocket('owner'));
    const sessionsCalls = sock.emit.mock.calls.filter(c => c[0] === 'shell:sessions');
    expect(sessionsCalls).toHaveLength(0);
  });
});

describe('registerExternalSession / unregisterExternalSession', () => {
  it('registers an external session that lists with metadata', () => {
    const pty = makeFakePty();
    const id = shell.registerExternalSession('run-123', pty, {
      label: 'pipeline-manuscript-completeness',
      agentId: 'agent-123',
      command: 'claude --model x',
      cwd: '/work',
    });
    expect(id).toBe('run-123');
    const [info] = shell.listAllSessions(makeSocket());
    expect(info).toMatchObject({
      sessionId: 'run-123',
      label: 'pipeline-manuscript-completeness',
      agentId: 'agent-123',
      kind: 'tui-run',
      command: 'claude --model x',
      external: true,
    });
  });

  it('is idempotent — re-registering the same id is a no-op returning the id', () => {
    const pty = makeFakePty();
    shell.registerExternalSession('run-1', pty, { label: 'first' });
    const again = shell.registerExternalSession('run-1', makeFakePty(), { label: 'second' });
    expect(again).toBe('run-1');
    expect(shell.getSession('run-1').label).toBe('first');
  });

  it('does NOT count toward the interactive session cap', () => {
    // Fill the cap with external sessions — interactive creation must still work.
    for (let i = 0; i < 6; i++) shell.registerExternalSession(`run-${i}`, makeFakePty(), {});
    const id = shell.createShellSession(makeSocket());
    expect(typeof id).toBe('string');
  });

  it('streams output to the attached viewer and buffers for re-attach', () => {
    const pty = makeFakePty();
    const id = shell.registerExternalSession('run-x', pty, {});
    // No viewer yet — output buffers without throwing.
    pty.emitData('early');
    const viewer = makeSocket('viewer');
    const result = shell.attachSession(id, viewer);
    expect(result.bufferedOutput).toBe('early');
    pty.emitData('live');
    expect(viewer.emit).toHaveBeenCalledWith('shell:output', { sessionId: id, data: 'live' });
  });

  it('is fully interactive — input writes through and resize works', () => {
    const pty = makeFakePty();
    const id = shell.registerExternalSession('run-rw', pty, {});
    expect(shell.writeToSession(id, 'yes\n')).toBe(true);
    expect(pty.write).toHaveBeenCalledWith('yes\n');
    expect(shell.resizeSession(id, 120, 40)).toBe(true);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('isExternalSessionAttached reflects whether a viewer is bound', () => {
    const pty = makeFakePty();
    const id = shell.registerExternalSession('run-att', pty, {});
    expect(shell.isExternalSessionAttached(id)).toBe(false); // registered, no viewer
    shell.attachSession(id, makeSocket('viewer'));
    expect(shell.isExternalSessionAttached(id)).toBe(true);
    shell.detachSocketSessions(shell.getSession(id).socket);
    expect(shell.isExternalSessionAttached(id)).toBe(false);
    // Never true for unknown ids or interactive shells.
    expect(shell.isExternalSessionAttached('missing')).toBe(false);
    const shellId = shell.createShellSession(makeSocket('owner'));
    expect(shell.isExternalSessionAttached(shellId)).toBe(false);
  });

  it('getLastInputAt tracks writeToSession recency, independent of socket attachment', () => {
    // Deliberately NOT keyed on socket attachment (unlike isExternalSessionAttached):
    // a regular (non-external) session's socket stays bound after its viewer
    // navigates away — only external one-shot runs get released via
    // shell:release-views — so an "is a socket attached" signal would never
    // naturally expire for those. Input recency does expire on its own once
    // nobody is actually writing to the session.
    const owner = makeSocket('owner');
    const shellId = shell.createShellSession(owner);
    expect(shell.getLastInputAt(shellId)).toBeNull(); // no input yet

    const before = Date.now();
    expect(shell.writeToSession(shellId, 'hello\n')).toBe(true);
    expect(shell.getLastInputAt(shellId)).toBeGreaterThanOrEqual(before);

    // Never null-coalesced weirdly for unknown ids.
    expect(shell.getLastInputAt('missing')).toBeNull();
  });

  it('releases a watched run when the same socket attaches to another session', () => {
    const viewer = makeSocket('viewer');
    const runId = shell.registerExternalSession('run-watch', makeFakePty(), {});
    shell.attachSession(runId, viewer);
    expect(shell.isExternalSessionAttached(runId)).toBe(true);
    // Same socket switches to a shell — the run is released so it resumes
    // normal completion instead of staying paused for a tab left behind.
    const shellId = shell.createShellSession(viewer);
    expect(shell.isExternalSessionAttached(runId)).toBe(false);
    expect(shell.getSession(runId)).toBeTruthy(); // still alive, just unwatched
    // The new shell is unaffected.
    expect(shell.getSession(shellId).socket).toBe(viewer);
  });

  it('releases a watched run when the same socket attaches to a different run', () => {
    const viewer = makeSocket('viewer');
    const runA = shell.registerExternalSession('run-A', makeFakePty(), {});
    const runB = shell.registerExternalSession('run-B', makeFakePty(), {});
    shell.attachSession(runA, viewer);
    shell.attachSession(runB, viewer);
    expect(shell.isExternalSessionAttached(runA)).toBe(false);
    expect(shell.isExternalSessionAttached(runB)).toBe(true);
  });

  it('releaseExternalViewsForSocket releases watched runs and broadcasts when something changed', () => {
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    const viewer = makeSocket('viewer');
    const runId = shell.registerExternalSession('run-leave', makeFakePty(), {});
    shell.attachSession(runId, viewer);
    expect(shell.isExternalSessionAttached(runId)).toBe(true);
    observer.emit.mockClear();
    // Viewer navigated away from /shell — release without disconnecting.
    shell.releaseExternalViewsForSocket(viewer);
    expect(shell.isExternalSessionAttached(runId)).toBe(false);
    expect(shell.getSession(runId)).toBeTruthy(); // run still alive, just unwatched
    expect(observer.emit).toHaveBeenCalledWith('shell:sessions', expect.anything());
  });

  it('releaseExternalViewsForSocket is a no-op (no broadcast) when the socket held no runs', () => {
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    observer.emit.mockClear();
    shell.releaseExternalViewsForSocket(makeSocket('stranger'));
    expect(observer.emit).not.toHaveBeenCalledWith('shell:sessions', expect.anything());
  });

  it('unregister removes the session, emits shell:exit to the viewer, broadcasts', () => {
    const observer = makeSocket('obs');
    shell.subscribeSessionList(observer);
    const viewer = makeSocket('viewer');
    const pty = makeFakePty();
    const id = shell.registerExternalSession('run-done', pty, {});
    shell.attachSession(id, viewer);
    expect(shell.unregisterExternalSession(id, { exitCode: 0 })).toBe(true);
    expect(shell.getSession(id)).toBeNull();
    expect(viewer.emit).toHaveBeenCalledWith('shell:exit', { sessionId: id, code: 0 });
    const last = observer.emit.mock.calls.filter(c => c[0] === 'shell:sessions').pop();
    expect(last[1]).toHaveLength(0);
  });

  it('unregister is a no-op for unknown ids and for interactive sessions', () => {
    expect(shell.unregisterExternalSession('nope')).toBe(false);
    const id = shell.createShellSession(makeSocket());
    expect(shell.unregisterExternalSession(id)).toBe(false);
    expect(shell.getSession(id)).toBeTruthy();
  });
});

describe('getSession / getSessionProcess / getSessionCount', () => {
  it('getSession returns the session record or null', () => {
    const id = shell.createShellSession(makeSocket());
    expect(shell.getSession(id)).toMatchObject({ pty: expect.any(Object) });
    expect(shell.getSession('missing')).toBeNull();
  });

  it('getSessionProcess returns the PTY or null', () => {
    const id = shell.createShellSession(makeSocket());
    expect(shell.getSessionProcess(id)).toBe(ptyInstances[0]);
    expect(shell.getSessionProcess('missing')).toBeNull();
  });

  it('getSessionCount tracks active sessions', () => {
    expect(shell.getSessionCount()).toBe(0);
    shell.createShellSession(makeSocket());
    shell.createShellSession(makeSocket());
    expect(shell.getSessionCount()).toBe(2);
  });
});

describe('buildSafeEnv', () => {
  // Windows environment variable names are case-insensitive and arrive in mixed
  // case: the real variable is `Path`, not `PATH`. A case-SENSITIVE prefix match
  // dropped it (while keeping the coincidentally-upper-case `PATHEXT`), leaving
  // the agent shell unable to resolve any CLI provider (#3180).
  it('keeps mixed-case Windows variables that a case-sensitive match dropped', () => {
    const env = {
      Path: 'C:\\Windows\\system32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      TEMP: 'C:\\Users\\Example\\AppData\\Local\\Temp',
      APPDATA: 'C:\\Users\\Example\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\Example',
    };
    const safe = shell.buildSafeEnv(env, 'win32');
    for (const key of Object.keys(env)) {
      expect(safe, `expected ${key} to survive the allowlist`).toHaveProperty(key);
    }
  });

  it('still strips secrets on Windows', () => {
    const safe = shell.buildSafeEnv(
      { Path: 'C:\\Windows', ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret' },
      'win32'
    );
    expect(safe).toHaveProperty('Path');
    expect(safe).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(safe).not.toHaveProperty('GITHUB_TOKEN');
  });

  // The Windows names must not widen the POSIX allowlist — a Linux/macOS box
  // with an `OS` or `TEMP` var set should filter exactly as it did before.
  it('does not apply the Windows additions on POSIX', () => {
    const safe = shell.buildSafeEnv(
      { PATH: '/usr/bin', HOME: '/home/example', APPDATA: 'x', SystemRoot: 'y', ANTHROPIC_API_KEY: 'sk-secret' },
      'linux'
    );
    expect(safe).toHaveProperty('PATH');
    expect(safe).toHaveProperty('HOME');
    expect(safe).not.toHaveProperty('APPDATA');
    expect(safe).not.toHaveProperty('SystemRoot');
    expect(safe).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('buildSafeEnv — POSIX case sensitivity', () => {
  // Folding case on POSIX would WIDEN the allowlist, not preserve it: PortOS
  // starts under `npm run`, which exports dozens of lower-case npm_config_*
  // vars (including values read from the user's .npmrc). Upper-casing keys
  // would push every one of them through the 'NPM_' prefix into an attachable
  // shell, so POSIX matching stays case-sensitive.
  it('does not admit lower-case npm_config_* through the NPM_ prefix', () => {
    const safe = shell.buildSafeEnv(
      { PATH: '/usr/bin', npm_config_registry: 'https://example.com', npm_config_mysecret: 'hunter2' },
      'linux'
    );
    expect(safe).toHaveProperty('PATH');
    expect(safe).not.toHaveProperty('npm_config_registry');
    expect(safe).not.toHaveProperty('npm_config_mysecret');
  });
});

describe('buildSafeEnv — Windows names are exact, not prefixes', () => {
  // The Windows additions are individual OS variables, not grouped families
  // like NPM_/XDG_. Prefix-matching them would hand anything merely STARTING
  // with one to an attachable agent shell — and `OS` is two characters, so it
  // would admit OS_API_KEY from a filter whose whole job is withholding
  // credentials.
  it('does not admit token-like lookalikes of the Windows names', () => {
    const safe = shell.buildSafeEnv({
      Path: 'C:\\Windows',
      APPDATA: 'C:\\Users\\Example\\AppData\\Roaming',
      APPDATA_TOKEN: 'leak-me',
      TEMP: 'C:\\Temp',
      TEMP_SECRET: 'leak-me',
      OS: 'Windows_NT',
      OS_API_KEY: 'leak-me',
    }, 'win32');
    expect(safe).toHaveProperty('Path');
    expect(safe).toHaveProperty('APPDATA');
    expect(safe).toHaveProperty('TEMP');
    expect(safe).toHaveProperty('OS');
    expect(safe).not.toHaveProperty('APPDATA_TOKEN');
    expect(safe).not.toHaveProperty('TEMP_SECRET');
    expect(safe).not.toHaveProperty('OS_API_KEY');
  });

  it('keeps the parenthesized ProgramFiles variants that exact-matching could drop', () => {
    const safe = shell.buildSafeEnv({
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
    }, 'win32');
    expect(safe).toHaveProperty('ProgramFiles(x86)');
    expect(safe).toHaveProperty('ProgramW6432');
  });
});

describe('buildSafeEnv — Windows folding must not widen the POSIX prefixes', () => {
  // Folding case for the PREFIX list (rather than only for the exact-name
  // Windows Set) reaches much further than intended: PortOS starts under
  // `npm run`, so npm's lower-case config vars are always present, and
  // npm_config__authToken is a registry credential.
  it('does not admit lower-case npm_config_* on Windows via the NPM_ prefix', () => {
    const safe = shell.buildSafeEnv({
      Path: 'C:\\Windows',
      npm_config__authToken: 'npm-registry-credential',
      npm_config_registry: 'https://example.com',
      npm_package_name: 'portos',
    }, 'win32');
    expect(safe).toHaveProperty('Path');
    expect(safe).not.toHaveProperty('npm_config__authToken');
    expect(safe).not.toHaveProperty('npm_config_registry');
    expect(safe).not.toHaveProperty('npm_package_name');
  });

  // The Windows names still need case-insensitive matching — that is the whole
  // point of the exact-name Set, and `Path` is why the fix exists.
  it('still matches the Windows names case-insensitively', () => {
    const safe = shell.buildSafeEnv(
      { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\cmd.exe', ProgramData: 'C:\\PD' },
      'win32'
    );
    for (const key of ['Path', 'SystemRoot', 'windir', 'ComSpec', 'ProgramData']) {
      expect(safe, `expected ${key} to survive`).toHaveProperty(key);
    }
  });
});
