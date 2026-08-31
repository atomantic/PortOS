import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistedState: null,
  writes: 0,
  worlds: new Map(),
  sent: [],
  deferredVerbAcks: [],
  deferVerbAcks: 0,
  rejectVerb: null,
  rejectedVerb: false,
  appStatuses: [],
  appStatusReads: 0,
  eidoverseStatus: {
    installed: true,
    runtimeStatus: 'online',
    appId: 'app-eidoverse',
    worldDataReady: true,
  },
  self: { instanceId: 'instance-example', name: 'Example PortOS' },
  worldStatePath: '/mock/data/eidoverse/portos-world.json',
}));

const DEFAULT_HUMAN_NAME = 'portos-8e9b660b05fb';

vi.mock('../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    dataPath: (...segments) => `/mock/data/${segments.join('/')}`,
    ensureDir: vi.fn(async () => {}),
    readJSONFile: vi.fn(async (path, fallback) => structuredClone(
      path === mocks.worldStatePath ? (mocks.persistedState ?? fallback) : fallback,
    )),
    atomicWrite: vi.fn(async (path, value) => {
      if (path !== mocks.worldStatePath) return;
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
  getEidoverseStatus: vi.fn(async () => structuredClone(mocks.eidoverseStatus)),
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
        if (message.verb === mocks.rejectVerb && !mocks.rejectedVerb) {
          mocks.rejectedVerb = true;
          queueMicrotask(() => this.emit('message', JSON.stringify({
            type: 'error',
            error: 'synthetic projection rejection',
          })));
          return;
        }
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
  mocks.rejectVerb = null;
  mocks.rejectedVerb = false;
  mocks.appStatuses = [];
  mocks.appStatusReads = 0;
  mocks.eidoverseStatus = {
    installed: true,
    runtimeStatus: 'online',
    appId: 'app-eidoverse',
    worldDataReady: true,
  };
  const libraryFiles = Object.values(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assetRecipe.slots)
    .flatMap((slot) => [
      { path: slot.preferredPaths[0], size: Math.min(slot.maxBytes, 1_000_000) },
      { path: slot.fallback, size: 1_000_000 },
    ]);
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/version') return Response.json({ sha: 'example-build', commitTime: '2026-01-01T00:00:00.000Z' });
    if (url.pathname === '/library-list') return Response.json(libraryFiles);
    if (url.pathname === '/library-models') return Response.json([]);
    if (url.pathname.startsWith('/library/')) return new Response(init?.method === 'HEAD' ? null : '', { status: 200 });
    return new Response(null, { status: 404 });
  }));
});

