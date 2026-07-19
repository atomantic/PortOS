import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creativeCommissionUpdateSchema } from '../../lib/creativeCommissionValidation.js';

// In-memory collectionStore so CRUD is exercised without touching the filesystem.
// Keyed by collection `type` so the machine-local commission store and the
// federated commissionFeedback store (#2686) don't share one map — `records` is
// the commission map the assertions reach into directly.
const records = new Map();
const feedbackRecords = new Map();
const mapForType = (type) => (type === 'commission-feedback' ? feedbackRecords : records);
const makeMemStore = (type) => {
  const store = mapForType(type);
  return {
    loadAll: async () => [...store.values()],
    loadOne: async (id) => store.get(id) || null,
    saveOne: async (id, rec) => { store.set(id, rec); },
    saveOneNow: async (id, rec) => { store.set(id, rec); },
    deleteOne: async (id) => { store.delete(id); },
    deleteOneNow: async (id) => { store.delete(id); },
    saveTypeIndex: async () => {},
    verifySchemaVersion: async () => ({ ok: true }),
  };
};
vi.mock('../../lib/collectionStore.js', () => ({ createCollectionStore: ({ type }) => makeMemStore(type) }));
vi.mock('../../lib/fileUtils.js', () => ({ PATHS: { data: '/tmp/portos-test-data' } }));
// Keep the federation side-effects (peer push, conflict-journal disk I/O) inert
// so the store unit tests stay deterministic and offline.
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: vi.fn(), emitRecordDeleted: vi.fn(),
  autoSubscribeRecordToAllPeers: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/conflictJournal.js', () => ({
  contentHashForRecord: vi.fn(() => 'hash'),
  setSyncBaseHash: vi.fn(() => Promise.resolve()),
  deleteSyncBaseHash: vi.fn(() => Promise.resolve()),
  flushBaseHashes: vi.fn(() => Promise.resolve()),
  maybeJournalBeforeOverwrite: vi.fn(() => Promise.resolve()),
}));

const {
  sanitizeCommission,
  sanitizeFeedbackEntry,
  assertValidSchedule,
  createCommission,
  updateCommission,
  deleteCommission,
  getCommission,
  listCommissions,
  recordCommissionRun,
  submitCommissionFeedback,
  backfillAllCommissionFeedback,
  sanitizeCommissionForSync,
  mergeCommissionRecord,
  getCommissionForSync,
  mergeCommissionsFromSync,
  pruneTombstonedCommissions,
  commissionStore,
  ERR_VALIDATION,
  ERR_NOT_FOUND,
} = await import('./store.js');
const { buildCommissionDirective } = await import('./abilityAdapters.js');

beforeEach(() => { records.clear(); feedbackRecords.clear(); });

const validInput = () => ({
  name: 'Nightly Surreal',
  enabled: true,
  targetAbility: 'video',
  brief: { intent: 'surreal', styleSpec: 'flat', constraints: { universeId: 'u-1' }, seedRefs: [] },
  schedule: { kind: 'DAILY', atLocalTime: '02:00', timezone: null },
  generation: { quality: 'high', aspectRatio: '9:16', targetDurationSeconds: 20 },
  feedbackWindow: 3,
});

