/**
 * Announce a retired model pin when a catalog refresh makes it observable.
 *
 * Runs from the toolkit's `onProvidersSaved` hook (wired in `bootstrap.js`) as a trigger for
 * `modelPinAudit.js`; no membership rule or stale set is stored here, and nothing is
 * written inside `server/lib/aiToolkit/`.
 *
 * The notification card IS the dedupe state: `providers.json` is written by many paths,
 * so the durable card answers "already announced?" across restarts. The key is `pinId` +
 * `model` (the pin's value, not its location), so a repoint re-announces and `reconcile()`
 * retracts cards whose pin no longer names that model. `clearModelPin` retracts by `pinId`.
 * `data/notifications.json` is machine-local.
 */

/**
 * At most one audit runs and one is queued behind it: `saveProviders` AWAITS this hook
 * and writes arrive in bursts, and the answer depends only on the final state. A queued
 * caller gets the in-flight promise; no cycle, since the audit never writes `providers.json`.
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

// Leaf shared with the panel so the card and the panel describe one pin identically.
import { pinProviderNames } from '../lib/modelPinReconcile.js';

/** Deferred to keep the audit out of the boot closure; memoizes the PROMISE (concurrent `import()` of a mocked module can escape the mock). */
let auditModule = null;
let notificationsModule = null;
const loadAuditModule = () => (auditModule ||= import('./modelPinAudit.js'));
const loadNotificationsModule = () => (notificationsModule ||= import('./notifications.js'));

/**
 * The identity of what a card announces: this pin holding this model. Newline
 * separator: pin and model ids embed dots, colons and slashes, but never newlines.
 */
const pinCardKey = (pin) => `${pin.id}\n${pin.model}`;

/**
 * One card per pin, so each carries its own `href`/`location` and can be retracted
 * independently when that pin is cleared.
 */
async function announce(pin, providers) {
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } =
    await loadNotificationsModule();
  // The persisted card is the dedupe record, keyed by the pin's VALUE.
  if (await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'pinKey', pinCardKey(pin))) return false;
  // Every record the pin was judged against, so the card agrees with the panel.
  const providerName = pinProviderNames(pin, providers);
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: 'Pinned model retired',
    description: `${pin.label} pins "${pin.model}", which ${providerName} no longer offers`
      + ` — clear it in ${pin.location}.`,
    priority: PRIORITY_LEVELS.MEDIUM,
    link: pin.href || null,
    // `pinId` is what `clearModelPin` retracts by.
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
 * The audit knows the complete stale set, so any other announced card is stale by
 * definition (repointed, replaced by a new key, or deleted), whatever path moved the pin.
 * Scoped to cards this module wrote (`AGENT_WARNING` with a `pinKey`). A legacy card with
 * no `pinKey` is retracted and re-announced in the same pass, so no migration is needed.
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
  // A store-read error makes an empty pin set "unknown", not "healthy": reconciling would
  // retract cards that the next audit re-notifies.
  if (incomplete) {
    console.error('❌ Model pin audit incomplete — a pin store was unreadable; keeping announced cards');
    return;
  }
  // Before the early return: a card for a just-repointed last stale pin must still come down.
  // Non-fatal so a failed retraction does not swallow the announcements.
  await reconcile(pins).catch((error) => {
    console.error(`❌ Reconciling retired-pin notifications failed: ${error.message}`);
  });
  if (pins.length === 0) return;
  // Sequential: `addNotification` and `exists` share one file. Each announcement is
  // independent so one failure does not drop the pins behind it.
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
    // Non-fatal by contract: the `providers.json` write already landed and callers have no `next(err)`.
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
