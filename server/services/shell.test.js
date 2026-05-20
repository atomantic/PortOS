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
    for (let i = 0; i < 5; i++) shell.createShellSession(makeSocket(`s${i}`));
    const socket = makeSocket('over');
    const id = shell.createShellSession(socket);
    expect(id).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('shell:error', {
      error: 'Max 5 shell sessions. Kill an existing session first.',
    });
  });

  it('does not throw when over-cap and socket is missing', () => {
    for (let i = 0; i < 5; i++) shell.createShellSession(makeSocket(`s${i}`));
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
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it('schedules initialCommand write after delay', () => {
    vi.useFakeTimers();
    const id = shell.createShellSession(makeSocket(), { initialCommand: 'ls', initialCommandDelayMs: 50 });
    expect(ptyInstances[0].write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(ptyInstances[0].write).toHaveBeenCalledWith('ls\n');
    expect(shell.getSession(id)).toBeTruthy();
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
