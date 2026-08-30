import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistedState: null,
  writes: 0,
  worlds: new Map(),
  sent: [],
  deferredVerbAcks: [],
  deferVerbAcks: 0,
  appStatuses: [],
  appStatusReads: 0,
  self: { instanceId: 'instance-example', name: 'Example PortOS' },
}));

vi.mock('../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    dataPath: (...segments) => `/mock/data/${segments.join('/')}`,
    ensureDir: vi.fn(async () => {}),
    readJSONFile: vi.fn(async (_path, fallback) => structuredClone(mocks.persistedState ?? fallback)),
    atomicWrite: vi.fn(async (_path, value) => {
      mocks.persistedState = structuredClone(value);
      mocks.writes += 1;
    }),
  };
});

vi.mock('./instances.js', () => ({
  getSelf: vi.fn(async () => mocks.self),
  ensureSelf: vi.fn(async () => mocks.self),
  getPeers: vi.fn(async () => []),
}));

vi.mock('./apps.js', () => ({
  getAllApps: vi.fn(async () => []),
  getAppStatuses: vi.fn(async () => {
    mocks.appStatusReads += 1;
    return mocks.appStatuses;
  }),
}));

vi.mock('./eidoverse.js', () => ({
  EIDOVERSE_PORT: 8940,
  getEidoverseStatus: vi.fn(async () => ({
    installed: true,
    runtimeStatus: 'online',
    appId: 'app-eidoverse',
    worldDataReady: true,
  })),
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      this.identity = null;
      this.world = null;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
      });
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event, value) {
      for (const listener of this.listeners.get(event) || []) listener(value);
    }

    send(raw, callback) {
      const message = JSON.parse(String(raw));
      if (message.type === 'join') {
        this.identity = message.id;
        this.world = message.world;
        const state = mocks.worlds.get(message.world) || { roles: {} };
        if (!Object.keys(state.roles).length) state.roles[message.id] = { role: 'owner' };
        else state.roles[message.id] ||= { role: 'visitor' };
        mocks.worlds.set(message.world, state);
        mocks.sent.push({ type: 'join', world: message.world, actor: message.id, agent: message.agent });
        queueMicrotask(() => {
          callback?.(null);
          this.emit('message', JSON.stringify({
            type: 'snapshot',
            yourRights: { role: state.roles[message.id].role, gen: false },
            state: structuredClone(state),
          }));
        });
        return;
      }
      if (message.type === 'verb') {
        const state = mocks.worlds.get(this.world);
        if (message.verb === 'grant') {
          state.roles[message.args.id] = {
            ...(state.roles[message.args.id] || {}),
            ...(message.args.role ? { role: message.args.role } : {}),
            ...(message.args.gen !== undefined ? { gen: message.args.gen } : {}),
          };
        }
        mocks.sent.push({
          type: 'verb',
          world: this.world,
          actor: this.identity,
          verb: message.verb,
          args: structuredClone(message.args),
        });
        queueMicrotask(() => callback?.(null));
        const acknowledge = () => {
          if (this.readyState !== FakeWebSocket.OPEN) return;
          this.emit('message', JSON.stringify({
            type: 'log',
            entry: { actor: this.identity, verb: message.verb, args: message.args },
          }));
        };
        if (mocks.deferVerbAcks > 0) {
          mocks.deferVerbAcks -= 1;
          mocks.deferredVerbAcks.push(acknowledge);
        } else {
          queueMicrotask(acknowledge);
        }
      }
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      queueMicrotask(() => this.emit('close'));
    }

    terminate() {
      this.close();
    }
  }

  return { WebSocket: FakeWebSocket };
});

const world = await import('./eidoverseWorld.js');

beforeEach(async () => {
  await world.__resetEidoverseWorldForTests();
  mocks.persistedState = null;
  mocks.writes = 0;
  mocks.worlds.clear();
  mocks.sent.length = 0;
  mocks.deferredVerbAcks.length = 0;
  mocks.deferVerbAcks = 0;
  mocks.appStatuses = [];
  mocks.appStatusReads = 0;
});

