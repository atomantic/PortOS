import { describe, it, expect } from 'vitest';
import {
  applyModelAccess,
  applyModelAccessList,
  modelAccessConstrains,
  modelMatchesAccessPatterns,
  normalizeModelAccess,
  providerConfiguredModels,
  scopeModelsByAccess,
} from './modelAccess.js';

const NVIDIA_CATALOG = [
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/nv-embedqa-mistral-7b-v2',
  'moonshotai/kimi-k2.5',
];

describe('normalizeModelAccess', () => {
  it('reads a missing, malformed or unconstraining policy as the same null sentinel', () => {
    // One sentinel, three inputs: nothing stored, garbage stored, and a mode
    // that constrains nothing. Every reader keys on `null`, so they must not
    // each have to re-derive which of the three they are looking at.
    for (const value of [undefined, null, 'allow', [], 42, { mode: 'all' }, { mode: 'all', patterns: [] }]) {
      expect(normalizeModelAccess(value)).toBeNull();
    }
  });

  it('keeps a parked pattern list when the mode is switched back to all', () => {
    // The user turning a provider back open must not lose the list they curated
    // — the mode is the switch, the patterns are the work.
    expect(normalizeModelAccess({ mode: 'all', patterns: ['meta/*'] }))
      .toEqual({ mode: 'all', patterns: ['meta/*'] });
    expect(modelAccessConstrains(normalizeModelAccess({ mode: 'all', patterns: ['meta/*'] }))).toBe(false);
  });

  it('trims, de-duplicates and drops blanks without reordering', () => {
    expect(normalizeModelAccess({ mode: 'allow', patterns: ['  meta/*  ', '', 'meta/*', 'nvidia/*'] }))
      .toEqual({ mode: 'allow', patterns: ['meta/*', 'nvidia/*'] });
  });

  it('falls back to the unconstraining mode for an unknown one', () => {
    // A record written by a newer build must degrade to "no constraint", never
    // to an arbitrary constraining mode that hides models the user can run.
    expect(normalizeModelAccess({ mode: 'subscription', patterns: ['meta/*'] }))
      .toEqual({ mode: 'all', patterns: ['meta/*'] });
  });
});

describe('modelMatchesAccessPatterns', () => {
  it('matches the whole id, not a substring', () => {
    expect(modelMatchesAccessPatterns('meta/llama-3.1-8b-instruct', ['llama'])).toBe(false);
    expect(modelMatchesAccessPatterns('meta/llama-3.1-8b-instruct', ['*llama*'])).toBe(true);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    // `gpt-4.1` must not match `gpt-4x1` — a dot that acted as a wildcard would
    // silently widen a policy past what the user can read in it.
    expect(modelMatchesAccessPatterns('gpt-4x1', ['gpt-4.1'])).toBe(false);
    expect(modelMatchesAccessPatterns('gpt-4.1', ['gpt-4.1'])).toBe(true);
  });

  it('supports * and ? and ignores case', () => {
    expect(modelMatchesAccessPatterns('openai/gpt-oss-120b:free', ['*:free'])).toBe(true);
    expect(modelMatchesAccessPatterns('META/Llama-3.1-8b-instruct', ['meta/*'])).toBe(true);
    expect(modelMatchesAccessPatterns('gpt-4', ['gpt-?'])).toBe(true);
    expect(modelMatchesAccessPatterns('gpt-41', ['gpt-?'])).toBe(false);
  });
});

describe('scopeModelsByAccess', () => {
  it('admits everything when the policy constrains nothing', () => {
    for (const policy of [null, { mode: 'all', patterns: ['meta/*'] }, { mode: 'allow', patterns: [] }]) {
      expect(scopeModelsByAccess(NVIDIA_CATALOG, normalizeModelAccess(policy))).toEqual(NVIDIA_CATALOG);
    }
  });

  it('a half-finished allow policy shows everything rather than nothing', () => {
    // The regression this exists for: a user picks "only models matching the
    // list", and before a single pattern is typed every model picker in PortOS
    // goes blank. "Not configured yet" and "configured to hide everything" are
    // different states and must not collapse.
    expect(scopeModelsByAccess(NVIDIA_CATALOG, normalizeModelAccess({ mode: 'allow', patterns: [] })))
      .toEqual(NVIDIA_CATALOG);
    expect(scopeModelsByAccess(NVIDIA_CATALOG, normalizeModelAccess({ mode: 'allow', patterns: ['nothing-matches-this'] })))
      .toEqual([]);
  });

  it('allow keeps matches, deny drops them, both in catalog order', () => {
    expect(scopeModelsByAccess(NVIDIA_CATALOG, { mode: 'allow', patterns: ['meta/*', 'moonshotai/*'] }))
      .toEqual(['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct', 'moonshotai/kimi-k2.5']);
    expect(scopeModelsByAccess(NVIDIA_CATALOG, { mode: 'deny', patterns: ['nvidia/*'] }))
      .toEqual(['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct', 'moonshotai/kimi-k2.5']);
  });

  it('never hides a model the provider is configured to run', () => {
    // A picker whose stored value is missing from its options renders blank and
    // re-points the provider on the next save. The policy governs what may be
    // chosen NEXT, not what the record already says.
    expect(scopeModelsByAccess(NVIDIA_CATALOG, { mode: 'allow', patterns: ['meta/*'] }, {
      keep: ['nvidia/llama-3.1-nemotron-70b-instruct'],
    })).toContain('nvidia/llama-3.1-nemotron-70b-instruct');
  });

  it('a kept id the catalog does not list is not introduced', () => {
    expect(scopeModelsByAccess(NVIDIA_CATALOG, { mode: 'allow', patterns: ['meta/*'] }, {
      keep: ['some/model-that-was-deleted'],
    })).not.toContain('some/model-that-was-deleted');
  });
});

