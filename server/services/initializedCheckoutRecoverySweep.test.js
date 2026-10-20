import { describe, expect, it, vi } from 'vitest';
import { _createInitializedRecoverySweep, INITIALIZED_RECOVERY_INTERVAL_MS } from './initializedCheckoutRecoverySweep.js';

const transaction = id => ({ transactionId: id, appId: 'app', journalDigest: `${id}-digest`,
  phase: 'quarantined-working', release: { branch: `claim/${id}` } });

describe('initialized retirement recovery drain', () => {
  it('serializes overlapping triggers, bounds batches and rotates past held work with fresh retry evidence', async () => {
    let time = 0, release;
    const rows = ['a', 'b', 'c'].map(transaction);
    const discover = vi.fn(async () => ({ ok: true, transactions: rows }));
    const recover = vi.fn(async () => ({ ok: false, reason: 'automatic-retirement-independent-review-required' }));
    recover.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const report = vi.fn();
    const drain = _createInitializedRecoverySweep({ discover, recover, report, now: () => time });
    const first = drain(async () => null);
    expect(drain(async () => null)).toBe(first);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release({ ok: false, reason: 'active-owner' });
    await first;
    expect(recover.mock.calls.map(([input]) => input.transactionId)).toEqual(['a', 'b']);
    expect(report.mock.calls[0][0]).toMatchObject({ transactionId: 'a', branch: 'claim/a', reason: 'active-owner' });
    expect(await drain(async () => null)).toMatchObject({ skipped: 'recovery-cadence' });
    time += INITIALIZED_RECOVERY_INTERVAL_MS;
    rows[0].journalDigest = 'new-journal';
    await drain(async () => null);
    expect(recover.mock.calls.slice(2).map(([input]) => input.transactionId)).toEqual(['c', 'a']);
    expect(recover.mock.calls.at(-1)[0].journalDigest).toBe('new-journal');
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it('clears completed diagnostics without letting terminal journals consume replay slots', async () => {
    const report = vi.fn();
    const recover = vi.fn(async () => ({ ok: false, reason: 'active-owner' }));
    const rows = ['a', 'b', 'c'].map(id => ({ ...transaction(id), settled: true, phase: 'restored-with-reviewed-finalization' }));
    const drain = _createInitializedRecoverySweep({ discover: async () => ({ ok: true, transactions: [...rows, transaction('d')] }), recover, report });
    await drain(async () => null);
    expect(recover.mock.calls.map(([input]) => input.transactionId)).toEqual(['d']);
    expect(report.mock.calls.slice(0, 3).every(([row]) => row.ok && row.reason === 'retirement-recovery-completed')).toBe(true);
  });
  it('does no discovery while stopped, paused, off or dry-run and checks the gate again before replay', async () => {
    const discover = vi.fn(async () => ({ ok: true, transactions: [transaction('a')] }));
    const recover = vi.fn();
    const drain = _createInitializedRecoverySweep({ discover, recover });
    for (const reason of ['daemon-stopped', 'daemon-paused', 'autonomy-off', 'autonomy-dry-run']) {
      expect(await drain(async () => reason)).toMatchObject({ skipped: reason });
    }
    expect(discover).not.toHaveBeenCalled();
    const gate = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('daemon-paused');
    expect(await drain(gate)).toMatchObject({ skipped: 'daemon-paused' });
    expect(recover).not.toHaveBeenCalled();
  });
  it('surfaces invalid journals and refuses an incomplete discovery without invoking recovery', async () => {
    const report = vi.fn();
    const recover = vi.fn();
    const discover = vi.fn(async () => ({ ok: true, transactions: [{ transactionId: 'invalid', reason: 'retirement-journal-invalid' }] }));
    const drain = _createInitializedRecoverySweep({ discover, recover, report, now: () => 0 });
    await drain(async () => null);
    expect(report).toHaveBeenCalledWith({ transactionId: 'invalid', reason: 'retirement-journal-invalid' });
    const capped = _createInitializedRecoverySweep({ discover: async () => ({ ok: false,
      reason: 'retirement-discovery-budget-exceeded', transactions: [transaction('a')] }), recover, report });
    expect(await capped(async () => null)).toMatchObject({ skipped: 'retirement-discovery-budget-exceeded' });
    expect(recover).not.toHaveBeenCalled();
  });
});
