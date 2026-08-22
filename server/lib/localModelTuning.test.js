import { describe, it, expect } from 'vitest';
import {
  TUNING_SPECS,
  compareTunings,
  describeTuning,
  launchArgs,
  launchConfig,
  launchEnv,
  launchTuning,
  normalizeTuning,
  requestBody,
  tuningGridFor,
  tuningSignature,
  tuningSpecsFor,
} from './localModelTuning.js';

describe('TUNING_SPECS', () => {
  // The whole point of the catalog is learning which flags to pass a model, so a
  // knob PortOS cannot send teaches nothing. Every knob must name EXACTLY ONE
  // transport — none means it renders in the form, changes nothing, and the
  // reading is filed under a configuration that never existed; two means the
  // derived `applies` picks a winner nobody declared.
  it('gives every knob exactly one transport that reaches the daemon', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        const transports = [spec.wire, spec.env, spec.cli, spec.config].filter(Boolean);
        expect(transports, `${runtime}/${spec.id}`).toHaveLength(1);
      }
    }
  });

  // Derived, not declared — so a spec literal cannot disagree with itself.
  it('derives applies and the user-facing note from that transport', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        expect(spec.applies, `${runtime}/${spec.id}`).toBe(spec.wire ? 'request' : 'launch');
        expect(spec.note, `${runtime}/${spec.id}`).toBeTruthy();
      }
    }
  });

  it('names the flag or variable the knob becomes, not just that it is applied', () => {
    const byId = (runtime, id) => tuningSpecsFor(runtime).find((s) => s.id === id);
    expect(byId('ollama', 'flashAttention').note).toContain('OLLAMA_FLASH_ATTENTION');
    expect(byId('lmstudio', 'contextLength').note).toContain('lms load --context-length');
    expect(byId('llama', 'ubatchSize').note).toContain('launch line');
    expect(byId('mtplx', 'depth').note).toContain('mtplx serve');
  });

  // LM Studio and MTPLX both ride the `cli` transport but re-run different
  // binaries. A note derived from the transport alone would tell an MTPLX user
  // PortOS runs `lms load`, which is a command that never executes here.
  it('names the right binary when two runtimes share the cli transport', () => {
    const noteFor = (runtime, id) => tuningSpecsFor(runtime).find((s) => s.id === id).note;
    expect(noteFor('mtplx', 'kvQuant')).toContain('mtplx serve');
    expect(noteFor('mtplx', 'kvQuant')).not.toContain('lms load');
    expect(noteFor('lmstudio', 'gpuOffload')).not.toContain('mtplx');
  });

  // Guard against a transport that is declared but renders nothing — the failure
  // a hand-maintained renderer switch would reintroduce.
  it('renders every knob through the renderer its transport names', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        const sample = { [spec.id]: spec.type === 'boolean' ? true : spec.type === 'enum' ? spec.options[0] : 1 };
        const rendered = Object.keys(launchEnv(runtime, sample)).length
          + launchArgs(runtime, sample).length
          + Object.keys(launchConfig(runtime, sample)).length
          + Object.keys(requestBody(runtime, sample)).length;
        expect(rendered, `${runtime}/${spec.id}`).toBeGreaterThan(0);
      }
    }
  });

  // PortOS does not start vLLM at all — it is a container from the shipped
  // compose stack, so there is no launch line to put a flag on.
  it('offers no knob for a runtime PortOS has no launch path into', () => {
    expect(tuningSpecsFor('vllm')).toEqual([]);
  });

  // `mtplx serve` exits before it binds on an unrecognized flag, which the LLMs
  // page reports as "the server would not start". These spellings were read off
  // upstream's own argument parser and are checked here so a future edit cannot
  // quietly reword one into a flag MTPLX has never accepted.
  it('renders MTPLX knobs as the flags mtplx serve actually accepts', () => {
    expect(launchArgs('mtplx', {
      contextWindow: 32768,
      depth: 4,
      generationMode: 'mtp',
      kvQuant: 'q8',
      batchingPreset: 'solo',
      profile: 'turbo',
    })).toEqual([
      '--context-window', '32768',
      '--depth', '4',
      '--generation-mode', 'mtp',
      '--kv-quant', 'q8',
      '--batching-preset', 'solo',
      '--profile', 'turbo',
    ]);
  });

  // argparse rejects an unlisted choice exactly as it rejects an unknown flag,
  // so an enum option is as load-bearing as the flag name itself.
  it('offers MTPLX only enum values its parser lists', () => {
    const options = (id) => tuningSpecsFor('mtplx').find((s) => s.id === id).options;
    expect(options('kvQuant')).toEqual(['off', 'q8', 'q4']);
    expect(options('generationMode')).toEqual(['mtp', 'ar']);
    expect(options('batchingPreset')).toEqual(['solo', 'latency', 'agent', 'throughput']);
    // A subset of MTPLX's PROFILE_CHOICES: the diagnostic profiles ('exact',
    // 'max-diagnostic') are valid but are not what a throughput sweep is asking.
    expect(options('profile')).toEqual(['sustained', 'turbo', 'performance-cold', 'stable']);
  });

  it('returns an empty list for an unknown runtime rather than throwing', () => {
    expect(tuningSpecsFor('not-a-runtime')).toEqual([]);
  });
});