describe('Eidoverse private-world lifecycle', () => {
  it('keeps status read-only when config has not been persisted yet', async () => {
    const status = await world.getEidoverseWorldStatus();

    expect(status).toMatchObject({
      world: 'portos',
      identity: { name: DEFAULT_HUMAN_NAME, source: 'instance-id' },
      presence: { connected: false },
    });
    expect(mocks.writes).toBe(0);
    expect(mocks.persistedState).toBeNull();
  });

  it('does not cold-project a fresh install at boot even when the runtime is online', async () => {
    await world.ensureEidoverseWorldConfig();

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({
      reconciled: false,
      reason: 'current',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
    expect(mocks.persistedState.pendingDesignVersion).toBe(2);
  });

  it('leaves a prepared boot-time design update pending without starting an offline runtime', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 1;
    mocks.persistedState.migrationReport = {
      status: 'ready',
      fromDesignVersion: 1,
      toDesignVersion: 2,
    };
    mocks.eidoverseStatus.runtimeStatus = 'stopped';

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({
      reconciled: false,
      reason: 'runtime-offline',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
    expect(mocks.persistedState.pendingDesignVersion).toBe(2);
  });

  it('gives the human and persistent CoS owner roles and hands ownership to a renamed human', async () => {
    const first = await world.ensureEidoverseWorldPresence();

    expect(first).toMatchObject({ connected: true, id: 'portos-cos', role: 'owner' });
    expect(mocks.worlds.get('portos').roles).toMatchObject({
      [DEFAULT_HUMAN_NAME]: { role: 'owner' },
      'portos-cos': { role: 'owner' },
    });
    expect(JSON.stringify(mocks.sent)).not.toContain(mocks.self.name);

    await world.updateEidoverseWorldConfig({ humanName: 'Second Example User' });
    expect(await world.getEidoverseWorldStatus()).toMatchObject({
      identity: { name: 'Second Example User', role: null },
      presence: { connected: false, role: null },
    });
    const reconnected = await world.ensureEidoverseWorldPresence();

    expect(reconnected.role).toBe('owner');
    expect(mocks.worlds.get('portos').roles['Second Example User']).toMatchObject({ role: 'owner' });
    expect(mocks.worlds.get('portos').roles[DEFAULT_HUMAN_NAME]).toMatchObject({ role: 'visitor' });
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: 'Second Example User', role: 'owner' },
    }));
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: DEFAULT_HUMAN_NAME, role: 'visitor' },
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

    expect(mocks.worlds.get('portos').roles[DEFAULT_HUMAN_NAME]).toMatchObject({ role: 'visitor' });
    expect(mocks.worlds.get('second-world').roles).toMatchObject({
      'Second Example User': { role: 'owner' },
      'portos-cos': { role: 'owner' },
    });
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      world: 'portos',
      actor: 'portos-cos',
      verb: 'grant',
      args: { id: DEFAULT_HUMAN_NAME, role: 'visitor' },
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
    mocks.deferVerbAcks = 1;
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

  it('preflights and locks recipe assets before completing a V2 reconciliation', async () => {
    const result = await world.projectEidoverseWorld();

    const expectedSlots = ['nexus', 'app', 'agent', 'task', 'goal', 'memory', 'storage', 'peer', 'activity', 'district'];
    expect(Object.keys(result.design.assetResolutions)).toEqual(expectedSlots);
    expect(Object.keys(mocks.persistedState.assetResolutions)).toEqual(expectedSlots);
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library/eidoverse/'))).toHaveLength(10);
    expect(result.summary.assetCatalogFingerprint).toEqual(expect.any(String));

    expect(result).toMatchObject({
      success: true,
      summary: { designVersion: 2, maxLiveEntities: 48, assetRecipeVersion: 2 },
      design: {
        selectedVersion: 2,
        lastAppliedVersion: 2,
        pendingVersion: null,
        reconciliation: { status: 'complete', checkpoint: 'projection-committed' },
      },
    });
    expect(Object.keys(result.design.assetResolutions)).toHaveLength(10);
    expect(mocks.persistedState).toMatchObject({
      schemaVersion: 2,
      lastAppliedDesignVersion: 2,
      pendingDesignVersion: null,
      reconciliation: { status: 'complete' },
    });
    expect(mocks.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'sky', args: expect.objectContaining({ system: 'skymesh' }) }),
      expect.objectContaining({ verb: 'light', args: expect.objectContaining({ id: 'portos-design-v2-light-nexus' }) }),
    ]));
    const authoredVerbs = mocks.sent.filter(({ type, verb }) => type === 'verb' && verb !== 'grant');
    expect(authoredVerbs[0].verb).toBe('terrain');
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library-models')).length).toBe(0);

    fetch.mockClear();
    await world.projectEidoverseWorld();
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library-list'))).toHaveLength(0);
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library-models'))).toHaveLength(0);
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library/eidoverse/'))).toHaveLength(10);

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({ reconciled: false, reason: 'current' });
  });

  it('keeps the previous atmosphere authoritative until V2 infrastructure exists during an upgrade', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 1;
    mocks.persistedState.pendingDesignVersion = 2;

    await world.projectEidoverseWorld();

    const authoredVerbs = mocks.sent.filter(({ type, verb }) => type === 'verb' && verb !== 'grant');
    const firstInfrastructure = authoredVerbs.findIndex(({ verb }) => verb === 'spawn');
    const firstEnvironment = authoredVerbs.findIndex(({ verb }) => verb === 'terrain');
    expect(firstInfrastructure).toBeGreaterThanOrEqual(0);
    expect(firstEnvironment).toBeGreaterThan(firstInfrastructure);
  });

  it('excludes a catalog-listed asset whose bytes disappeared and locks a verified fallback', async () => {
    const slots = world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assetRecipe.slots;
    const appPreferred = slots.app.preferredPaths[0];
    const libraryFiles = Object.values(slots).flatMap((slot) => [
      { path: slot.preferredPaths[0], size: Math.min(slot.maxBytes, 1_000_000) },
      { path: slot.fallback, size: 1_000_000 },
    ]);
    fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/version') return Response.json({ sha: 'example-build', commitTime: '2026-01-01T00:00:00.000Z' });
      if (url.pathname === '/library-list') return Response.json(libraryFiles);
      if (url.pathname === '/library-models') return Response.json([]);
      if (url.pathname === `/library/${appPreferred}` && init?.method === 'HEAD') return new Response(null, { status: 404 });
      if (url.pathname.startsWith('/library/')) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });

    const result = await world.projectEidoverseWorld();

    expect(result.design.assetResolutions.app).toMatchObject({
      path: slots.app.fallback,
      strategy: 'fallback',
    });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/library-models'))).toBe(true);
  });

  it('writes only opaque resource keys and generic labels to the Eidoverse log', async () => {
    mocks.appStatuses = [{
      id: 'example-private-app-record',
      name: 'Example confidential application',
      overallStatus: 'online',
      managed: true,
    }];

    await world.projectEidoverseWorld();

    const serializedLog = JSON.stringify(mocks.sent.filter(({ type }) => type === 'verb'));
    expect(serializedLog).toContain('"kind":"app"');
    expect(serializedLog).toContain('"label":"Managed app"');
    expect(serializedLog).toContain('"count":1');
    expect(serializedLog).not.toMatch(/example-private-app-record|Example confidential application/);
  });

  it('fails before world mutation when the Eidoverse protocol identity is unavailable', async () => {
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(world.projectEidoverseWorld()).rejects.toMatchObject({ code: 'EIDOVERSE_PROTOCOL_INCOMPATIBLE' });
    expect(mocks.sent.some(({ type }) => type === 'verb')).toBe(false);
    expect(mocks.persistedState).toMatchObject({
      lastAppliedDesignVersion: null,
      pendingDesignVersion: 2,
      reconciliation: { status: 'failed' },
    });
  });

  it('preserves the prior design when required asset resolution fails', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 1;
    fetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/version') return Response.json({ sha: 'example-build', commitTime: '2026-01-01T00:00:00.000Z' });
      if (url.pathname === '/library-list' || url.pathname === '/library-models') return Response.json([]);
      return new Response(null, { status: 404 });
    });

    const error = await world.projectEidoverseWorld().then(() => null, (reason) => reason);
    expect(error).toMatchObject({ code: 'EIDOVERSE_ASSET_RECIPE_UNRESOLVED' });
    expect(error.message).toMatch(/nexus.*app.*agent/);
    expect(mocks.sent.some(({ type }) => type === 'verb')).toBe(false);
    expect(mocks.persistedState).toMatchObject({
      lastAppliedDesignVersion: 1,
      pendingDesignVersion: 2,
      reconciliation: {
        status: 'failed',
        errorCode: 'EIDOVERSE_ASSET_RECIPE_UNRESOLVED',
        errorContext: { missing: expect.arrayContaining(['nexus', 'app', 'agent']) },
      },
    });
  });

  it('verifies and records an explicit install-local store override', async () => {
    await world.updateEidoverseWorldConfig({ assetOverrides: { app: 'store/example-local-asset' } });

    const result = await world.projectEidoverseWorld();

    expect(result.design.assetResolutions.app).toMatchObject({
      path: 'store/example-local-asset',
      userOverride: true,
      shippedDefault: false,
    });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/library/store/example-local-asset'))).toBe(true);
  });

  it('resets only the selected district asset lock and override', async () => {
    await world.projectEidoverseWorld();
    await world.updateEidoverseWorldConfig({
      assetOverrides: {
        app: 'store/example-local-asset',
        operations: 'store/example-legacy-operations',
      },
    });

    const reset = await world.updateEidoverseWorldConfig({ reset: { scope: 'district', districtId: 'apps' } });

    expect(reset.design.userOverrides.assets?.app).toBeUndefined();
    expect(reset.design.assetResolutions.app).toBeUndefined();
    expect(reset.design.assetResolutions.agent).toBeTruthy();
    expect(reset.design.pendingVersion).toBe(2);

    const nexusReset = await world.updateEidoverseWorldConfig({ reset: { scope: 'district', districtId: 'nexus' } });
    expect(nexusReset.design.userOverrides.assets?.operations).toBeUndefined();
  });

  it('compensates partially applied V2 entities and leaves the prior design authoritative', async () => {
    mocks.rejectVerb = 'comp';

    await expect(world.projectEidoverseWorld()).rejects.toMatchObject({
      code: 'EIDOVERSE_WORLD_VERB_REJECTED',
      compensationStatus: 'complete',
    });

    const firstSpawn = mocks.sent.find((entry) => entry.verb === 'spawn' && entry.args.id.startsWith('portos-design-v2-'));
    expect(firstSpawn).toBeTruthy();
    expect(mocks.sent).toContainEqual(expect.objectContaining({
      verb: 'remove',
      args: { id: firstSpawn.args.id },
    }));
    expect(mocks.persistedState).toMatchObject({
      lastAppliedDesignVersion: null,
      pendingDesignVersion: 2,
      reconciliation: {
        status: 'failed',
        checkpoint: 'compensation-complete',
        compensationStatus: 'complete',
      },
    });
  });

  it('mows a newly applied field when a later environment operation fails', async () => {
    mocks.rejectVerb = 'light';

    await expect(world.projectEidoverseWorld()).rejects.toMatchObject({
      code: 'EIDOVERSE_WORLD_VERB_REJECTED',
      compensationStatus: 'complete',
    });

    expect(mocks.sent).toContainEqual(expect.objectContaining({
      verb: 'grass',
      args: { clear: true },
    }));
  });
});