describe('sanitizeCommission', () => {
  it('drops a null / id-less record', () => {
    expect(sanitizeCommission(null)).toBeNull();
    expect(sanitizeCommission({ name: 'no id' })).toBeNull();
  });

  it('normalizes a partial record to the canonical shape', () => {
    const rec = sanitizeCommission({ id: 'c1' });
    expect(rec.name).toBe('Untitled Commission');
    expect(rec.enabled).toBe(true);
    expect(rec.targetAbility).toBe('video');
    expect(rec.brief).toMatchObject({ intent: '', styleSpec: '', seedRefs: [] });
    expect(rec.generation).toMatchObject({ quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10 });
    expect(rec.runs).toEqual([]);
    expect(rec.feedback).toEqual([]);
  });

  it('routes generation through the ability adapter per output type (#2769)', () => {
    const img = sanitizeCommission({ id: 'c1', targetAbility: 'image', generation: { imageCount: 4, targetDurationSeconds: 30 } });
    expect(img.targetAbility).toBe('image');
    // Keeps the image key; drops the off-type video duration key.
    expect(img.generation).toEqual({ model: null, quality: 'standard', aspectRatio: '16:9', imageCount: 4 });

    const music = sanitizeCommission({ id: 'c2', targetAbility: 'music', generation: { lengthSeconds: 60 } });
    expect(music.generation).toEqual({ model: null, lengthSeconds: 60 });

    const series = sanitizeCommission({ id: 'c3', targetAbility: 'series', generation: { episodeCount: 2 } });
    expect(series.generation).toEqual({ model: null, episodeCount: 2 });
  });

  it('preserves an unknown (forward-version) output type verbatim so a newer peer record round-trips (#2769)', () => {
    // A newer peer might sync an output type this install does not know yet.
    // Rewriting it to `video` would corrupt the newer brief on read (and could
    // push the downgrade back via LWW), so it is preserved untouched; the
    // scheduler skips it rather than mis-generating.
    const rec = sanitizeCommission({ id: 'c1', targetAbility: 'story', generation: { chapters: 5 } });
    expect(rec.targetAbility).toBe('story');
    expect(rec.generation).toEqual({ chapters: 5 });
  });

  it('falls back to video for a missing/blank output type', () => {
    expect(sanitizeCommission({ id: 'c1' }).targetAbility).toBe('video');
    expect(sanitizeCommission({ id: 'c2', targetAbility: '' }).targetAbility).toBe('video');
  });

  it('caps runs to the last MAX_PERSISTED_RUNS', () => {
    const runs = Array.from({ length: 80 }, (_, i) => ({ id: `run-${i}` }));
    const rec = sanitizeCommission({ id: 'c1', runs });
    expect(rec.runs).toHaveLength(50);
    expect(rec.runs[0].id).toBe('run-30');
  });

  it('defaults the LLM assignment to unset (install default)', () => {
    const rec = sanitizeCommission({ id: 'c1' });
    expect(rec.assignment).toEqual({ providerId: null, model: null });
  });

  it('normalizes and trims a set assignment pin', () => {
    const rec = sanitizeCommission({ id: 'c1', assignment: { providerId: '  claude-tui  ', model: '  sonnet  ' } });
    expect(rec.assignment).toEqual({ providerId: 'claude-tui', model: 'sonnet' });
  });

  it('drops a provider-less model so the pin can never dangle', () => {
    const rec = sanitizeCommission({ id: 'c1', assignment: { model: 'sonnet' } });
    expect(rec.assignment).toEqual({ providerId: null, model: null });
  });
});

describe('assertValidSchedule', () => {
  it('returns the derived cron for a valid schedule', () => {
    expect(assertValidSchedule({ kind: 'DAILY', atLocalTime: '02:00' })).toBe('0 2 * * *');
  });

  it('throws ERR_VALIDATION for an underivable/invalid schedule', () => {
    expect(() => assertValidSchedule({ kind: 'DAILY' })).toThrow();
    try { assertValidSchedule({ kind: 'CUSTOM', cron: 'not a cron' }); }
    catch (e) { expect(e.code).toBe(ERR_VALIDATION); }
  });
});

describe('createCommission', () => {
  it('mints an id, sanitizes, and persists', async () => {
    const rec = await createCommission(validInput());
    expect(rec.id).toMatch(/^commission-/);
    expect(rec.name).toBe('Nightly Surreal');
    expect(rec.generation.quality).toBe('high');
    expect(rec.brief.constraints).toEqual({ universeId: 'u-1' });
    expect(records.get(rec.id)).toEqual(rec);
  });

  it('rejects an invalid schedule before persisting', async () => {
    await expect(createCommission({ ...validInput(), schedule: { kind: 'DAILY' } })).rejects.toThrow();
    expect(records.size).toBe(0);
  });
});

