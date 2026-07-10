/**
 * Pure record-transform tests for the Creative Director storage logic shared by
 * the file + Postgres backends. No I/O — these lock the mutation semantics the
 * two backends MUST agree on (status preservation, scene patching, runs[] cap).
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_PERSISTED_RUNS,
  trimRuns,
  mirrorStatus,
  mirrorTimestamp,
  buildProjectRecord,
  applyProjectPatch,
  applyTreatment,
  applyPlan,
  applyPlanStepUpdate,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
  sanitizeProjectForSync,
  mergeProjectRecord,
  startingImageFilename,
  normalizeModelOverrides,
  resolveStagePin,
} from './projectsLogic.js';

const VALID_TREATMENT = {
  logline: 'A cat finds a hat.',
  synopsis: 'Then puts it on.',
  scenes: [{ sceneId: 'scene-1', order: 0, intent: 'Cat enters', prompt: 'A cat walks in', durationSeconds: 4 }],
};

describe('modelOverrides (per-project provider/model pins)', () => {
  const base = { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 };

  it('defaults to an empty object on a bare project', () => {
    const p = buildProjectRecord(base, { id: 'cd-1', now: 'now', collectionId: 'c-1' });
    expect(p.modelOverrides).toEqual({});
  });

  it('normalizes: keeps provider-bearing stages, drops empty + model-only ones', () => {
    const p = buildProjectRecord(
      {
        ...base,
        modelOverrides: {
          treatment: { providerId: '  agent-a  ', model: '  qwen  ' },
          plan: { model: 'no-provider' }, // dropped — a model alone can't resolve
          evaluation: { providerId: '' },  // dropped — blank provider
          bogus: { providerId: 'x' },       // dropped — not a known stage
        },
      },
      { id: 'cd-1', now: 'now', collectionId: 'c-1' },
    );
    expect(p.modelOverrides).toEqual({ treatment: { providerId: 'agent-a', model: 'qwen' } });
  });

  it('normalizeModelOverrides tolerates non-objects', () => {
    expect(normalizeModelOverrides(null)).toEqual({});
    expect(normalizeModelOverrides('nope')).toEqual({});
    expect(normalizeModelOverrides([1, 2])).toEqual({});
    expect(normalizeModelOverrides({ treatment: { providerId: 'a' } })).toEqual({ treatment: { providerId: 'a' } });
  });

  it('applyProjectPatch re-normalizes an incoming override object', () => {
    const next = applyProjectPatch({ id: 'cd-1', modelOverrides: {} }, {
      modelOverrides: { plan: { providerId: 'a', model: '' }, evaluation: { model: 'orphan' } },
    });
    expect(next.modelOverrides).toEqual({ plan: { providerId: 'a' } });
  });

  it('resolveStagePin prefers the project override, else the global assignment', () => {
    const settings = { creativeDirector: { treatment: { providerId: 'global', model: 'gm' } } };
    // Override wins when it names a provider.
    expect(resolveStagePin('treatment', { modelOverrides: { treatment: { providerId: 'proj', model: 'pm' } } }, settings))
      .toEqual({ providerId: 'proj', model: 'pm' });
    // No override → global.
    expect(resolveStagePin('treatment', {}, settings)).toEqual({ providerId: 'global', model: 'gm' });
    // Neither → empty strings.
    expect(resolveStagePin('plan', {}, settings)).toEqual({ providerId: '', model: '' });
  });
});

describe('buildProjectRecord', () => {
  it('produces a draft project with the supplied collection id and null pointers', () => {
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 },
      { id: 'cd-1', now: '2026-06-07T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(p).toMatchObject({
      id: 'cd-1', name: 'X', status: 'draft', collectionId: 'col-1',
      timelineProjectId: null, finalVideoId: null, treatment: null, runs: [],
    });
  });

  it('defaults cast to [] and passes a supplied cast through (#1808)', () => {
    const bare = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 },
      { id: 'cd-1', now: '2026-06-07T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(bare.cast).toEqual([]);

    const cast = [{ ingredientId: 'cat-c', name: 'Mara', type: 'character', role: 'cast' }];
    const seeded = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9, cast },
      { id: 'cd-2', now: '2026-06-07T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(seeded.cast).toEqual(cast);

    // A malformed (non-array) cast coerces to [] rather than persisting junk.
    const bad = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9, cast: 'nope' },
      { id: 'cd-3', now: '2026-06-07T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(bad.cast).toEqual([]);
  });
});

describe('applyProjectPatch', () => {
  it('merges the patch and bumps updatedAt', () => {
    const next = applyProjectPatch({ id: 'cd-1', status: 'draft', updatedAt: 'old' }, { status: 'planning' });
    expect(next.status).toBe('planning');
    expect(next.updatedAt).not.toBe('old');
  });
  it('throws on an invalid status', () => {
    expect(() => applyProjectPatch({ id: 'cd-1' }, { status: 'bogus' })).toThrow(/Invalid status/);
  });
});

describe('applyTreatment — status preservation', () => {
  it('preserves paused status', () => {
    const next = applyTreatment({ id: 'cd-1', status: 'paused' }, VALID_TREATMENT);
    expect(next.status).toBe('paused');
    expect(next.treatment.scenes[0].status).toBe('pending');
  });
  it('preserves failed status', () => {
    expect(applyTreatment({ id: 'cd-1', status: 'failed' }, VALID_TREATMENT).status).toBe('failed');
  });
  it('flips planning → rendering', () => {
    expect(applyTreatment({ id: 'cd-1', status: 'planning' }, VALID_TREATMENT).status).toBe('rendering');
  });
  it('initializes scene runtime fields', () => {
    const next = applyTreatment({ id: 'cd-1', status: 'planning' }, VALID_TREATMENT);
    expect(next.treatment.scenes[0]).toMatchObject({ status: 'pending', retryCount: 0, renderedJobId: null, evaluation: null });
  });
  it('throws on an invalid treatment', () => {
    expect(() => applyTreatment({ id: 'cd-1', status: 'planning' }, { logline: '', synopsis: '', scenes: [] })).toThrow(/Treatment validation failed/);
  });
  it('preserves per-scene cast the agent supplied (#1808)', () => {
    const sceneCast = [{ ingredientId: 'cat-c', name: 'Mara', role: 'cast' }];
    const treatment = {
      ...VALID_TREATMENT,
      scenes: [{ ...VALID_TREATMENT.scenes[0], cast: sceneCast }],
    };
    const next = applyTreatment({ id: 'cd-1', status: 'planning' }, treatment);
    expect(next.treatment.scenes[0].cast).toEqual(sceneCast);
  });
});

describe('applySceneUpdate', () => {
  const base = () => ({ id: 'cd-1', status: 'rendering', treatment: { logline: 'l', synopsis: 's', scenes: [{ sceneId: 'scene-1', order: 0, status: 'pending' }] } });
  it('patches the matching scene and returns it', () => {
    const { project, updated } = applySceneUpdate(base(), 'scene-1', { status: 'rendering', renderedJobId: 'job-1' });
    expect(updated).toMatchObject({ status: 'rendering', renderedJobId: 'job-1' });
    expect(project.treatment.scenes[0].renderedJobId).toBe('job-1');
  });
  it('does not mutate the input project (immutable update)', () => {
    const input = base();
    applySceneUpdate(input, 'scene-1', { status: 'accepted' });
    expect(input.treatment.scenes[0].status).toBe('pending');
  });
  it('throws when the project has no treatment', () => {
    expect(() => applySceneUpdate({ id: 'cd-1' }, 'scene-1', {})).toThrow(/no treatment/);
  });
  it('throws when the scene id is unknown', () => {
    expect(() => applySceneUpdate(base(), 'scene-9', {})).toThrow(/Scene not found/);
  });
});

describe('appendRun / applyRunUpdate', () => {
  it('appends a run with a generated runId + startedAt', () => {
    const { project, run } = appendRun({ id: 'cd-1', runs: [] }, { kind: 'treatment', status: 'running' });
    expect(run.runId).toBeTruthy();
    expect(run.startedAt).toBeTruthy();
    expect(project.runs).toHaveLength(1);
  });
  it('honors a supplied runId', () => {
    const { run } = appendRun({ id: 'cd-1', runs: [] }, { runId: 'fixed', kind: 'evaluate', status: 'running' });
    expect(run.runId).toBe('fixed');
  });
  it('patches an existing run by id', () => {
    const start = appendRun({ id: 'cd-1', runs: [] }, { runId: 'r1', status: 'running' });
    const { project, updated } = applyRunUpdate(start.project, 'r1', { status: 'completed' });
    expect(updated.status).toBe('completed');
    expect(project.runs[0].status).toBe('completed');
  });
  it('returns updated=null and the unchanged project for an unknown runId', () => {
    const input = { id: 'cd-1', runs: [{ runId: 'r1', status: 'running' }] };
    const { project, updated } = applyRunUpdate(input, 'nope', { status: 'completed' });
    expect(updated).toBeNull();
    expect(project).toBe(input);
  });
});

describe('mirrorStatus / mirrorTimestamp (typed-column safety)', () => {
  it('mirrorStatus bounds to 32 chars and falls back to draft', () => {
    expect(mirrorStatus('rendering')).toBe('rendering');
    expect(mirrorStatus('x'.repeat(80)).length).toBe(32);
    expect(mirrorStatus('')).toBe('draft');
    expect(mirrorStatus(null)).toBe('draft');
    expect(mirrorStatus(undefined)).toBe('draft');
  });
  it('mirrorTimestamp returns a NORMALIZED ISO string and falls back otherwise', () => {
    expect(mirrorTimestamp('2026-01-01T00:00:00.000Z', 'fb')).toBe('2026-01-01T00:00:00.000Z');
    // Out-of-range calendar date: Date.parse rolls it over (Feb 31 → Mar 3).
    // The mirror column must get the NORMALIZED value PG accepts, not the raw
    // string PG would reject — otherwise the INSERT throws and blocks boot.
    expect(mirrorTimestamp('2026-02-31T00:00:00.000Z', 'fb')).toBe('2026-03-03T00:00:00.000Z');
    expect(mirrorTimestamp('not-a-date', 'fb')).toBe('fb');
    expect(mirrorTimestamp(12345, 'fb')).toBe('fb');
    expect(mirrorTimestamp(null, 'fb')).toBe('fb');
    // Extended-year ISO that Date.parse accepts but is outside Postgres
    // TIMESTAMPTZ range → must fall back, not bind a ±YYYYYY string that throws.
    expect(mirrorTimestamp('-100000-01-01T00:00:00.000Z', 'fb')).toBe('fb');
    expect(mirrorTimestamp('+275760-09-13T00:00:00.000Z', 'fb')).toBe('fb');
    // Year 0000: Date.parse accepts it and toISOString emits a 4-digit
    // '0000-…', but Postgres has no Gregorian year zero → must fall back.
    expect(mirrorTimestamp('0000-01-01T00:00:00.000Z', 'fb')).toBe('fb');
    // A normal in-range year still passes.
    expect(mirrorTimestamp('0001-01-01T00:00:00.000Z', 'fb')).toBe('0001-01-01T00:00:00.000Z');
  });
});

describe('trimRuns', () => {
  it('is a no-op under the cap', () => {
    const runs = [{ runId: 'a', status: 'completed' }];
    expect(trimRuns(runs)).toBe(runs);
  });
  it('caps terminal runs but keeps every in-flight run', () => {
    const terminal = Array.from({ length: MAX_PERSISTED_RUNS + 50 }, (_, i) => ({ runId: `t${i}`, status: 'completed' }));
    const inflight = [{ runId: 'live', status: 'running' }];
    const trimmed = trimRuns([...terminal, ...inflight]);
    expect(trimmed.length).toBe(MAX_PERSISTED_RUNS);
    expect(trimmed.some((r) => r.runId === 'live')).toBe(true);
  });
  it('preserves chronological order after trimming', () => {
    const runs = Array.from({ length: MAX_PERSISTED_RUNS + 10 }, (_, i) => ({ runId: `t${i}`, status: 'completed' }));
    const trimmed = trimRuns(runs);
    // The most-recent MAX runs, still in ascending order.
    expect(trimmed[0].runId).toBe('t10');
    expect(trimmed[trimmed.length - 1].runId).toBe(`t${runs.length - 1}`);
  });
  it('returns [] for non-array input', () => {
    expect(trimRuns(undefined)).toEqual([]);
    expect(trimRuns(null)).toEqual([]);
  });
});

// --- Federation (#1564) — soft-delete + LWW merge decision ------------------

describe('buildProjectRecord soft-delete trio', () => {
  it('stamps deleted=false / deletedAt=null on a fresh project', () => {
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 },
      { id: 'cd-1', now: '2026-06-23T00:00:00.000Z', collectionId: 'col-1' },
    );
    expect(p.deleted).toBe(false);
    expect(p.deletedAt).toBeNull();
  });
});

describe('startingImageFilename', () => {
  it('reduces a /data/images/ path or bare filename to the basename', () => {
    expect(startingImageFilename('/data/images/start.png')).toBe('start.png');
    expect(startingImageFilename('start.png')).toBe('start.png');
    expect(startingImageFilename('/data/images/start.png?v=2')).toBe('start.png');
  });
  it('returns null for empty, external, or non-images absolute paths', () => {
    expect(startingImageFilename('')).toBeNull();
    expect(startingImageFilename(null)).toBeNull();
    expect(startingImageFilename('https://example.com/x.png')).toBeNull();
    expect(startingImageFilename('data:image/png;base64,AAAA')).toBeNull();
    expect(startingImageFilename('/data/videos/x.mp4')).toBeNull();
  });
});

describe('sanitizeProjectForSync', () => {
  it('drops a non-object or id-less record (drop-on-floor contract)', () => {
    expect(sanitizeProjectForSync(null)).toBeNull();
    expect(sanitizeProjectForSync([])).toBeNull();
    expect(sanitizeProjectForSync({ name: 'no id' })).toBeNull();
  });
  it('normalizes the soft-delete trio and preserves the body verbatim', () => {
    const out = sanitizeProjectForSync({ id: 'cd-1', name: 'X', styleSpec: 'noir', updatedAt: '2026-06-23T00:00:00.000Z', deleted: true, deletedAt: '2026-06-23T01:00:00.000Z' });
    expect(out).toMatchObject({ id: 'cd-1', name: 'X', styleSpec: 'noir', deleted: true, deletedAt: '2026-06-23T01:00:00.000Z' });
  });
  it('forces deletedAt=null when not deleted', () => {
    const out = sanitizeProjectForSync({ id: 'cd-1', name: 'X', deleted: false, deletedAt: 'stray' });
    expect(out.deleted).toBe(false);
    expect(out.deletedAt).toBeNull();
  });
});

describe('mergeProjectRecord (LWW, tombstone-aware)', () => {
  const at = (iso, extra = {}) => ({ id: 'cd-1', name: 'P', updatedAt: iso, ...extra });
  it('inserts when there is no local counterpart', () => {
    const { next, inserted, remoteWins } = mergeProjectRecord(null, at('2026-06-23T00:00:00.000Z'));
    expect(inserted).toBe(true);
    expect(remoteWins).toBe(true);
    expect(next.id).toBe('cd-1');
  });
  it('remote with a newer updatedAt wins', () => {
    const local = at('2026-06-23T00:00:00.000Z', { styleSpec: 'old' });
    const { next, remoteWins, changed } = mergeProjectRecord(local, at('2026-06-23T01:00:00.000Z', { styleSpec: 'new' }));
    expect(remoteWins).toBe(true);
    expect(changed).toBe(true);
    expect(next.styleSpec).toBe('new');
  });
  it('local wins when its updatedAt is newer (no change)', () => {
    const local = at('2026-06-23T02:00:00.000Z', { styleSpec: 'keep' });
    const { next, remoteWins } = mergeProjectRecord(local, at('2026-06-23T01:00:00.000Z', { styleSpec: 'lose' }));
    expect(remoteWins).toBe(false);
    expect(next.styleSpec).toBe('keep');
  });
  it('a newer remote tombstone overwrites a live local record', () => {
    const local = at('2026-06-23T00:00:00.000Z');
    const { next, remoteWins } = mergeProjectRecord(local, at('2026-06-23T03:00:00.000Z', { deleted: true, deletedAt: '2026-06-23T03:00:00.000Z' }));
    expect(remoteWins).toBe(true);
    expect(next.deleted).toBe(true);
  });
  it('drops a malformed remote (next null)', () => {
    expect(mergeProjectRecord(at('2026-06-23T00:00:00.000Z'), { name: 'no id' }).next).toBeNull();
  });
});

// =============================================================================
// CDO Phase 2 (#2184) — production directive + plan transforms.
// =============================================================================

const VALID_PLAN = {
  steps: [
    { stepId: 'a', toolName: 'pipeline_createSeries', args: { name: 'Noir' } },
    { stepId: 'b', toolName: 'pipeline_renderComicCover', args: { issueId: 'i1' }, dependsOn: ['a'] },
  ],
};

describe('buildProjectRecord — directive/plan (CDO Phase 2)', () => {
  it('defaults directive and plan to null on a bare project', () => {
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9 },
      { id: 'cd-1', now: 'T', collectionId: 'col-1' },
    );
    expect(p.directive).toBeNull();
    expect(p.plan).toBeNull();
  });
  it('stores a supplied directive object verbatim', () => {
    const directive = { goal: 'make a comic', deliverables: ['covers'], constraints: { universeId: 'u1' } };
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9, directive },
      { id: 'cd-1', now: 'T', collectionId: 'col-1' },
    );
    expect(p.directive).toEqual(directive);
    expect(p.plan).toBeNull();
  });
  it('coerces a non-object directive to null', () => {
    const p = buildProjectRecord(
      { name: 'X', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9, directive: 'nope' },
      { id: 'cd-1', now: 'T', collectionId: 'col-1' },
    );
    expect(p.directive).toBeNull();
  });
});

describe('applyPlan', () => {
  it('normalizes steps (status→pending, retryCount→0, result→null, dependsOn→[]) and flips planning→rendering', () => {
    const next = applyPlan({ id: 'cd-1', status: 'planning' }, VALID_PLAN);
    expect(next.status).toBe('rendering');
    expect(next.plan.replanRounds).toBe(0);
    expect(next.plan.steps[0]).toMatchObject({ stepId: 'a', status: 'pending', retryCount: 0, result: null, dependsOn: [] });
    expect(next.plan.steps[1]).toMatchObject({ stepId: 'b', status: 'pending', dependsOn: ['a'] });
  });
  it('preserves paused/failed status (a human parked it)', () => {
    expect(applyPlan({ id: 'cd-1', status: 'paused' }, VALID_PLAN).status).toBe('paused');
    expect(applyPlan({ id: 'cd-1', status: 'failed' }, VALID_PLAN).status).toBe('failed');
  });
  it('throws a validation error on a malformed plan', () => {
    expect(() => applyPlan({ id: 'cd-1', status: 'planning' }, { steps: [] })).toThrow(/Plan validation failed/);
    expect(() => applyPlan({ id: 'cd-1', status: 'planning' }, { steps: [{ stepId: 'a' }] })).toThrow(/Plan validation failed/);
  });
  it('on a RE-PLAN preserves an already-done step verbatim and bumps replanRounds', () => {
    const first = applyPlan({ id: 'cd-1', status: 'planning' }, VALID_PLAN);
    // Mark step "a" done as the advance loop would.
    first.plan.steps[0].status = 'done';
    first.plan.steps[0].result = { seriesId: 's1' };
    const revised = applyPlan(first, {
      steps: [
        { stepId: 'a', toolName: 'pipeline_createSeries', args: { name: 'Noir' } },
        { stepId: 'c', toolName: 'pipeline_generateStage', args: { issueId: 'i1', stageId: 'prose' }, dependsOn: ['a'] },
      ],
    });
    expect(revised.plan.replanRounds).toBe(1);
    // "a" keeps its terminal-success status + result — never re-run.
    expect(revised.plan.steps[0]).toMatchObject({ stepId: 'a', status: 'done', result: { seriesId: 's1' } });
    // The revised remaining step is fresh pending.
    expect(revised.plan.steps[1]).toMatchObject({ stepId: 'c', status: 'pending' });
  });
  it('does NOT preserve a failed step across a re-plan (re-runs it)', () => {
    const first = applyPlan({ id: 'cd-1', status: 'planning' }, VALID_PLAN);
    first.plan.steps[0].status = 'failed';
    const revised = applyPlan(first, VALID_PLAN);
    expect(revised.plan.steps[0].status).toBe('pending');
  });
});

describe('applyPlanStepUpdate', () => {
  it('patches a single step and returns the updated step', () => {
    const base = applyPlan({ id: 'cd-1', status: 'planning' }, VALID_PLAN);
    const { project, updated } = applyPlanStepUpdate(base, 'b', { status: 'running' });
    expect(updated).toMatchObject({ stepId: 'b', status: 'running' });
    expect(project.plan.steps.find((s) => s.stepId === 'b').status).toBe('running');
    expect(project.plan.steps.find((s) => s.stepId === 'a').status).toBe('pending');
  });
  it('returns { updated: null } (project unchanged) for an unknown stepId', () => {
    const base = applyPlan({ id: 'cd-1', status: 'planning' }, VALID_PLAN);
    const { project, updated } = applyPlanStepUpdate(base, 'zzz', { status: 'done' });
    expect(updated).toBeNull();
    expect(project).toBe(base);
  });
  it('returns { updated: null } when the project has no plan', () => {
    const { updated } = applyPlanStepUpdate({ id: 'cd-1', plan: null }, 'a', { status: 'done' });
    expect(updated).toBeNull();
  });
});
