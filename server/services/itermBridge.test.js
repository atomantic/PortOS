import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  ITERM_NOTIFICATION,
  decodeItermClientMessage,
  encodeItermServerMessage,
} from '../lib/itermMessages.js';
import { staticImportClosure } from '../lib/staticImportGraph.js';
import { createItermBridge } from './itermBridge.js';

// A fake iTerm2 API server speaking the same PortOS-authored schema over a
// WebSocket on a temp Unix socket. Every fixture below is invented.

const pane = (uuid, width = 80, height = 24) => ({
  session: { uniqueIdentifier: uuid, gridSize: { width, height }, title: `title-${uuid}` },
});
const LAYOUT = {
  windows: [
    { windowId: 'win-a', tabs: [{ tabId: 'tab-1', root: { links: [pane('AAAA-1'), { node: { links: [pane('AAAA-2')] } }] } }] },
    { windowId: 'win-b', tabs: [{ tabId: 'tab-2', root: { links: [pane('BBBB-1', 120, 40)] } }] },
  ],
};

const startFakeIterm = async (socketPath) => {
  const state = {
    handshakes: [],
    requests: [],
    sockets: new Set(),
    layout: LAYOUT,
    onGetBuffer: null,
  };
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, handleProtocols: (protocols) => (protocols.has('api.iterm2.com') ? 'api.iterm2.com' : false) });
  const send = (ws, message) => ws.send(encodeItermServerMessage(message));
  wss.on('connection', (ws, req) => {
    state.handshakes.push({ headers: req.headers, protocol: ws.protocol });
    state.sockets.add(ws);
    ws.on('close', () => state.sockets.delete(ws));
    ws.on('message', async (data) => {
      const msg = decodeItermClientMessage(data);
      state.requests.push(msg);
      const reply = (body) => send(ws, { id: msg.id, ...body });
      if (msg.listSessionsRequest) reply({ listSessionsResponse: state.layout });
      else if (msg.notificationRequest) reply({ notificationResponse: { status: 0 } });
      else if (msg.variableRequest) {
        reply({ variableResponse: { status: 0, values: msg.variableRequest.get.map((name) => JSON.stringify(`${name}-${msg.variableRequest.sessionId}`)) } });
      } else if (msg.sendTextRequest) reply({ sendTextResponse: { status: 0 } });
      else if (msg.getBufferRequest) {
        await state.onGetBuffer?.(ws, msg);
        reply({
          getBufferResponse: {
            status: 0,
            contents: [{ text: `screen of ${msg.getBufferRequest.session}` }, { text: '$ ' }],
            cursor: { x: 2, y: 501 },
            windowedCoordRange: { coordRange: { start: { x: 0, y: 500 }, end: { x: 0, y: 502 } } },
          },
        });
      }
    });
  });
  await new Promise((done) => httpServer.listen(socketPath, done));
  state.notify = (notification) => {
    for (const ws of state.sockets) send(ws, { notification });
  };
  state.dropAll = () => {
    for (const ws of state.sockets) ws.terminate();
  };
  state.close = () => new Promise((done) => {
    state.dropAll();
    wss.close();
    httpServer.close(() => done());
  });
  state.count = (key) => state.requests.filter((r) => r[key]).length;
  return state;
};

const fakeSocket = (name) => {
  const events = [];
  return {
    name,
    events,
    emit: (event, payload) => events.push([event, payload]),
    last: (event) => events.filter(([e]) => e === event).at(-1)?.[1],
    all: (event) => events.filter(([e]) => e === event).map(([, p]) => p),
  };
};

