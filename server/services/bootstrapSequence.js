/**
 * The load-bearing ORDER of server boot, extracted from `bootstrap.js` (#3451).
 *
 * `bootstrap.js` owns *what* each boot step is — the real migration runner, the
 * real AI Toolkit, the real stores, the real listener. This module owns *when*
 * each step runs relative to its neighbours, and receives every step as an
 * injected parameter. That split is the whole point: the ordering contract the
 * `bootstrap.js` header describes ("ordering inside each phase is load-bearing")
 * can then be executed and asserted by `bootstrapSequence.test.js` without
 * importing a module graph that would open a real listener, touch the real
 * database, or reach a provider.
 *
 * Rules for editing:
 *   - Nothing here may import a PortOS service, `db.js`, or the AI Toolkit.
 *     Every dependency arrives as a parameter; that is what keeps this testable.
 *   - `await` vs fire-and-forget is part of the contract, not an accident: an
 *     awaited step blocks every later step, and the tests assert which is which.
 *   - No step here may reach an AI provider (CLAUDE.md "No cold-bootstrap LLM
 *     calls"). Boot loads on-disk state and ARMS schedulers, nothing more.
 */

/**
 * Run a best-effort step, logging and continuing on failure. Wrapped in
 * `Promise.resolve` so a synchronous step (or an injected double that returns
 * nothing) flows through the same path as an async one.
 */
const bestEffort = (result, onError) => Promise.resolve(result).catch(onError);

/** Shared shape for the "log it and keep booting" handlers below. */
const logFailure = (label) => (err) => console.error(`❌ ${label}: ${err?.message ?? err}`);

/** Same, but keeping the stack — used where a failure is worth a full trace. */
const logFailureWithStack = (label) => (err) => console.error(`❌ ${label}: ${err?.stack ?? err}`);

/**
 * Pre-route boot ordering (`bootstrapServices`).
 *
 * Load-bearing points, in order:
 *   1. `applyDataMigrations` runs FIRST and is awaited — the toolkit reads
 *      stage-config.json / providers.json, so a pull-and-restart that skipped
 *      `npm run migrations` must still land new prompt stages before then.
 *   2. `verifyCollections` runs before anything can serve a request, and only
 *      logs: a hard exit on a schema mismatch is worse than a noisy log.
 *   3. `createToolkit` → `registerToolkitShims` → `warmProviders`: the shims
 *      hand the toolkit to the compatibility modules before the providers file
 *      is warmed, so the codex-sentinel migration write completes before any
 *      request can consult providers state (hence the await).
 *   4. `registerRunners` before the workers below, so a run dispatched by the
 *      spawner cannot land on a toolkit without PortOS's CLI/TUI runners.
 *   5. `startSpawner` LAST, and its promise is returned (not awaited): CoS init
 *      in the post-route phase gates on it so `task:ready` can't be emitted
 *      before the spawner registered its listener.
 *
 * Returns `{ aiToolkit, spawnerReady }`.
 */
export const runPreRouteSequence = async ({
  applyDataMigrations,
  verifyCollections,
  createToolkit,
  registerToolkitShims,
  warmProviders,
  ensureLocalLlmBackend,
  registerRunners,
  initAutoFixer,
  initTaskLearning,
  startSpawner
}) => {
  await bestEffort(applyDataMigrations(), logFailureWithStack('Migration run failed at startup'));
  await bestEffort(verifyCollections(), logFailureWithStack('Collection version check failed at startup'));

  const aiToolkit = createToolkit();
  registerToolkitShims(aiToolkit);
  await bestEffort(warmProviders(aiToolkit), logFailure('Failed to load providers at startup'));

  // Fire-and-forget: a local backend that won't start must not delay the boot.
  ensureLocalLlmBackend();

  registerRunners(aiToolkit);
  console.log('🔧 Registered PortOS CLI + TUI runners via aiToolkit runner extension points');

  initAutoFixer();
  initTaskLearning();

  const spawnerReady = bestEffort(startSpawner(), logFailure('Failed to initialize spawner'));
  return { aiToolkit, spawnerReady };
};

/**
 * CoS auto-start must wait for the spawner. `cos.init()` can emit `task:ready`
 * for pending tasks while it initializes; emitted before the spawner registered
 * its listener, those events are dropped and the tasks sit forever.
 */
export const initCosAfterSpawner = ({ spawnerReady, initCos }) =>
  Promise.resolve(spawnerReady)
    .then(() => initCos())
    .catch(logFailure('CoS init failed'));

/**
 * Legacy INLINE commission feedback is split into the federated store BEFORE the
 * per-commission crons are armed (#2686), so a fire reads the federated view.
 * Both are best-effort and neither blocks boot.
 */
export const armCommissionScheduler = ({ backfillCommissionFeedback, startCommissionScheduler }) => {
  bestEffort(backfillCommissionFeedback(), logFailure('Commission feedback backfill failed'));
  bestEffort(startCommissionScheduler(), logFailure('Creative Commission scheduler init failed'));
};