describe('normalizeTuning', () => {
  it('drops keys the runtime does not declare', () => {
    expect(normalizeTuning('llama', { ubatchSize: 512, rmRf: '/' })).toEqual({ ubatchSize: 512 });
  });

  it('clamps a number to its declared range', () => {
    expect(normalizeTuning('llama', { threads: 9999 })).toEqual({ threads: 256 });
    expect(normalizeTuning('llama', { threads: 0 })).toEqual({ threads: 1 });
  });

  it('rounds an integer knob rather than truncating — a launch line takes whole numbers', () => {
    expect(normalizeTuning('llama', { ubatchSize: 511.6 })).toEqual({ ubatchSize: 512 });
  });

  it('keeps a fractional knob fractional when the spec declares a step', () => {
    expect(normalizeTuning('lmstudio', { gpuOffload: 0.85 })).toEqual({ gpuOffload: 0.85 });
  });

  it('coerces the string booleans a form posts', () => {
    expect(normalizeTuning('llama', { flashAttn: 'true' })).toEqual({ flashAttn: true });
    expect(normalizeTuning('llama', { flashAttn: 'false' })).toEqual({ flashAttn: false });
  });

  it('rejects an enum value outside the declared options', () => {
    expect(normalizeTuning('llama', { cacheTypeK: 'q2_k' })).toEqual({});
    expect(normalizeTuning('llama', { cacheTypeK: 'q8_0' })).toEqual({ cacheTypeK: 'q8_0' });
  });

  // ABSENT is not zero. An empty field must leave the daemon on its own default
  // rather than pinning a value the user never chose.
  it.each([undefined, null, '', {}])('treats %p as "no tuning", not as zeroes', (input) => {
    expect(normalizeTuning('llama', input)).toEqual({});
  });

  it('drops a non-numeric value instead of recording NaN', () => {
    expect(normalizeTuning('llama', { threads: 'lots' })).toEqual({});
  });
});

describe('tuningSignature', () => {
  it('is empty for backend defaults, so a pre-tuning store key is unchanged', () => {
    expect(tuningSignature({})).toBe('');
    expect(tuningSignature(null)).toBe('');
  });

  it('is stable regardless of key order', () => {
    expect(tuningSignature({ ubatchSize: 512, threads: 8 }))
      .toBe(tuningSignature({ threads: 8, ubatchSize: 512 }));
  });

  it('separates two different tunings', () => {
    expect(tuningSignature({ ubatchSize: 512 })).not.toBe(tuningSignature({ ubatchSize: 256 }));
  });
});

describe('describeTuning', () => {
  it('renders labels in spec order with human units', () => {
    expect(describeTuning('llama', { flashAttn: true, ctxSize: 32768 }))
      .toBe('Context size 32k · Flash attention on');
  });

  it('is null for backend defaults so the caller can say so in its own words', () => {
    expect(describeTuning('llama', {})).toBeNull();
  });

  it('renders a false boolean as off, not as absent', () => {
    expect(describeTuning('llama', { flashAttn: false })).toBe('Flash attention off');
  });

  it('ignores a key the runtime does not declare rather than inventing a label', () => {
    expect(describeTuning('llama', { somethingElse: 4 })).toBeNull();
  });
});