describe('itermBridge', () => {
  let dir;
  let fake;
  let bridge;
  let deps;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'it2-'));
    const socketPath = join(dir, 's');
    fake = await startFakeIterm(socketPath);
    deps = {
      socketPath,
      enabled: true,
      running: true,
      auth: vi.fn(async () => ({ cookie: 'cookie-test', key: 'key-test' })),
      isRunning: vi.fn(async () => deps.running),
      detectInstall: vi.fn(async () => ({ state: 'ready' })),
      isFeatureEnabled: vi.fn(async () => deps.enabled),
      idleMs: 60,
      backoffInitialMs: 20,
      backoffMaxMs: 40,
      libraryVersion: 'node portos-test',
    };
    bridge = createItermBridge(deps);
  });

  afterEach(async () => {
    bridge.shutdown();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listAndConnect = async () => {
    const socket = fakeSocket('lister');
    await bridge.subscribeList(socket);
    await vi.waitFor(() => expect(socket.last('iterm:sessions')?.sessions?.[0]?.jobName).toBeTruthy());
    return socket;
  };

  it('makes no connection until a socket subscribes, then handshakes with every required header', async () => {
    await bridge.reconcileItermBridge({ reason: 'boot' });
    expect(deps.auth).not.toHaveBeenCalled();
    expect(fake.handshakes).toHaveLength(0);

    await listAndConnect();
    expect(fake.handshakes).toHaveLength(1);
    const { headers, protocol } = fake.handshakes[0];
    expect(protocol).toBe('api.iterm2.com');
    expect(headers).toMatchObject({
      origin: 'ws://localhost/',
      'x-iterm2-library-version': 'node portos-test',
      'x-iterm2-disable-auth-ui': 'true',
      'x-iterm2-cookie': 'cookie-test',
      'x-iterm2-key': 'key-test',
      'x-iterm2-advisory-name': 'PortOS',
    });
    const types = fake.requests.filter((r) => r.notificationRequest && !r.notificationRequest.variableMonitorRequest)
      .map((r) => r.notificationRequest.notificationType);
    expect(types).toEqual(expect.arrayContaining([
      ITERM_NOTIFICATION.NEW_SESSION, ITERM_NOTIFICATION.TERMINATE_SESSION, ITERM_NOTIFICATION.LAYOUT_CHANGE,
    ]));
    // Screen updates are NOT subscribed until someone views a session.
    expect(types).not.toContain(ITERM_NOTIFICATION.SCREEN_UPDATE);
  });

  it('builds its own registry in window → tab → pane order', async () => {
    const socket = await listAndConnect();
    await vi.waitFor(() => expect(socket.last('iterm:sessions').sessions.every((s) => s.cwd)).toBe(true));
    const { sessions, status } = socket.last('iterm:sessions');
    expect(status.state).toBe('connected');
    expect(sessions.map((s) => [s.id, s.windowIndex, s.tabIndex, s.paneIndex, s.paneCount])).toEqual([
      ['iterm-AAAA-1', 1, 1, 1, 2],
      ['iterm-AAAA-2', 1, 1, 2, 2],
      ['iterm-BBBB-1', 2, 1, 1, 1],
    ]);
    expect(sessions[2]).toMatchObject({ cols: 120, rows: 40, label: 'name-BBBB-1', jobName: 'jobName-BBBB-1', cwd: 'path-BBBB-1' });
  });

  it('never reaches the PortOS shell registry or the Workspaces grouping', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const closure = staticImportClosure(resolve(here, 'itermBridge.js')).files;
    expect(closure.has(resolve(here, 'shell.js'))).toBe(false);
    expect(closure.has(resolve(here, 'workspaceContext.js'))).toBe(false);
  });

  it('subscribes screen updates on first view, streams a rendered frame, and unsubscribes on last detach', async () => {
    await listAndConnect();
    const viewerA = fakeSocket('a');
    const viewerB = fakeSocket('b');
    expect(bridge.attachViewer('iterm-AAAA-2', viewerA)).toMatchObject({ id: 'iterm-AAAA-2', cols: 80, rows: 24 });
    await vi.waitFor(() => expect(viewerA.last('iterm:output')?.data).toContain('screen of AAAA-2'));
    // Cursor y=501 with row 1 at absolute line 500 → screen row 2, col 3.
    expect(viewerA.last('iterm:output').data).toContain('\x1b[2;3H');
    const screenSubs = () => fake.requests.filter((r) => r.notificationRequest?.notificationType === ITERM_NOTIFICATION.SCREEN_UPDATE);
    expect(screenSubs().map((r) => [r.notificationRequest.session, r.notificationRequest.subscribe])).toEqual([['AAAA-2', true]]);

    // A second viewer gets the cached frame without a second subscription.
    expect(bridge.attachViewer('iterm-AAAA-2', viewerB).bufferedOutput).toContain('screen of AAAA-2');
    bridge.detachViewer('iterm-AAAA-2', viewerA);
    expect(screenSubs()).toHaveLength(1);
    bridge.detachViewer('iterm-AAAA-2', viewerB);
    await vi.waitFor(() => expect(screenSubs().map((r) => r.notificationRequest.subscribe)).toEqual([true, false]));
  });

  it('coalesces a burst of screen updates to one in-flight fetch plus one trailing fetch', async () => {
    await listAndConnect();
    let first = true;
    fake.onGetBuffer = () => {
      if (!first) return;
      first = false;
      // Five updates land while the first fetch is still in flight.
      for (let i = 0; i < 5; i += 1) fake.notify({ screenUpdateNotification: { session: 'AAAA-1' } });
    };
    const viewer = fakeSocket('v');
    bridge.attachViewer('iterm-AAAA-1', viewer);
    await vi.waitFor(() => expect(viewer.all('iterm:output')).toHaveLength(2));
    await new Promise((done) => setTimeout(done, 50));
    expect(fake.count('getBufferRequest')).toBe(2);
  });

  it('types byte-exact input in order', async () => {
    await listAndConnect();
    const inputs = ['l', 's', '\r', '\x1b[A', '\x03', '\x1b[200~line one\nline two\x1b[201~'];
    for (const data of inputs) expect(bridge.sendInput('iterm-BBBB-1', data)).toBe(true);
    await vi.waitFor(() => expect(fake.count('sendTextRequest')).toBe(inputs.length));
    expect(fake.requests.filter((r) => r.sendTextRequest).map((r) => [r.sendTextRequest.session, r.sendTextRequest.text]))
      .toEqual(inputs.map((text) => ['BBBB-1', text]));
    expect(bridge.sendInput('iterm-missing', 'x')).toBe(false);
  });

  it('drops a terminated session and tells its viewers', async () => {
    const socket = await listAndConnect();
    const viewer = fakeSocket('v');
    bridge.attachViewer('iterm-AAAA-1', viewer);
    fake.notify({ terminateSessionNotification: { sessionId: 'AAAA-1' } });
    await vi.waitFor(() => expect(viewer.last('iterm:exit')).toEqual({ id: 'iterm-AAAA-1' }));
    expect(socket.last('iterm:sessions').sessions.map((s) => s.id)).toEqual(['iterm-AAAA-2', 'iterm-BBBB-1']);
  });

  it('clears the registry when iTerm2 goes away and reconnects without ever launching it', async () => {
    const socket = await listAndConnect();
    const viewer = fakeSocket('v');
    bridge.attachViewer('iterm-AAAA-1', viewer);
    expect(deps.auth).toHaveBeenCalledTimes(1);

    // iTerm2 quits: the socket drops and the running check now says no.
    deps.running = false;
    fake.dropAll();
    await vi.waitFor(() => expect(viewer.last('iterm:exit')).toEqual({ id: 'iterm-AAAA-1' }));
    await vi.waitFor(() => expect(socket.last('iterm:sessions').status.state).toBe('not-running'));
    expect(socket.last('iterm:sessions').sessions).toEqual([]);
    expect(deps.auth).toHaveBeenCalledTimes(1); // no cookie request while not running

    // iTerm2 relaunches: the backoff loop reconnects on its own.
    deps.running = true;
    await vi.waitFor(() => expect(socket.last('iterm:sessions').status.state).toBe('connected'));
    expect(deps.auth).toHaveBeenCalledTimes(2);
    expect(fake.handshakes).toHaveLength(2);
  });

  it('reports a static install problem without probing iTerm2 at all', async () => {
    deps.detectInstall.mockResolvedValue({ state: 'api-disabled' });
    const socket = fakeSocket('lister');
    await bridge.subscribeList(socket);
    expect(socket.last('iterm:sessions').status.state).toBe('api-disabled');
    expect(deps.isRunning).not.toHaveBeenCalled();
    expect(deps.auth).not.toHaveBeenCalled();
    expect(await bridge.getItermStatus()).toEqual({ state: 'api-disabled', detail: null });
  });

  it('disconnects immediately when the feature turns off', async () => {
    const socket = await listAndConnect();
    deps.enabled = false;
    await bridge.reconcileItermBridge({ reason: 'feature-toggle' });
    expect(socket.last('iterm:sessions')).toMatchObject({ status: { state: 'disconnected' }, sessions: [] });
    await vi.waitFor(() => expect(fake.sockets.size).toBe(0));
  });

  it('disconnects after the idle window once the last subscriber leaves', async () => {
    const socket = await listAndConnect();
    await bridge.unsubscribeList(socket);
    expect(fake.sockets.size).toBe(1); // still inside the idle window
    await vi.waitFor(() => expect(fake.sockets.size).toBe(0));
    expect(await bridge.getItermStatus()).toEqual({ state: 'disconnected', detail: null });
  });
});
