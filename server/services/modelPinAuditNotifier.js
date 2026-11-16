/**
 * Announce a retired model pin at the moment it becomes observable.
 *
 * `modelPinAudit.js` derives the stale set on READ; derive-on-read cannot tell anybody,
 * so a pin would stay quietly broken until the user opens Settings → Providers. The
 * announcement is a notification CARD, with a log line beside it as the operator trail.
 *
 * A catalog refresh is that moment, so this runs from the toolkit's `onProvidersSaved`
 * host extension point (wired in `bootstrap.js`). It is a TRIGGER for the existing audit,
 * never a second source of truth: no membership rule lives here, no stale set is
 * persisted, and nothing is written inside `server/lib/aiToolkit/` (its AGENTS.md
 * forbids that).
 *
 * **The card IS the dedupe state.** `providers.json` is written by a refresh, a PATCH, a
 * migration and a boot seed alike, so an install with one rotted pin would otherwise
 * narrate on every write. The durable card answers "already announced?", so a restart
 * cannot re-announce.
 *
 * **What is deduped is the pin's VALUE, not its location.** `pin.id` says where a pin
 * lives; the retirement is about the model it holds. Keying on id alone would leave a
 * card naming the old model after a repoint, and permanently suppress the next model
 * retired at that location. The dedupe key is `pinId` + `model`, and `reconcile()`
 * retracts every announced card whose pin no longer names that model on the next audit,
 * whatever path moved it. `clearModelPin` retracts by `pinId` alone so a panel clear is
 * immediate.
 *
 * `data/notifications.json` is machine-local (nothing in `server/` federates it).
 */

/**
 * At most one audit runs, and at most one more is queued behind it.
 *
 * `saveProviders` AWAITS this hook and provider writes arrive in bursts (harness catalog
 * sync, graph import, and the graph's own projection write re-entering this hook). The
 * audit's answer depends only on the FINAL state, so coalescing bounds a burst of N
 * writes at two audits. This is about write latency alone; the announcement dedupe is
 * the persisted card.
 *
 * A queued caller gets the in-flight promise. That cannot cycle: the audit only READS
 * the pin stores and never writes `providers.json`.
 */
let running = null;
let queued = false;

/**
 * Test seam: drop the in-flight coalescing state between cases. Deliberately NOT a
 * "forget what was announced" reset: that lives in `data/notifications.json`.
 */
export function resetModelPinReportState() {
  running = null;
  queued = false;
}

// The one exception to this module's no-static-imports posture: naming a pin's provider
// records is a pure leaf (`modelPinReconcile.js`) shared with the panel, so the card and
// the panel describe one pin identically.
import { pinProviderNames } from '../lib/modelPinReconcile.js';

/**
 * Deferred so the audit's import closure stays out of the boot closure `bootstrap.js`
 * pays for. Memoizes the PROMISE (as `modelPinAudit.js`'s loaders do): concurrent
 * `import()` calls of a mocked module can otherwise let one caller escape the mock.
 */
let auditModule = null;
let notificationsModule = null;
const loadAuditModule = () => (auditModule ||= import('./modelPinAudit.js'));
const loadNotificationsModule = () => (notificationsModule ||= import('./notifications.js'));

/**
 * The identity of what a card ANNOUNCES: this pin, holding this model.
 *
 * A NEWLINE separator: pin ids and model ids embed dots, colons and slashes, so any
 * printable separator a user could type could be forged into a collision. A newline can
 * appear in neither (pin ids are built from a settings path or record id, and a model id
 * is charset-bounded before storage).
 */
const pinCardKey = (pin) => `${pin.id}\n${pin.model}`;

/**
 * One card per pin, so each carries its own `href`/`location` and can be retracted
 * independently when that pin is cleared.
 */
async function announce(pin, providers) {
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } =
    await loadNotificationsModule();
  // The persisted card is the dedupe record. Keyed by the pin's VALUE, so a pin repointed
  // to a DIFFERENT retired model announces the new one.
  if (await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'pinKey', pinCardKey(pin))) return false;
  // Every record the pin was judged against (a reviewer pin spans several), so the card
  // agrees with the panel; `pinProviderNames` is what both call.
  const providerName = pinProviderNames(pin, providers);
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: 'Pinned model retired',
    description: `${pin.label} pins "${pin.model}", which ${providerName} no longer offers`
      + ` — clear it in ${pin.location}.`,
    priority: PRIORITY_LEVELS.MEDIUM,
    link: pin.href || null,
    // `pinId` stays beside `pinKey`: it is what `clearModelPin` retracts by,
    // and what a surface linking back to the pin reads.
    metadata: {
      pinId: pin.id, pinKey: pinCardKey(pin),
      kind: pin.kind, providerIds: pin.providerIds, model: pin.model,
    },
  });
  return true;
}

