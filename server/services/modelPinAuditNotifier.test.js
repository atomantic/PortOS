/**
 * Retired-pin announcement on a catalog refresh (#7328).
 *
 * The regressions these uniquely catch: an install with one rotted pin
 * re-narrating on every `providers.json` write (there is no other transition
 * tracker), a throwing audit turning a landed provider save into a failure, and
 * the bootstrap hook losing one of its two consumers when the other is edited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { stripCommentsAndNormalize } from '../lib/mirrorParity.js';

vi.mock('./modelPinAudit.js', () => ({ auditModelPins: vi.fn() }));

const { auditModelPins } = await import('./modelPinAudit.js');
const {
  reportRetiredModelPins, resetStaleModelPinReport,
} = await import('./modelPinAuditNotifier.js');

const audited = (...ids) => ({ pins: ids.map((id) => ({ id })), providers: {} });

let logged;
let errored;

beforeEach(() => {
  vi.clearAllMocks();
  resetStaleModelPinReport();
  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
  errored.mockRestore();
});

describe('reportRetiredModelPins', () => {
  it('announces once, naming how many pins went stale', async () => {
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model', 'task:brain-sync'));

    await reportRetiredModelPins();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('2 of 2 stored model pin(s)');
    // Single-line, and never a dump of the pin array (AGENTS.md logging rule).
    expect(logged.mock.calls[0][0]).not.toContain('\n');
    expect(logged.mock.calls[0][0]).not.toContain('settings:imageGen.agy.model');
  });

  it('stays silent on a later refresh that finds the SAME stale set', async () => {
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));

    await reportRetiredModelPins();
    logged.mockClear();
    await reportRetiredModelPins();
    await reportRetiredModelPins();

    expect(logged).not.toHaveBeenCalled();
  });

  it('stays silent on every refresh when nothing is stale', async () => {
    auditModelPins.mockResolvedValue(audited());

    await reportRetiredModelPins();
    await reportRetiredModelPins();

    expect(logged).not.toHaveBeenCalled();
  });

  it('announces only the pin that NEWLY rotted, alongside the running total', async () => {
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));
    await reportRetiredModelPins();
    logged.mockClear();

    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model', 'task:brain-sync'));
    await reportRetiredModelPins();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain('1 of 2 stored model pin(s)');
  });

  it('announces again after the user clears a pin that later rots a second time', async () => {
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));
    await reportRetiredModelPins();

    // Cleared back to inherit — it drops out of the stale set entirely.
    auditModelPins.mockResolvedValue(audited());
    await reportRetiredModelPins();
    logged.mockClear();

    // Re-pinned, and rotted again: this is news, not the set we already reported.
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));
    await reportRetiredModelPins();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the audit throws, and does not forget what it announced', async () => {
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));
    await reportRetiredModelPins();
    logged.mockClear();

    auditModelPins.mockRejectedValue(new Error('settings store unreadable'));
    await expect(reportRetiredModelPins()).resolves.toBeUndefined();
    expect(errored.mock.calls[0][0]).toContain('settings store unreadable');

    // The failure must leave the reported set alone. Clearing it here would make
    // the very next audit re-announce a pin the user was already told about.
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));
    await reportRetiredModelPins();

    expect(logged).not.toHaveBeenCalled();
  });

  it('coalesces a burst of provider saves into two audits, not one per save', async () => {
    // saveProviders AWAITS this hook, and provider writes arrive in bursts (the
    // harness catalog sync saves one provider at a time). Every audit but the
    // last reads state that is already superseded.
    let release;
    auditModelPins.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    auditModelPins.mockResolvedValue(audited('settings:imageGen.agy.model'));

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
    expect(logged).toHaveBeenCalledTimes(1);
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
