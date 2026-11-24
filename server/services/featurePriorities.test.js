/**
 * The audit scope read from feature priorities (#18524): what one PortOS audit is told about tiers, and what it never is.
 *
 * Runs the real resolver on its file backend (PATHS.data re-rooted at a temp dir). Tier precedence itself is proven in
 * `routes/featurePriorities.test.js`; this suite pins the projection an audit prompt receives.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { getFeatureArea } from '../lib/featureAreas.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-audit-scope-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('./instanceFeatures.js', async () => ({
  ...(await vi.importActual('./instanceFeatures.js')),
  detectFeatureConfiguration: async () => ({}),
}));
const usageStore = vi.hoisted(() => ({ failure: null }));
vi.mock('../lib/pgFileFacade.js', async () => {
  const actual = await vi.importActual('../lib/pgFileFacade.js');
  return {
    ...actual,
    createPgFileFacade: (options) => {
      const facade = actual.createPgFileFacade(options);
      return { ...facade, getBackend: async () => {
        if (usageStore.failure) throw usageStore.failure;
        return facade.getBackend();
      } };
    },
  };
});

const { recordVisit, resolveAuditPriorityScope } = await import('./featurePriorities.js');
const { writeSettingsFile } = bindSettingsFile(tempRoot);

const PORTOS = { id: PORTOS_APP_ID, name: 'PortOS' };
const DAY_MS = 24 * 60 * 60 * 1000;
const entry = (areaId) => ({ label: getFeatureArea(areaId).label, globs: [...getFeatureArea(areaId).codeGlobs] });
const labels = (areas) => areas.map((area) => area.label);

const seedBrainDays = async (count) => {
  for (let ago = count - 1; ago >= 0; ago -= 1) await recordVisit('/brain/inbox', { now: Date.now() - ago * DAY_MS });
};

beforeEach(async () => {
  rmSync(join(tempRoot, 'feature-usage-days.json'), { force: true });
  await writeSettingsFile({});
  usageStore.failure = null;
});
afterEach(() => vi.restoreAllMocks());
afterAll(cleanup);

describe('resolveAuditPriorityScope', () => {
  it('returns null for a managed app, a missing app and an app without an id, without reading the store', async () => {
    usageStore.failure = new Error('the store must not be read');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const app of [{ id: 'app-1', name: 'Managed' }, { name: 'No id' }, null, undefined]) {
      expect(await resolveAuditPriorityScope(app, 'performance-efficiency')).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('lists a switched-off optional feature as P3 with its catalog globs, and nothing else on a fresh install', async () => {
    const scope = await resolveAuditPriorityScope(PORTOS, 'performance-efficiency');
    expect(Object.keys(scope).sort()).toEqual(['exempt', 'p0', 'p2', 'p3']);
    expect(scope.exempt).toBe(false);
    expect(scope.p0).toEqual([]);
    expect(scope.p2).toEqual([]);
    // Beeper ships disabled, so with no visit it is dormant before any evidence exists.
    expect(scope.p3).toContainEqual(entry('beeper'));
    expect(labels(scope.p3)).not.toContain('Brain');
  });

  it('is empty when every optional feature is on and nothing is pinned or learned', async () => {
    const { INSTANCE_FEATURE_IDS } = await import('../lib/instanceFeatureRegistry.js');
    await writeSettingsFile({ instanceFeatures: Object.fromEntries(INSTANCE_FEATURE_IDS.map((id) => [id, { enabled: true }])) });
    expect(await resolveAuditPriorityScope(PORTOS, 'accessibility')).toEqual({ exempt: false, p0: [], p2: [], p3: [] });
  });

  it('groups pinned and learned tiers, leaves P1 out and carries labels and globs only', async () => {
    await seedBrainDays(16);
    await writeSettingsFile({ featurePriorities: { overrides: { jira: 'P2', tribe: 'P1', 'settings-core': 'P3' } } });
    const scope = await resolveAuditPriorityScope(PORTOS, 'code-simplification');
    expect(scope.p0).toEqual([entry('brain')]);
    expect(scope.p2).toContainEqual(entry('jira'));
    expect(scope.p3).toContainEqual(entry('settings-core'));
    const listed = [...scope.p0, ...scope.p2, ...scope.p3];
    expect(labels(listed)).not.toContain(getFeatureArea('tribe').label);
    for (const area of listed) {
      expect(Object.keys(area).sort()).toEqual(['globs', 'label']);
      expect(area.globs.length).toBeGreaterThan(0);
    }
    // Sixteen seeded days of usage, their dates and each tier's source must not survive the projection.
    expect(JSON.stringify(scope)).not.toMatch(/\d{4}-\d{2}-\d{2}|activeDays|lastActive|evidence|pinned|learned|feature-off|"source"|"tier"|"areaId"/);
  });

  it('marks the security, privacy and data integrity lanes exempt, folded task ids included', async () => {
    for (const taskType of ['security', 'privacy', 'data-integrity-safety', 'data-safety', 'data-integrity', 'upgrade-rehearsal']) {
      const scope = await resolveAuditPriorityScope(PORTOS, taskType);
      expect(scope.exempt, taskType).toBe(true);
      expect(scope.p3, taskType).toContainEqual(entry('beeper'));
    }
    expect((await resolveAuditPriorityScope(PORTOS, 'ui-runtime-bugs')).exempt).toBe(false);
  });

  it('hands out copies, so a caller cannot edit the catalog through the scope', async () => {
    const scope = await resolveAuditPriorityScope(PORTOS, 'performance-efficiency');
    const beeper = scope.p3.find((area) => area.label === 'Beeper');
    beeper.globs.push('server/**');
    expect(getFeatureArea('beeper').codeGlobs).not.toContain('server/**');
  });

  it('falls back to no scope when the usage store is unavailable, on stdout with a skip marker', async () => {
    usageStore.failure = new Error('Feature usage tracking requires PostgreSQL');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // null, never a scope that reads "everything is dormant".
    expect(await resolveAuditPriorityScope(PORTOS, 'performance-efficiency')).toBeNull();
    expect(log).toHaveBeenCalledWith('⏭️ Feature priority scope unavailable for performance-efficiency, auditing without it: Feature usage tracking requires PostgreSQL');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