describe('updateCommission', () => {
  it('deep-merges a partial brief without wiping other fields', async () => {
    const created = await createCommission(validInput());
    const updated = await updateCommission(created.id, { brief: { intent: 'new intent' } });
    expect(updated.brief.intent).toBe('new intent');
    expect(updated.brief.styleSpec).toBe('flat'); // preserved
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('replaces the assignment pin on patch and clears it with a null provider', async () => {
    const created = await createCommission(validInput());
    const pinned = await updateCommission(created.id, { assignment: { providerId: 'claude-tui', model: 'sonnet' } });
    expect(pinned.assignment).toEqual({ providerId: 'claude-tui', model: 'sonnet' });
    // A clear (null provider) resets to the install default and drops the model.
    const cleared = await updateCommission(created.id, { assignment: { providerId: null, model: null } });
    expect(cleared.assignment).toEqual({ providerId: null, model: null });
  });

  it('preserves the assignment pin when a patch omits it', async () => {
    const created = await createCommission(validInput());
    await updateCommission(created.id, { assignment: { providerId: 'claude-tui', model: 'sonnet' } });
    const updated = await updateCommission(created.id, { name: 'Renamed' });
    expect(updated.assignment).toEqual({ providerId: 'claude-tui', model: 'sonnet' });
  });

  it('preserves brief.constraints when a partial brief patch omits them', async () => {
    // Regression: the create-path brief schema defaults constraints/seedRefs, so
    // a PATCH that omitted them used to wipe a stored universeId. The update-path
    // schema carries no defaults, so an omitted key is preserved by the merge.
    const created = await createCommission(validInput()); // constraints.universeId = 'u-1'
    const parsed = creativeCommissionUpdateSchema.parse({ brief: { intent: 'reworked' } });
    const updated = await updateCommission(created.id, parsed);
    expect(updated.brief.constraints).toEqual({ universeId: 'u-1' });
  });

  it('deep-merges constraints so a partial constraints patch keeps the other key', async () => {
    const created = await createCommission({
      ...validInput(),
      brief: { intent: 'x', constraints: { universeId: 'u-1', seriesId: 's-1' } },
    });
    const parsed = creativeCommissionUpdateSchema.parse({ brief: { constraints: { universeId: 'u-2' } } });
    const updated = await updateCommission(created.id, parsed);
    expect(updated.brief.constraints).toEqual({ universeId: 'u-2', seriesId: 's-1' });
  });

  it('preserves omitted generation fields on a partial generation patch', async () => {
    const created = await createCommission(validInput()); // quality 'high', aspect '9:16', duration 20
    const parsed = creativeCommissionUpdateSchema.parse({ generation: { quality: 'draft' } });
    const updated = await updateCommission(created.id, parsed);
    expect(updated.generation.quality).toBe('draft');
    expect(updated.generation.aspectRatio).toBe('9:16'); // preserved, not defaulted to 16:9
    expect(updated.generation.targetDurationSeconds).toBe(20); // preserved, not defaulted to 10
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    try { await updateCommission('nope', { enabled: false }); }
    catch (e) { expect(e.code).toBe(ERR_NOT_FOUND); }
  });
});

describe('recordCommissionRun', () => {
  it('appends a run and caps history', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { status: 'started', projectId: 'cd-1', promptUsed: 'g' });
    const after = await getCommission(created.id);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ status: 'started', projectId: 'cd-1', promptUsed: 'g' });
    expect(after.runs[0].id).toMatch(/^run-/);
  });

  it('persists a manual trigger and defaults everything else to schedule', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { status: 'started', trigger: 'manual' });
    await recordCommissionRun(created.id, { status: 'started' });
    await recordCommissionRun(created.id, { status: 'started', trigger: 'bogus' });
    const after = await getCommission(created.id);
    expect(after.runs.map((r) => r.trigger)).toEqual(['manual', 'schedule', 'schedule']);
  });
});

