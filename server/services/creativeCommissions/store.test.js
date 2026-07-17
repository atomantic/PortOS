import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creativeCommissionUpdateSchema } from '../../lib/creativeCommissionValidation.js';

// In-memory collectionStore so CRUD is exercised without touching the filesystem.
const records = new Map();
const makeMemStore = () => ({
  loadAll: async () => [...records.values()],
  loadOne: async (id) => records.get(id) || null,
  saveOne: async (id, rec) => { records.set(id, rec); },
  saveOneNow: async (id, rec) => { records.set(id, rec); },
  deleteOne: async (id) => { records.delete(id); },
  deleteOneNow: async (id) => { records.delete(id); },
  saveTypeIndex: async () => {},
  verifySchemaVersion: async () => ({ ok: true }),
});
vi.mock('../../lib/collectionStore.js', () => ({ createCollectionStore: () => makeMemStore() }));
vi.mock('../../lib/fileUtils.js', () => ({ PATHS: { data: '/tmp/portos-test-data' } }));

const {
  sanitizeCommission,
  sanitizeFeedbackEntry,
  assertValidSchedule,
  createCommission,
  updateCommission,
  deleteCommission,
  getCommission,
  recordCommissionRun,
  submitCommissionFeedback,
  ERR_VALIDATION,
  ERR_NOT_FOUND,
} = await import('./store.js');
const { buildCommissionDirective } = await import('./directive.js');

beforeEach(() => records.clear());

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
  it('removes the record', async () => {
    const created = await createCommission(validInput());
    const r = await deleteCommission(created.id);
    expect(r).toEqual({ id: created.id, deleted: true });
    expect(records.has(created.id)).toBe(false);
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

describe('submitCommissionFeedback', () => {
  it('appends a reaction keyed to an existing run and returns the updated commission', async () => {
    const created = await createCommission(validInput());
    await recordCommissionRun(created.id, { id: 'run-A', status: 'started', projectId: 'cd-1' });
    const updated = await submitCommissionFeedback(created.id, { runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(updated.feedback).toHaveLength(1);
    expect(updated.feedback[0]).toMatchObject({ runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(updated.feedback[0].id).toMatch(/^feedback-/);
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
