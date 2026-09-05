import { createHash } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistedState: null,
  writes: 0,
  worlds: new Map(),
  socketUrls: [],
  sockets: [],
  nextSeq: 0,
  sent: [],
  deferredVerbAcks: [],
  deferVerbAcks: 0,
  rejectVerb: null,
  rejectedVerb: false,
  appStatuses: [],
  appStatusReads: 0,
  featureEnabled: true,
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
  const isWorldStatePath = (path) => String(path).replaceAll('\\', '/') === mocks.worldStatePath;
  return {
    ...actual,
    dataPath: (...segments) => `/mock/data/${segments.join('/')}`,
    ensureDir: vi.fn(async () => {}),
    readJSONFile: vi.fn(async (path, fallback) => structuredClone(
      isWorldStatePath(path) ? (mocks.persistedState ?? fallback) : fallback,
    )),
    atomicWrite: vi.fn(async (path, value) => {
      if (!isWorldStatePath(path)) return;
      mocks.persistedState = structuredClone(value);
      mocks.writes += 1;
    }),
  };
});

vi.mock('./instances.js', () => ({
  getSelf: vi.fn(async () => mocks.self),
  ensureSelf: vi.fn(async () => mocks.self),
  getInstanceId: vi.fn(async () => mocks.self?.instanceId ?? 'unknown-instance'),
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

vi.mock('./instanceFeatures.js', () => ({
  getInstanceFeatures: vi.fn(async () => ({
    features: [{ id: 'eidoverse', enabled: mocks.featureEnabled }],
  })),
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.readyState = 0;
      this.listeners = new Map();
      this.identity = null;
      this.world = null;
      mocks.socketUrls.push(String(url));
      mocks.sockets.push(this);
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
        mocks.sent.push({ type: 'join', world: message.world, actor: message.id, agent: message.agent, guest: message.guest });
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
          sentAt: Date.now(),
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
          const log = JSON.stringify({ type: 'log', entry: { seq: mocks.nextSeq++, actor: this.identity, verb: message.verb, args: message.args } });
          if (message.verb === 'say') {
            for (const socket of mocks.sockets) {
              if (socket.world === this.world && socket.readyState === FakeWebSocket.OPEN) socket.emit('message', log);
            }
          } else this.emit('message', log);
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
const { EIDOVERSE_WORLD_DESIGN_V1 } = await import('../lib/eidoverseWorldDesign.js');

beforeEach(async () => {
  vi.unstubAllEnvs();
  await world.__resetEidoverseWorldForTests();
  mocks.persistedState = null;
  mocks.writes = 0;
  mocks.worlds.clear();
  mocks.socketUrls.length = 0;
  mocks.sockets.length = 0;
  mocks.nextSeq = 0;
  mocks.sent.length = 0;
  mocks.deferredVerbAcks.length = 0;
  mocks.deferVerbAcks = 0;
  mocks.rejectVerb = null;
  mocks.rejectedVerb = false;
  mocks.appStatuses = [];
  mocks.appStatusReads = 0;
  mocks.featureEnabled = true;
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
  const uploadedAssets = new Set();
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/version') return Response.json({ sha: 'example-build', commitTime: '2026-01-01T00:00:00.000Z' });
    if (url.pathname === '/library-list') return Response.json(libraryFiles);
    if (url.pathname === '/library-models') return Response.json([]);
    if (url.pathname === '/geom') return Response.json({ bbox: { min: [-1, 0, -1], max: [1, 2, 1] } });
    if (url.pathname === '/upload') {
      const path = `store/${createHash('sha256').update(init.body).digest('hex').slice(0, 16)}.glb`;
      uploadedAssets.add(`/library/${path}`);
      return Response.json({ path });
    }
    if (/^\/library\/store\/[0-9a-f]{16}\.glb$/.test(url.pathname) && !uploadedAssets.has(url.pathname)) return new Response(null, { status: 404 });
    if (url.pathname.startsWith('/library/')) return new Response(init?.method === 'HEAD' ? null : '', { status: 200 });
    return new Response(null, { status: 404 });
  }));
});

describe('Eidoverse private-world lifecycle', () => {
  it('keeps status read-only when config has not been persisted yet', async () => {
    const status = await world.getEidoverseWorldStatus();
    const compact = await world.getEidoverseWorldStatus({ compact: true });
    expect(compact).toMatchObject({ setup: { installed: true, runtimeStatus: 'online' }, cos: { connected: false } });
    expect(JSON.stringify(compact).length).toBeLessThan(4000);
    expect(compact).not.toHaveProperty('instance');
    expect(compact).not.toHaveProperty('recipe');
    expect(compact).not.toHaveProperty('human');
    expect(mocks.sent).toHaveLength(0);

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
    expect(mocks.persistedState.pendingDesignVersion).toBe(3);
  });

  it('reconciles a migrated V1 world through the normal online boot path', async () => {
    mocks.persistedState = {
      schemaVersion: 1,
      world: 'portos',
      recipe: EIDOVERSE_WORLD_DESIGN_V1,
    };

    const result = await world.reconcilePendingEidoverseWorld();

    expect(result.reconciled).toBe(true);
    expect(mocks.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'terrain' }),
      expect.objectContaining({
        verb: 'spawn',
        args: expect.objectContaining({ id: expect.stringMatching(/^portos-design-v2-/) }),
      }),
    ]));
    expect(mocks.persistedState).toMatchObject({
      schemaVersion: 3,
      lastAppliedDesignVersion: 3,
      pendingDesignVersion: null,
      migrationReport: { status: 'applied' },
      reconciliation: { status: 'complete', checkpoint: 'projection-committed' },
    });
  });

  it('reads projection progress without runtime, app-registry, or library probes', async () => {
    await world.ensureEidoverseWorldConfig();
    fetch.mockClear();
    mocks.appStatusReads = 0;

    const progress = await world.getEidoverseWorldProjectionStatus();

    expect(progress).toMatchObject({
      design: { selectedVersion: 3, pendingVersion: 3 },
      projection: { lastRunAt: null },
    });
    expect(mocks.appStatusReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves a pending upgrade untouched when the Eidoverse feature is disabled', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 1;
    mocks.persistedState.migrationReport = {
      status: 'ready',
      fromDesignVersion: 1,
      toDesignVersion: 3,
    };
    mocks.featureEnabled = false;

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({
      reconciled: false,
      reason: 'feature-disabled',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
    expect(mocks.persistedState.pendingDesignVersion).toBe(3);
  });

  it('leaves a prepared boot-time design update pending without starting an offline runtime', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 1;
    mocks.persistedState.migrationReport = {
      status: 'ready',
      fromDesignVersion: 1,
      toDesignVersion: 3,
    };
    mocks.eidoverseStatus.runtimeStatus = 'stopped';

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({
      reconciled: false,
      reason: 'runtime-offline',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
    expect(mocks.persistedState.pendingDesignVersion).toBe(3);
  });

  it('marks a persisted in-flight projection as interrupted before boot reconciliation', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.reconciliation = {
      ...mocks.persistedState.reconciliation,
      status: 'applying',
      checkpoint: 'applying-live',
      operationCount: 20,
      appliedOperations: 5,
    };
    fetch.mockClear();

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({
      reconciled: false,
      reason: 'interrupted',
    });
    expect(mocks.persistedState.reconciliation).toMatchObject({
      status: 'failed',
      checkpoint: 'interrupted',
      errorCode: 'EIDOVERSE_PROJECTION_INTERRUPTED',
      operationCount: 20,
      appliedOperations: 5,
    });
    expect(mocks.persistedState.pendingDesignVersion).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
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

  it('migrates a stale V1 recipe submitted after the update instead of pinning V1 defaults', async () => {
    const updated = await world.updateEidoverseWorldConfig({ recipe: EIDOVERSE_WORLD_DESIGN_V1 });

    expect(updated.design.userOverrides).toEqual({});
    expect(updated.recipe).toMatchObject({
      version: 3,
      limits: {
        apps: world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits.apps,
        tasks: world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits.tasks,
      },
      environment: {
        terrain: {
          size: world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.environment.terrain.size,
          segments: world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.environment.terrain.segments,
        },
      },
    });
  });

  it('persists every writable field accepted in a V2 recipe submission', async () => {
    const recipe = structuredClone(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.name = 'Example Systems Garden';
    recipe.maxEntities = 12;
    recipe.districts[0].label = 'Example Nexus';
    recipe.paths = [{ id: 'example-route', label: 'Example Route', toDistrictId: 'apps', nodes: [[1, 0, 1]] }];

    const updated = await world.updateEidoverseWorldConfig({ recipe });

    expect(updated.design.userOverrides).toMatchObject({
      name: 'Example Systems Garden',
      maxEntities: 12,
    });
    expect(updated.design.userOverrides.districts[0].label).toBe('Example Nexus');
    expect(updated.design.userOverrides.paths[0].label).toBe('Example Route');
    expect(updated.recipe).toMatchObject({
      name: 'Example Systems Garden',
      maxEntities: 12,
    });
    expect(updated.recipe.districts[0].label).toBe('Example Nexus');
    expect(updated.recipe.paths[0].label).toBe('Example Route');
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

  it('continues projection when a prior-world actor cannot retire an old owner', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.ownership.retired = [{
      world: 'example-prior-world',
      id: 'Example Retired Owner',
      actorId: 'example-retired-actor',
      actorAvatar: 'eidoverse/assets/vrms/example-retired-actor.vrm',
    }];
    mocks.worlds.set('example-prior-world', {
      roles: {
        'example-existing-owner': { role: 'owner' },
        'example-retired-actor': { role: 'visitor' },
      },
    });

    const result = await world.projectEidoverseWorld();

    expect(result.success).toBe(true);
    expect(mocks.persistedState.ownership.retired).toEqual([expect.objectContaining({
      world: 'example-prior-world',
      id: 'Example Retired Owner',
      attempts: 1,
    })]);
    expect(mocks.persistedState.reconciliation).toMatchObject({
      status: 'complete',
      retiredOwnerCleanup: {
        status: 'partial',
        failedCount: 1,
        retryingCount: 1,
        droppedCount: 0,
        codes: ['EIDOVERSE_OWNER_HANDOFF_FAILED'],
      },
    });
    expect(mocks.sent).toContainEqual(expect.objectContaining({ verb: 'terrain' }));

    await world.projectEidoverseWorld();
    expect(mocks.persistedState.ownership.retired[0]).toMatchObject({ attempts: 2 });

    await world.projectEidoverseWorld();
    expect(mocks.persistedState.ownership.retired).toEqual([]);
    expect(mocks.persistedState.reconciliation.retiredOwnerCleanup).toMatchObject({
      failedCount: 1,
      retryingCount: 0,
      droppedCount: 1,
    });

    await world.projectEidoverseWorld();
    expect(mocks.persistedState.reconciliation.retiredOwnerCleanup).toBeUndefined();
  });

  it('retries only a retired owner whose demotion verb failed', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.ownership.retired = [
      { world: 'portos', id: 'Example Failed Owner' },
      { world: 'portos', id: 'Example Successful Owner' },
    ];
    mocks.worlds.set('portos', {
      roles: {
        [DEFAULT_HUMAN_NAME]: { role: 'owner' },
        'portos-cos': { role: 'owner' },
        'Example Failed Owner': { role: 'owner' },
        'Example Successful Owner': { role: 'owner' },
      },
    });
    mocks.rejectVerb = 'grant';

    await expect(world.projectEidoverseWorld()).resolves.toMatchObject({ success: true });

    expect(mocks.persistedState.ownership.retired).toEqual([expect.objectContaining({
      world: 'portos',
      id: 'Example Failed Owner',
      attempts: 1,
    })]);
    expect(mocks.persistedState.reconciliation.retiredOwnerCleanup).toMatchObject({
      failedCount: 1,
      retryingCount: 1,
      droppedCount: 0,
      codes: ['EIDOVERSE_WORLD_VERB_REJECTED'],
    });

    await expect(world.projectEidoverseWorld()).resolves.toMatchObject({ success: true });
    expect(mocks.persistedState.ownership.retired).toEqual([]);
    expect(mocks.persistedState.reconciliation.retiredOwnerCleanup).toBeUndefined();
  });

  it('makes the full reset a recovery for retired ownership and cached roles', async () => {
    await world.ensureEidoverseWorldPresence();
    mocks.persistedState.ownership.retired = [{
      world: 'example-prior-world',
      id: 'Example Retired Owner',
    }];
    mocks.persistedState.human.role = 'owner';
    mocks.persistedState.cos.role = 'owner';
    mocks.persistedState.reconciliation.retiredOwnerCleanup = { status: 'partial', failedCount: 1 };
    mocks.persistedState.migrationReport = {
      status: 'ready',
      retiredOwnerCleanup: { status: 'partial', failedCount: 1 },
    };

    const reset = await world.updateEidoverseWorldConfig({
      world: 'example-reset-world',
      humanName: 'Example Reset Human',
      reset: { scope: 'all' },
    });
    const status = await world.getEidoverseWorldStatus();

    expect(reset).toMatchObject({
      human: { role: null },
      cos: { role: null },
      design: {
        migrationReport: { status: 'ready' },
        reconciliation: { status: 'pending', checkpoint: 'configuration-saved' },
      },
    });
    expect(status.presence).toMatchObject({ connected: false, role: null });
    expect(reset.design.migrationReport.retiredOwnerCleanup).toBeUndefined();
    expect(reset.design.reconciliation.retiredOwnerCleanup).toBeUndefined();
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

  // Anyone who can reach the Eidoverse door reads this payload, so a field
  // naming the machine, its network, or its operator would leak on every join.
  it('names its host opaquely on GET /host, and carries no machine identity', async () => {
    const descriptor = await world.readEidoverseHostDescriptor();

    expect(Object.keys(descriptor).sort()).toEqual(['caps', 'id', 'kind', 'label', 'version']);
    expect(descriptor).toMatchObject({
      id: expect.stringMatching(/^hst_[0-9a-f]{12}$/),
      kind: 'portos',
      label: world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.name,
      version: expect.any(String),
      caps: { eido: false },
    });

    const serialized = JSON.stringify(descriptor);
    for (const identity of [hostname(), hostname().split('.')[0], homedir(), userInfo().username]) {
      if (identity) expect(serialized).not.toContain(identity);
    }
    expect(serialized).not.toContain(mocks.self.instanceId);
    expect(serialized).not.toContain(mocks.self.name);
    expect(serialized).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}|\.ts\.net|\/Users\/|\/home\//);
    // Stable across reads: the id is a digest of this install, not a nonce.
    expect((await world.readEidoverseHostDescriptor()).id).toBe(descriptor.id);
  });

  // The label is the operator's, not a constant: a renamed world has to reach
  // the door, or `GET /host` and the world's own meta entity disagree.
  it('serves the operator-chosen world title as the host descriptor label', async () => {
    const recipe = structuredClone(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.name = 'Example Systems Garden';
    const updated = await world.updateEidoverseWorldConfig({ recipe });

    const descriptor = await world.readEidoverseHostDescriptor();
    expect(descriptor.label).toBe('Example Systems Garden');
    // The same string the projection hangs on the world's meta entity.
    expect(updated.design.name).toBe(descriptor.label);
  });

  // The world says who hosts it. A live projection has to actually supply that
  // meta, or the reconciliation sweep deletes the carrier on the next run.
  it('plants the world meta entity, naming its host opaquely and never by machine', async () => {
    await world.projectEidoverseWorld();

    const metaComp = mocks.sent.find(({ verb, args }) => (
      verb === 'comp' && args?.id === 'portos-design-v2-meta' && args?.type === 'portos'
    ));
    expect(metaComp?.args.data).toMatchObject({
      kind: 'world-meta',
      managedBy: 'portos',
      designVersion: 3,
      meta: { title: expect.any(String), hostId: expect.stringMatching(/^hst_[0-9a-f]{12}$/) },
    });
    expect(JSON.stringify(metaComp.args.data)).not.toContain(mocks.self.instanceId);
    expect(JSON.stringify(metaComp.args.data)).not.toContain(mocks.self.name);
  });

  it('keeps scheduled results compact while persisting aliases and the full legend across reconnect', async () => {
    mocks.appStatuses = [{ id: 'app-example', name: 'Example private title', overallStatus: 'online' }];
    fetch.mockImplementationOnce(async () => Response.json({
      sha: 'example-label-build', commitTime: '2026-01-01T00:00:00.000Z',
      capabilities: { objectLabels: 1, portosNavigation: 1, labelPreferences: 99, largeWorldColliders: 1 },
    }));
    const first = await world.projectEidoverseWorld();
    expect(first.design.reconciliation.runtimeVersion.capabilities).toEqual({ objectLabels: 1, portosNavigation: 1, labelPreferences: null, largeWorldColliders: 1 });
    expect(first.design.assetResolutions.citySurface.bytes).toBeGreaterThan(1_000_000);
    const object = first.summary.objects.find(({ kind }) => kind === 'app');
    expect(object).toBeDefined();
    await world.updateEidoverseWorldConfig({ labelAliases: { [object.resourceKey]: 'Example tower' } });
    const { SCRIPT_HANDLERS } = await import('./autonomousJobs/scriptHandlers.js');
    const next = await SCRIPT_HANDLERS['eidoverse-projection']();
    expect(next.summary.objectCount).toBeGreaterThan(0);
    expect(JSON.stringify(next).length).toBeLessThan(4096);
    expect(JSON.stringify(next)).not.toContain('Example tower');
    expect(next).not.toHaveProperty('projection');
    expect(next).not.toHaveProperty('summary.objects');
    await world.closeEidoverseWorldConnections();
    const reloaded = await world.getEidoverseWorldStatus();
    // A legacy renderer remains usable even though it advertises no label capabilities.
    expect(reloaded.design.reconciliation.runtimeVersion.capabilities.objectLabels).toBeNull();
    expect(reloaded.design.labelAliases).toEqual({ [object.resourceKey]: 'Example tower' });
    const savedObjects = reloaded.projection.lastSummary.objects;
    expect(savedObjects).toHaveLength(next.summary.objectCount);
    expect(savedObjects.find(({ id }) => id === object.id).name).toBe('Example tower');
    expect(JSON.stringify(savedObjects)).not.toContain('Example private title');
    await world.updateEidoverseWorldConfig({ reset: { scope: 'assets' } });
    expect((await world.getEidoverseWorldStatus()).design.labelAliases).toEqual({ [object.resourceKey]: 'Example tower' });
    await world.updateEidoverseWorldConfig({ reset: { scope: 'district', districtId: 'apps' } });
    expect((await world.getEidoverseWorldStatus()).design.labelAliases).toEqual({});
  });

  it.each(['district anchor', 'terrain'])('preserves custom %s geometry on a landscape-capable runtime', async (customization) => {
    const recipe = structuredClone(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    if (customization === 'district anchor') recipe.districts.find(({ id }) => id === 'apps').anchor = [50, 0, 50];
    else recipe.environment.terrain.flatRadius = 100;
    await world.updateEidoverseWorldConfig({ recipe });
    fetch.mockImplementationOnce(async () => Response.json({
      sha: 'example-landscape-build', commitTime: '2026-01-01T00:00:00.000Z',
      capabilities: { largeWorldColliders: 1 },
    }));

    const result = await world.projectEidoverseWorld();

    expect(result.design.reconciliation.runtimeVersion.capabilities.largeWorldColliders).toBe(1);
    expect(result.recipe.districts).toEqual(recipe.districts);
    expect(result.recipe.environment.terrain).toEqual(recipe.environment.terrain);
    const upload = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname === '/upload');
    const bytes = upload[1].body;
    const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    expect(gltf.meshes).toHaveLength(2); // No raised coast or ocean overlays custom land.
    expect(result.design.assetResolutions.citySurface.bytes).toBeLessThan(1_000_000);
  });

  it('preflights and locks recipe assets before completing a V2 reconciliation', async () => {
    const result = await world.projectEidoverseWorld();

    const expectedSlots = ['nexus', 'app', 'agent', 'task', 'goal', 'memory', 'storage', 'peer', 'activity', 'district', 'desk', 'barrel', 'tree', 'citySurface'];
    expect(Object.keys(result.design.assetResolutions)).toEqual(expectedSlots);
    expect(Object.keys(mocks.persistedState.assetResolutions)).toEqual(expectedSlots);
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library/eidoverse/'))).toHaveLength(13);
    expect(result.summary.assetCatalogFingerprint).toEqual(expect.any(String));

    expect(result).toMatchObject({
      success: true,
      summary: { designVersion: 3, maxLiveEntities: 48, assetRecipeVersion: 3 },
      design: {
        selectedVersion: 3,
        lastAppliedVersion: 3,
        pendingVersion: null,
        reconciliation: { status: 'complete', checkpoint: 'projection-committed' },
      },
    });
    expect(Object.keys(result.design.assetResolutions)).toHaveLength(14);
    expect(mocks.persistedState).toMatchObject({
      schemaVersion: 3,
      lastAppliedDesignVersion: 3,
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
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/library/eidoverse/'))).toHaveLength(13);

    await expect(world.reconcilePendingEidoverseWorld()).resolves.toEqual({ reconciled: false, reason: 'current' });
  });

  it('uses one configured runtime origin for WebSocket projection and HTTP asset preflight', async () => {
    vi.stubEnv('EIDOVERSE_WS_URL', 'wss://example-eidoverse.test:9443/custom/ws');

    await world.projectEidoverseWorld();

    expect(mocks.socketUrls.length).toBeGreaterThan(0);
    expect(mocks.socketUrls.every((url) => url === 'wss://example-eidoverse.test:9443/custom/ws')).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([input]) => (
      new URL(String(input)).origin === 'https://example-eidoverse.test:9443'
    ))).toBe(true);
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
    expect(authoredVerbs[firstEnvironment].sentAt - authoredVerbs[firstEnvironment - 1].sentAt).toBeGreaterThanOrEqual(4);
  });

  it('shares verb pacing between ownership retirement and the projection burst', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.ownership.retired = [
      { world: 'portos', id: 'Example Retired Owner A' },
      { world: 'portos', id: 'Example Retired Owner B' },
    ];

    await world.projectEidoverseWorld();

    const cosVerbs = mocks.sent.filter(({ type, actor }) => type === 'verb' && actor === 'portos-cos');
    expect(cosVerbs.slice(0, 2).map(({ verb }) => verb)).toEqual(['grant', 'grant']);
    expect(cosVerbs.some(({ verb }) => verb !== 'grant')).toBe(true);
    for (let index = 1; index < cosVerbs.length; index += 1) {
      expect(cosVerbs[index].sentAt - cosVerbs[index - 1].sentAt).toBeGreaterThanOrEqual(4);
    }
  });

  it('measures and uploads the shared city once, then reuses its assets', async () => {
    const first = await world.projectEidoverseWorld();
    expect(first.design.assetResolutions.citySurface).toMatchObject({ strategy: 'generated', userOverride: false });
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/upload')).toHaveLength(1);
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/geom')).toBe(true);
    fetch.mockClear();
    await world.projectEidoverseWorld();
    expect(fetch.mock.calls.filter(([input]) => ['/geom', '/upload'].includes(new URL(String(input)).pathname))).toEqual([]);
  });

  it('keeps the prior world authoritative if model geometry is invalid', async () => {
    await world.ensureEidoverseWorldConfig();
    mocks.persistedState.lastAppliedDesignVersion = 2;
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((input, init) => new URL(String(input)).pathname === '/geom'
      ? Promise.resolve(Response.json({ bbox: { min: [0, 0, 0], max: [0, 0, 0] } }))
      : original(input, init));
    await expect(world.projectEidoverseWorld()).rejects.toMatchObject({ code: 'EIDOVERSE_ASSET_GEOMETRY_INVALID' });
    expect(mocks.persistedState.lastAppliedDesignVersion).toBe(2);
    expect(mocks.sent.some(({ type }) => type === 'verb')).toBe(false);
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
      if (url.pathname === '/geom') return Response.json({ bbox: { min: [-1, 0, -1], max: [1, 2, 1] } });
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
      pendingDesignVersion: 3,
      reconciliation: { status: 'failed' },
    });
  });

  it('reports a transiently unreachable runtime without false update remediation', async () => {
    fetch.mockRejectedValueOnce(new Error('Example startup race'));

    await expect(world.projectEidoverseWorld()).rejects.toMatchObject({
      status: 503,
      code: 'EIDOVERSE_WORLD_UNAVAILABLE',
    });
    expect(mocks.sent.some(({ type }) => type === 'verb')).toBe(false);
    expect(mocks.persistedState).toMatchObject({
      pendingDesignVersion: 3,
      reconciliation: {
        status: 'failed',
        errorCode: 'EIDOVERSE_WORLD_UNAVAILABLE',
        errorContext: null,
      },
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
      pendingDesignVersion: 3,
      reconciliation: {
        status: 'failed',
        errorCode: 'EIDOVERSE_ASSET_RECIPE_UNRESOLVED',
        errorContext: { missing: expect.arrayContaining(['nexus', 'app', 'agent']) },
      },
    });
  });

  it('verifies semantic and legacy store overrides and explains their provenance in the legend', async () => {
    await world.updateEidoverseWorldConfig({ assetOverrides: {
      app: 'store/example-local-asset', operations: 'store/example-legacy-operations',
    } });

    const result = await world.projectEidoverseWorld();

    expect(result.design.assetResolutions.app).toMatchObject({
      path: 'store/example-local-asset',
      userOverride: true,
      shippedDefault: false,
    });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/library/store/example-local-asset'))).toBe(true);
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/library/store/example-legacy-operations'))).toBe(true);
    expect(result.summary.objects.find(({ kind, districtId }) => kind === 'district' && districtId === 'nexus')?.asset)
      .toEqual({ path: 'store/example-legacy-operations', slot: 'operations', reason: 'user-override' });
  });

  it('resets only the selected district asset lock and override', async () => {
    await world.projectEidoverseWorld();
    await world.updateEidoverseWorldConfig({
      assetOverrides: {
        app: 'store/example-local-asset',
        operations: 'store/example-legacy-operations',
        district: 'store/example-path-marker',
      },
    });

    const reset = await world.updateEidoverseWorldConfig({ reset: { scope: 'district', districtId: 'apps' } });

    expect(reset.design.userOverrides.assets?.app).toBeUndefined();
    expect(reset.design.assetResolutions.app).toBeUndefined();
    expect(reset.design.assetResolutions.agent).toBeTruthy();
    expect(reset.design.pendingVersion).toBe(3);

    const nexusReset = await world.updateEidoverseWorldConfig({ reset: { scope: 'district', districtId: 'nexus' } });
    expect(nexusReset.design.userOverrides.assets?.operations).toBeUndefined();
    expect(nexusReset.design.userOverrides.assets?.district).toBeUndefined();
  });

  it('resets the effective sources and semantic assets for a custom district', async () => {
    const recipe = structuredClone(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.districts = recipe.districts.map((district) => district.id === 'apps'
      ? { ...district, id: 'example-yard', label: 'Example Yard', sources: ['goals'] }
      : district);
    recipe.includes.goals = false;
    recipe.limits.goals = 1;
    recipe.scale.goal = 2.5;
    await world.updateEidoverseWorldConfig({
      recipe,
      assetOverrides: {
        goal: 'store/example-local-goal',
        district: 'store/example-local-district',
      },
    });

    const reset = await world.updateEidoverseWorldConfig({
      reset: { scope: 'district', districtId: 'example-yard' },
    });

    expect(reset.recipe.districts).toContainEqual(expect.objectContaining({
      id: 'example-yard',
      sources: ['goals'],
    }));
    expect(reset.recipe.includes.goals).toBe(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.includes.goals);
    expect(reset.recipe.limits.goals).toBe(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits.goals);
    expect(reset.recipe.scale.goal).toBe(world.DEFAULT_EIDOVERSE_PROJECTION_RECIPE.scale.goal);
    expect(reset.design.userOverrides.assets?.goal).toBeUndefined();
    expect(reset.design.userOverrides.assets?.district).toBeUndefined();

    await expect(world.updateEidoverseWorldConfig({
      reset: { scope: 'district', districtId: 'missing-yard' },
    })).rejects.toMatchObject({ status: 400, code: 'EIDOVERSE_DISTRICT_NOT_FOUND' });
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
      pendingDesignVersion: 3,
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


it('admits a visitor before joining and exposes only new live chat to both guest and resident', async () => {
  await world.ensureEidoverseWorldPresence();
  expect((await world.readEidoverseWorldChat()).messages).toEqual([]);
  const guest = await world.admitEidoverseGuest({ agent: true });
  const grantIndex = mocks.sent.findIndex((entry) => entry.verb === 'grant' && entry.args.id === guest.identity.name);
  const joinIndex = mocks.sent.findIndex((entry) => entry.type === 'join' && entry.actor === guest.identity.name);
  expect(grantIndex).toBeLessThan(joinIndex);
  expect(mocks.sent[grantIndex].args).toEqual({ id: guest.identity.name, role: 'visitor', gen: false });
  expect(mocks.sent[joinIndex]).toMatchObject({ agent: true, guest: true });
  expect(guest.connection.readChat().messages).toEqual([]);
  await guest.connection.sendVerb('say', { text: 'Example visitor greeting.' });
  const incoming = await world.readEidoverseWorldChat();
  expect(incoming.messages).toEqual([{ seq: expect.any(Number), actor: guest.identity.name, text: 'Example visitor greeting.' }]);
  await world.sayInEidoverseWorld('Example resident reply.');
  expect(guest.connection.readChat(incoming.cursor).messages).toEqual([{ seq: expect.any(Number), actor: 'portos-cos', text: 'Example resident reply.' }]);
  for (let index = 0; index < 3; index += 1) await guest.connection.sendVerb('say', { text: 'Example text '.repeat(150) });
  const page = guest.connection.readChat(incoming.cursor);
  expect(JSON.stringify(page).length).toBeLessThan(3500);
  expect(page.hasMore).toBe(true);
  expect(guest.connection.readChat(page.cursor).cursor).toBeGreaterThan(page.cursor);
  await guest.connection.close();
});