describe('deleteCommission', () => {
  it('SOFT-deletes (tombstones) the record so the deletion federates (#2686)', async () => {
    const created = await createCommission(validInput());
    const r = await deleteCommission(created.id);
    expect(r).toEqual({ id: created.id, deleted: true });
    // The row survives as a tombstone (LWW never propagates a hard delete), but
    // it's excluded from live reads.
    expect(records.get(created.id)).toMatchObject({ deleted: true });
    expect(typeof records.get(created.id).deletedAt).toBe('string');
    await expect(getCommission(created.id)).rejects.toMatchObject({ code: ERR_NOT_FOUND });
    expect((await listCommissions()).some((c) => c.id === created.id)).toBe(false);
  });

  it('a second delete of an already-tombstoned commission 404s', async () => {
    const created = await createCommission(validInput());
    await deleteCommission(created.id);
    await expect(deleteCommission(created.id)).rejects.toMatchObject({ code: ERR_NOT_FOUND });
  });
});

describe('pruneTombstonedCommissions', () => {
  it('tombstones the commission\'s feedback BEFORE the hard-prune so it GCs instead of staying live', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'completed' });
    await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'up', note: 'more Magritte' });
    await deleteCommission(created.id);
    // Age the commission tombstone past the cutoff.
    const rec = records.get(created.id);
    records.set(created.id, { ...rec, deletedAt: '2020-01-01T00:00:00.000Z' });

    const result = await pruneTombstonedCommissions(Date.parse('2021-01-01T00:00:00.000Z'));

    expect(result.pruned).toBe(1);
    expect(records.has(created.id)).toBe(false); // commission hard-pruned
    // The orphan-prevention contract: every feedback row for the pruned
    // commission is now a tombstone (not live, not hard-deleted), so it
    // federates its removal and ages out through normal tombstone GC.
    const rows = [...feedbackRecords.values()].filter((f) => f.commissionId === created.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const f of rows) expect(f.deleted).toBe(true);
  });

  it('a restore landing mid-sweep keeps its feedback (revalidated inside the per-id queue)', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'completed' });
    await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'up', note: 'keep me' });
    await deleteCommission(created.id);
    records.set(created.id, { ...records.get(created.id), deletedAt: '2020-01-01T00:00:00.000Z' });

    // Hold the commission's write queue with a gated "restore" so the sweep's
    // eligibility listing sees the stale tombstone, then let the restore land
    // FIRST — the sweep's queued revalidation must then skip the commission.
    const store = commissionStore();
    let releaseRestore;
    const gate = new Promise((resolve) => { releaseRestore = resolve; });
    const restoreDone = store.queueRecordWrite(created.id, async () => {
      await gate;
      const rec = await store.readRaw(created.id, { includeDeleted: true });
      await store.writeRaw(created.id, { ...rec, deleted: false, deletedAt: null });
    });
    const prunePromise = pruneTombstonedCommissions(Date.parse('2021-01-01T00:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let listPrunable observe the tombstone
    releaseRestore();
    const result = await prunePromise;
    await restoreDone;

    expect(result).toEqual({ pruned: 0, ids: [] });
    expect(records.get(created.id)).toMatchObject({ deleted: false }); // restore won
    const rows = [...feedbackRecords.values()].filter((f) => f.commissionId === created.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const f of rows) expect(f.deleted).not.toBe(true); // ratings survived
  });
});

