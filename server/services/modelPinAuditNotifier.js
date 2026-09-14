/**
 * Announce a retired model pin at the moment it becomes observable (#7332).
 *
 * `modelPinAudit.js` derives the stale set on READ, which is the right rule —
 * it catches pins that rotted before it shipped and needs nothing persisted.
 * What derive-on-read cannot do is tell anybody: without this, a pin stays
 * quietly broken until the user happens to open Settings → Providers. On a
 * single-user PM2 install a `console.log` reaches nobody either, so the
 * announcement is a notification CARD, with the log line kept beside it as the
 * operator trail.
 *
 * A catalog refresh is that moment, so this runs from the toolkit's
 * `onProvidersSaved` host extension point (wired in `bootstrap.js`). It is a
 * TRIGGER for the existing audit, never a second source of truth: no membership
 * rule lives here, no stale set is persisted by this module, and nothing is
 * written inside `server/lib/aiToolkit/` (its AGENTS.md forbids that).
 *
 * **The card IS the dedupe state.** `providers.json` is written by a refresh, a
 * legacy `PATCH /api/providers/:id`, a migration and a boot seed alike, so an
 * install carrying one rotted pin would narrate on every one of them forever.
 * The card answers "has this pin already been announced?" from the durable
 * record itself — so a restart cannot re-announce, which is exactly what an
 * in-process transition set could not promise.
 *
 * **What is deduped is the pin's VALUE, not its location** (#7366). `pin.id`
 * says where a pin lives; the retirement being announced is about the model it
 * holds. Keying on the id alone meant a user who repointed the pin in Settings
 * — rather than clearing it from the panel — kept a card naming the old model
 * forever, AND had the card permanently suppressed for the next model retired
 * at that same location, which is the case the feature exists for. So the
 * dedupe key is `pinId` + `model`, and every announced card whose pin no longer
 * names that model is retracted by `reconcile()` below on the next audit —
 * whatever path moved it. `clearModelPin` still retracts by `pinId` alone, so a
 * clear from the panel is immediate rather than waiting for the next refresh.
 *
 * `data/notifications.json` is machine-local — nothing in `server/` federates
 * it — so this raises no privacy or sync question.
 */

/**
 * At most one audit runs, and at most one more is queued behind it.
 *
 * `saveProviders` AWAITS this hook, so every audit sits on the latency of the
 * write that triggered it — and provider writes arrive in bursts: the harness
 * catalog sync saves one provider at a time, the graph's import does the same,
 * and the graph's own projection write re-enters this hook from inside a pass
 * it latches itself out of. Each of those saves would otherwise pay a full
 * audit whose answer depends only on the FINAL state, so all but the last is
 * wasted. Coalescing bounds a burst of N writes at two audits. This is about
 * write-latency alone — the announcement's own dedupe is the persisted card.
 *
 * A queued caller gets the in-flight promise. That cannot cycle back on itself:
 * the audit only READS the pin stores, and never writes `providers.json`.
 */
let running = null;
let queued = false;

/**
 * Test seam: drop the in-flight coalescing state between cases.
 *
 * Deliberately NOT a "forget what was announced" reset — there is no such state
 * here. What was announced lives in `data/notifications.json`, which is why a
 * restart stays silent.
 */
export function resetModelPinReportState() {
  running = null;
  queued = false;
}

// The one exception to this module's no-static-imports posture: naming a pin's
// provider records is a pure leaf (`modelPinReconcile.js`), and the panel calls
// the same function — a private spelling here is how the card and the panel end
// up describing one pin differently.
import { pinProviderNames } from '../lib/modelPinReconcile.js';

/**
 * Deferred so the audit's own import closure — and the pin stores behind it —
 * stays out of the boot closure `bootstrap.js` pays for. Memoizes the PROMISE
 * rather than the module, matching `modelPinAudit.js`'s own loaders: concurrent
 * `import()` calls of a mocked module can let one caller escape the mock unless
 * they share a single in-flight promise.
 */
