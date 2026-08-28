/**
 * Executable coverage for the boot ORDER (#3451).
 *
 * `bootstrap.js` says its ordering is load-bearing, and every install depends on
 * that ordering being right — but the file can't be imported under test (it
 * pulls the whole service graph, and its steps open a listener, a database, and
 * agent workers). `bootstrapSequence.js` exists so the ordering can be run for
 * real with injected doubles: nothing here touches the network, the filesystem,
 * PostgreSQL, or an AI provider.
 *
 * Assertions are on the recorded CALL SEQUENCE, not on "each step ran" — a
 * refactor that reorders two steps is exactly the regression this guards.
 * `await` vs fire-and-forget is asserted too, with deferred promises: several
 * steps are correct only because a later one waits (or deliberately doesn't).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { stripCommentsAndNormalize } from '../lib/mirrorParity.js';
import {
  runPreRouteSequence,
  initCosAfterSpawner,
  armCommissionScheduler,
  gateOnDatabase,
  runDbAndCatalogMigrations,
  warmMandatoryStores,
  runDatabasePhase,
  runPostRouteSequence,
  runPostListenSequence
} from './bootstrapSequence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Records the order steps run in. `impl` lets a step return a value/promise. */
const createRecorder = () => {
  const calls = [];
  const step = (name, impl) => vi.fn((...args) => {
    calls.push(name);
    return impl ? impl(...args) : undefined;
  });
  return { calls, step };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Pre-attached no-op catch would swallow the rejection the code under test
  // must handle, so callers reject only where the sequence has a handler.
  return { promise, resolve, reject };
};

