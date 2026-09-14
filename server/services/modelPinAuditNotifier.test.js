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
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' },
}));

const { auditModelPins } = await import('./modelPinAudit.js');
const { addNotification, exists } = await import('./notifications.js');
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
 * The persisted notification store, as the module sees it: `exists` answers
 * from what `addNotification` has already written. Mocking the two independently
 * would let the dedupe pass while the real round-trip is broken.
 */
function backNotificationsWithAStore() {
  const cards = [];
  exists.mockImplementation(async (type, field, value) =>
    cards.some((card) => card.type === type && card.metadata?.[field] === value));
  addNotification.mockImplementation(async (card) => { cards.push(card); return card; });
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
