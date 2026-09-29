import { describe, expect, it } from 'vitest';
import {
  draftsFromWorld,
  mergeDraft,
  reconcileAfterReset,
  shouldReplaceDraft,
} from './eidoverseDraftReconcile.js';

const districts = [{ id: 'apps', sources: ['apps'] }];
const world = ({ recipe, assets = {}, aliases = {} }) => ({
  recipe,
  design: { userOverrides: { assets }, labelAliases: aliases },
});

describe('reconcileAfterReset', () => {
  it('reset all: adopts the server result for every key the user left alone, keeps edited keys', () => {
    const submitted = draftsFromWorld(world({
      recipe: { districts, limits: { apps: 8, agents: 6 } },
      assets: { app: 'custom/a.glb', tree: 'custom/t.glb' },
      aliases: { 'app-1': 'Alpha' },
    }));
    const drafts = {
      recipe: { districts, limits: { apps: 8, agents: 9 } }, // user edited agents while in flight
      assets: { app: 'custom/a.glb', tree: 'custom/t.glb' },
      aliases: { 'app-1': 'Alpha', 'app-2': 'Beta' }, // user added an alias
    };
    const serverAfter = draftsFromWorld(world({ recipe: { districts, limits: { apps: 4, agents: 4 } } }));

    const next = reconcileAfterReset({ reset: { scope: 'all' }, drafts, submitted, serverAfter });

    expect(next.recipe.limits).toEqual({ apps: 4, agents: 9 });
    expect(next.assets).toEqual({});
    expect(next.aliases).toEqual({ 'app-2': 'Beta' });
  });

  it('district reset: only that district\'s sources, kinds and asset slots follow the server', () => {
    const submitted = draftsFromWorld(world({
      recipe: { districts, includes: { apps: false, agents: false }, limits: { apps: 2, agents: 2 }, scale: { app: 3, agent: 3 } },
      assets: { desk: 'custom/desk.glb', barrel: 'custom/barrel.glb' },
      aliases: { 'app-1': 'Alpha', 'agent-1': 'Gamma' },
    }));
    const drafts = {
      recipe: { ...submitted.recipe, limits: { apps: 2, agents: 7 } }, // unrelated unsaved edit
      assets: { ...submitted.assets },
      aliases: { ...submitted.aliases },
    };
    const serverAfter = draftsFromWorld(world({
      recipe: { districts, includes: { agents: false }, limits: { agents: 2 }, scale: { agent: 3 } },
      assets: { barrel: 'custom/barrel.glb' },
      aliases: { 'agent-1': 'Gamma' },
    }));

    const next = reconcileAfterReset({
      reset: { scope: 'district', districtId: 'apps' }, drafts, submitted, serverAfter,
    });

    expect(next.recipe.includes).toEqual({ agents: false });
    expect(next.recipe.limits).toEqual({ agents: 7 });
    expect(next.recipe.scale).toEqual({ agent: 3 });
    expect(next.assets).toEqual({ barrel: 'custom/barrel.glb' });
    expect(next.aliases).toEqual({ 'agent-1': 'Gamma' });
  });

  it('a key edited locally while the server also changed it: local wins', () => {
    const submitted = draftsFromWorld(world({
      recipe: { districts, limits: { apps: 2 }, assets: { app: 'a' } },
      assets: { app: 'custom/a.glb' },
    }));
    const drafts = {
      recipe: { ...submitted.recipe, limits: { apps: 5 } },
      assets: { app: 'custom/edited.glb' },
      aliases: {},
    };
    const serverAfter = draftsFromWorld(world({ recipe: { districts, limits: { apps: 8 }, assets: {} } }));

    const next = reconcileAfterReset({
      reset: { scope: 'district', districtId: 'apps' }, drafts, submitted, serverAfter,
    });

    expect(next.recipe.limits).toEqual({ apps: 5 });
    expect(next.assets).toEqual({ app: 'custom/edited.glb' });
  });

  it('leaves the recipe draft alone when the response carries no recipe', () => {
    const drafts = { recipe: { keep: true }, assets: {}, aliases: {} };
    const next = reconcileAfterReset({
      reset: { scope: 'all' },
      drafts,
      submitted: drafts,
      serverAfter: draftsFromWorld({}),
    });
    expect(next.recipe).toBe(drafts.recipe);
  });
});

describe('mergeDraft (refresh-assets)', () => {
  it('applies the server-side asset change to untouched keys and keeps a locally edited one', () => {
    const serverBefore = { app: 'old-app.glb', desk: 'old-desk.glb' };
    const serverAfter = { app: 'new-app.glb' }; // desk removed, app changed
    const submitted = { ...serverBefore };
    const current = { app: 'typed.glb', desk: 'old-desk.glb', extra: 'local.glb' };

    expect(mergeDraft({ current, submitted, serverBefore, serverAfter }))
      .toEqual({ app: 'typed.glb', extra: 'local.glb' });
  });

  it('returns the draft untouched when the server copy did not change', () => {
    const current = { a: 1 };
    expect(mergeDraft({ current, submitted: { a: 0 }, serverBefore: { z: 1 }, serverAfter: { z: 1 } })).toBe(current);
  });
});

describe('shouldReplaceDraft', () => {
  it('encodes the deliberate per-request differences', () => {
    const cleanUnchanged = { wasClean: true, isStillCurrent: () => true };
    const dirtyUnchanged = { wasClean: false, isStillCurrent: () => true };
    // projection / non-forced action: needs a clean draft
    expect(shouldReplaceDraft(cleanUnchanged)).toBe(true);
    expect(shouldReplaceDraft(dirtyUnchanged)).toBe(false);
    // save / reset-all: replaces a dirty draft too, but never one edited in flight
    expect(shouldReplaceDraft({ ...dirtyUnchanged, forceReplace: true })).toBe(true);
    expect(shouldReplaceDraft({ wasClean: true, isStillCurrent: () => false, forceReplace: true })).toBe(false);
  });
});
