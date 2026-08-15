import { describe, it, expect } from 'vitest';
import { resolveModelRates, isFreeProvider, isFreeModelId, estimateCostUsd, PRICING_AS_OF } from './modelPricing.js';

describe('resolveModelRates', () => {
  it('matches exact model ids', () => {
    const r = resolveModelRates('claude-code', 'claude-opus-4-8');
    expect(r).toMatchObject({ rateModel: 'claude-opus-4-8', inputPer1M: 5, outputPer1M: 25, matched: 'exact' });
    const r5 = resolveModelRates('claude-code', 'claude-opus-5');
    expect(r5).toMatchObject({ rateModel: 'claude-opus-5', inputPer1M: 5, outputPer1M: 25, matched: 'exact' });
  });

  it('resolves CLI shorthand model names via family rules', () => {
    // Asserted by RATES, not by pointer id: the whole opus tier shares one rate
    // pair, so which listed opus id gets reported is a bump-to-bump detail the
    // suite should not have to be edited for. The pointer's validity is pinned
    // by the dedicated test below.
    expect(resolveModelRates('claude-code', 'opus')).toMatchObject({ inputPer1M: 5, outputPer1M: 25, matched: 'family' });
    expect(resolveModelRates('claude-code', 'sonnet')).toMatchObject({ rateModel: 'claude-sonnet-4-5', matched: 'family' });
    expect(resolveModelRates('claude-code', 'haiku')).toMatchObject({ rateModel: 'claude-haiku-4-5', matched: 'family' });
  });

  // #4163: the opus tier is one shared rate pair, and the `/opus/i` family rule
  // derives its pointer from the model list instead of naming an id by hand.
  // These three pin the properties that made the hand-maintained pointer safe,
  // so a future opus bump is a one-line prepend with no other edit anywhere.
  describe('opus tier', () => {
    const LISTED_OPUS_IDS = [
      'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
    ];

    it('bills every listed opus generation at the same tier rates', () => {
      for (const id of LISTED_OPUS_IDS) {
        expect(resolveModelRates('claude-code', id)).toMatchObject({
          rateModel: id, inputPer1M: 5, outputPer1M: 25, matched: 'exact',
        });
      }
    });

    // The point of the dedup: an opus id the table has never heard of still
    // prices at $5/$25 without anyone re-pointing a family rule at it.
    it('prices an unlisted opus id at tier rates without a pointer bump', () => {
      for (const id of [
        'opus', 'claude-opus-9', 'claude-opus-6-2', 'global.anthropic.claude-opus-7-20270101-v1:0',
      ]) {
        expect(resolveModelRates('claude-code', id)).toMatchObject({
          inputPer1M: 5, outputPer1M: 25, matched: 'family',
        });
      }
    });

    // The family rule reports a LABEL, and downstream code leans on it: the UI
    // prints "Priced as <rateModel>", and usageReconciler compares two ids'
    // rateModel to decide whether they are the same family. So the pointer must
    // stay a non-null, exactly-resolvable key whose rates agree with the tier —
    // a null or synthetic label would silently break both.
    it('reports a family label that is itself an exact table id at the same rates', () => {
      const viaFamily = resolveModelRates('claude-code', 'opus');
      // Shape-matched rather than hardcoded to the current head id, so the next
      // opus bump doesn't have to edit this suite — that per-bump edit is what
      // the refactor removed. The exact-resolution check below is what actually
      // pins the pointer to a real table key.
      expect(viaFamily.rateModel).toMatch(/^claude-opus-\d/);
      expect(resolveModelRates('claude-code', viaFamily.rateModel)).toMatchObject({
        rateModel: viaFamily.rateModel,
        inputPer1M: viaFamily.inputPer1M,
        outputPer1M: viaFamily.outputPer1M,
        matched: 'exact',
      });
      // …and every opus id agrees on that label, which is what lets the
      // reconciler treat `opus` and `claude-opus-N` as one model.
      expect(resolveModelRates('claude-code', 'claude-opus-9').rateModel).toBe(viaFamily.rateModel);
    });
  });

  it('resolves fable/mythos to the Claude 5 flagship rates', () => {
    expect(resolveModelRates('claude-code', 'claude-fable-5')).toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(resolveModelRates('claude-code', 'fable')).toMatchObject({ rateModel: 'claude-fable-5', matched: 'family' });
  });

  it('resolves Bedrock-prefixed ids through family rules', () => {
    const r = resolveModelRates('claude-code-bedrock', 'global.anthropic.claude-opus-4-8');
    expect(r).toMatchObject({ rateModel: 'claude-opus-4-8', matched: 'family' });
    const r5 = resolveModelRates('claude-code-bedrock', 'global.anthropic.claude-opus-5');
    expect(r5).toMatchObject({ rateModel: 'claude-opus-5', matched: 'family' });
  });

  it('resolves configured-default sentinels to their provider family', () => {
    expect(resolveModelRates('codex', 'codex-configured-default')).toMatchObject({ rateModel: 'gpt-5.3-codex', matched: 'family' });
    expect(resolveModelRates('grok', 'grok-configured-default')).toMatchObject({ rateModel: 'grok-4.5', matched: 'family' });
    expect(resolveModelRates('antigravity-cli', 'antigravity-configured-default')).toMatchObject({ rateModel: 'gemini-3.1-pro-preview', matched: 'family' });
  });

  it('resolves suffixed gpt-5.6 ids to their base rates', () => {
    expect(resolveModelRates('codex', 'gpt-5.6-terra-2026-06-01')).toMatchObject({ rateModel: 'gpt-5.6-terra', matched: 'family' });
  });

  it('prices Cerebras gpt-oss-120b at open-weights rates, not OpenAI GPT rates', () => {
    expect(resolveModelRates('cerebras', 'gpt-oss-120b')).toMatchObject({
      rateModel: 'gpt-oss-120b (cerebras)', inputPer1M: 0.35, outputPer1M: 0.75,
    });
  });

  it('keeps other gpt-oss sizes on open-weights rates rather than the proprietary /gpt/ rule', () => {
    expect(resolveModelRates('cerebras', 'gpt-oss-20b')).toMatchObject({ rateModel: 'gpt-oss-120b (cerebras)', matched: 'family' });
  });

  // gpt-oss is open-weights: the id does not identify the host, and rates differ
  // per host — so no bare gpt-oss id may report `exact` (that would strip the
  // UI's `~` approximate marker and claim a published rate we don't have).
  it('never reports an exact match for an open-weights gpt-oss id on any host', () => {
    for (const providerId of ['cerebras', 'groq', 'openrouter', 'some-custom-host']) {
      expect(resolveModelRates(providerId, 'gpt-oss-120b').matched).not.toBe('exact');
    }
  });

  it('still resolves proprietary OpenAI ids through the gpt family rule', () => {
    expect(resolveModelRates('codex', 'gpt-4.1')).toMatchObject({ rateModel: 'gpt-5.4', matched: 'family' });
  });

  it('estimates an unrecognized Cerebras model at the Cerebras flagship rate', () => {
    expect(resolveModelRates('cerebras', 'zai-glm-4.7')).toMatchObject({ rateModel: 'gpt-oss-120b (cerebras)', matched: 'providerDefault' });
  });

  it('falls back to a provider default when the model is unknown', () => {
    const r = resolveModelRates('claude-code', 'my-custom-alias');
    expect(r).toMatchObject({ rateModel: 'claude-sonnet-4-5', matched: 'providerDefault' });
  });

  it('falls back to the generic blended rate when nothing matches', () => {
    const r = resolveModelRates('mystery-provider', 'mystery-model');
    expect(r).toMatchObject({ rateModel: null, inputPer1M: 3, outputPer1M: 15, matched: 'fallback' });
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(resolveModelRates(null, null).matched).toBe('fallback');
    expect(resolveModelRates(undefined, undefined).matched).toBe('fallback');
  });

  it('exposes the verification date', () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isFreeProvider', () => {
  it('classifies ollama and lmstudio ids as free (object and string forms)', () => {
    expect(isFreeProvider('ollama')).toBe(true);
    expect(isFreeProvider('lmstudio')).toBe(true);
    expect(isFreeProvider({ id: 'ollama', type: 'api' })).toBe(true);
  });

  it('classifies ollamaBacked CLI wrappers as free', () => {
    expect(isFreeProvider({ id: 'claude-ollama', ollamaBacked: true, command: 'claude' })).toBe(true);
  });

  it('classifies localhost API endpoints as free', () => {
    expect(isFreeProvider({ id: 'my-local', type: 'api', endpoint: 'http://localhost:1234/v1' })).toBe(true);
    expect(isFreeProvider({ id: 'my-local', type: 'api', endpoint: 'http://127.0.0.1:11434/v1' })).toBe(true);
  });

  it('does not classify paid providers as free', () => {
    expect(isFreeProvider({ id: 'claude-code', type: 'cli', command: 'claude' })).toBe(false);
    expect(isFreeProvider({ id: 'grok', type: 'api', endpoint: 'https://api.x.ai/v1' })).toBe(false);
    expect(isFreeProvider('codex')).toBe(false);
    expect(isFreeProvider(null)).toBe(false);
  });
});

describe('estimateCostUsd', () => {
  it('computes input + output cost per 1M tokens', () => {
    const rates = { inputPer1M: 3, outputPer1M: 15 };
    expect(estimateCostUsd(1_000_000, 1_000_000, rates)).toBeCloseTo(18);
    expect(estimateCostUsd(500_000, 0, rates)).toBeCloseTo(1.5);
  });

  it('treats missing counts and rates as zero', () => {
    expect(estimateCostUsd(null, undefined, { inputPer1M: 3, outputPer1M: 15 })).toBe(0);
    expect(estimateCostUsd(1000, 1000, null)).toBe(0);
  });

  it('prices cache read and cache write at their own per-1M rates', () => {
    const rates = { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 };
    const cost = estimateCostUsd(0, 0, rates, { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.5 + 6.25);
  });

  it('omits cache cost entirely when the 4th argument is absent (back-compat)', () => {
    const rates = resolveModelRates('claude-code', 'claude-opus-5');
    expect(estimateCostUsd(1_000_000, 0, rates)).toBeCloseTo(5);
  });

  it('bills a cache read at 10% of the input rate for an Anthropic model', () => {
    const rates = resolveModelRates('claude-code', 'claude-opus-5');
    const inputCost = estimateCostUsd(1_000_000, 0, rates);
    const cacheReadCost = estimateCostUsd(0, 0, rates, { cacheReadTokens: 1_000_000 });
    expect(cacheReadCost).toBeCloseTo(inputCost * 0.1);
    expect(cacheReadCost).toBeCloseTo(0.5); // $5/MTok input → $0.50/MTok cache hit
  });

  it('bills a 5-minute cache write at 1.25x the input rate', () => {
    const rates = resolveModelRates('claude-code', 'claude-opus-5');
    expect(estimateCostUsd(0, 0, rates, { cacheWriteTokens: 1_000_000 })).toBeCloseTo(6.25);
  });

  // The #3124 regression in one assertion: charging cache reads at the standard
  // input rate overstates them 10x, and not counting them at all understates the
  // whole run by ~90% of its real input volume.
  it('prices a cache-heavy agentic run far below the same volume as fresh input', () => {
    const rates = resolveModelRates('claude-code', 'claude-opus-5');
    const asCacheReads = estimateCostUsd(0, 0, rates, { cacheReadTokens: 10_000_000 });
    const asFreshInput = estimateCostUsd(10_000_000, 0, rates);
    expect(asCacheReads).toBeCloseTo(asFreshInput * 0.1);
    // …but is emphatically NOT free, which is what omitting the tier implied.
    expect(asCacheReads).toBeGreaterThan(0);
  });
});

describe('cache-tier rates on resolveModelRates', () => {
  it('derives both cache tiers from the input rate on every match tier', () => {
    for (const [providerId, model] of [
      ['claude-code', 'claude-opus-5'],        // exact
      ['claude-code', 'opus'],                 // family
      ['claude-code', 'no-such-model'],        // providerDefault
      ['who-knows', 'no-such-model']           // fallback
    ]) {
      const rates = resolveModelRates(providerId, model);
      expect(rates.cacheReadPer1M).toBeCloseTo(rates.inputPer1M * 0.1);
      expect(rates.cacheWritePer1M).toBeCloseTo(rates.inputPer1M * 1.25);
    }
  });

  it('uses xAI\'s higher published cached-input ratio for grok', () => {
    const rates = resolveModelRates('grok', 'grok-4.5');
    expect(rates.inputPer1M).toBe(2);
    expect(rates.cacheReadPer1M).toBeCloseTo(0.3); // 0.15x per docs.x.ai
  });

  it('keeps the OpenAI/Codex 10% cached-input ratio', () => {
    const rates = resolveModelRates('codex', 'gpt-5.3-codex');
    expect(rates.cacheReadPer1M).toBeCloseTo(rates.inputPer1M * 0.1);
  });
});

describe('isFreeModelId', () => {
  it('treats Ollama/LM Studio family:tag ids as local (free)', () => {
    for (const id of ['qwen3.6:35b', 'llama3.1:8b-instruct-q8_0', 'deepseek-r1:7b', 'codestral:latest', 'mistral-small3.2:24b']) {
      expect(isFreeModelId(id)).toBe(true);
    }
  });

  // A tagged id that still resolves to a KNOWN hosted family is not free — the
  // `gpt-oss` rule prices it at its Cerebras host rate, so treating the Ollama
  // tag as authoritative would zero out a real bill.
  it('defers to a known hosted family over the local-tag shape', () => {
    expect(isFreeModelId('gpt-oss:120b')).toBe(false);
  });

  // Regression: Bedrock model ids carry a `:0` version suffix, so a bare
  // "contains a colon" test priced real paid Bedrock usage at $0.
  it('does NOT treat a Bedrock versioned id as local, despite the colon', () => {
    for (const id of [
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    ]) {
      expect(isFreeModelId(id)).toBe(false);
    }
  });

  // An `org/repo` id is NOT self-evidently local: paid hosted catalogs use the
  // same shape (`cohere/command-r`, OpenRouter's `provider/model`), and calling
  // an unknown one free would under-bill real usage. Locality for that shape has
  // to come from the provider (isFreeProvider), not the model syntax.
  it('does NOT infer local from a bare org/repo shape', () => {
    for (const id of ['unsloth/Qwen3-30B', 'cohere/command-r', 'meta-llama/Llama-3-70B', 'mistralai/Mistral-Large']) {
      expect(isFreeModelId(id)).toBe(false);
    }
  });

  it('does NOT treat hosted model ids as local', () => {
    for (const id of [
      'claude-opus-5', 'claude-fable-5', 'gpt-5.3-codex', 'grok-4.5',
      'gemini-3.1-pro-preview', 'global.anthropic.claude-opus-5', 'opus', 'sonnet'
    ]) {
      expect(isFreeModelId(id)).toBe(false);
    }
  });

  it('is false for empty/nullish input', () => {
    expect(isFreeModelId(null)).toBe(false);
    expect(isFreeModelId('')).toBe(false);
    expect(isFreeModelId(undefined)).toBe(false);
  });

  // Regression: a Claude-Code CLI pointed at an Ollama backend records the LOCAL
  // model id in its transcript. Billing it through the `claude` provider default
  // invented ~$166 of cost on a real install.
  it('keeps a local model free even when it arrives via a claude provider', () => {
    expect(isFreeModelId('qwen3.6:35b')).toBe(true);
    // The provider-level check can't catch this on its own — hence the model check.
    expect(isFreeProvider('claude-code')).toBe(false);
  });
});