describe('sanitizeFeedbackEntry', () => {
  it('normalizes an up/down reaction and mints an id', () => {
    const e = sanitizeFeedbackEntry({ runId: 'run-1', rating: 'up', note: 'more Magritte' });
    expect(e).toMatchObject({ runId: 'run-1', rating: 'up', note: 'more Magritte' });
    expect(e.id).toMatch(/^feedback-/);
    expect(typeof e.at).toBe('string');
  });

  it('preserves a non-zero numeric rating verbatim', () => {
    expect(sanitizeFeedbackEntry({ rating: 2 }).rating).toBe(2);
    expect(sanitizeFeedbackEntry({ rating: -3 }).rating).toBe(-3);
  });

  it('drops a reaction with no usable rating (null/0/garbage)', () => {
    expect(sanitizeFeedbackEntry({ note: 'x' })).toBeNull();
    expect(sanitizeFeedbackEntry({ rating: 0 })).toBeNull();
    expect(sanitizeFeedbackEntry({ rating: 'meh' })).toBeNull();
    expect(sanitizeFeedbackEntry(null)).toBeNull();
  });
});

describe('sanitizeCommission (feedback)', () => {
  it('deep-sanitizes and caps feedback, dropping ratingless entries', () => {
    const feedback = [
      { id: 'f-keep', runId: 'r1', rating: 'up', note: 'keep' },
      { note: 'no rating — dropped' },
      ...Array.from({ length: 120 }, (_, i) => ({ id: `f-${i}`, rating: 'down' })),
    ];
    const rec = sanitizeCommission({ id: 'c1', feedback });
    expect(rec.feedback).toHaveLength(100); // MAX_PERSISTED_FEEDBACK
    // The ratingless entry is filtered before capping.
    expect(rec.feedback.every((f) => f.rating === 'up' || f.rating === 'down')).toBe(true);
  });
});

describe('commission BRIEF federation (#2686)', () => {
  it('sanitizeCommissionForSync normalizes the soft-delete trio and drops a bad id', () => {
    expect(sanitizeCommissionForSync({ id: 'not-a-commission' })).toBeNull();
    const rec = sanitizeCommissionForSync({ id: 'commission-x', name: 'Nightly' });
    expect(rec).toMatchObject({ id: 'commission-x', deleted: false, deletedAt: null });
  });

  it('mergeCommissionRecord inserts a remote and preserves LOCAL schedule/runs/assignment on a remote win', () => {
    const local = sanitizeCommission({
      id: 'commission-x', name: 'Local', updatedAt: '2026-01-01T00:00:00.000Z',
      schedule: { kind: 'DAILY', atLocalTime: '02:00' }, runs: [{ id: 'run-1', status: 'ok' }],
      assignment: { providerId: 'claude', model: 'opus' },
    });
    // Remote is the WIRE form (schedule/runs/assignment stripped) with a newer brief.
    const remote = { id: 'commission-x', name: 'Renamed on peer', brief: { intent: 'surreal' }, updatedAt: '2026-06-06T00:00:00.000Z' };
    const { next, remoteWins } = mergeCommissionRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(next.name).toBe('Renamed on peer');
    expect(next.brief.intent).toBe('surreal');
    // Machine-local fields carried forward from LOCAL, not reset by the remote.
    expect(next.schedule.atLocalTime).toBe('02:00');
    expect(next.runs).toHaveLength(1);
    expect(next.assignment.providerId).toBe('claude');
  });

  it('a stale remote loses to a newer local (no clobber)', () => {
    const local = sanitizeCommission({ id: 'commission-x', name: 'Newer', updatedAt: '2026-09-09T00:00:00.000Z' });
    const remote = { id: 'commission-x', name: 'Older', updatedAt: '2020-01-01T00:00:00.000Z' };
    const { next, remoteWins } = mergeCommissionRecord(local, remote);
    expect(remoteWins).toBe(false);
    expect(next.name).toBe('Newer');
  });

  it('mergeCommissionsFromSync inserts a remote commission DORMANT (no cron, disabled) so it never double-runs', async () => {
    const remote = { id: 'commission-peer', name: 'From peer A', enabled: true, brief: { intent: 'dreamlike' }, updatedAt: '2026-05-05T00:00:00.000Z' };
    const res = await mergeCommissionsFromSync([remote], { source: { via: 'sync', peerId: 'peer-a' } });
    expect(res).toEqual({ applied: true, count: 1 });
    const got = await getCommission('commission-peer');
    expect(got.name).toBe('From peer A');
    // Dormant on the receiver: no usable schedule AND disabled, so the user must
    // explicitly enable + schedule it locally to activate — no double-run.
    expect(got.schedule.atLocalTime).toBeNull();
    expect(got.enabled).toBe(false);
  });

  it('a schedule-only edit does NOT advance the brief clock; a brief edit does', async () => {
    const created = await createCommission(validInput());
    const briefClock0 = records.get(created.id).briefUpdatedAt;
    await updateCommission(created.id, { schedule: { kind: 'DAILY', atLocalTime: '05:00' } });
    const afterSched = records.get(created.id);
    // Machine-local edit → brief clock preserved, so a peer's brief edit isn't
    // beaten by it (deterministic: the schedule path copies current.briefUpdatedAt).
    expect(afterSched.briefUpdatedAt).toBe(briefClock0);
    await updateCommission(created.id, { name: 'Renamed' });
    const afterName = records.get(created.id);
    // Federated edit → brief clock advances to the update moment (== updatedAt).
    expect(afterName.briefUpdatedAt).toBe(afterName.updatedAt);
  });

  it('a tombstone advances the brief clock so the delete wins the LWW on peers', async () => {
    const created = await createCommission(validInput());
    await deleteCommission(created.id);
    const tomb = records.get(created.id);
    expect(tomb.deleted).toBe(true);
    // Delete bumps the brief clock to the delete moment (== updatedAt == deletedAt),
    // so a peer's briefUpdatedAt-keyed LWW applies the tombstone.
    expect(tomb.briefUpdatedAt).toBe(tomb.updatedAt);
    expect(tomb.briefUpdatedAt).toBe(tomb.deletedAt);
    // The wire form's LWW key (updatedAt) is the brief clock — a peer will apply it.
    expect(sanitizeCommissionForSync(tomb).briefUpdatedAt).toBe(tomb.briefUpdatedAt);
  });

  it('getCommissionForSync surfaces a tombstone after delete', async () => {
    const created = await createCommission(validInput());
    await deleteCommission(created.id);
    const wire = await getCommissionForSync(created.id);
    expect(wire).toMatchObject({ id: created.id, deleted: true });
  });
});