/** Let every already-queued microtask + promise continuation drain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPreRouteSequence — pre-route boot order', () => {
  const buildDeps = (recorder, overrides = {}) => {
    const { step } = recorder;
    return {
      applyDataMigrations: step('applyDataMigrations', () => Promise.resolve()),
      loadUsage: step('loadUsage', () => Promise.resolve()),
      verifyCollections: step('verifyCollections', () => Promise.resolve()),
      createToolkit: step('createToolkit', () => ({ id: 'toolkit' })),
      registerToolkitShims: step('registerToolkitShims'),
      warmProviders: step('warmProviders', () => Promise.resolve([])),
      ensureLocalLlmBackend: step('ensureLocalLlmBackend'),
      registerRunners: step('registerRunners'),
      initAutoFixer: step('initAutoFixer'),
      initTaskLearning: step('initTaskLearning'),
      startSpawner: step('startSpawner', () => Promise.resolve()),
      ...overrides
    };
  };

  it('runs every step exactly once, in the documented order', async () => {
    const recorder = createRecorder();
    await runPreRouteSequence(buildDeps(recorder));
    expect(recorder.calls).toEqual([
      'applyDataMigrations',
      'loadUsage',
      'verifyCollections',
      'createToolkit',
      'registerToolkitShims',
      'warmProviders',
      'ensureLocalLlmBackend',
      'registerRunners',
      'initAutoFixer',
      'initTaskLearning',
      'startSpawner'
    ]);
  });

  it('returns the constructed toolkit and a spawner promise', async () => {
    const recorder = createRecorder();
    const { aiToolkit, spawnerReady } = await runPreRouteSequence(buildDeps(recorder));
    expect(aiToolkit).toEqual({ id: 'toolkit' });
    await expect(spawnerReady).resolves.toBeUndefined();
  });

  it('hands the SAME toolkit instance to the shims, the provider warm, and the runners', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder);
    const { aiToolkit } = await runPreRouteSequence(deps);
    expect(deps.registerToolkitShims).toHaveBeenCalledWith(aiToolkit);
    expect(deps.warmProviders).toHaveBeenCalledWith(aiToolkit);
    expect(deps.registerRunners).toHaveBeenCalledWith(aiToolkit);
  });

  it('awaits the data migrations before the toolkit reads its config files', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      applyDataMigrations: recorder.step('applyDataMigrations', () => gate.promise)
    });
    const done = runPreRouteSequence(deps);
    await flush();
    // The toolkit reads stage-config.json / providers.json — a migration that
    // hasn't landed yet means "Stage X not found" on an updated install.
    expect(recorder.calls).toEqual(['applyDataMigrations']);
    gate.resolve();
    await done;
    expect(recorder.calls.indexOf('loadUsage')).toBeGreaterThan(recorder.calls.indexOf('applyDataMigrations'));
    expect(recorder.calls).toContain('createToolkit');
  });

  it('awaits usage loading after migrations before continuing startup', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      loadUsage: recorder.step('loadUsage', () => gate.promise)
    });
    const done = runPreRouteSequence(deps);
    await flush();
    expect(recorder.calls).toEqual(['applyDataMigrations', 'loadUsage']);
    gate.resolve();
    await done;
    expect(recorder.calls).toContain('verifyCollections');
  });

  it('awaits the provider warm before registering runners', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      warmProviders: recorder.step('warmProviders', () => gate.promise)
    });
    const done = runPreRouteSequence(deps);
    await flush();
    expect(recorder.calls).not.toContain('registerRunners');
    gate.resolve([]);
    await done;
    expect(recorder.calls).toContain('registerRunners');
  });

  it('keeps booting when the migration run and the collection check both fail', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      applyDataMigrations: recorder.step('applyDataMigrations', () => Promise.reject(new Error('migrations exploded'))),
      verifyCollections: recorder.step('verifyCollections', () => Promise.reject(new Error('schema drift')))
    });
    await expect(runPreRouteSequence(deps)).resolves.toMatchObject({ aiToolkit: { id: 'toolkit' } });
    // A noisy log the user can act on beats a server that refuses to start.
    expect(recorder.calls).toContain('createToolkit');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Migration run failed at startup'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Collection version check failed at startup'));
  });

  it('resolves spawnerReady even when the spawner fails, so CoS init is never blocked', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      startSpawner: recorder.step('startSpawner', () => Promise.reject(new Error('spawner down')))
    });
    const { spawnerReady } = await runPreRouteSequence(deps);
    await expect(spawnerReady).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize spawner'));
  });

  it('does not reach the toolkit itself — every touch goes through an injected step', async () => {
    // AGENTS.md "No cold-bootstrap LLM calls": the sequence may construct and
    // hand off the toolkit, never dispatch a run through it.
    const executeRun = vi.fn();
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      createToolkit: recorder.step('createToolkit', () => ({
        services: { runner: { executeRun }, providers: { executeRun }, prompts: { executeRun } }
      }))
    });
    await runPreRouteSequence(deps);
    expect(executeRun).not.toHaveBeenCalled();
  });
});

describe('initCosAfterSpawner', () => {
  it('waits for the spawner before CoS init, so task:ready listeners exist', async () => {
    const spawner = deferred();
    const initCos = vi.fn(() => Promise.resolve());
    const done = initCosAfterSpawner({ spawnerReady: spawner.promise, initCos });
    await flush();
    expect(initCos).not.toHaveBeenCalled();
    spawner.resolve();
    await done;
    expect(initCos).toHaveBeenCalledTimes(1);
  });

  it('logs instead of throwing when CoS init fails', async () => {
    await initCosAfterSpawner({
      spawnerReady: Promise.resolve(),
      initCos: () => Promise.reject(new Error('cos boom'))
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CoS init failed'));
  });
});

describe('armCommissionScheduler', () => {
  it('runs both backfills before arming the per-commission crons', () => {
    const { calls, step } = createRecorder();
    armCommissionScheduler({
      backfillCommissionFeedback: step('feedback', () => Promise.resolve()),
      backfillProjectCommissionIds: step('backpointer', () => Promise.resolve()),
      startCommissionScheduler: step('arm', () => Promise.resolve())
    });
    expect(calls).toEqual(['feedback', 'backpointer', 'arm']);
  });

  it('arms the scheduler even if both backfills fail, and logs each', async () => {
    const arm = vi.fn(() => Promise.reject(new Error('cron boom')));
    armCommissionScheduler({
      backfillCommissionFeedback: () => Promise.reject(new Error('backfill boom')),
      backfillProjectCommissionIds: () => Promise.reject(new Error('backpointer boom')),
      startCommissionScheduler: arm
    });
    await flush();
    expect(arm).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Commission feedback backfill failed'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Commission back-pointer backfill failed'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Creative Commission scheduler init failed'));
  });
});

describe('gateOnDatabase', () => {
  const healthy = { connected: true, hasSchema: true, hasCatalogSchema: true };

  it('reports ready without touching ensureSchema when the DB is current', async () => {
    const ensureSchema = vi.fn();
    const onUnbootable = vi.fn();
    const result = await gateOnDatabase({
      checkHealth: vi.fn(async () => healthy),
      ensureSchema,
      escapeHatch: false,
      onUnbootable
    });
    expect(result).toEqual({ dbReady: true });
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(onUnbootable).not.toHaveBeenCalled();
  });

  it('upgrades and re-probes an install that merely lags the current schema', async () => {
    const { calls, step } = createRecorder();
    // First probe reports the catalog schema missing (the shape an install that
    // pulled new code but hasn't re-run ensureSchema is in); the second, after
    // the upgrade, reports healthy.
    const probes = [{ connected: true, hasSchema: true, hasCatalogSchema: false }, healthy];
    const onUnbootable = vi.fn();
    const result = await gateOnDatabase({
      checkHealth: step('checkHealth', () => Promise.resolve(probes.shift())),
      ensureSchema: step('ensureSchema', () => Promise.resolve()),
      escapeHatch: false,
      onUnbootable
    });
    expect(calls).toEqual(['checkHealth', 'ensureSchema', 'checkHealth']);
    expect(result).toEqual({ dbReady: true });
    expect(onUnbootable).not.toHaveBeenCalled();
  });

  it('refuses to start when the DB is unreachable and no escape hatch is set', async () => {
    const onUnbootable = vi.fn();
    const result = await gateOnDatabase({
      checkHealth: vi.fn(async () => ({ connected: false, error: 'ECONNREFUSED' })),
      ensureSchema: vi.fn(),
      escapeHatch: false,
      onUnbootable
    });
    expect(result).toEqual({ dbReady: false });
    expect(onUnbootable).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('PostgreSQL is required but unreachable'));
  });

  it('falls through the failed upgrade of an uninitialized DB to the fail-fast', async () => {
    const onUnbootable = vi.fn();
    await gateOnDatabase({
      checkHealth: vi.fn(async () => ({ connected: true, hasSchema: false, hasCatalogSchema: false })),
      ensureSchema: vi.fn(async () => {
        throw new Error('relation "memories" does not exist');
      }),
      escapeHatch: false,
      onUnbootable
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Schema upgrade on boot failed'));
    expect(onUnbootable).toHaveBeenCalledTimes(1);
  });

  it('warns instead of exiting under the dev/test escape hatch', async () => {
    const onUnbootable = vi.fn();
    const result = await gateOnDatabase({
      checkHealth: vi.fn(async () => ({ connected: false, error: 'no server' })),
      ensureSchema: vi.fn(),
      escapeHatch: true,
      onUnbootable
    });
    expect(result).toEqual({ dbReady: false });
    expect(onUnbootable).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('booting via escape hatch'));
  });
});

describe('runDbAndCatalogMigrations', () => {
  const buildDeps = (recorder, overrides = {}) => {
    const { step } = recorder;
    return {
      dbReady: true,
      ensureSchema: step('ensureSchema', () => Promise.resolve()),
      loadDbMigrationRunner: step('loadDbMigrationRunner', () =>
        Promise.resolve(step('runDbMigrations', () => Promise.resolve()))),
      migrateBibleToCatalog: step('migrateBibleToCatalog', () => Promise.resolve()),
      repairUniverseTags: step('repairUniverseTags', () => Promise.resolve()),
      migrateCatalogPayload: step('migrateCatalogPayload', () => Promise.resolve()),
      reconcileCanonCatalog: step('reconcileCanonCatalog', () => Promise.resolve()),
      initMediaAssetIndex: step('initMediaAssetIndex', () => Promise.resolve()),
      onMigrationFailure: vi.fn(),
      ...overrides
    };
  };

  it('walks the migrations in dependency order', async () => {
    const recorder = createRecorder();
    await runDbAndCatalogMigrations(buildDeps(recorder));
    expect(recorder.calls).toEqual([
      'ensureSchema',
      'loadDbMigrationRunner',
      'runDbMigrations',
      'migrateBibleToCatalog',
      'repairUniverseTags',
      'migrateCatalogPayload',
      'reconcileCanonCatalog',
      'initMediaAssetIndex'
    ]);
  });

  it('runs nothing at all on the file escape hatch', async () => {
    const recorder = createRecorder();
    await runDbAndCatalogMigrations(buildDeps(recorder, { dbReady: false }));
    expect(recorder.calls).toEqual([]);
  });

  it('treats a failed schema-delta migration as fatal and skips the rest', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      loadDbMigrationRunner: recorder.step('loadDbMigrationRunner', () =>
        Promise.resolve(recorder.step('runDbMigrations', () => Promise.reject(new Error('delta 42 failed')))))
    });
    await runDbAndCatalogMigrations(deps);
    expect(recorder.calls).toEqual(['ensureSchema', 'loadDbMigrationRunner', 'runDbMigrations']);
    expect(deps.onMigrationFailure).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DB migration failed at boot'));
  });

  it('is NOT fatal when the migration runner module itself cannot be loaded', async () => {
    // Only a migration that RAN and failed leaves a possibly-half-applied
    // install; a runner that never loaded applied nothing, so it takes the
    // group's log-and-continue path.
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      loadDbMigrationRunner: recorder.step('loadDbMigrationRunner', () => Promise.reject(new Error('module missing')))
    });
    await runDbAndCatalogMigrations(deps);
    expect(deps.onMigrationFailure).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual(['ensureSchema', 'loadDbMigrationRunner']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('catalog migrations failed at boot'));
  });

  it('keeps booting when a best-effort catalog migration fails', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      repairUniverseTags: recorder.step('repairUniverseTags', () => Promise.reject(new Error('tag repair hiccup')))
    });
    await runDbAndCatalogMigrations(deps);
    expect(deps.onMigrationFailure).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('catalog migrations failed at boot'));
    // Later steps are skipped (they share one try block) but boot continues.
    expect(recorder.calls).toEqual([
      'ensureSchema',
      'loadDbMigrationRunner',
      'runDbMigrations',
      'migrateBibleToCatalog',
      'repairUniverseTags'
    ]);
  });
});

describe('warmMandatoryStores', () => {
  const buildDeps = (recorder, overrides = {}) => {
    const { step } = recorder;
    return {
      warmUniverses: step('warmUniverses', () => Promise.resolve([])),
      warmSeries: step('warmSeries', () => Promise.resolve([])),
      warmIssues: step('warmIssues', () => Promise.resolve([])),
      warmStoryBuilder: step('warmStoryBuilder', () => Promise.resolve([])),
      warmWritersRoom: step('warmWritersRoom', () => Promise.resolve([])),
      warmCatalogUserTypes: step('warmCatalogUserTypes', () => Promise.resolve()),
      warmCreativeDirector: step('warmCreativeDirector', () => Promise.resolve([])),
      pruneLegacyFiles: step('pruneLegacyFiles', () => Promise.resolve()),
      onWarmFailure: vi.fn(),
      ...overrides
    };
  };

  it('warms every store in soft-reference order, pruning last', async () => {
    const recorder = createRecorder();
    await warmMandatoryStores(buildDeps(recorder));
    expect(recorder.calls).toEqual([
      'warmUniverses',
      'warmSeries',
      'warmIssues',
      'warmStoryBuilder',
      'warmWritersRoom',
      'warmCatalogUserTypes',
      'warmCreativeDirector',
      'pruneLegacyFiles'
    ]);
  });

  it('refuses to start when a store cannot select its backend', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      warmWritersRoom: recorder.step('warmWritersRoom', () => Promise.reject(new Error('import failed')))
    });
    await warmMandatoryStores(deps);
    expect(deps.onWarmFailure).toHaveBeenCalledTimes(1);
    // The prune must NOT run: it would drop the .imported recovery copies while
    // a domain's import is still unfinished.
    expect(recorder.calls).not.toContain('pruneLegacyFiles');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Mandatory store warmup failed at boot'));
  });
});

describe('runDatabasePhase', () => {
  const buildDeps = (recorder, gateResult = { dbReady: true }) => {
    const { step } = recorder;
    return {
      gate: step('gate', () => Promise.resolve(gateResult)),
      migrate: step('migrate', () => Promise.resolve()),
      warmStores: step('warmStores', () => Promise.resolve()),
      reconcileStackerNews: step('reconcileStackerNews', () => Promise.resolve())
    };
  };

  it('gates, migrates, warms, then arms the opt-in schedulers', async () => {
    const recorder = createRecorder();
    await runDatabasePhase(buildDeps(recorder));
    expect(recorder.calls).toEqual(['gate', 'migrate', 'warmStores', 'reconcileStackerNews']);
  });

  it('passes the gate result (dbReady + ensureSchema) straight to the migrations', async () => {
    const recorder = createRecorder();
    const gateResult = { dbReady: true, ensureSchema: () => {} };
    const deps = buildDeps(recorder, gateResult);
    const returned = await runDatabasePhase(deps);
    expect(deps.migrate).toHaveBeenCalledWith(gateResult);
    expect(returned).toBe(gateResult);
  });

  it('skips the warm + scheduler arm when there is no usable DB', async () => {
    const recorder = createRecorder();
    await runDatabasePhase(buildDeps(recorder, { dbReady: false }));
    expect(recorder.calls).toEqual(['gate', 'migrate']);
  });
});

describe('runPostRouteSequence — post-route boot order', () => {
  const buildDeps = (recorder, overrides = {}) => {
    const { step } = recorder;
    return {
      startBackgroundServices: step('startBackgroundServices'),
      ensureSelf: step('ensureSelf', () => Promise.resolve()),
      initSyncLog: step('initSyncLog', () => Promise.resolve()),
      recoverStuckClassifications: step('recoverStuckClassifications', () => Promise.resolve()),
      initMediaJobQueue: step('initMediaJobQueue', () => Promise.resolve()),
      initMediaJobDependentHooks: step('initMediaJobDependentHooks'),
      initSharing: step('initSharing', () => Promise.resolve()),
      recoverCreativeDirectorProjects: step('recoverCreativeDirectorProjects', () => Promise.resolve()),
      runDatabasePhase: step('runDatabasePhase', () => Promise.resolve({ dbReady: true })),
      loadSeriesCoverBackfill: step('loadSeriesCoverBackfill', () =>
        Promise.resolve(step('backfillSeriesCoverImages', () => Promise.resolve()))),
      startListening: step('startListening'),
      onFatal: vi.fn(),
      ...overrides
    };
  };

  it('walks the whole chain in the documented order, ending in listen()', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder);
    await runPostRouteSequence(deps);
    expect(recorder.calls).toEqual([
      'startBackgroundServices',
      'ensureSelf',
      'initSyncLog',
      'recoverStuckClassifications',
      'initMediaJobQueue',
      'initMediaJobDependentHooks',
      'initSharing',
      'recoverCreativeDirectorProjects',
      'runDatabasePhase',
      'loadSeriesCoverBackfill',
      'backfillSeriesCoverImages',
      'startListening'
    ]);
    expect(deps.onFatal).not.toHaveBeenCalled();
  });

  it('arms the background services synchronously, before the chain awaits anything', () => {
    const recorder = createRecorder();
    const promise = runPostRouteSequence(buildDeps(recorder));
    expect(recorder.calls).toEqual(['startBackgroundServices']);
    return promise;
  });

  it('awaits the sync log before brain recovery can append to it', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      initSyncLog: recorder.step('initSyncLog', () => gate.promise)
    });
    const done = runPostRouteSequence(deps);
    await flush();
    // Recovering earlier would mint colliding sync sequence numbers and corrupt
    // every peer's cursor.
    expect(recorder.calls).not.toContain('recoverStuckClassifications');
    gate.resolve();
    await done;
    expect(recorder.calls).toContain('recoverStuckClassifications');
  });

  it('awaits the media job queue before wiring its completion hooks', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      initMediaJobQueue: recorder.step('initMediaJobQueue', () => gate.promise)
    });
    const done = runPostRouteSequence(deps);
    await flush();
    // The hooks must be listening before the queue replays `completed` for
    // reloaded jobs, and no route may enqueue against a half-init queue.
    expect(recorder.calls).toEqual(['startBackgroundServices', 'ensureSelf', 'initSyncLog', 'recoverStuckClassifications', 'initMediaJobQueue']);
    gate.resolve();
    await done;
    expect(recorder.calls).toContain('initMediaJobDependentHooks');
    expect(recorder.calls).toContain('startListening');
  });

  it('does NOT await brain recovery, sharing, CD recovery, or the cover backfill', async () => {
    const recorder = createRecorder();
    const stuck = deferred();
    const deps = buildDeps(recorder, {
      recoverStuckClassifications: recorder.step('recoverStuckClassifications', () => stuck.promise),
      initSharing: recorder.step('initSharing', () => deferred().promise),
      recoverCreativeDirectorProjects: recorder.step('recoverCreativeDirectorProjects', () => deferred().promise),
      loadSeriesCoverBackfill: recorder.step('loadSeriesCoverBackfill', () =>
        Promise.resolve(recorder.step('backfillSeriesCoverImages', () => deferred().promise)))
    });
    // None of these ever settle; the server must still start listening.
    await runPostRouteSequence(deps);
    expect(recorder.calls).toContain('startListening');
    stuck.resolve();
  });

  it('awaits the series-cover backfill MODULE but not the backfill itself', async () => {
    const recorder = createRecorder();
    const load = deferred();
    const deps = buildDeps(recorder, {
      loadSeriesCoverBackfill: recorder.step('loadSeriesCoverBackfill', () => load.promise)
    });
    const done = runPostRouteSequence(deps);
    await flush();
    expect(recorder.calls).not.toContain('startListening');
    // A script that won't even load is a real breakage, so the load sits on the
    // fatal path; the cosmetic backfill run never delays the listener.
    load.resolve(recorder.step('backfillSeriesCoverImages', () => deferred().promise));
    await done;
    expect(recorder.calls).toContain('startListening');
    expect(deps.onFatal).not.toHaveBeenCalled();
  });

  it('is fatal when the series-cover backfill module cannot be loaded', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      loadSeriesCoverBackfill: recorder.step('loadSeriesCoverBackfill', () => Promise.reject(new Error('script missing')))
    });
    await runPostRouteSequence(deps);
    expect(deps.onFatal).toHaveBeenCalledTimes(1);
    expect(recorder.calls).not.toContain('startListening');
  });

  it('finishes the database phase before the listener opens', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const deps = buildDeps(recorder, {
      runDatabasePhase: recorder.step('runDatabasePhase', () => gate.promise)
    });
    const done = runPostRouteSequence(deps);
    await flush();
    // A request landing on a partially-migrated install is the failure mode.
    expect(recorder.calls).not.toContain('startListening');
    gate.resolve({ dbReady: true });
    await done;
    expect(recorder.calls).toContain('startListening');
  });

  it('is fatal when an awaited step rejects, and never opens the listener', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      initMediaJobQueue: recorder.step('initMediaJobQueue', () => Promise.reject(new Error('queue half-init')))
    });
    await runPostRouteSequence(deps);
    expect(deps.onFatal).toHaveBeenCalledTimes(1);
    expect(recorder.calls).not.toContain('startListening');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Instance init failed'));
  });

  it('is NOT fatal when a fire-and-forget step rejects', async () => {
    const recorder = createRecorder();
    const deps = buildDeps(recorder, {
      recoverStuckClassifications: recorder.step('recoverStuckClassifications', () => Promise.reject(new Error('brain boom'))),
      initSharing: recorder.step('initSharing', () => Promise.reject(new Error('bucket gone'))),
      loadSeriesCoverBackfill: recorder.step('loadSeriesCoverBackfill', () =>
        Promise.resolve(recorder.step('backfillSeriesCoverImages', () => Promise.reject(new Error('no covers')))))
    });
    await runPostRouteSequence(deps);
    await flush();
    expect(deps.onFatal).not.toHaveBeenCalled();
    expect(recorder.calls).toContain('startListening');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Brain recovery failed'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Sharing init failed'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('series cover backfill failed at boot'));
  });
});

describe('runPostListenSequence — inside the listen callback', () => {
  const buildDeps = (recorder, overrides = {}) => {
    const { step } = recorder;
    return {
      announceListening: step('announceListening'),
      setupProcessErrorHandlers: step('setupProcessErrorHandlers'),
      backfillOriginInstanceId: step('backfillOriginInstanceId', () => Promise.resolve()),
      startPolling: step('startPolling'),
      initSyncOrchestrator: step('initSyncOrchestrator'),
      ...overrides
    };
  };

  it('announces, arms the safety net, then backfills before peer sync starts', async () => {
    const recorder = createRecorder();
    await runPostListenSequence(buildDeps(recorder));
    expect(recorder.calls).toEqual([
      'announceListening',
      'setupProcessErrorHandlers',
      'backfillOriginInstanceId',
      'startPolling',
      'initSyncOrchestrator'
    ]);
  });

  it('does not start peer polling until origin tags are backfilled', async () => {
    const recorder = createRecorder();
    const gate = deferred();
    const done = runPostListenSequence(buildDeps(recorder, {
      backfillOriginInstanceId: recorder.step('backfillOriginInstanceId', () => gate.promise)
    }));
    await flush();
    // Polling a peer first would ship records with no originInstanceId.
    expect(recorder.calls).not.toContain('startPolling');
    gate.resolve();
    await done;
    expect(recorder.calls).toContain('startPolling');
  });

  it('logs and continues when the backfill fails', async () => {
    const recorder = createRecorder();
    await runPostListenSequence(buildDeps(recorder, {
      backfillOriginInstanceId: recorder.step('backfillOriginInstanceId', () => Promise.reject(new Error('tag boom')))
    }));
    expect(recorder.calls).not.toContain('startPolling');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Post-startup init failed'));
  });
});

/**
 * Source contract. The behavioural tests above run the sequence with doubles;
 * these assert the properties that only the real files can carry — that boot is
 * silent on the LLM front, and that the tested ordering is the one that actually
 * runs on a real install.
 */
