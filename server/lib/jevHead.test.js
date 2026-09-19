import { describe, expect, it } from 'vitest';
import { JEV_LABELS, JEV_SIDECAR_FAILURE_CODES } from './jev.js';
import { JEV_DECISION_IDS } from './jevDecisions.js';
import { SCOPE_ADHERENCE_REASONS } from './scopeAdherenceReasons.js';
import {
  JEV_HEAD_BLOCKER_FALLBACK,
  JEV_HEAD_BLOCKER_REASONS,
  jevHeadBlockerLabel,
} from './jevHeadReasons.js';
import {
  countHeadParams,
  headAdoptionBlocker,
  headBeatsBaselines,
  isHeadCompatible,
  JEV_HEAD_FAILURE_CODES,
  JEV_HEAD_MAX_HIDDEN,
  JEV_HEAD_POOLING,
  JEV_HEAD_SCHEMA_VERSION,
  jevHeadActionRequestSchema,
  jevHeadFileName,
  jevHeadSlug,
  jevHeadTrainRequestSchema,
  parseJevHead,
} from './jevHead.js';

const BASE = { id: 'openjev-qwen3.5-4b-nli', repository: 'AlexWortega/openjev', revision: 'abc123' };

const linearHead = (overrides = {}) => ({
  schemaVersion: JEV_HEAD_SCHEMA_VERSION,
  decisionId: 'scope-adherence',
  architecture: 'linear',
  pooling: JEV_HEAD_POOLING,
  baseModel: { ...BASE },
  hiddenSize: 4,
  labels: [...JEV_LABELS],
  layers: [{
    weight: [[0.1, 0.2, 0.3, 0.4], [1, 0, 0, 0], [0, 1, 0, 0]],
    bias: [0, 0.5, -0.5],
  }],
  metrics: { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 },
  corpusHash: 'deadbeefcafe0001',
  corpusSources: ['merged-pr'],
  trainedAt: '2026-09-19T00:00:00.000Z',
  ...overrides,
});