describe('launchTuning / launchConfig / launchEnv / launchArgs / requestBody', () => {
  it('keeps only the knobs that reach the llama.cpp command line', () => {
    expect(launchTuning('llama', { ubatchSize: 512, cacheTypeK: 'q8_0' }))
      .toEqual({ ubatchSize: 512, cacheTypeK: 'q8_0' });
  });

  it('renders llama.cpp knobs as the config object its manager relaunches with', () => {
    expect(launchConfig('llama', { ubatchSize: 512, cacheTypeK: 'q8_0' }))
      .toEqual({ ubatchSize: 512, cacheTypeK: 'q8_0' });
  });

  it('carries llama.cpp --parallel so a TUI-agent slot count can be measured', () => {
    expect(launchConfig('llama', { parallel: 1 })).toEqual({ parallel: 1 });
    expect(normalizeTuning('llama', { parallel: 0 })).toEqual({ parallel: 1 });
    expect(normalizeTuning('llama', { parallel: 99 })).toEqual({ parallel: 16 });
  });

  // A key no spec declares must never reach a launch line, whichever renderer
  // it is handed to.
  it('drops an undeclared key from every launch renderer', () => {
    expect(launchConfig('llama', { rmRf: '/' })).toEqual({});
    expect(launchEnv('ollama', { rmRf: '/' })).toEqual({});
    expect(launchArgs('lmstudio', { rmRf: '/' })).toEqual([]);
  });

  it('renders Ollama knobs as the daemon environment they only reach it through', () => {
    expect(launchEnv('ollama', { numCtx: 8192, flashAttention: true, kvCacheType: 'q8_0' })).toEqual({
      OLLAMA_CONTEXT_LENGTH: '8192',
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
    });
  });

  // Ollama parses 0/1, not JS `false` — and an explicitly-off toggle has to
  // survive as an override of a daemon default that may be on.
  it('renders a false toggle as 0 rather than dropping it', () => {
    expect(launchEnv('ollama', { flashAttention: false })).toEqual({ OLLAMA_FLASH_ATTENTION: '0' });
  });

  it('renders LM Studio knobs as the lms load flags that carry them', () => {
    expect(launchArgs('lmstudio', { contextLength: 8192, gpuOffload: 0.5 }))
      .toEqual(['--context-length', '8192', '--gpu', '0.5']);
  });

  it('renders lms flags in catalog order, whatever order the knobs were set in', () => {
    expect(launchArgs('lmstudio', { parallel: 2, contextLength: 8192 }))
      .toEqual(['--context-length', '8192', '--parallel', '2']);
  });

  it('renders nothing for a runtime whose knobs travel by another transport', () => {
    expect(launchArgs('ollama', { numCtx: 8192 })).toEqual([]);
    expect(launchEnv('lmstudio', { contextLength: 8192 })).toEqual({});
  });

  it('sends no request body for a runtime whose knobs are all launch-time', () => {
    expect(requestBody('ollama', { numCtx: 8192 })).toEqual({});
    expect(requestBody('lmstudio', { contextLength: 8192 })).toEqual({});
  });
});