describe('legacy inline feedback → federated split (#2686)', () => {
  // Seed a pre-#2686 record that still carries INLINE feedback (Phase 2 storage),
  // written straight into the machine-local commission map.
  const seedLegacy = () => {
    records.set('commission-legacy', {
      id: 'commission-legacy', name: 'Legacy', enabled: true, targetAbility: 'video',
      brief: {}, schedule: { kind: 'DAILY', atLocalTime: '02:00' }, generation: {},
      runs: [{ id: 'run-A', status: 'started' }],
      feedback: [{ id: 'feedback-old', runId: 'run-A', rating: 'up', note: 'legacy like', at: '2026-01-01T00:00:00.000Z' }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  };

  it('listCommissions falls back to inline feedback before migration (no under-report)', async () => {
    seedLegacy();
    const list = await listCommissions();
    const legacy = list.find((c) => c.id === 'commission-legacy');
    expect(legacy.feedback).toHaveLength(1);
    expect(legacy.feedback[0]).toMatchObject({ runId: 'run-A', rating: 'up', note: 'legacy like' });
  });

  it('getCommission migrates inline → federated and clears the inline array', async () => {
    seedLegacy();
    const rec = await getCommission('commission-legacy');
    expect(rec.feedback).toHaveLength(1);
    expect(rec.feedback[0]).toMatchObject({ runId: 'run-A', rating: 'up', note: 'legacy like' });
    // Inline array on the machine-local record is now cleared; a federated record exists.
    expect(records.get('commission-legacy').feedback).toEqual([]);
    expect([...feedbackRecords.values()].some((f) => f.commissionId === 'commission-legacy')).toBe(true);
  });

  it('a PARTIAL migration never hides the un-migrated tail (inline ∪ federated on read)', async () => {
    // Seed a legacy record with 2 inline reactions, then pre-federate ONLY the
    // first (simulating a backfill that wrote a prefix then threw, inline retained).
    records.set('commission-partial', {
      id: 'commission-partial', name: 'Partial', enabled: true, targetAbility: 'video',
      brief: {}, schedule: { kind: 'DAILY', atLocalTime: '02:00' }, generation: {},
      runs: [{ id: 'run-A' }, { id: 'run-B' }],
      feedback: [
        { id: 'feedback-a', runId: 'run-A', rating: 'up', note: 'A', at: '2026-01-01T00:00:00.000Z' },
        { id: 'feedback-b', runId: 'run-B', rating: 'down', note: 'B', at: '2026-01-02T00:00:00.000Z' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    feedbackRecords.set('cfeedback-run-A', {
      id: 'cfeedback-run-A', commissionId: 'commission-partial', runId: 'run-A',
      rating: 'up', note: 'A', at: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', deleted: false, deletedAt: null,
    });
    // listCommissions must show BOTH reactions (federated run-A ∪ inline run-B), not just run-A.
    const list = await listCommissions();
    const rec = list.find((c) => c.id === 'commission-partial');
    expect(rec.feedback.map((f) => f.runId).sort()).toEqual(['run-A', 'run-B']);
  });

  it('backfillAllCommissionFeedback splits every commission idempotently', async () => {
    seedLegacy();
    const first = await backfillAllCommissionFeedback();
    expect(first.migrated).toBe(1);
    // Re-running is a no-op (inline already cleared).
    const second = await backfillAllCommissionFeedback();
    expect(second.migrated).toBe(0);
    expect(records.get('commission-legacy').feedback).toEqual([]);
  });
});

describe('submitCommissionFeedback', () => {
  it('appends a reaction keyed to an existing run and returns the updated commission', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'started', projectId: 'cd-1' });
    const updated = await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(updated.feedback).toHaveLength(1);
    expect(updated.feedback[0]).toMatchObject({ runId: 'run-A', rating: 'up', note: 'more Magritte' });
    // Feedback now lives in the federated commissionFeedback store (#2686), keyed
    // by a deterministic per-run id so a re-rating LWW-updates in place.
    expect(updated.feedback[0].id).toMatch(/^cfeedback-/);
  });

  it('closes the loop: the reaction folds into the next directive', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'started', projectId: 'cd-1' });
    await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'down', note: 'less horror' });
    const after = await getCommission(created.id);
    const directive = buildCommissionDirective(after);
    expect(directive.goal).toContain('Recent dislikes: less horror.');
  });

  it('re-rating a run REPLACES its prior reaction (no contradictory stacking)', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'started', projectId: 'cd-1' });
    await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'up', note: 'first take' });
    const updated = await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'down', note: 'changed my mind' });
    // Exactly one reaction for the run — the latest — not two.
    const forRun = updated.feedback.filter((f) => f.runId === 'run-A');
    expect(forRun).toHaveLength(1);
    expect(forRun[0]).toMatchObject({ rating: 'down', note: 'changed my mind' });
    // And the digest reflects only the latest vote, not both.
    const directive = buildCommissionDirective(await getCommission(created.id));
    expect(directive.goal).toContain('Recent dislikes: changed my mind.');
    expect(directive.goal).not.toContain('first take');
  });

  it('rejects a reaction referencing a run not on the commission (VALIDATION)', async () => {
    const created = await createCommission(validInput());
    await expect(
      submitCommissionFeedback(created.id, { runId: 'ghost', rating: 'up' }),
    ).rejects.toMatchObject({ code: ERR_VALIDATION });
  });

  it('throws NOT_FOUND for an unknown commission', async () => {
    await expect(
      submitCommissionFeedback('nope', { runId: 'r', rating: 'up' }),
    ).rejects.toMatchObject({ code: ERR_NOT_FOUND });
  });
});
