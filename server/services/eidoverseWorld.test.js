import { describe, expect, it } from 'vitest';
import {
  buildProjectionPlan,
  DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
  projectedJiraTickets,
  projectedStorage,
} from './eidoverseWorld.js';
import { eidoverseProjectionRecipeSchema } from '../lib/validation.js';

const APP_FALLBACK = DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assetRecipe.slots.app.fallback;

const emptySources = () => ({
  apps: [], agents: [], tasks: [], features: [], peers: [], health: null,
  productivity: [], activity: [], goals: [], memory: [], storage: [], jira: [], operations: [],
});

const appSource = () => ({
  ...emptySources(),
  apps: [{ id: 'app-example', label: 'Example app', status: 'online', type: 'bun', managed: true }],
  health: { apps: { total: 1, online: 1 } },
});

const currentEnvironment = (recipe = DEFAULT_EIDOVERSE_PROJECTION_RECIPE) => ({
  terrain: recipe.environment.terrain,
  sky: recipe.environment.sky,
  grass: recipe.environment.grass,
});

const signalSpawn = (plan, kind) => plan.operations.find((operation) => (
  operation.verb === 'spawn' && operation.args.id.startsWith(`portos-design-v2-signal-${kind}-`)
));

const snapshotFromPlan = (plan, { foldModelDefaults = false } = {}) => {
  const state = { entities: {} };
  for (const { verb, args } of plan.operations) {
    if (['terrain', 'sky', 'grass'].includes(verb)) {
      state[verb] = structuredClone(args);
    } else if (verb === 'light') {
      state.entities[args.id] = { kind: 'light', ...structuredClone(args) };
      if (state.entities[args.id].day === true) delete state.entities[args.id].day;
    } else if (verb === 'spawn') {
      state.entities[args.id] = structuredClone(args);
      if (foldModelDefaults && state.entities[args.id].yaw === 0) delete state.entities[args.id].yaw;
      if (foldModelDefaults && state.entities[args.id].scale === 1) delete state.entities[args.id].scale;
    } else if (verb === 'place') {
      Object.assign(state.entities[args.id], structuredClone(args));
    } else if (verb === 'comp') {
      state.entities[args.id].comp ||= {};
      state.entities[args.id].comp[args.type] = structuredClone(args.data);
    } else if (verb === 'remove') {
      delete state.entities[args.id];
    }
  }
  return state;
};