/**
 * PostgreSQL health gate. An EXISTING install can be reachable but lag the
 * current schema, so a connected-but-incomplete DB gets one `ensureSchema()`
 * upgrade + re-probe BEFORE we declare it unbootable. Both the memory schema and
 * the creative-catalog schema are required — the catalog has no file-backed
 * equivalent.
 *
 * `escapeHatch` (MEMORY_BACKEND=file / NODE_ENV=test, dev+test only) downgrades
 * the fail-fast to a warning. `onUnbootable` defaults to exiting the process;
 * it is injected so the gate can be exercised without killing the test runner.
 */
export const gateOnDatabase = async ({
  checkHealth,
  ensureSchema,
  escapeHatch,
  onUnbootable = () => process.exit(1)
}) => {
  let health = await checkHealth();
  if (health.connected && (!health.hasSchema || !health.hasCatalogSchema)) {
    // try/catch is appropriate here: this runs outside the request lifecycle, so
    // an uncaught throw would crash boot. A truly uninitialized DB (base tables
    // absent) makes ensureSchema() throw — log and fall through to the gate.
    try {
      await ensureSchema();
      health = await checkHealth();
    } catch (err) {
      console.error(`🗄️  Schema upgrade on boot failed: ${err.message}`);
    }
  }
  const dbReady = Boolean(health.connected && health.hasSchema && health.hasCatalogSchema);
  if (!escapeHatch && !dbReady) {
    const reason = health.connected ? 'required schema missing' : `unreachable (${health.error || 'connection failed'})`;
    console.error(`❌ PostgreSQL is required but ${reason} — refusing to start.`);
    console.error('   Set up the database with: npm run setup:db');
    console.error('   Dev/test only: set PGMODE=file in .env to boot without PostgreSQL (unsupported for production).');
    onUnbootable();
  } else if (escapeHatch && !dbReady) {
    console.warn(`⚠️  PostgreSQL unavailable (${health.error || 'no schema'}) — booting via escape hatch; catalog/DB features are disabled.`);
  }
  return { dbReady };
};

/**
 * DB schema + catalog/media migrations, in dependency order. Best-effort as a
 * group (a transient hiccup mid-walk shouldn't crash an otherwise-healthy boot)
 * EXCEPT `runDbMigrations`, which is FATAL: each migration is transactional so a
 * failure rolls back un-applied, but a partially-migrated install serving
 * requests is worse than a hard stop.
 *
 * Order notes: `ensureSchema` first (base tables + the schema_migrations
 * tracking table); the versioned delta runner next, before any store warm or
 * `listen()`, so a half-applied delta can't race a request; `repairUniverseTags`
 * after the bible→catalog promotion so the rows it rewrites exist;
 * `reconcileCanonCatalog` last so it reconciles rows already at the current
 * payload-shape version.
 *
 * `loadDbMigrationRunner` is a separate step from running it on purpose: only a
 * migration that RAN and failed is fatal. A runner module that can't even be
 * loaded falls to the group's log-and-continue handler, exactly as it did when
 * the `await import(...)` sat outside the inner try.
 *
 * Skipped entirely when `!dbReady` (escape hatch) — every step below would throw.
 */
export const runDbAndCatalogMigrations = async ({
  dbReady,
  ensureSchema,
  loadDbMigrationRunner,
  migrateBibleToCatalog,
  repairUniverseTags,
  migrateCatalogPayload,
  reconcileCanonCatalog,
  initMediaAssetIndex,
  onMigrationFailure = () => process.exit(1)
}) => {
  if (!dbReady) return;
  try {
    await ensureSchema();
    const runDbMigrations = await loadDbMigrationRunner();
    try {
      await runDbMigrations();
    } catch (err) {
      console.error(`❌ DB migration failed at boot — refusing to start: ${err?.stack ?? err.message}`);
      onMigrationFailure();
      return;
    }
    await migrateBibleToCatalog();
    await repairUniverseTags();
    await migrateCatalogPayload();
    await reconcileCanonCatalog();
    await initMediaAssetIndex();
  } catch (err) {
    console.error(`🪄 catalog migrations failed at boot: ${err.message}`);
  }
};

/**
 * Mandatory PostgreSQL store warmups (#1014–1017, #1001, #997) + legacy prune.
 * Each touch forces backend selection and runs a one-time, marker-gated file→DB
 * import that MUST complete before `listen()` — so the first request/sync sees
 * fully-migrated records, never a half-applied import racing a request.
 *
 * Order is load-bearing: series before issues (issues soft-ref series), both
 * before Story Builder (sessions soft-ref both), Creative Director before the
 * prune (the prune stamps a single completion marker once no domain is blocked,
 * so CD's marker must already exist), and `pruneLegacyFiles` LAST for the same
 * reason.
 *
 * A failure here is FATAL, unlike the best-effort catalog migrations above: a
 * store that couldn't select its backend would serve unmigrated/empty data.
 */
