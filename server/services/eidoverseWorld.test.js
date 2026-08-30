import { describe, expect, it } from 'vitest';
import {
  buildProjectionPlan,
  DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
} from './eidoverseWorld.js';
import { eidoverseProjectionRecipeSchema } from '../lib/validation.js';

const emptySources = () => ({
  apps: [],
  agents: [],
  tasks: [],
  features: [],
  peers: [],
  health: null,
  productivity: [],
  activity: [],
  goals: [],
  memory: [],
  storage: [],
  jira: [],
  operations: [],
});

const appSource = () => ({
  ...emptySources(),
  apps: [{ id: 'app-example', label: 'Example app', status: 'online', type: 'bun', managed: true }],
  health: { apps: { total: 1, online: 1 } },
});

describe('Eidoverse PortOS projection plan', () => {
  it('keeps the shipped recipe valid at the route schema boundary', () => {
    expect(eidoverseProjectionRecipeSchema.parse(DEFAULT_EIDOVERSE_PROJECTION_RECIPE)).toEqual(
      DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
    );
  });

  it('creates stable model and metadata operations for available sources', () => {
    const first = buildProjectionPlan({ source: appSource() });
    const second = buildProjectionPlan({ source: appSource() });

    expect(second).toEqual(first);
    expect(first.summary.sourceAvailability).toMatchObject({ apps: true, agents: true, health: true });
    expect(first.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'terrain' }),
      expect.objectContaining({ verb: 'spawn', args: expect.objectContaining({ lib: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets.app }) }),
      expect.objectContaining({ verb: 'comp', args: expect.objectContaining({ type: 'portos' }) }),
    ]));
    expect(first.summary.created).toBe(2);
  });

  it('treats a zero limit as intentional and does not fall back to the source length', () => {
    const recipe = {
      ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE,
      limits: { ...DEFAULT_EIDOVERSE_PROJECTION_RECIPE.limits, apps: 0 },
    };
    const plan = buildProjectionPlan({
      source: appSource(),
      recipe,
      currentState: { terrain: recipe.terrain, entities: {} },
    });

    expect(plan.operations.some((operation) => operation.verb === 'spawn' && operation.args.lib === recipe.assets.app)).toBe(false);
    expect(plan.summary.sourceCounts.apps).toBe(1);
  });

  it('does not remove generated entities when their source is temporarily unavailable', () => {
    const created = buildProjectionPlan({ source: appSource(), currentState: { terrain: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.terrain } });
    const appSpawn = created.operations.find((operation) => operation.verb === 'spawn' && operation.args.lib === DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets.app);
    const unavailable = buildProjectionPlan({
      source: { ...emptySources(), apps: null },
      currentState: {
        terrain: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.terrain,
        entities: { [appSpawn.args.id]: appSpawn.args },
      },
    });

    expect(unavailable.summary.sourceAvailability.apps).toBe(false);
    expect(unavailable.operations).not.toContainEqual({ verb: 'remove', args: { id: appSpawn.args.id } });
  });

  it('removes generated entities after a confirmed empty source read', () => {
    const created = buildProjectionPlan({ source: appSource(), currentState: { terrain: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.terrain } });
    const appSpawn = created.operations.find((operation) => operation.verb === 'spawn' && operation.args.lib === DEFAULT_EIDOVERSE_PROJECTION_RECIPE.assets.app);
    const empty = buildProjectionPlan({
      source: { ...emptySources(), health: { apps: { total: 0, online: 0 } } },
      currentState: {
        terrain: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.terrain,
        entities: { [appSpawn.args.id]: appSpawn.args },
      },
    });

    expect(empty.operations).toContainEqual({ verb: 'remove', args: { id: appSpawn.args.id } });
    expect(empty.summary.removed).toBe(1);
  });

  it('materializes the expanded OpenWorld resource contract as stable model metadata', () => {
    const source = {
      ...emptySources(),
      health: { apps: { total: 1, online: 1 }, diskPercent: 42 },
      productivity: [{ id: 'summary', label: 'Productivity', completedToday: 3 }],
      activity: [{ id: 'summary', label: 'Activity calendar', activeDays: 2 }],
      goals: [{ id: 'goal-example', label: 'Example goal', progress: 50 }],
      memory: [{ id: 'projects', label: 'Memory projects', count: 4 }],
      storage: [{ id: 'database', label: 'PostgreSQL', status: 'online', tableCount: 3 }],
      jira: [{ id: 'EX-1', label: 'Example ticket', status: 'To Do' }],
      operations: [{ id: 'overview', label: 'PortOS operations', inbox: { total: 2 } }],
    };
    const plan = buildProjectionPlan({
      source,
      currentState: { terrain: DEFAULT_EIDOVERSE_PROJECTION_RECIPE.terrain },
    });

    expect(plan.summary.sourceAvailability).toMatchObject({
      productivity: true,
      activity: true,
      goals: true,
      memory: true,
      storage: true,
      jira: true,
      operations: true,
    });
    expect(plan.summary.sourceCounts).toMatchObject({
      productivity: 1,
      activity: 1,
      goals: 1,
      memory: 1,
      storage: 1,
      jira: 1,
      operations: 1,
    });

    const components = new Map(
      plan.operations
        .filter((operation) => operation.verb === 'comp')
        .map((operation) => [operation.args.data.sourceId, operation.args.data]),
    );
    expect(components.get('goal-example')).toMatchObject({ resource: 'goals', progress: 50 });
    expect(components.get('database')).toMatchObject({ resource: 'storage', tableCount: 3 });
    expect(components.get('overview')).toMatchObject({ resource: 'operations', inbox: { total: 2 } });
    expect(plan.operations.filter((operation) => operation.verb === 'spawn')).toHaveLength(8);
  });
});
