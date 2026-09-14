/**
 * Announce a retired model pin at the moment it becomes observable (#7328).
 *
 * `modelPinAudit.js` derives the stale set on READ, which is the right rule —
 * it catches pins that rotted before it shipped and needs nothing persisted.
 * What derive-on-read cannot do is tell anybody: without this, a pin stays
 * quietly broken until the user happens to open Settings → Providers.
 *
 * A catalog refresh is that moment, so this runs from the toolkit's
 * `onProvidersSaved` host extension point (wired in `bootstrap.js`) and logs.
 * It is a TRIGGER for the existing audit, never a second source of truth: no
 * membership rule lives here, no stale set is persisted, and nothing is written
 * inside `server/lib/aiToolkit/` (its AGENTS.md forbids that).
 *
 * **Transition only.** `providers.json` is written by a refresh, a legacy
 * `PATCH /api/providers/:id`, a migration and a boot seed alike, so an install
 * carrying one rotted pin would narrate on every one of them forever. The ids
 * reported last time are held in process memory and re-announced only when a
 * pin that was NOT stale then is stale now. Nothing is persisted — a restart
 * re-announcing once is the accepted cost of keeping this off disk and off the
 * federation layer.
 */

/**
 * The pin ids reported by the last SUCCESSFUL audit.
 *
 * Only a successful audit may replace this. A failed one that wrote an empty
 * set here would forget what it had already announced, so the next successful
 * audit would re-announce a pin the user was told about — the exact narration
 * loop this module exists to prevent.
 */
let lastReportedStaleIds = new Set();

/**
 * At most one audit runs, and at most one more is queued behind it.
 *
 * `saveProviders` AWAITS this hook, so every audit sits on the latency of the
 * write that triggered it — and provider writes arrive in bursts: the harness
 * catalog sync saves one provider at a time, the graph's import does the same,
 * and the graph's own projection write re-enters this hook from inside a pass
 * it latches itself out of. Each of those saves would otherwise pay a full
 * audit whose answer depends only on the FINAL state, so all but the last is
 * wasted. Coalescing bounds a burst of N writes at two audits.
 *
 * A queued caller gets the in-flight promise. That cannot cycle back on itself:
 * the audit only READS the pin stores, and never writes `providers.json`.
 */
let running = null;
let queued = false;

/** Test seam: forget what was reported so the next audit announces again. */
export function resetStaleModelPinReport() {
  lastReportedStaleIds = new Set();
  running = null;
  queued = false;
}

/**
 * Deferred so the audit's own import closure — and the pin stores behind it —
 * stays out of the boot closure `bootstrap.js` pays for. Memoizes the PROMISE
 * rather than the module, matching `modelPinAudit.js`'s own loaders: concurrent
 * `import()` calls of a mocked module can let one caller escape the mock unless
 * they share a single in-flight promise.
 */
let auditModule = null;
const loadAuditModule = () => (auditModule ||= import('./modelPinAudit.js'));

async function reportOnce() {
  const { auditModelPins } = await loadAuditModule();
  const { pins } = await auditModelPins();
  const staleIds = new Set(pins.map((pin) => pin.id));
  // A pin that was already stale last time is not news. Only a pin that has
  // newly rotted earns a line, so the normal state (nothing stale, or the same
  // stale set as before) is silent.
  const newlyStale = [...staleIds].filter((id) => !lastReportedStaleIds.has(id));
  // Assign the full set, not just the new ids: a pin the user clears drops out
  // here, so rotting again later announces again.
  lastReportedStaleIds = staleIds;
  if (newlyStale.length === 0) return;
  console.log(`⚠️ ${newlyStale.length} of ${staleIds.size} stored model pin(s) now name a retired model`
    + ' — review Settings → Providers');
}

async function drain() {
  do {
    queued = false;
    // The hook is non-fatal by contract: the `providers.json` write has already
    // landed, and its callers include boot warmups and schedulers with no
    // Express `next(err)` to bubble to. Log and continue, leaving
    // `lastReportedStaleIds` untouched so the next audit still announces.
    await reportOnce().catch((error) => {
      console.error(`❌ Model pin audit after provider save failed: ${error.message}`);
    });
  } while (queued);
  running = null;
}

/**
 * Audit the stored model pins and log any that newly went stale. Never rejects.
 *
 * @returns {Promise<void>}
 */
export function reportRetiredModelPins() {
  if (running) {
    queued = true;
    return running;
  }
  running = drain();
  return running;
}
