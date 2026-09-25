import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  VIDEO_FINISH_PROFILES,
  applyVideoFinishProfiles,
  validateFinishProfileGraph,
  sanitizeFinishProfiles,
  finishTargetForModel,
  isDeliveryVideoModel,
} from './videoFinishProfiles.js';
import { VIDEO_BUCKET_MLX, VIDEO_BUCKET_CUDA } from './mediaModelBuckets.js';

// The shipped registry is loaded via the runtime DEFAULT_REGISTRY, which is
// applied on fresh installs via seedIfMissing(). mediaModels.test.js already
// validates the loaded registry against the defaults.

// A minimal well-formed pair: same runtime, same base repo, same modes — the
// pair differs only in step budget, which is what makes a seed re-render
// reproduce the draft's composition.
const draft = (over = {}) => ({
  id: 'draft', runtime: 'wan22', repo: 'org/base', supportedModes: ['text'], steps: 4, finishModelId: 'full', ...over,
});
const full = (over = {}) => ({
  id: 'full', runtime: 'wan22', repo: 'org/base', supportedModes: ['text'], steps: 20, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('applyVideoFinishProfiles', () => {
  it('attaches the shipped finishModelId to a matching draft entry', () => {
    const [entry] = applyVideoFinishProfiles([
      { id: 'wan22_t2v_a14b_lightning', repo: VIDEO_FINISH_PROFILES.wan22_t2v_a14b_lightning.shippedRepo },
    ]);
    expect(entry.finishModelId).toBe('wan22_t2v_a14b');
  });

  it('leaves an existing finishModelId alone — including an explicit null override', () => {
    const list = [
      { id: 'wan22_t2v_a14b_lightning', repo: VIDEO_FINISH_PROFILES.wan22_t2v_a14b_lightning.shippedRepo, finishModelId: null },
    ];
    expect(applyVideoFinishProfiles(list)[0].finishModelId).toBeNull();
  });

  it('skips an entry whose repo was re-pointed at a fork', () => {
    const [entry] = applyVideoFinishProfiles([
      { id: 'wan22_t2v_a14b_lightning', repo: 'someone/fork-of-wan' },
    ]);
    expect(entry.finishModelId).toBeUndefined();
  });

  it('leaves custom / unknown ids and non-entries untouched', () => {
    const list = [{ id: 'my-custom-model', repo: 'me/mine' }, null, 'nope'];
    expect(applyVideoFinishProfiles(list)).toEqual(list);
  });
});

describe('validateFinishProfileGraph', () => {
  it('accepts a genuinely compatible pair', () => {
    expect(validateFinishProfileGraph([draft(), full()])).toEqual([]);
  });

  it('accepts a list with no finish edges at all', () => {
    expect(validateFinishProfileGraph([full(), { id: 'other' }])).toEqual([]);
  });

  it('rejects a target that is not in this platform list', () => {
    const [problem] = validateFinishProfileGraph([draft({ finishModelId: 'typo_id' })]);
    expect(problem.id).toBe('draft');
    expect(problem.reason).toMatch(/not a video model/);
  });

  it('rejects a self-reference', () => {
    const [problem] = validateFinishProfileGraph([draft({ finishModelId: 'draft' })]);
    expect(problem.reason).toMatch(/itself/);
  });

  it('rejects a chained target (which is also how cycles are ruled out)', () => {
    const problems = validateFinishProfileGraph([
      draft(),
      full({ finishModelId: 'draft' }), // full → draft → full would be a cycle
    ]);
    expect(problems.map((p) => p.reason).join(' ')).toMatch(/chained/);
  });

  it('rejects a runtime mismatch', () => {
    const [problem] = validateFinishProfileGraph([draft(), full({ runtime: 'ltx2' })]);
    expect(problem.reason).toMatch(/runtime mismatch/);
  });

  it('rejects a base repo mismatch — different weights do not reproduce a seed', () => {
    const [problem] = validateFinishProfileGraph([draft(), full({ repo: 'org/other-checkpoint' })]);
    expect(problem.reason).toMatch(/base repo mismatch/);
  });

  it('rejects a supportedModes mismatch', () => {
    const [problem] = validateFinishProfileGraph([draft(), full({ supportedModes: ['image'] })]);
    expect(problem.reason).toMatch(/supportedModes mismatch/);
  });

  it('rejects a non-string finishModelId', () => {
    const [problem] = validateFinishProfileGraph([draft({ finishModelId: 7 }), full()]);
    expect(problem.reason).toMatch(/non-empty string/);
  });

  it('passes for every shipped platform list — a typo in the registry fails here', async () => {
    const { loadMediaModels } = await import('./mediaModels.js');
    const registry = loadMediaModels();
    for (const platform of [VIDEO_BUCKET_MLX, VIDEO_BUCKET_CUDA]) {
      const entries = registry.video[platform];
      if (Array.isArray(entries)) {
        expect(validateFinishProfileGraph(entries)).toEqual([]);
      }
    }
  });
});

describe('sanitizeFinishProfiles', () => {
  it('returns the list untouched when the graph is sound', () => {
    const list = [draft(), full()];
    expect(sanitizeFinishProfiles(list)).toBe(list);
  });

  it('strips a bad edge and logs it, without touching the rest of the entry', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const [entry] = sanitizeFinishProfiles([draft({ finishModelId: 'deleted_by_user' })]);
    expect(entry.finishModelId).toBeUndefined();
    expect(entry.id).toBe('draft');
    expect(entry.steps).toBe(4);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('finishTargetForModel', () => {
  it('resolves the delivery entry from the available list', () => {
    expect(finishTargetForModel(draft(), [draft(), full()])?.id).toBe('full');
  });

  it('returns null when the target model is not available on this install', () => {
    expect(finishTargetForModel(draft(), [draft()])).toBeNull();
  });

  it('returns null for a model with no declared target', () => {
    expect(finishTargetForModel(full(), [draft(), full()])).toBeNull();
    expect(finishTargetForModel(null, [full()])).toBeNull();
  });
});

// Which END of a pair a model sits on (#5423). A delivery model is declared as
// the place a settled composition is taken, so anything that trades fidelity
// for speed must refuse to run on it — the finish graph is the only authority
// that can answer that, which is why the predicate lives here.
describe('isDeliveryVideoModel', () => {
  const list = [draft(), full()];

  it('is true for a model another entry names as its Finish target', () => {
    expect(isDeliveryVideoModel(full(), list)).toBe(true);
  });

  it('is false for the draft that names it', () => {
    expect(isDeliveryVideoModel(draft(), list)).toBe(false);
  });

  it('is false for a model nobody finishes into', () => {
    expect(isDeliveryVideoModel({ id: 'standalone' }, list)).toBe(false);
  });

  it.each([
    ['a missing model', null, list],
    ['a model with no id', { runtime: 'wan22' }, list],
    ['a missing list', full(), null],
  ])('is false for %s', (_label, model, entries) => {
    expect(isDeliveryVideoModel(model, entries)).toBe(false);
  });
});
