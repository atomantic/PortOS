/**
 * Retired-pin announcement on a catalog refresh (#7332).
 *
 * The regressions these uniquely catch: an install with one rotted pin
 * re-raising a card on every `providers.json` write (the persisted card is the
 * only dedupe state — there is no in-process tracker to fall back on), a
 * throwing audit or a failing notification write turning a landed provider save
 * into a failure, and the bootstrap hook losing one of its two consumers when
 * the other is edited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { stripCommentsAndNormalize } from '../lib/mirrorParity.js';

vi.mock('./modelPinAudit.js', () => ({ auditModelPins: vi.fn() }));
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn(),
  exists: vi.fn(),
  getNotifications: vi.fn(),
  removeNotification: vi.fn(),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' },
}));

const { auditModelPins } = await import('./modelPinAudit.js');
const {
  addNotification, exists, getNotifications, removeNotification,
} = await import('./notifications.js');
const {
  reportRetiredModelPins, resetModelPinReportState,
} = await import('./modelPinAuditNotifier.js');

const pin = (id, overrides = {}) => ({
  id,
  kind: 'imageGen',
  providerIds: ['antigravity-cli'],
  model: 'retired-model-1',
  label: 'Agy CLI image model',
  location: 'Settings → Media Gen → Image Gen',
  href: '/media/image?settings=1',
  ...overrides,
});

const audited = (...pins) => ({
  pins,
  providers: Object.fromEntries(pins.flatMap((p) => p.providerIds.map((id) => [id, { id, name: 'Agy CLI' }]))),
});

/**
 * The persisted notification store, as the module sees it: every read answers
 * from what the writes have already put there. Mocking them independently would
 * let the dedupe and the retraction both pass while the real round-trip is
 * broken — which is exactly how a card keyed on the pin's LOCATION looked
 * correct for a release (#7366).
 */
function backNotificationsWithAStore() {
  const cards = [];
  let nextId = 1;
  exists.mockImplementation(async (type, field, value) =>
    cards.some((card) => card.type === type && card.metadata?.[field] === value));
  addNotification.mockImplementation(async (card) => {
    const stored = { id: `card-${nextId++}`, ...card };
    cards.push(stored);
    return stored;
  });
  getNotifications.mockImplementation(async ({ type } = {}) =>
    cards.filter((card) => !type || card.type === type));
  removeNotification.mockImplementation(async (id) => {
    const at = cards.findIndex((card) => card.id === id);
    if (at >= 0) cards.splice(at, 1);
    return { success: true };
  });
  return cards;
}

let logged;
let errored;

beforeEach(() => {
  vi.clearAllMocks();
  resetModelPinReportState();
  backNotificationsWithAStore();
  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
  errored.mockRestore();
});