describe('Eidoverse private-world lifecycle', () => {
  it('keeps status read-only when config has not been persisted yet', async () => {
    const status = await world.getEidoverseWorldStatus();

    expect(status).toMatchObject({
      world: 'portos',
      identity: { name: 'Example PortOS', source: 'instance-name' },
      presence: { connected: false },
    });
    expect(mocks.writes).toBe(0);
    expect(mocks.persistedState).toBeNull();
  });

  it('gives the human and persistent CoS owner roles and hands ownership to a renamed human', async () => {
    const first = await world.ensureEidoverseWorldPresence();

    expect(first).toMatchObject({ connected: true, id: 'portos-cos', role: 'owner' });
    expect(mocks.worlds.get('portos').roles).toMatchObject({
      'Example PortOS': { role: 'owner' },
      'portos-cos': { role: 'owner' },
    });

    await world.updateEidoverseWorldConfig({ humanName: 'Second Example User' });
    expect(await world.getEidoverseWorldStatus()).toMatchObject({
      identity: { name: 'Second Example User', role: null },
      presence: { connected: false, role: null },
    });
    const reconnected = await world.ensureEidoverseWorldPresence();

    expect(reconnected.role).toBe('owner');
    expect(mocks.worlds.get('portos').roles['Second Example User']).toMatchObject({ role: 'owner' });
    expect(mocks.worlds.get('portos').roles['Example PortOS']).toMatchObject({ role: 'visitor' });
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: 'Second Example User', role: 'owner' },
    }));
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: 'Example PortOS', role: 'visitor' },
    }));
    expect(mocks.persistedState.ownership.retired).toEqual([]);
  });

  it('clears observed roles when switching worlds or CoS identities', async () => {
    await world.ensureEidoverseWorldPresence();
    await world.updateEidoverseWorldConfig({ world: 'second-world', cosId: 'second-cos' });

    expect(await world.getEidoverseWorldStatus()).toMatchObject({
      world: 'second-world',
      identity: { role: null },
      cos: { id: 'second-cos', connected: false, role: null },
      presence: { connected: false, role: null },
    });
  });

  it('retires the prior human owner when the world and human identity change together', async () => {
    await world.ensureEidoverseWorldPresence();
    await world.updateEidoverseWorldConfig({
      world: 'second-world',
      humanName: 'Second Example User',
    });
    await world.ensureEidoverseWorldPresence();

    expect(mocks.worlds.get('portos').roles['Example PortOS']).toMatchObject({ role: 'visitor' });
    expect(mocks.worlds.get('second-world').roles).toMatchObject({
      'Second Example User': { role: 'owner' },
      'portos-cos': { role: 'owner' },
    });
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      world: 'portos',
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: 'Example PortOS', role: 'visitor' },
    }));
    expect(mocks.persistedState.ownership.retired).toEqual([]);
  });

  it('closes the persistent connection when the CoS presence is disabled', async () => {
    await world.ensureEidoverseWorldPresence();
    await world.updateEidoverseWorldConfig({ cosEnabled: false });

    expect((await world.getEidoverseWorldStatus()).presence.connected).toBe(false);
    await expect(world.ensureEidoverseWorldPresence()).rejects.toMatchObject({ code: 'EIDOVERSE_COS_DISABLED' });
  });

  it('stops a multi-operation augmentation before sending the next verb when canceled', async () => {
    await world.ensureEidoverseWorldPresence();
    mocks.sent.length = 0;
    const controller = new AbortController();
    const pending = world.augmentEidoverseWorld([
      { verb: 'spawn', args: { id: 'example-one', lib: 'eidoverse/assets/models/example.glb' } },
      { verb: 'spawn', args: { id: 'example-two', lib: 'eidoverse/assets/models/example.glb' } },
    ], { signal: controller.signal });

    await vi.waitFor(() => {
      expect(mocks.sent).toContainEqual(expect.objectContaining({ verb: 'spawn', args: expect.objectContaining({ id: 'example-one' }) }));
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.sent).not.toContainEqual(expect.objectContaining({ verb: 'spawn', args: expect.objectContaining({ id: 'example-two' }) }));
  });

  it('drops a canceled verb connection so its late acknowledgement cannot satisfy a retry', async () => {
    await world.ensureEidoverseWorldPresence();
    mocks.sent.length = 0;
    mocks.deferVerbAcks = 2;
    const operation = [{ verb: 'spawn', args: { id: 'example-one', lib: 'eidoverse/assets/models/example.glb' } }];
    const controller = new AbortController();
    const first = world.augmentEidoverseWorld(operation, { signal: controller.signal });

    await vi.waitFor(() => expect(mocks.deferredVerbAcks).toHaveLength(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    let retrySettled = false;
    const retry = world.augmentEidoverseWorld(operation).finally(() => { retrySettled = true; });
    await vi.waitFor(() => expect(mocks.deferredVerbAcks).toHaveLength(2));
    mocks.deferredVerbAcks[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retrySettled).toBe(false);

    mocks.deferredVerbAcks[1]();
    await expect(retry).resolves.toMatchObject({ success: true, applied: 1 });
  });

  it('releases a canceled projection without waiting for a slow source read', async () => {
    let resolveAppStatuses;
    mocks.appStatuses = new Promise((resolve) => {
      resolveAppStatuses = resolve;
    });
    const controller = new AbortController();
    const pending = world.projectEidoverseWorld({ signal: controller.signal });

    await vi.waitFor(() => expect(mocks.appStatusReads).toBe(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolveAppStatuses([]);
  });
});