describe('providerConfiguredModels', () => {
  it('collects every tier a record pins and nothing else', () => {
    expect(providerConfiguredModels({
      defaultModel: 'a', lightModel: 'b', mediumModel: '', heavyModel: null,
      ultraModel: 'c', fallbackModel: 'd', models: ['e'],
    })).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('applyModelAccess', () => {
  const scoped = { id: 'nvidia-nim', models: NVIDIA_CATALOG, modelAccess: { mode: 'allow', patterns: ['meta/*'] } };

  it('narrows models and preserves the full catalog for the editor', () => {
    const result = applyModelAccess(scoped);
    expect(result.models).toEqual(['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct']);
    // Without this the provider editor — which saves its model textarea verbatim
    // — would persist the narrowed list over the real catalog on any unrelated edit.
    expect(result.modelCatalog).toEqual(NVIDIA_CATALOG);
    expect(result.modelAccessHiddenCount).toBe(3);
  });

  it('leaves the stored record untouched', () => {
    applyModelAccess(scoped);
    expect(scoped.models).toEqual(NVIDIA_CATALOG);
  });

  it('returns the SAME object when nothing is hidden', () => {
    // An install that has not configured this must serialize byte for byte as
    // before — no redundant `modelCatalog` copy on every provider in the list.
    const plain = { id: 'ollama', models: NVIDIA_CATALOG };
    expect(applyModelAccess(plain)).toBe(plain);
    const openPolicy = { id: 'x', models: NVIDIA_CATALOG, modelAccess: { mode: 'allow', patterns: ['*'] } };
    expect(applyModelAccess(openPolicy)).toBe(openPolicy);
  });

  it('prefers a resolved inherited policy over the record\'s own absent one', () => {
    // `modelAccessEffective` is what `withGatewayModelAccess` stamps on a
    // gateway-backed wrapper: one NVIDIA entitlement covers the api record, its
    // CLI wrapper and its TUI wrapper.
    const wrapper = {
      id: 'opencode-nvidia-nim',
      models: NVIDIA_CATALOG,
      modelAccessEffective: { mode: 'allow', patterns: ['meta/*'] },
    };
    expect(applyModelAccess(wrapper).models).toHaveLength(2);
  });

  it('passes nullish and non-array inputs through', () => {
    expect(applyModelAccess(null)).toBeNull();
    expect(applyModelAccessList(undefined)).toBeUndefined();
    expect(applyModelAccessList([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
});

describe('glob matching is not a translated RegExp', () => {
  it('answers a pathological pattern instantly instead of backtracking', () => {
    // Patterns are user input, and a glob translated to a RegExp backtracks
    // exponentially on this shape — every model list read would hang. The
    // greedy single-backtrack walk is O(n·m). Budgeted generously so the guard
    // reports the cliff, not machine noise.
    const started = Date.now();
    expect(modelMatchesAccessPatterns('a'.repeat(400), ['*a*a*a*a*a*a*a*a*a*a*b'])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('handles trailing, leading and consecutive wildcards', () => {
    expect(modelMatchesAccessPatterns('meta/llama', ['*'])).toBe(true);
    expect(modelMatchesAccessPatterns('meta/llama', ['**meta**'])).toBe(true);
    expect(modelMatchesAccessPatterns('meta/llama', ['meta/*'])).toBe(true);
    expect(modelMatchesAccessPatterns('meta/', ['meta/*'])).toBe(true);
    expect(modelMatchesAccessPatterns('meta', ['meta/*'])).toBe(false);
    expect(modelMatchesAccessPatterns('meta/llama', ['*llama'])).toBe(true);
    expect(modelMatchesAccessPatterns('meta/llama-x', ['*llama'])).toBe(false);
  });
});