describe('boot source contract', () => {
  const read = (rel) => stripCommentsAndNormalize(readFileSync(join(__dirname, rel), 'utf-8').replace(/\r\n/g, '\n'));
  const BOOTSTRAP = read('bootstrap.js');
  const SEQUENCE = read('bootstrapSequence.js');

  // Every entry point that dispatches work to an AI provider. AGENTS.md's
  // "No cold-bootstrap LLM calls": a fresh install coming online must be silent
  // until the user asks for AI-backed work. Boot may ARM a scheduler (which
  // gates on user config before it ever fires) but must never call these.
  const PROVIDER_CALLS = [
    'runStagedLLM',
    'runInlineLLM',
    'runStageScopedInlineLLM',
    'runPromptThroughProvider',
    'executeCliRun',
    'executeTuiRun',
    'executeApiRun',
    'createRun'
  ];

  for (const [label, src] of [['bootstrap.js', BOOTSTRAP], ['bootstrapSequence.js', SEQUENCE]]) {
    it(`${label} queues no AI provider call at boot`, () => {
      for (const name of PROVIDER_CALLS) {
        // A bare reference (e.g. handing executeCliRun to setCliRunner) is fine —
        // registering a runner is not invoking one. Only an invocation fails.
        expect(src, `${label} invokes ${name}() during boot`).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
      }
    });
  }

  it('bootstrapSequence.js imports nothing — every dependency is injected', () => {
    // An import here would both defeat the "runs without a real install"
    // property these tests rely on and let a service sneak into the boot path
    // untested.
    expect(SEQUENCE).not.toMatch(/\bimport\s/);
  });

  it('bootstrap.js delegates its ordering to the tested sequence module', () => {
    expect(BOOTSTRAP).toMatch(/from '\.\/bootstrapSequence\.js'/);
    for (const fn of ['runPreRouteSequence', 'runPostRouteSequence', 'runPostListenSequence', 'runDatabasePhase']) {
      expect(BOOTSTRAP, `bootstrap.js never calls ${fn}() — the tested ordering would be dead code`)
        .toMatch(new RegExp(`\\b${fn}\\s*\\(`));
    }
  });
});