let auditModule = null;
let notificationsModule = null;
const loadAuditModule = () => (auditModule ||= import('./modelPinAudit.js'));
const loadNotificationsModule = () => (notificationsModule ||= import('./notifications.js'));

/**
 * The identity of what a card ANNOUNCES: this pin, holding this model.
 *
 * A NEWLINE rather than a printable separator — a pin id embeds dots, colons and
 * slashes (`settings:codeReview.providerModels.provider:x`) and so does a model
 * id, so any separator a user could type could be forged into a collision
 * between two different pins. A newline can appear in neither — every pin id is
 * built here from a settings path or a record id, and a model id is charset-
 * bounded well before it is stored.
 */
const pinCardKey = (pin) => `${pin.id}\n${pin.model}`;

/**
 * One card per pin, so each carries the pin's own `href`/`location` and can be
 * retracted independently when that one pin is cleared. A single rolled-up card
 * could do neither.
 */
async function announce(pin, providers) {
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } =
    await loadNotificationsModule();
  // The persisted card is the dedupe record: already announced, still true.
  // Keyed by the pin's VALUE, so a pin repointed to a DIFFERENT retired model
  // announces the new one instead of being silenced by the old card.
  if (await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'pinKey', pinCardKey(pin))) return false;
  // Every record the pin was judged against, not just the first: a reviewer pin
  // spans several (#7339), and naming one would have this card disagree with the
  // panel about the same pin. `pinProviderNames` is what both call.
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
 * `clearModelPin` covers the ONE path that starts at the card, and covered only
 * that: a pin repointed anywhere else — Settings, a record edit, a template
 * save, a `PATCH` — left its card standing forever, naming a model the pin no
 * longer holds (#7366). The audit already knows the complete set of pins that
 * are stale right now, so every other announced card is stale BY DEFINITION,
 * whatever moved it: the pin was repointed to a live model, repointed to a
 * different retired one (announced again under its new key), or deleted
 * outright. Retracting from the derived set needs no change-detection and no
 * second source of truth, which is the same posture as the audit itself.
 *
 * Scoped to cards this module wrote — `AGENT_WARNING` carrying a `pinKey` — so
 * a warning raised by any other producer is never touched. A card predating
 * #7366 carries no `pinKey`; it is retracted here and re-announced under the
 * new key on the same pass if the pin is still stale, so an upgrading install
 * converges on the first audit rather than needing a migration. Should that one
 * retraction fail, the re-announcement leaves two cards for one pin — the
 * deliberate trade for keeping the two guards independent, and self-healing:
 * the next audit retracts the legacy card, and a Clear from the panel takes
 * both at once (`removeByMetadata` matches every card sharing the `pinId`).
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
  const { pins, providers } = await auditModelPins();
  // BEFORE the early return below and before announcing: an install whose last
  // stale pin was just repointed to a live model has an empty pin set and a
  // card that must still come down.
  //
  // Non-fatal, like each individual announcement: a failed retraction must not
  // swallow the announcements behind it. The next audit re-derives the same set
  // and retries whatever is still standing.
  await reconcile(pins).catch((error) => {
    console.error(`❌ Reconciling retired-pin notifications failed: ${error.message}`);
  });
  if (pins.length === 0) return;
  // Sequential, not Promise.all: `addNotification` and `exists` share one file,
  // and two concurrent announcements of the same pin would both miss the card
  // the other is about to write.
  //
  // Each pin's announcement is independent, so one that fails must not take the
  // rest of the run with it — a transient write error on the first pin would
  // otherwise silently drop every pin behind it, and the coalescing guard means
  // the next audit may be a whole burst away.
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
    // The hook is non-fatal by contract: the `providers.json` write has already
    // landed, and its callers include boot warmups and schedulers with no
    // Express `next(err)` to bubble to. A failed audit — or a failed
    // notification write — must never fail the provider save; the next refresh
    // re-derives the same stale set and announces whatever is still missing.
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
