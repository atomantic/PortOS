import { describe, expect, it } from 'vitest';
import {
  EIDOVERSE_ASSET_RECIPE_V2,
  EIDOVERSE_WORLD_DESIGN_V1,
  EIDOVERSE_WORLD_DESIGN_V2,
  EIDOVERSE_WORLD_DESIGNS,
  extractEidoverseDesignOverrides,
  inspectEidoverseAssetResolutionLocks,
  migrateEidoverseWorldState,
  resolveEidoverseAssetRecipe,
} from './eidoverseWorldDesign.js';

const catalog = () => Object.values(EIDOVERSE_ASSET_RECIPE_V2.slots).flatMap((slot) => [
  { path: slot.preferredPaths[0], size: Math.min(slot.maxBytes, 10_000_000) },
  { path: slot.fallback, size: 4_000_000 },
]);

describe('Eidoverse World Design V2', () => {
  it('keeps the shipped migration baselines deeply immutable', () => {
    expect(Object.isFrozen(EIDOVERSE_WORLD_DESIGN_V1.assets)).toBe(true);
    expect(Object.isFrozen(EIDOVERSE_ASSET_RECIPE_V2.slots.app.preferredPaths)).toBe(true);
    expect(Object.isFrozen(EIDOVERSE_WORLD_DESIGN_V2.environment.lights[0])).toBe(true);
    expect(EIDOVERSE_WORLD_DESIGNS).toEqual({ 1: EIDOVERSE_WORLD_DESIGN_V1, 2: EIDOVERSE_WORLD_DESIGN_V2 });
  });

  it('upgrades untouched V1 leaves to V2 without manufacturing overrides', () => {
    const migrated = migrateEidoverseWorldState({ schemaVersion: 1, recipe: EIDOVERSE_WORLD_DESIGN_V1 }, {
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(migrated.compatible).toBe(true);
    expect(migrated.state).toMatchObject({
      schemaVersion: 2,
      selectedDesignVersion: 2,
      lastAppliedDesignVersion: 1,
      pendingDesignVersion: 2,
      userOverrides: {},
      recipe: { version: 2, name: 'Luminous Systems Garden' },
    });
    expect(migrated.report).toMatchObject({ status: 'ready', preservedOverrides: [] });
  });

  it('preserves customized V1 leaves while inheriting new V2 defaults', () => {
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        limits: { ...EIDOVERSE_WORLD_DESIGN_V1.limits, apps: 3 },
        assets: { ...EIDOVERSE_WORLD_DESIGN_V1.assets, app: 'store/example-local-model' },
      },
    });

    expect(migrated.state.userOverrides).toMatchObject({
      limits: { apps: 3 },
      assets: { app: 'store/example-local-model' },
    });
    expect(migrated.state.recipe).toMatchObject({
      version: 2,
      limits: { apps: 3, agents: EIDOVERSE_WORLD_DESIGN_V2.limits.agents },
      assets: { app: 'store/example-local-model' },
    });
    expect(migrated.report.preservedOverrides).toEqual(expect.arrayContaining(['limits.apps', 'assets.app']));
  });

  it('clamps oversized V1 source caps to the V2 design budget and reports the original values', () => {
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        limits: {
          ...EIDOVERSE_WORLD_DESIGN_V1.limits,
          apps: 20,
          agents: 2,
        },
      },
    });

    expect(migrated.state.userOverrides.limits).toEqual({ agents: 2 });
    expect(migrated.state.recipe.limits).toMatchObject({
      apps: EIDOVERSE_WORLD_DESIGN_V2.limits.apps,
      agents: 2,
    });
    expect(migrated.report.unsupportedOverrides.limits).toEqual({ apps: 20 });
  });

  it('preserves only a customized V1 terrain leaf while adopting V2 terrain defaults', () => {
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        terrain: { ...EIDOVERSE_WORLD_DESIGN_V1.terrain, seed: 'example-custom' },
      },
    });

    expect(migrated.state.userOverrides).toMatchObject({
      environment: { terrain: { seed: 'example-custom' } },
    });
    expect(migrated.state.recipe.environment.terrain).toMatchObject({
      seed: 'example-custom',
      size: EIDOVERSE_WORLD_DESIGN_V2.environment.terrain.size,
      segments: EIDOVERSE_WORLD_DESIGN_V2.environment.terrain.segments,
      layers: EIDOVERSE_WORLD_DESIGN_V2.environment.terrain.layers,
    });
  });

  it('reports unportable V1 asset paths without activating a blocking V2 override', () => {
    const portable = 'eidoverse/assets/models/example-custom.glb';
    const unportable = 'eidoverse/assets/legacy/example-custom.obj';
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        assets: {
          ...EIDOVERSE_WORLD_DESIGN_V1.assets,
          app: portable,
          feature: unportable,
        },
      },
    });

    expect(migrated.state.userOverrides.assets).toEqual({ app: portable });
    expect(migrated.state.recipe.assets).toEqual({ app: portable });
    expect(migrated.report.unsupportedOverrides.assets).toEqual({ feature: unportable });
    expect(migrated.report.preservedOverrides).toContain('assets.app');
  });

  it('retires only an automatic machine-derived V1 identity during migration', () => {
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      world: 'portos',
      human: { name: 'Example Machine', source: 'instance-name', role: 'owner', avatar: 'eidoverse/assets/vrms/example.vrm' },
      cos: { id: 'portos-cos', avatar: 'eidoverse/assets/vrms/example-cos.vrm' },
      recipe: EIDOVERSE_WORLD_DESIGN_V1,
    });
    const configured = migrateEidoverseWorldState({
      schemaVersion: 1,
      human: { name: 'Example User', source: 'configured', role: 'owner' },
      recipe: EIDOVERSE_WORLD_DESIGN_V1,
    });

    expect(migrated.state.human).toEqual({
      name: null,
      source: null,
      role: null,
      avatar: 'eidoverse/assets/vrms/example.vrm',
    });
    expect(migrated.state.ownership.retired).toEqual([{
      world: 'portos',
      id: 'Example Machine',
      actorId: 'portos-cos',
      actorAvatar: 'eidoverse/assets/vrms/example-cos.vrm',
    }]);
    expect(migrated.report.removedMachineDerivedIdentity).toBe(true);
    expect(configured.state.human).toMatchObject({ name: 'Example User', source: 'configured', role: 'owner' });
    expect(configured.report.removedMachineDerivedIdentity).toBe(false);
  });

  it('retains unsupported V1 customization values in the migration report', () => {
    const migrated = migrateEidoverseWorldState({
      schemaVersion: 1,
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        layout: { ...EIDOVERSE_WORLD_DESIGN_V1.layout, spacing: 11 },
        retiredExtension: { mode: 'example-custom-mode' },
      },
    });

    expect(migrated.report).toMatchObject({
      unsupportedOverrides: {
        layout: { spacing: 11 },
        retiredExtension: { mode: 'example-custom-mode' },
      },
      ignoredLegacyLayout: { spacing: 11 },
    });
  });

  it('fails closed on state written by a newer schema', () => {
    const state = { schemaVersion: 99, future: true };
    expect(migrateEidoverseWorldState(state)).toMatchObject({
      compatible: false,
      state,
      report: { status: 'blocked', reason: 'newer-state-schema' },
    });
  });

  it('fails closed on malformed state and version markers', () => {
    expect(migrateEidoverseWorldState([])).toMatchObject({
      compatible: false,
      report: { reason: 'invalid-state-shape' },
    });
    expect(migrateEidoverseWorldState({ schemaVersion: 0 })).toMatchObject({
      compatible: false,
      report: { reason: 'invalid-state-schema' },
    });
    expect(migrateEidoverseWorldState({ schemaVersion: 2, selectedDesignVersion: 'not-a-version' })).toMatchObject({
      compatible: false,
      report: { reason: 'invalid-design-version' },
    });
    expect(migrateEidoverseWorldState({ schemaVersion: 2, assetRecipeVersion: -1 })).toMatchObject({
      compatible: false,
      report: { reason: 'invalid-asset-recipe-version' },
    });
  });

  it('fails closed on newer design and asset-recipe versions within schema V2', () => {
    expect(migrateEidoverseWorldState({ schemaVersion: 2, selectedDesignVersion: 99 })).toMatchObject({
      compatible: false,
      report: { reason: 'newer-design-version' },
    });
    expect(migrateEidoverseWorldState({
      schemaVersion: 2,
      selectedDesignVersion: 2,
      assetRecipeVersion: 99,
    })).toMatchObject({
      compatible: false,
      report: { reason: 'newer-asset-recipe-version' },
    });
  });

  it('resolves a portable recipe deterministically and reuses a valid lock', () => {
    const first = resolveEidoverseAssetRecipe({ files: catalog() });
    const second = resolveEidoverseAssetRecipe({
      files: [...catalog()].reverse(),
      existing: first.resolutions,
    });

    expect(first.missing).toEqual([]);
    expect(Object.keys(first.resolutions)).toHaveLength(10);
    expect(second).toEqual(first);
    expect(Object.values(first.resolutions).every(({ path }) => path.startsWith('eidoverse/assets/models/'))).toBe(true);
    expect(first.resolutions.storage.path).not.toBe(first.resolutions.app.path);
    expect(first.resolutions.app).toMatchObject({
      designVersion: 2,
      assetRecipeVersion: 2,
      slot: 'app',
      strategy: 'preferred',
      shippedDefault: true,
      userOverride: false,
    });
    expect(JSON.stringify(EIDOVERSE_ASSET_RECIPE_V2)).not.toMatch(/\.glb\s*data:|base64/i);
  });

  it('invalidates only a slot whose recipe fingerprint changed', () => {
    const first = resolveEidoverseAssetRecipe({ files: catalog(), resolvedAt: 'old' });
    const existing = structuredClone(first.resolutions);
    existing.app.recipeFingerprint = 'retired-slot-contract';
    const next = resolveEidoverseAssetRecipe({ files: catalog(), existing, resolvedAt: 'new' });

    expect(next.resolutions.app.resolvedAt).toBe('new');
    expect(next.resolutions.app.recipeFingerprint).not.toBe('retired-slot-contract');
    expect(next.resolutions.agent).toEqual(first.resolutions.agent);
  });

  it('can validate a complete lock without consulting a catalog', () => {
    const first = resolveEidoverseAssetRecipe({ files: catalog(), resolvedAt: 'old' });
    expect(inspectEidoverseAssetResolutionLocks({ existing: first.resolutions })).toEqual({
      current: true,
      invalidated: [],
      resolutions: first.resolutions,
    });

    const changedOverride = inspectEidoverseAssetResolutionLocks({
      existing: first.resolutions,
      overrides: { app: 'store/example-local-asset' },
    });
    expect(changedOverride.current).toBe(false);
    expect(changedOverride.invalidated).toEqual(['app']);
    expect(changedOverride.resolutions.agent).toEqual(first.resolutions.agent);
  });

  it('records an explicit store override as local without making store assets defaults', () => {
    const result = resolveEidoverseAssetRecipe({
      files: catalog(),
      overrides: { app: 'store/example-local-asset' },
      resolvedAt: 'now',
    });

    expect(result.resolutions.app).toMatchObject({
      path: 'store/example-local-asset',
      strategy: 'user-override',
      shippedDefault: false,
      userOverride: true,
      resolvedAt: 'now',
    });
    expect(Object.entries(result.resolutions)
      .filter(([slot]) => slot !== 'app')
      .every(([, resolution]) => resolution.path.startsWith('eidoverse/assets/models/'))).toBe(true);
  });

  it('never selects a content-addressed store asset for a portable default', () => {
    const result = resolveEidoverseAssetRecipe({
      files: [
        ...catalog(),
        { path: 'store/0123456789abcdef', size: 1 },
      ],
    });

    expect(Object.values(result.resolutions).some(({ path }) => path.startsWith('store/'))).toBe(false);
  });

  it('uses deterministic search results when a preferred library path is absent', () => {
    const appSlot = EIDOVERSE_ASSET_RECIPE_V2.slots.app;
    const searchedPath = 'eidoverse/assets/models/example_server_console.glb';
    const withoutApp = catalog().filter(({ path }) => (
      path !== appSlot.preferredPaths[0] && path !== appSlot.fallback
    ));
    const result = resolveEidoverseAssetRecipe({
      files: withoutApp,
      searchResults: { 'computer server': [{ path: searchedPath, size: 2_000_000 }] },
    });

    expect(result.resolutions.app).toMatchObject({ path: searchedPath, source: 'query' });
  });

  it('accepts renamed search hits without substring-matching excluded whole tokens', () => {
    const taskSlot = EIDOVERSE_ASSET_RECIPE_V2.slots.task;
    const renamedPath = 'eidoverse/assets/models/example_cargo_pod_blue.glb';
    const withoutTask = catalog().filter(({ path }) => (
      path !== taskSlot.preferredPaths[0] && path !== taskSlot.fallback
    ));
    const result = resolveEidoverseAssetRecipe({
      files: withoutTask,
      searchResults: { 'scifi crate': [{ path: renamedPath, size: 2_000_000 }] },
    });

    expect(result.resolutions.task).toMatchObject({ path: renamedPath, strategy: 'query' });
  });

  it('keeps catalog entries with unknown sizes and records nullable lock bytes', () => {
    const appPath = EIDOVERSE_ASSET_RECIPE_V2.slots.app.preferredPaths[0];
    const files = catalog().map((candidate) => (
      candidate.path === appPath ? { path: candidate.path } : candidate
    ));
    const result = resolveEidoverseAssetRecipe({ files });

    expect(result.resolutions.app).toMatchObject({
      path: appPath,
      strategy: 'preferred',
      bytes: null,
    });
  });

  it('uses a safe catalog GLB as a last resort after semantic searches are exhausted', () => {
    const taskSlot = EIDOVERSE_ASSET_RECIPE_V2.slots.task;
    const files = catalog().filter(({ path }) => (
      path !== taskSlot.preferredPaths[0] && path !== taskSlot.fallback
    ));
    const result = resolveEidoverseAssetRecipe({
      files,
      searchResults: Object.fromEntries(taskSlot.fallbackQueries.map((query) => [query, []])),
    });

    expect(result.missing).not.toContain('task');
    expect(result.resolutions.task).toMatchObject({ strategy: 'catalog-fallback' });
  });

  it('searches before accepting an explicit fallback asset', () => {
    const appSlot = EIDOVERSE_ASSET_RECIPE_V2.slots.app;
    const files = catalog().filter(({ path }) => path !== appSlot.preferredPaths[0]);
    const beforeSearch = resolveEidoverseAssetRecipe({ files });
    const afterSearch = resolveEidoverseAssetRecipe({
      files,
      searchResults: Object.fromEntries(appSlot.fallbackQueries.map((query) => [query, []])),
    });

    expect(beforeSearch.missing).toContain('app');
    expect(afterSearch.resolutions.app).toMatchObject({ path: appSlot.fallback, strategy: 'fallback' });
  });

  it('does not mistake a materialized asset lock for a user override', () => {
    expect(extractEidoverseDesignOverrides({
      ...EIDOVERSE_WORLD_DESIGN_V2,
      assets: { app: 'eidoverse/assets/models/example_app.glb' },
    })).toEqual({});
  });

  it('does not pin key-reordered recipe arrays as user overrides', () => {
    const recipe = structuredClone(EIDOVERSE_WORLD_DESIGN_V2);
    recipe.districts = recipe.districts.map(({
      accent, sources, anchor, landmark, direction, label, id,
    }) => ({ accent, sources, anchor, landmark, direction, label, id }));
    recipe.paths = recipe.paths.map(({ nodes, toDistrictId, label, id }) => ({
      nodes, toDistrictId, label, id,
    }));
    recipe.environment.lights = recipe.environment.lights.map(({
      day, keep, range, intensity, color, pos, id,
    }) => ({ day, keep, range, intensity, color, pos, id }));

    expect(extractEidoverseDesignOverrides(recipe)).toEqual({});
  });
});