describe('parseJevHead', () => {
  it('accepts a well-formed linear head', () => {
    const result = parseJevHead(linearHead());
    expect(result.ok).toBe(true);
    expect(countHeadParams(result.head)).toBe(15);
  });

  it('accepts a two-layer mlp1 head whose widths chain', () => {
    const result = parseJevHead(linearHead({
      architecture: 'mlp1',
      layers: [
        { weight: [[1, 0, 0, 0], [0, 1, 0, 0]], bias: [0, 0] },
        { weight: [[1, 0], [0, 1], [1, 1]], bias: [0, 0, 0] },
      ],
    }));
    expect(result.ok).toBe(true);
  });

  // The failure this rejects is silent otherwise: a head whose DECLARED input
  // width disagrees with its own first layer would fail deep inside a forward
  // pass, on a machine, with a Python traceback the operator never sees.
  it('rejects a head whose declared hiddenSize does not match its weights', () => {
    expect(parseJevHead(linearHead({ hiddenSize: 8 }))).toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  it('rejects a head whose layer widths do not chain', () => {
    expect(parseJevHead(linearHead({
      architecture: 'mlp1',
      layers: [
        { weight: [[1, 0, 0, 0], [0, 1, 0, 0]], bias: [0, 0] },
        // Three inputs, but the layer above emits two.
        { weight: [[1, 0, 0], [0, 1, 0], [1, 1, 0]], bias: [0, 0, 0] },
      ],
    })), 'a mismatched chain must not parse').toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  // The output width IS the label contract. A head emitting two logits would
  // make `decideFromScores` read a neutral probability as an entailment one.
  it('rejects a head whose final layer does not emit one logit per label', () => {
    expect(parseJevHead(linearHead({
      layers: [{ weight: [[0.1, 0.2, 0.3, 0.4], [1, 0, 0, 0]], bias: [0, 0] }],
    }))).toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  it('rejects relabelled or reordered labels', () => {
    expect(parseJevHead(linearHead({ labels: ['entailment', 'contradiction', 'neutral'] })))
      .toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  it('rejects an mlp1 hidden layer wider than the bound', () => {
    const wide = JEV_HEAD_MAX_HIDDEN + 1;
    expect(parseJevHead(linearHead({
      architecture: 'mlp1',
      layers: [
        { weight: Array.from({ length: wide }, () => [1, 0, 0, 0]), bias: Array.from({ length: wide }, () => 0) },
        { weight: Array.from({ length: 3 }, () => Array.from({ length: wide }, () => 0)), bias: [0, 0, 0] },
      ],
    }))).toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  it('rejects a linear head that ships two layers', () => {
    expect(parseJevHead(linearHead({
      layers: [
        { weight: [[1, 0, 0, 0], [0, 1, 0, 0]], bias: [0, 0] },
        { weight: [[1, 0], [0, 1], [1, 1]], bias: [0, 0, 0] },
      ],
    }))).toEqual({ ok: false, code: 'jev-head-invalid' });
  });

  it('rejects an unknown key rather than dropping it', () => {
    expect(parseJevHead({ ...linearHead(), adopted: true })).toEqual({ ok: false, code: 'jev-head-invalid' });
  });
});

describe('isHeadCompatible', () => {
  it('accepts the exact pinned revision', () => {
    expect(isHeadCompatible(linearHead(), BASE)).toBe(true);
  });

  // Embeddings from another checkpoint are another vector space. A head applied
  // across one produces confident numbers with nothing anywhere to signal they
  // are meaningless, which is strictly worse than no head at all.
  it('refuses a head fit on a different encoder revision', () => {
    expect(isHeadCompatible(linearHead(), { ...BASE, revision: 'other' })).toBe(false);
  });

  it('refuses a head fit on a different repository at the same revision', () => {
    expect(isHeadCompatible(linearHead(), { ...BASE, repository: 'someone/else' })).toBe(false);
  });
});

describe('the adoption gate', () => {
  it('adopts only a head that beats BOTH baselines', () => {
    expect(headBeatsBaselines(linearHead().metrics)).toBe(true);
    expect(headAdoptionBlocker(linearHead().metrics)).toBeNull();
  });

  it('refuses a head that beats the majority class but not stock zero-shot', () => {
    const metrics = { trained: 0.60, stockZeroShot: 0.66, majorityClass: 0.52, goldSize: 40, trainSize: 120 };
    expect(headBeatsBaselines(metrics)).toBe(false);
    expect(headAdoptionBlocker(metrics)).toBe('jev-head-below-zero-shot');
  });

  // The skew case the second baseline exists for: on a corpus that is 80% one
  // label, a head can beat a weak zero-shot classifier while still losing to a
  // constant prediction — and would otherwise be adopted on the strength of the
  // corpus's imbalance.
  it('refuses a head that beats stock zero-shot but not the majority class', () => {
    const metrics = { trained: 0.74, stockZeroShot: 0.61, majorityClass: 0.80, goldSize: 40, trainSize: 120 };
    expect(headBeatsBaselines(metrics)).toBe(false);
    expect(headAdoptionBlocker(metrics)).toBe('jev-head-below-majority-class');
  });

  // Ties lose. The stock classifier needs no corpus, no training run and no
  // privacy argument, so a draw is not a reason to adopt anything.
  it('refuses an exact tie with either baseline', () => {
    expect(headBeatsBaselines({ trained: 0.6, stockZeroShot: 0.6, majorityClass: 0.5, goldSize: 40, trainSize: 120 })).toBe(false);
    expect(headBeatsBaselines({ trained: 0.6, stockZeroShot: 0.5, majorityClass: 0.6, goldSize: 40, trainSize: 120 })).toBe(false);
  });

  it('refuses metrics it cannot read at all', () => {
    expect(headBeatsBaselines({ trained: 0.9 })).toBe(false);
    expect(headAdoptionBlocker(null)).toBe('jev-head-metrics-invalid');
  });
});

describe('head slugs', () => {
  // A head is addressed by slug and resolved inside a directory the Node
  // service owns. A decision id with a colon or a slash would make the slug a
  // path; this is what makes that a test failure rather than a runtime one.
  it('every shipped decision id is a usable slug', () => {
    expect(JEV_DECISION_IDS.length).toBeGreaterThan(1);
    for (const id of JEV_DECISION_IDS) expect(`${id}:${jevHeadSlug(id)}`).toBe(`${id}:${id}`);
  });

  it('refuses a decision id that would escape the heads directory', () => {
    for (const bad of ['../escape', 'a/b', 'UPPER', '.hidden', '', 'a:b']) {
      expect(`${bad}:${jevHeadSlug(bad)}`).toBe(`${bad}:null`);
    }
  });

  it('names the adopted and candidate files apart', () => {
    expect(jevHeadFileName('scope-adherence')).toBe('scope-adherence.json');
    expect(jevHeadFileName('scope-adherence', { candidate: true })).toBe('scope-adherence.candidate.json');
    expect(jevHeadFileName('../escape')).toBeNull();
  });
});

describe('the head failure vocabulary', () => {
  // The head codes exist in three places — this list, the sidecar's forwardable
  // subset, and the operator-facing labels. Nothing tied them together, so the
  // copies could drift silently; these two assertions are that tie.
  it('declares every head code the sidecar is allowed to forward', () => {
    const forwardable = JEV_SIDECAR_FAILURE_CODES.filter((code) => code.startsWith('jev-head-'));
    expect(forwardable.length).toBeGreaterThan(3);
    expect(forwardable.filter((code) => !JEV_HEAD_FAILURE_CODES.includes(code))).toEqual([]);
  });

  it('gives every forwardable head code an operator-facing label', () => {
    for (const code of JEV_SIDECAR_FAILURE_CODES.filter((c) => c.startsWith('jev-head-'))) {
      expect(`${code}:${Object.hasOwn(SCOPE_ADHERENCE_REASONS, code)}`).toBe(`${code}:true`);
    }
  });

  // The other half of the vocabulary: every verdict `headAdoptionBlocker` can
  // return has to render as prose, or a fourth blocker shows an operator a raw
  // slug with a green suite behind it.
  it('gives every adoption blocker a label', () => {
    const blockers = JEV_HEAD_FAILURE_CODES.filter((code) => Object.hasOwn(JEV_HEAD_BLOCKER_REASONS, code));
    expect(blockers.sort()).toEqual(Object.keys(JEV_HEAD_BLOCKER_REASONS).sort());
    for (const code of blockers) expect(jevHeadBlockerLabel(code)).not.toBe(JEV_HEAD_BLOCKER_FALLBACK);
    // An unknown code degrades to the fallback rather than rendering undefined,
    // and a prototype key cannot return a function React would throw on.
    expect(jevHeadBlockerLabel('toString')).toBe(JEV_HEAD_BLOCKER_FALLBACK);
  });
});

describe('route schemas', () => {
  // No `repoPath`, ever: a client-supplied checkout would turn a training
  // button into an arbitrary-directory reader with a forge token beside it.
  it('the train request accepts only an architecture', () => {
    expect(jevHeadTrainRequestSchema.safeParse({}).success).toBe(true);
    expect(jevHeadTrainRequestSchema.safeParse({ architecture: 'mlp1' }).success).toBe(true);
    expect(jevHeadTrainRequestSchema.safeParse({ repoPath: '/etc' }).success).toBe(false);
    expect(jevHeadTrainRequestSchema.safeParse({ architecture: 'transformer' }).success).toBe(false);
  });

  it('the action request accepts only a known decision id', () => {
    expect(jevHeadActionRequestSchema.safeParse({ decisionId: 'scope-adherence' }).success).toBe(true);
    expect(jevHeadActionRequestSchema.safeParse({ decisionId: 'made-up' }).success).toBe(false);
  });
});