/**
 * Retract every announced card the current audit no longer earns.
 *
 * `clearModelPin` covers only the path that starts at the card; a pin repointed anywhere
 * else (Settings, a record edit, a template save, a `PATCH`) would leave its card naming a
 * model the pin no longer holds. The audit knows the complete set of currently-stale
 * pins, so every other announced card is stale BY DEFINITION: repointed to a live model,
 * repointed to a different retired one (announced again under its new key), or deleted.
 * Retracting from the derived set needs no change-detection and no second source of truth.
 *
 * Scoped to cards this module wrote (`AGENT_WARNING` carrying a `pinKey`), so another
 * producer's warning is never touched. A legacy card with no `pinKey` is retracted and
 * re-announced under the new key on the same pass, so no migration is needed. If that
 * retraction fails, two cards briefly exist for one pin; the next audit retracts the
 * legacy one, and a panel Clear takes both (`removeByMetadata` matches every card sharing
 * the `pinId`).
 */
async function reconcile(stalePins) {
  const { getNotifications, removeNotification, NOTIFICATION_TYPES } = await loadNotificationsModule();
  const earned = new Set(stalePins.map(pinCardKey));
  const cards = await getNotifications({ type: NOTIFICATION_TYPES.AGENT_WARNING });
  // Sequential for the same reason the announcements are: these share one file.
  for (const card of cards) {
    if (!card.metadata?.pinId) continue;
    if (card.metadata.pinKey && earned.has(card.metadata.pinKey)) continue;
    await removeNotification(card.id).catch((error) => {
      console.error(`❌ Retracting stale retired-pin card ${card.id} failed: ${error.message}`);
    });
  }
}

async function reportOnce() {
  const { auditModelPins } = await loadAuditModule();
  const { pins, providers, incomplete } = await auditModelPins();
  // A transient store-read error leaves collectors unevaluated, so an empty pin set is
  // "unknown", not "healthy": reconciling would retract announced cards and the next audit
  // would re-notify. Skip the pass; the next refresh retries.
  if (incomplete) {
    console.error('❌ Model pin audit incomplete — a pin store was unreadable; keeping announced cards');
    return;
  }
  // BEFORE the early return and before announcing: an install whose last stale pin was just
  // repointed has an empty pin set and a card that must still come down.
  //
  // Non-fatal, like each announcement: a failed retraction must not swallow the
  // announcements behind it; the next audit retries.
  await reconcile(pins).catch((error) => {
    console.error(`❌ Reconciling retired-pin notifications failed: ${error.message}`);
  });
  if (pins.length === 0) return;
  // Sequential, not Promise.all: `addNotification` and `exists` share one file, and two
  // concurrent announcements of the same pin would both miss the other's card.
  //
  // Each announcement is independent: one failure must not drop every pin behind it, and
  // the coalescing guard means the next audit may be a whole burst away.
  let announced = 0;
  for (const pin of pins) {
    const raised = await announce(pin, providers).catch((error) => {
      console.error(`❌ Announcing retired model pin ${pin.id} failed: ${error.message}`);
      return false;
    });
    if (raised) announced += 1;
  }
  if (announced === 0) return;
  console.log(`⚠️ ${announced} of ${pins.length} stored model pin(s) now name a retired model`
    + ' — see Notifications');
}

async function drain() {
  do {
    queued = false;
    // The hook is non-fatal by contract: the `providers.json` write has already landed and
    // callers include boot warmups and schedulers with no `next(err)` to bubble to. A failed
    // audit or notification write must never fail the provider save.
    await reportOnce().catch((error) => {
      console.error(`❌ Model pin audit after provider save failed: ${error.message}`);
    });
  } while (queued);
  running = null;
}

/**
 * Audit the stored model pins and raise a card for any that newly went stale.
 * Never rejects.
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