describe('Eidoverse PortOS projection plan', () => {
  it('keeps the shipped V2 recipe valid at the route schema boundary', () => {
    expect(eidoverseProjectionRecipeSchema.parse(DEFAULT_EIDOVERSE_PROJECTION_RECIPE)).toEqual(
      DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
    );
  });

  it('creates stable environment, district, signal, and metadata operations', () => {
    const first = buildProjectionPlan({ source: appSource() });
    const second = buildProjectionPlan({ source: appSource() });

    expect(second).toEqual(first);
    expect(first.summary).toMatchObject({
      designVersion: 2,
      liveEntityCount: 2,
      infrastructureCount: 29,
      sourceAvailability: { apps: true, agents: true, health: true, environment: true },
    });
    expect(first.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'terrain' }),
      expect.objectContaining({ verb: 'sky', args: expect.objectContaining({ system: 'skymesh', hours: 7.2 }) }),
      expect.objectContaining({ verb: 'grass' }),
      expect.objectContaining({ verb: 'light', args: expect.objectContaining({ id: 'portos-design-v2-light-nexus' }) }),
      expect.objectContaining({ verb: 'spawn', args: expect.objectContaining({ id: expect.stringContaining('signal-app-'), lib: APP_FALLBACK }) }),
      expect.objectContaining({ verb: 'comp', args: expect.objectContaining({ type: 'portos', data: expect.objectContaining({ districtId: 'apps' }) }) }),
    ]));
    expect(first.operations.some(({ args }) => /car|vehicle/i.test(args?.lib || ''))).toBe(false);
    expect(first.operations).toContainEqual(expect.objectContaining({
      layer: 'ambient',
      verb: 'comp',
      args: expect.objectContaining({ type: 'motion' }),
    }));
  });

  it('uses the install-local materialized asset lock in projection operations', () => {
    const lockedApp = 'eidoverse/assets/models/example_locked_app.glb';
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      assets: { ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets, app: lockedApp },
    };
    const plan = buildProjectionPlan({
      source: appSource(),
      recipe,
      currentState: currentEnvironment(recipe),
    });

    expect(signalSpawn(plan, 'app').args.lib).toBe(lockedApp);
  });

  it('uses semantic slots for district landmarks and paths instead of a retired feature asset', () => {
    const legacyFeature = 'store/example-legacy-feature';
    const appLandmark = 'store/example-app-landmark';
    const pathMarker = 'store/example-path-marker';
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      assets: {
        ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets,
        feature: legacyFeature,
        app: appLandmark,
        district: pathMarker,
      },
    };
    const plan = buildProjectionPlan({ source: emptySources(), recipe });
    const appDistrict = plan.operations.find((operation) => (
      operation.verb === 'spawn' && operation.args.id === 'portos-design-v2-infra-apps'
    ));
    const pathNode = plan.operations.find((operation) => (
      operation.verb === 'spawn' && operation.args.id.startsWith('portos-design-v2-path-')
    ));

    expect(appDistrict.args.lib).toBe(appLandmark);
    expect(pathNode.args.lib).toBe(pathMarker);
    expect(plan.operations.filter(({ verb }) => verb === 'spawn').map(({ args }) => args.lib)).not.toContain(legacyFeature);
  });

  it('restores semantic components after an asset change respawns a model', () => {
    const id = 'portos-design-v2-infra-agents';
    const initial = buildProjectionPlan({ source: emptySources() });
    const spawn = initial.operations.find((operation) => operation.verb === 'spawn' && operation.args.id === id);
    const portos = initial.operations.find((operation) => (
      operation.verb === 'comp' && operation.args.id === id && operation.args.type === 'portos'
    ));
    const motion = initial.operations.find((operation) => (
      operation.verb === 'comp' && operation.args.id === id && operation.args.type === 'motion'
    ));
    const replacement = 'eidoverse/assets/models/example_locked_agent.glb';
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      assets: { ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets, agent: replacement },
    };
    const plan = buildProjectionPlan({
      source: emptySources(),
      recipe,
      currentState: {
        ...currentEnvironment(recipe),
        entities: {
          [id]: {
            ...spawn.args,
            comp: { portos: portos.args.data, motion: motion.args.data },
          },
        },
      },
    });

    expect(plan.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'remove', args: { id } }),
      expect.objectContaining({ verb: 'spawn', args: expect.objectContaining({ id, lib: replacement }) }),
      expect.objectContaining({ verb: 'comp', args: { id, type: 'portos', data: portos.args.data } }),
      expect.objectContaining({ verb: 'comp', args: { id, type: 'motion', data: motion.args.data } }),
    ]));
  });

  it('recognizes Eidoverse folded light defaults as already applied', () => {
    const entities = Object.fromEntries(DEFAULT_EIDOVERSE_PROJECTION_RECIPE.environment.lights.map((light) => [
      light.id,
      {
        kind: 'light',
        pos: light.pos,
        color: light.color,
        intensity: light.intensity,
        range: light.range,
        keep: light.keep,
        // The runtime omits `day` when its protocol-default value is true.
      },
    ]));
    const plan = buildProjectionPlan({
      source: emptySources(),
      currentState: { ...currentEnvironment(), entities },
    });

    expect(plan.operations.filter(({ verb }) => verb === 'light')).toEqual([]);
  });

  it('converges after the runtime folds default model yaw and light fields', () => {
    const first = buildProjectionPlan({ source: emptySources() });
    const currentState = snapshotFromPlan(first, { foldModelDefaults: true });
    const second = buildProjectionPlan({ source: emptySources(), currentState });

    expect(second.operations).toEqual([]);
  });

  it('drives landmarks and signal placement from persisted district overrides', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    const apps = recipe.districts.find(({ id }) => id === 'apps');
    apps.label = 'Example App Garden';
    apps.anchor = [50, 0, 50];
    const plan = buildProjectionPlan({
      source: appSource(),
      recipe,
      currentState: currentEnvironment(recipe),
    });
    const landmark = plan.operations.find(({ verb, args }) => (
      verb === 'spawn' && args.id === 'portos-design-v2-infra-apps'
    ));
    const signal = signalSpawn(plan, 'app');
    const component = plan.operations.find(({ verb, args }) => (
      verb === 'comp' && args.id === signal.args.id && args.type === 'portos'
    ));

    expect(landmark.args.pos).toEqual([50, 0, 50]);
    expect(component.args.data).toMatchObject({
      districtId: 'apps',
      districtLabel: 'Example App Garden',
    });
    expect(Math.abs(signal.args.pos[0] - 50)).toBeLessThanOrEqual(13);
    expect(Math.abs(signal.args.pos[2] - 50)).toBeLessThanOrEqual(13);
  });

  it('gives a custom district id finite defaults and converges on the next plan', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.districts = [{
      ...recipe.districts.find(({ id }) => id === 'apps'),
      id: 'example-custom',
      label: 'Example Custom District',
    }];
    const first = buildProjectionPlan({ source: emptySources(), recipe });
    const landmark = first.operations.find(({ verb, args }) => (
      verb === 'spawn' && args.id === 'portos-design-v2-infra-example-custom'
    ));
    const second = buildProjectionPlan({
      source: emptySources(),
      recipe,
      currentState: snapshotFromPlan(first, { foldModelDefaults: true }),
    });

    expect(Number.isFinite(landmark.args.scale)).toBe(true);
    expect(landmark.args.scale).toBe(1);
    expect(second.operations).toEqual([]);
  });

  it('rejects and defensively ignores authored light ids outside the managed namespace', () => {
    const manualId = 'example-manual-light';
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      environment: {
        ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.environment,
        lights: [{
          id: manualId,
          pos: [0, 4, 0],
          color: 0xffffff,
          intensity: 4,
          range: 12,
          keep: true,
          day: true,
        }],
      },
    };
    const plan = buildProjectionPlan({
      source: emptySources(),
      recipe,
      currentState: {
        ...currentEnvironment(recipe),
        entities: { [manualId]: { id: manualId, lib: 'store/example-manual-model' } },
      },
    });

    expect(eidoverseProjectionRecipeSchema.safeParse(recipe).success).toBe(false);
    expect(plan.operations.some(({ args }) => args?.id === manualId)).toBe(false);
  });

  it('turns aggregate Nexus health into light plus non-color attention cues', () => {
    const plan = buildProjectionPlan({
      source: { ...emptySources(), health: { id: 'overview', status: 'error' } },
      currentState: currentEnvironment(),
    });
    const nexusLight = plan.operations.find(({ verb, args }) => (
      verb === 'light' && args.id === 'portos-design-v2-light-nexus'
    ));
    const healthCue = plan.operations.find(({ verb, args }) => (
      verb === 'comp' && args.type === 'portos' && args.data?.kind === 'health'
    ));

    expect(nexusLight).toMatchObject({ layer: 'ambient', args: { color: 0xff4d6d, intensity: 28 } });
    expect(healthCue.args.data).toMatchObject({
      severity: 'error',
      visualCue: { shape: 'spike', motion: 'urgent-bob' },
    });
    expect(plan.operations).toContainEqual(expect.objectContaining({
      layer: 'ambient',
      verb: 'comp',
      args: expect.objectContaining({ id: healthCue.args.id, type: 'motion' }),
    }));
  });

  it('preserves the adapters canonical attention status in spatial warning cues', () => {
    const plan = buildProjectionPlan({
      source: {
        ...emptySources(),
        apps: [{ id: 'apps-attention', status: 'attention', count: 3 }],
        health: { id: 'overview', status: 'attention' },
      },
      currentState: currentEnvironment(),
    });
    const warnings = plan.operations
      .filter(({ verb, args }) => verb === 'comp' && args.type === 'portos')
      .map(({ args }) => args.data)
      .filter(({ kind }) => ['app', 'health'].includes(kind));

    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'app',
        severity: 'attention',
        visualCue: { shape: 'diamond', motion: 'pulse' },
      }),
      expect.objectContaining({
        kind: 'health',
        severity: 'attention',
        visualCue: { shape: 'diamond', motion: 'pulse' },
      }),
    ]));
  });

  it('keeps ordinary pending work and unread counts in the steady visual channel', () => {
    const plan = buildProjectionPlan({
      source: {
        ...emptySources(),
        productivity: [{
          id: 'summary',
          queue: { pendingApprovals: 2, pendingTasks: 4 },
        }],
        goals: [{ id: 'goal-example', status: 'active', todoPending: 2 }],
        operations: [{ id: 'overview', status: 'active', notifications: { unread: 3 } }],
      },
      currentState: currentEnvironment(),
    });
    const components = plan.operations
      .filter(({ verb, args }) => verb === 'comp' && args.type === 'portos')
      .map(({ args }) => args.data)
      .filter(({ kind }) => ['productivity', 'goal', 'operations'].includes(kind));

    expect(components).toHaveLength(3);
    expect(components).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'productivity', status: 'steady', severity: 'normal' }),
      expect.objectContaining({ kind: 'goal', status: 'active', severity: 'normal' }),
      expect.objectContaining({ kind: 'operations', status: 'active', severity: 'normal' }),
    ]));
    expect(components.every(({ visualCue }) => visualCue.motion === 'steady')).toBe(true);
  });

  it('treats a zero limit as intentional', () => {
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      limits: { ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits, apps: 0 },
    };
    const plan = buildProjectionPlan({ source: appSource(), recipe, currentState: { ...currentEnvironment(recipe), entities: {} } });

    expect(signalSpawn(plan, 'app')).toBeUndefined();
    expect(plan.summary.sourceCounts.apps).toBe(1);
  });

  it('does not remove signals when their source is temporarily unavailable', () => {
    const created = buildProjectionPlan({ source: appSource(), currentState: currentEnvironment() });
    const appSpawn = signalSpawn(created, 'app');
    const currentComponent = created.operations.find((operation) => (
      operation.verb === 'comp' && operation.args.id === appSpawn.args.id && operation.args.type === 'portos'
    )).args.data;
    const unavailable = buildProjectionPlan({
      source: { ...emptySources(), apps: null },
      currentState: {
        ...currentEnvironment(),
        entities: {
          [appSpawn.args.id]: {
            ...appSpawn.args,
            comp: {
              portos: currentComponent,
            },
          },
        },
      },
    });

    expect(unavailable.summary.sourceAvailability.apps).toBe(false);
    expect(unavailable.operations).not.toContainEqual(expect.objectContaining({ verb: 'remove', args: { id: appSpawn.args.id } }));
    expect(unavailable.operations).toContainEqual(expect.objectContaining({
      verb: 'comp',
      args: expect.objectContaining({
        id: appSpawn.args.id,
        type: 'portos',
        data: expect.objectContaining({
          freshness: 'stale',
          status: 'stale',
          resourceKey: currentComponent.resourceKey,
        }),
      }),
    }));
  });

  it('keeps stale signals inside the shared live-entity budget', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.limits.apps = 48;
    recipe.limits.peers = 8;
    const peers = Array.from({ length: 8 }, (_, index) => ({
      id: `peer-${index}`,
      status: 'online',
    }));
    const initial = buildProjectionPlan({
      source: { ...emptySources(), peers },
      recipe,
    });
    const apps = Array.from({ length: 48 }, (_, index) => ({
      id: `app-${index}`,
      status: 'online',
    }));
    const mixed = buildProjectionPlan({
      source: { ...emptySources(), apps, peers: null },
      recipe,
      currentState: snapshotFromPlan(initial),
    });
    const appSpawns = mixed.operations.filter(({ verb, args }) => (
      verb === 'spawn' && args.id.startsWith('portos-design-v2-signal-app-')
    ));

    expect(mixed.summary.liveEntityCount).toBe(48);
    expect(mixed.summary.districtCounts).toMatchObject({ apps: 40, federation: 8 });
    expect(appSpawns).toHaveLength(40);
    expect(mixed.operations).not.toContainEqual(expect.objectContaining({
      verb: 'remove',
      args: expect.objectContaining({ id: expect.stringContaining('signal-peer-') }),
    }));
  });

  it('shares the budget between unavailable stale sources and current sources', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.limits.apps = 48;
    for (const sourceKey of Object.keys(recipe.limits)) recipe.limits[sourceKey] = Math.max(3, recipe.limits[sourceKey]);
    const apps = Array.from({ length: 48 }, (_, index) => ({ id: `app-${index}`, status: 'online' }));
    const initial = buildProjectionPlan({ source: { ...emptySources(), apps }, recipe });
    const rows = (prefix) => Array.from({ length: 3 }, (_, index) => ({ id: `${prefix}-${index}`, status: 'active' }));
    const mixed = buildProjectionPlan({
      recipe,
      source: {
        ...emptySources(),
        apps: null,
        agents: rows('agent'),
        tasks: rows('task'),
        peers: rows('peer'),
        health: { id: 'overview', status: 'healthy' },
        productivity: rows('productivity'),
        activity: rows('activity'),
        goals: rows('goal'),
        memory: rows('memory'),
        storage: rows('storage'),
        jira: rows('jira'),
        operations: rows('operations'),
      },
      currentState: snapshotFromPlan(initial),
    });

    expect(mixed.summary.liveEntityCount).toBe(48);
    expect(mixed.summary.districtCounts.apps).toBeGreaterThan(0);
    expect(Object.entries(mixed.summary.districtCounts)
      .filter(([district]) => district !== 'apps')
      .every(([, count]) => count > 0)).toBe(true);
    expect(mixed.summary.droppedBySource.apps).toBeGreaterThan(0);
    expect(mixed.operations.some(({ verb, args }) => (
      verb === 'spawn' && args.id.startsWith('portos-design-v2-signal-goal-')
    ))).toBe(true);
  });

  it('shares a saturated live budget across every available semantic source', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.maxEntities = 12;
    for (const sourceKey of Object.keys(recipe.limits)) recipe.limits[sourceKey] = 48;
    const rows = (prefix) => Array.from({ length: 3 }, (_, index) => ({
      id: `${prefix}-${index}`,
      status: 'active',
    }));
    const plan = buildProjectionPlan({
      recipe,
      source: {
        ...emptySources(),
        apps: rows('app'),
        agents: rows('agent'),
        tasks: rows('task'),
        peers: rows('peer'),
        health: { id: 'overview', status: 'healthy' },
        productivity: rows('productivity'),
        activity: rows('activity'),
        goals: rows('goal'),
        memory: rows('memory'),
        storage: rows('storage'),
        jira: rows('jira'),
        operations: rows('operations'),
      },
    });

    expect(plan.summary).toMatchObject({
      liveEntityCount: 12,
      maxLiveEntities: 12,
      truncated: true,
    });
    expect(Object.values(plan.summary.districtCounts).every((count) => count > 0)).toBe(true);
    expect(plan.summary.droppedBySource).toMatchObject({
      apps: 2,
      agents: 2,
      tasks: 2,
      goals: 2,
      memory: 2,
      storage: 2,
      peers: 2,
    });
  });

  it('retires unsanitized V1 signals without charging them to the V2 live budget', () => {
    const recipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    recipe.limits.apps = 48;
    const apps = Array.from({ length: 48 }, (_, index) => ({
      id: `app-${index}`,
      status: 'online',
    }));
    const legacyEntities = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [
      `portos-projection-jira-${index}`,
      {
        lib: 'eidoverse/assets/models/example-legacy.glb',
        comp: { portos: { label: `Private legacy ticket ${index}` } },
      },
    ]));
    const plan = buildProjectionPlan({
      source: { ...emptySources(), apps, jira: null },
      recipe,
      currentState: { ...currentEnvironment(recipe), entities: legacyEntities },
    });
    const legacyRemovals = plan.operations.filter(({ verb, args }) => (
      verb === 'remove' && args.id.startsWith('portos-projection-jira-')
    ));

    expect(plan.summary.liveEntityCount).toBe(48);
    expect(legacyRemovals).toHaveLength(3);
    expect(JSON.stringify(plan.operations)).not.toMatch(/Private legacy ticket/);
  });

  it('removes signals after a confirmed empty source read', () => {
    const created = buildProjectionPlan({ source: appSource(), currentState: currentEnvironment() });
    const appSpawn = signalSpawn(created, 'app');
    const empty = buildProjectionPlan({
      source: { ...emptySources(), health: { apps: { total: 0, online: 0 } } },
      currentState: { ...currentEnvironment(), entities: { [appSpawn.args.id]: appSpawn.args } },
    });

    expect(empty.operations).toContainEqual(expect.objectContaining({ verb: 'remove', args: { id: appSpawn.args.id } }));
  });

  it('materializes bounded WorldSignal metadata for the expanded PortOS contract', () => {
    const source = {
      ...emptySources(),
      health: { apps: { total: 1, online: 1 }, diskPercent: 42 },
      productivity: [{ id: 'summary', label: 'Productivity', completedToday: 3 }],
      activity: [{ id: 'activity-summary', label: 'Activity calendar', activeDays: 2 }],
      goals: [{ id: 'goal-example', label: 'Example goal', progress: 50 }],
      memory: [{ id: 'projects', label: 'Memory projects', count: 4 }],
      storage: [{ id: 'database', label: 'PostgreSQL', status: 'online', tableCount: 3 }],
      jira: [{ id: 'EX-1', label: 'Example ticket', status: 'To Do' }],
      operations: [{ id: 'overview', label: 'PortOS operations', inbox: { total: 2 } }],
    };
    const plan = buildProjectionPlan({ source, currentState: currentEnvironment() });
    const components = plan.operations
      .filter((operation) => operation.verb === 'comp' && operation.args.type === 'portos')
      .map((operation) => operation.args.data);

    expect(components.find(({ kind }) => kind === 'goal')).toMatchObject({
      managedBy: 'portos', resource: 'goals', route: '/goals/list', districtId: 'goals',
      freshness: 'current', disclosure: 'aggregate', metrics: { progress: 50 },
    });
    expect(components.find(({ kind }) => kind === 'storage')).toMatchObject({ resource: 'storage', districtId: 'data', metrics: { tableCount: 3 } });
    expect(components.find(({ kind }) => kind === 'operations')).toMatchObject({ resource: 'operations', districtId: 'nexus', metrics: { 'inbox.total': 2 } });
    expect(JSON.stringify(components)).not.toMatch(/Example goal|Example ticket|EX-1|goal-example/);
    expect(plan.summary.liveEntityCount).toBe(8);
  });

  it('aggregates storage and Jira without emitting private table, domain, ticket, or machine labels', () => {
    const storage = projectedStorage({
      db: { tables: [{ name: 'private_table', totalBytes: 10 }], sizeBytes: 10, migrations: { applied: 3 } },
      fs: { domains: [{ name: 'private-domain', bytes: 20, files: 2 }], totalBytes: 20, totalFiles: 2 },
    });
    const jira = projectedJiraTickets([
      { key: 'PRIVATE-1', summary: 'Private customer work', statusCategory: 'In Progress', priority: 'High', storyPoints: 3 },
      { key: 'PRIVATE-2', summary: 'Another private item', statusCategory: 'To Do', priority: 'Urgent', storyPoints: 2 },
    ]);

    expect(storage).toHaveLength(2);
    expect(storage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'database', tableCount: 1 }),
      expect.objectContaining({ id: 'filesystem', domainCount: 1 }),
    ]));
    expect(jira).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'jira-active', count: 1, storyPoints: 3 }),
      expect.objectContaining({ id: 'jira-pending', count: 1, urgent: 1 }),
    ]));
    expect(JSON.stringify({ storage, jira })).not.toMatch(/private_table|private-domain|PRIVATE-|customer work|private item/i);
  });

  it('caps live signals at 48 and keeps uncapped placement stable when source order changes', () => {
    const cappedApps = Array.from({ length: 80 }, (_, index) => ({ id: `app-${index}`, label: `Example app ${index}` }));
    const stableApps = cappedApps.slice(0, 40);
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      limits: { ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits, apps: 100 },
    };
    const capped = buildProjectionPlan({ source: { ...emptySources(), apps: cappedApps }, recipe });
    const first = buildProjectionPlan({ source: { ...emptySources(), apps: stableApps }, recipe });
    const second = buildProjectionPlan({ source: { ...emptySources(), apps: [...stableApps].reverse() }, recipe });
    const appPlaces = (plan) => plan.operations
      .filter((operation) => operation.verb === 'spawn' && operation.args.id.includes('signal-app-'))
      .map(({ args }) => [args.id, args.pos]);

    expect(capped.summary.liveEntityCount).toBe(48);
    expect(appPlaces(second)).toEqual(appPlaces(first));
  });

  it('keeps source-adapter priority before applying per-source caps', () => {
    const plan = buildProjectionPlan({
      source: {
        ...emptySources(),
        activity: [
          { id: 'summary', activeDays: 7 },
          { id: 'day-latest', tasks: 5 },
          { id: 'day-second', tasks: 4 },
          { id: 'day-third', tasks: 3 },
        ],
        memory: [
          { id: 'largest', count: 10 },
          { id: 'second-largest', count: 9 },
          { id: 'third-largest', count: 8 },
          { id: 'smallest', count: 1 },
        ],
      },
      currentState: currentEnvironment(),
    });
    const components = plan.operations
      .filter(({ verb, args }) => verb === 'comp' && args.type === 'portos')
      .map(({ args }) => args.data);
    const activity = components.filter(({ kind }) => kind === 'activity');
    const memory = components.filter(({ kind }) => kind === 'memory');

    expect(activity).toHaveLength(3);
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ metrics: expect.objectContaining({ activeDays: 7 }) }),
      expect.objectContaining({ metrics: expect.objectContaining({ tasks: 5 }) }),
      expect.objectContaining({ metrics: expect.objectContaining({ tasks: 4 }) }),
    ]));
    expect(memory.map(({ metrics }) => metrics.count).sort((left, right) => left - right)).toEqual([8, 9, 10]);
  });

  it('turns goal progress into observable constellation height', () => {
    const plan = buildProjectionPlan({
      source: { ...emptySources(), goals: [{ id: 'goal-example', progress: 75, status: 'active' }] },
      currentState: currentEnvironment(),
    });
    const goal = signalSpawn(plan, 'goal');

    expect(goal.args.pos[1]).toBeCloseTo(5.625, 3);
  });

  it('turns enabled feature flags into district affordances instead of extra props', () => {
    const plan = buildProjectionPlan({
      source: {
        ...emptySources(),
        features: [
          { id: 'datadog', label: 'Datadog', enabled: true },
          { id: 'jira', label: 'Jira', enabled: true },
        ],
      },
    });
    const districtComponents = new Map(plan.operations
      .filter((operation) => operation.verb === 'comp' && operation.args.data.kind === 'district')
      .map((operation) => [operation.args.data.districtId, operation.args.data]));

    expect(districtComponents.get('apps').affordances).toEqual(['datadog']);
    expect(districtComponents.get('goals').affordances).toEqual(['jira']);
    expect(districtComponents.get('nexus').affordances).toEqual(['datadog', 'jira']);
    expect(plan.summary.liveEntityCount).toBe(0);
  });

  it('honors feature inclusion and caps in district affordances and landmark scale', () => {
    const source = {
      ...emptySources(),
      features: [
        { id: 'datadog', enabled: true },
        { id: 'jira', enabled: true },
      ],
    };
    const excludedRecipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    excludedRecipe.includes.features = false;
    const cappedRecipe = structuredClone(DEFAULT_EIDOVERSE_PROJECTION_RECIPE);
    cappedRecipe.limits.features = 0;
    const excluded = buildProjectionPlan({ source, recipe: excludedRecipe });
    const capped = buildProjectionPlan({ source, recipe: cappedRecipe });
    const empty = buildProjectionPlan({ source: { ...source, features: [] } });
    const districtComponents = (plan) => plan.operations
      .filter(({ verb, args }) => verb === 'comp' && args.data?.kind === 'district')
      .map(({ args }) => args.data);
    const appsLandmark = (plan) => plan.operations.find(({ verb, args }) => (
      verb === 'spawn' && args.id === 'portos-design-v2-infra-apps'
    ));

    expect(districtComponents(excluded).every(({ affordances }) => affordances.length === 0)).toBe(true);
    expect(districtComponents(capped).every(({ affordances }) => affordances.length === 0)).toBe(true);
    expect(appsLandmark(excluded).args.scale).toBe(appsLandmark(empty).args.scale);
    expect(appsLandmark(capped).args.scale).toBe(appsLandmark(empty).args.scale);
  });

  it('keeps authored architecture identical across installs while local signals differ', () => {
    const first = buildProjectionPlan({ source: {
      ...emptySources(),
      apps: [{ id: 'install-a-app', status: 'online' }],
    } });
    const second = buildProjectionPlan({ source: {
      ...emptySources(),
      apps: [{ id: 'install-b-app', status: 'stopped' }],
    } });
    const architecture = (plan) => plan.operations.filter(({ layer }) => ['environment', 'infrastructure'].includes(layer));
    const signals = (plan) => plan.operations.filter(({ layer }) => layer === 'live');

    expect(architecture(second)).toEqual(architecture(first));
    expect(signals(second)).not.toEqual(signals(first));
  });

  it('never mutates unrelated manual entities during reconciliation', () => {
    const currentState = {
      ...currentEnvironment(),
      entities: {
        'manual-example': { lib: 'eidoverse/assets/models/example_manual.glb', pos: [1, 0, 1] },
        'portos-projection-app-retired': { lib: APP_FALLBACK, pos: [2, 0, 2] },
      },
    };
    const plan = buildProjectionPlan({ source: emptySources(), currentState });

    expect(plan.operations.some(({ args }) => args?.id === 'manual-example')).toBe(false);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      layer: 'reconciliation', verb: 'remove', args: { id: 'portos-projection-app-retired' },
    }));
  });
});