describe('compareTunings', () => {
  const measured = (tuning, charsPerSecond, extra = {}) => ({
    backend: 'llama',
    modelId: 'example-7b',
    tuning,
    performance: { meanCharsPerSecond: charsPerSecond, maxWorkingContextTokens: 16384 },
    assessedAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  });

  it('ranks a model\'s tunings and reports each against the winner', () => {
    const [row] = compareTunings([
      measured({ ubatchSize: 256 }, 90),
      measured({ ubatchSize: 512 }, 120),
    ]);
    expect(row.modelId).toBe('example-7b');
    expect(row.best.charsPerSecond).toBe(120);
    expect(row.best.label).toBe('Micro-batch size 512');
    expect(row.variants.map((v) => v.deltaPercent)).toEqual([100, 75]);
  });

  it('ranks by exact tokens per second when every variant reports tokenizer usage', () => {
    const [row] = compareTunings([
      measured({ ubatchSize: 256 }, 100, {
        performance: { meanCharsPerSecond: 100, meanTokensPerSecond: 20, tokensEstimated: false, maxWorkingContextTokens: 16384 },
      }),
      measured({ ubatchSize: 512 }, 90, {
        performance: { meanCharsPerSecond: 90, meanTokensPerSecond: 30, tokensEstimated: false, maxWorkingContextTokens: 16384 },
      }),
    ]);
    expect(row.metric).toBe('tokensPerSecond');
    expect(row.metricLabel).toBe('tokens/s');
    expect(row.best.rate).toBe(30);
    expect(row.best.tokensPerSecond).toBe(30);
    expect(row.best.charsPerSecond).toBe(90);
    expect(row.variants.map((variant) => variant.rate)).toEqual([30, 20]);
    expect(row.variants.map((variant) => variant.deltaPercent)).toEqual([100, 66.7]);
  });

  it('labels the untuned variant as backend defaults rather than an empty string', () => {
    const [row] = compareTunings([measured({}, 120), measured({ ubatchSize: 512 }, 90)]);
    expect(row.best.label).toBe('Backend defaults');
  });

  // The record is the authority on the configuration it was measured under. A
  // knob that has since left the catalog would otherwise re-derive to "Backend
  // defaults", silently changing what a stored reading claims to be.
  it('shows the label the reading was measured under, not one re-derived today', () => {
    const [row] = compareTunings([
      measured({ someRetiredKnob: 8192 }, 120, { tuningLabel: 'Max KV size 8k' }),
      measured({ ubatchSize: 512 }, 90),
    ]);
    expect(row.best.label).toBe('Max KV size 8k');
  });

  // One reading is not a comparison. Presenting it as "the best tuning" would
  // dress a single measurement up as a conclusion.
  it('omits a model measured under only one tuning', () => {
    expect(compareTunings([measured({ ubatchSize: 512 }, 120)])).toEqual([]);
  });

  it('omits a variant that never produced throughput instead of scoring it zero', () => {
    expect(compareTunings([
      measured({ ubatchSize: 512 }, 120),
      measured({ ubatchSize: 256 }, null),
    ])).toEqual([]);
  });

  it('never mixes two models into one comparison', () => {
    const rows = compareTunings([
      measured({ ubatchSize: 512 }, 120),
      measured({ ubatchSize: 512 }, 40, { modelId: 'other-70b' }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe('tuningGridFor', () => {
  // The baseline is the reading every variant's `deltaPercent` is measured
  // against — a grid without it compares variants to each other and answers a
  // different question than the one the table claims to answer.
  it('leads with backend defaults, keyed so it shares an untuned record', () => {
    const [baseline] = tuningGridFor('llama');
    expect(baseline).toEqual({ key: '', label: null, tuning: {} });
  });

  it('varies exactly one knob per variant, so deltaPercent attributes the change', () => {
    for (const variant of tuningGridFor('llama').slice(1)) {
      expect(Object.keys(variant.tuning)).toHaveLength(1);
    }
  });

  // Ollama honours OLLAMA_KV_CACHE_TYPE only with flash attention on, so the
  // kv variant carries its prerequisite. Without it the run would re-measure the
  // baseline under a label claiming a quantized cache — a wrong answer.
  it('carries a knob\'s declared prerequisite into the variant that needs it', () => {
    const kv = tuningGridFor('ollama').find((v) => v.tuning.kvCacheType);
    expect(kv.tuning).toEqual({ kvCacheType: 'q8_0', flashAttention: true });
  });

  it('labels every variant so a comparison row says which knob it describes', () => {
    for (const variant of tuningGridFor('llama').slice(1)) {
      expect(variant.label).toBeTruthy();
      expect(variant.key).toBe(tuningSignature(variant.tuning));
    }
  });

  it('never repeats a knob set — one measurement per configuration', () => {
    const keys = tuningGridFor('llama').map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The returned length IS the run count a consent gate names, so the cap has to
  // bound the whole grid, baseline included.
  it('truncates to maxVariants, counting the baseline', () => {
    expect(tuningGridFor('llama', { maxVariants: 3 })).toHaveLength(3);
    expect(tuningGridFor('llama', { maxVariants: 1 })).toHaveLength(1);
  });

  it('falls back to the default for a nonsense cap rather than emptying the grid', () => {
    const full = tuningGridFor('llama');
    expect(tuningGridFor('llama', { maxVariants: 0 })).toEqual(full);
    expect(tuningGridFor('llama', { maxVariants: Number.NaN })).toEqual(full);
  });

  // A runtime PortOS cannot pass flags to has nothing to sweep. One entry is the
  // signal for that — the caller must read it as "no comparison available",
  // never as a one-variant sweep worth minutes of GPU.
  it('returns the baseline alone for a runtime with no sweepable knob', () => {
    expect(tuningGridFor('mtplx')).toHaveLength(1);
    expect(tuningGridFor('vllm')).toHaveLength(1);
    expect(tuningGridFor('not-a-runtime')).toHaveLength(1);
  });

  // The grid is built from the catalog, so a candidate the catalog would reject
  // must not survive into a launch line.
  it('produces only knob sets the catalog would accept back', () => {
    for (const runtime of ['llama', 'ollama', 'lmstudio']) {
      for (const variant of tuningGridFor(runtime)) {
        expect(normalizeTuning(runtime, variant.tuning)).toEqual(variant.tuning);
      }
    }
  });

  // Every variant has to reach the daemon through some transport, or the sweep
  // measures the baseline several times under different names.
  it('renders every variant through a transport that reaches the daemon', () => {
    const rendered = (runtime, tuning) => ({
      ...launchConfig(runtime, tuning), ...launchEnv(runtime, tuning),
      ...launchArgs(runtime, tuning), ...requestBody(runtime, tuning),
    });
    for (const runtime of ['llama', 'ollama', 'lmstudio']) {
      for (const variant of tuningGridFor(runtime).slice(1)) {
        expect(Object.keys(rendered(runtime, variant.tuning)).length).toBeGreaterThan(0);
      }
    }
  });

  // The grid feeds `compareTunings`, whose ranking is by throughput — a variant
  // that changes what is being measured (a different context window) would make
  // the winner incomparable rather than faster.
  it('never sweeps a knob that changes what is being measured', () => {
    const changesTheMeasurement = ['ctxSize', 'numCtx', 'contextLength'];
    for (const runtime of ['llama', 'ollama', 'lmstudio']) {
      for (const variant of tuningGridFor(runtime)) {
        for (const knob of changesTheMeasurement) expect(variant.tuning[knob]).toBeUndefined();
      }
    }
  });
});