export const warmMandatoryStores = async ({
  warmUniverses,
  warmSeries,
  warmIssues,
  warmStoryBuilder,
  warmWritersRoom,
  warmCatalogUserTypes,
  warmCreativeDirector,
  pruneLegacyFiles,
  onWarmFailure = () => process.exit(1)
}) => {
  try {
    await warmUniverses();
    await warmSeries();
    await warmIssues();
    await warmStoryBuilder();
    await warmWritersRoom();
    await warmCatalogUserTypes();
    await warmCreativeDirector();
    await pruneLegacyFiles();
  } catch (err) {
    console.error(`❌ Mandatory store warmup failed at boot — refusing to start: ${err?.stack ?? err.message}`);
    onWarmFailure();
  }
};

/**
 * Database phase: gate, then migrate, then (only on a real DB) warm the stores
 * and arm the Stacker News schedulers. The warm/arm pair is skipped on the
 * escape hatch for the same reason the migrations are — there is no DB to read.
 *
 * Returns the gate result so a caller can branch on `dbReady`.
 */
export const runDatabasePhase = async ({ gate, migrate, warmStores, reconcileStackerNews }) => {
  const gateResult = await gate();
  await migrate(gateResult);
  if (gateResult.dbReady) {
    await warmStores();
    // OFF by default — arms timers for opted-in accounts only, after their
    // tables exist. No initial sync, no local-LLM call.
    await reconcileStackerNews();
  }
  return gateResult;
};

/**
 * Post-route boot ordering (`runBootSequence`), ending in `startListening()`.
 *
 * Load-bearing points, in order:
 *   1. `startBackgroundServices` first and NOT awaited — every scheduler in it
 *      is armed, never fired, so nothing below depends on it.
 *   2. `ensureSelf` → `initSyncLog` awaited before anything can mutate brain
 *      records, so sync sequence numbers are loaded before the first append.
 *   3. `recoverStuckClassifications` AFTER `initSyncLog` (it appends to the sync
 *      log; running it earlier mints colliding seqs and corrupts peer cursors)
 *      but fire-and-forget, since nothing below reads its result.
 *   4. `initMediaJobQueue` awaited before `initMediaJobDependentHooks` — the
 *      hooks must be listening before the queue replays `completed` events for
 *      reloaded jobs, and before a route can enqueue against a half-init queue.
 *   5. The database phase before `startListening`, so no request can land on a
 *      partially-migrated install.
 *   6. The series-cover backfill MODULE is awaited but the backfill RUN is not:
 *      a cosmetic thumbnail pass must never delay the server accepting
 *      requests, while a script that won't even load is a real breakage and
 *      takes the fatal path.
 *
 * Returns the chain's promise; a rejection anywhere in it is fatal.
 */
export const runPostRouteSequence = ({
  startBackgroundServices,
  ensureSelf,
  initSyncLog,
  recoverStuckClassifications,
  initMediaJobQueue,
  initMediaJobDependentHooks,
  initSharing,
  recoverCreativeDirectorProjects,
  runDatabasePhase: databasePhase,
  loadSeriesCoverBackfill,
  startListening,
  onFatal = () => process.exit(1)
}) => {
  startBackgroundServices();

  return Promise.resolve()
    .then(() => ensureSelf())
    .then(() => initSyncLog())
    .then(() => {
      bestEffort(recoverStuckClassifications(), logFailure('Brain recovery failed'));
    })
    .then(() => initMediaJobQueue())
    .then(() => initMediaJobDependentHooks())
    .then(() => {
      // Sharing attaches chokidar watchers + drains the offline manifest
      // backlog. Fire-and-forget — a failed bucket shouldn't block boot.
      bestEffort(initSharing(), logFailure('Sharing init failed'));
    })
    .then(() => {
      // Nudges Creative Director projects the media-queue reload just marked
      // 'failed (interrupted by restart)' so they don't sit frozen. Owns its own
      // failure path (it must resolve the CD recovery gate either way).
      recoverCreativeDirectorProjects();
    })
    .then(() => databasePhase())
    .then(async () => {
      // Load awaited, run not — see point 6 above.
      const backfillSeriesCoverImages = await loadSeriesCoverBackfill();
      bestEffort(backfillSeriesCoverImages(), logFailure('series cover backfill failed at boot'));
    })
    .then(() => startListening())
    .catch((err) => {
      console.error(`❌ Instance init failed: ${err.message}`);
      onFatal();
    });
};

/**
 * Inside the `listen()` callback: announce the URLs, arm the process-level
 * safety net, then backfill origin tags before peer polling + sync start — the
 * backfill stamps `originInstanceId` on legacy rows, and polling a peer before
 * it completes would ship untagged records.
 */
export const runPostListenSequence = ({
  announceListening,
  setupProcessErrorHandlers,
  backfillOriginInstanceId,
  startPolling,
  initSyncOrchestrator
}) => {
  announceListening();
  setupProcessErrorHandlers();
  return bestEffort(
    Promise.resolve(backfillOriginInstanceId()).then(() => {
      startPolling();
      initSyncOrchestrator();
    }),
    logFailure('Post-startup init failed')
  );
};