describe('reportRetiredModelPins', () => {
  it('raises one card per stale pin, naming it and linking where it lives', async () => {
    auditModelPins.mockResolvedValue(audited(
      pin('settings:imageGen.agy.model'),
      pin('task:brain-sync', {
        kind: 'task', label: 'brain-sync task model', model: 'retired-model-2',
        location: 'Chief of Staff → Schedule', href: '/cos/schedule',
      }),
    ));

    await reportRetiredModelPins();

    expect(addNotification).toHaveBeenCalledTimes(2);
    const [first, second] = addNotification.mock.calls.map(([card]) => card);
    expect(first.type).toBe('agent_warning');
    expect(first.metadata.pinId).toBe('settings:imageGen.agy.model');
    expect(first.description).toContain('Agy CLI image model');
    expect(first.description).toContain('retired-model-1');
    expect(first.description).toContain('Settings → Media Gen → Image Gen');
    expect(first.link).toBe('/media/image?settings=1');
    expect(second.link).toBe('/cos/schedule');
    expect(second.metadata.pinId).toBe('task:brain-sync');
  });

  it('keeps a single-line log trail beside the cards', async () => {
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));

    await reportRetiredModelPins();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('1 of 1 stored model pin(s)');
    // Single-line, and never a dump of the pin array (AGENTS.md logging rule).
    expect(logged.mock.calls[0][0]).not.toContain('\n');
    expect(logged.mock.calls[0][0]).not.toContain('settings:imageGen.agy.model');
  });

  it('raises nothing on a later refresh that finds the SAME stale set', async () => {
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));

    await reportRetiredModelPins();
    addNotification.mockClear();
    logged.mockClear();
    await reportRetiredModelPins();
    await reportRetiredModelPins();

    expect(addNotification).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  // #7366 — the dedupe key was `pin.id`, which says where a pin LIVES, not what
  // it holds. These three pin the value-keyed behavior that replaced it.
  it('announces again when the pin is repointed to ANOTHER retired model', async () => {
    const cards = backNotificationsWithAStore();
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    addNotification.mockClear();

    // The user repoints the pin in Settings rather than clearing it from the
    // panel, and the new id is retired too. Keying on the pin's location alone
    // suppressed this card permanently — the exact case the feature exists for.
    auditModelPins.mockResolvedValue(audited(
      pin('settings:imageGen.agy.model', { model: 'retired-model-9' }),
    ));
    await reportRetiredModelPins();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0].description).toContain('retired-model-9');
    // And exactly ONE card stands: the one naming the model the pin holds now.
    expect(cards.map((card) => card.metadata.model)).toEqual(['retired-model-9']);
  });

  it('retracts the card when the pin is repointed to a LIVE model', async () => {
    const cards = backNotificationsWithAStore();
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    expect(cards).toHaveLength(1);

    // Repointed in Settings, so `clearModelPin` — the only retraction path
    // before #7366 — never ran. The pin drops out of the stale set, and a card
    // naming a model the pin no longer holds is a loop the user cannot close.
    auditModelPins.mockResolvedValue(audited());
    await reportRetiredModelPins();

    expect(cards).toHaveLength(0);
    expect(removeNotification).toHaveBeenCalledTimes(1);
  });

  it('keeps announced cards when the audit is incomplete after a store-read error', async () => {
    const cards = backNotificationsWithAStore();
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    expect(cards).toHaveLength(1);
    addNotification.mockClear();

    // A transient store-read error leaves the pin set unevaluated, so the empty
    // set is "unknown", not "healthy": reconciling it would retract the card
    // and the next audit would re-notify.
    auditModelPins.mockResolvedValue({ pins: [], providers: {}, incomplete: true });
    await reportRetiredModelPins();

    expect(cards).toHaveLength(1);
    expect(removeNotification).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
    expect(errored.mock.calls[0][0]).toContain('incomplete');
  });

  it('announces the new model even when retracting the old card FAILS', async () => {
    // The two guards are deliberately independent: `reconcile` normally takes
    // the superseded card down first, but it is non-fatal, so the dedupe key
    // must carry the pin's VALUE on its own. Keyed on `pin.id` alone, a failed
    // retraction silences the new retirement until someone clears the pin by
    // hand — which is the #7366 failure mode surviving its own fix.
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    addNotification.mockClear();

    removeNotification.mockRejectedValueOnce(new Error('notifications.json unwritable'));
    auditModelPins.mockResolvedValue(audited(
      pin('settings:imageGen.agy.model', { model: 'retired-model-9' }),
    ));
    await reportRetiredModelPins();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0].metadata.model).toBe('retired-model-9');
  });

  it('leaves an AGENT_WARNING raised by another producer alone', async () => {
    const cards = backNotificationsWithAStore();
    cards.push({ id: 'other-1', type: 'agent_warning', metadata: { runId: 'abc' } });
    auditModelPins.mockResolvedValue(audited());

    await reportRetiredModelPins();

    expect(cards).toHaveLength(1);
    expect(removeNotification).not.toHaveBeenCalled();
  });

  it('stays silent across a RESTART, because the card is the dedupe record', async () => {
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    addNotification.mockClear();

    // A restart drops every in-process tracker; the persisted card survives.
    resetModelPinReportState();
    await reportRetiredModelPins();

    expect(addNotification).not.toHaveBeenCalled();
  });

  it('stays silent on every refresh when nothing is stale', async () => {
    auditModelPins.mockResolvedValue(audited());

    await reportRetiredModelPins();
    await reportRetiredModelPins();

    expect(addNotification).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it('announces only the pin that NEWLY rotted, alongside the running total', async () => {
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    await reportRetiredModelPins();
    addNotification.mockClear();
    logged.mockClear();

    auditModelPins.mockResolvedValue(audited(
      pin('settings:imageGen.agy.model'),
      pin('task:brain-sync', { kind: 'task' }),
    ));
    await reportRetiredModelPins();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0].metadata.pinId).toBe('task:brain-sync');
    expect(logged.mock.calls[0][0]).toContain('1 of 2 stored model pin(s)');
  });

  it('falls back to the provider id when the audit names no provider record', async () => {
    auditModelPins.mockResolvedValue({ pins: [pin('settings:imageGen.agy.model')], providers: {} });

    await reportRetiredModelPins();

    expect(addNotification.mock.calls[0][0].description).toContain('antigravity-cli');
  });

  it('never rejects when the audit throws, and raises no card', async () => {
    auditModelPins.mockRejectedValue(new Error('settings store unreadable'));

    await expect(reportRetiredModelPins()).resolves.toBeUndefined();

    expect(errored.mock.calls[0][0]).toContain('settings store unreadable');
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('announces the remaining pins when one pin\'s write fails', async () => {
    // The coalescing guard means the next audit may be a whole burst away, so a
    // transient failure on the first pin must not silently drop the rest.
    auditModelPins.mockResolvedValue(audited(
      pin('settings:imageGen.agy.model'),
      pin('task:brain-sync', { kind: 'task' }),
    ));
    addNotification.mockRejectedValueOnce(new Error('notifications.json unwritable'));

    await expect(reportRetiredModelPins()).resolves.toBeUndefined();

    expect(addNotification).toHaveBeenCalledTimes(2);
    expect(addNotification.mock.calls[1][0].metadata.pinId).toBe('task:brain-sync');
    expect(logged.mock.calls[0][0]).toContain('1 of 2 stored model pin(s)');
  });

  it('never rejects when the notification write fails, and re-announces next refresh', async () => {
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));
    addNotification.mockRejectedValueOnce(new Error('notifications.json unwritable'));

    await expect(reportRetiredModelPins()).resolves.toBeUndefined();
    expect(errored.mock.calls[0][0]).toContain('notifications.json unwritable');

    // Nothing persisted, so the pin is still unannounced — the next refresh owes
    // the user the card the failed write never produced.
    await reportRetiredModelPins();
    expect(addNotification).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of provider saves into two audits, not one per save', async () => {
    // saveProviders AWAITS this hook, and provider writes arrive in bursts (the
    // harness catalog sync saves one provider at a time). Every audit but the
    // last reads state that is already superseded.
    let release;
    auditModelPins.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    auditModelPins.mockResolvedValue(audited(pin('settings:imageGen.agy.model')));

    const burst = Promise.all([
      reportRetiredModelPins(), reportRetiredModelPins(),
      reportRetiredModelPins(), reportRetiredModelPins(),
    ]);
    await Promise.resolve();
    expect(auditModelPins).toHaveBeenCalledTimes(1);

    release(audited());
    await burst;

    // One in flight plus one covering everything that landed behind it.
    expect(auditModelPins).toHaveBeenCalledTimes(2);
    // And the final state is what got reported, not the superseded first read.
    expect(addNotification).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap wiring', () => {
  // `createToolkit` has no unit harness — building it arms the whole toolkit —
  // so the fact the audit depends on is asserted against the source.
  const SRC = stripCommentsAndNormalize(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.js'), 'utf-8'),
  );

  it('runs the pin audit from the providers-saved hook alongside the graph reconcile', () => {
    const hook = SRC.slice(SRC.indexOf('onProvidersSaved:'));
    const consumers = hook.slice(0, hook.indexOf(']'));
    expect(consumers).toContain('onProvidersSavedForGraph()');
    expect(consumers).toContain('reportRetiredModelPins()');
    // allSettled, not all: one consumer rejecting must not skip or fail the other.
    expect(consumers).toContain('Promise.allSettled');
  });
});
