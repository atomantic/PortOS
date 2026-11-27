/**
 * Launch/runtime tuning knobs for the local model runtimes PortOS can measure.
 *
 * A throughput number is meaningless without the launch configuration behind it,
 * so this pure module holds the per-runtime knob catalog, the normalizer that
 * turns a request body into a knob set, and the stable signature that lets
 * several tunings of ONE model coexist in the store and be ranked.
 *
 * ## Only knobs PortOS can actually SET (read before adding a knob)
 *
 * A knob PortOS cannot apply files a reading under a configuration that never
 * existed. The catalog holds ONLY knobs with a code path that reaches the daemon,
 * and a knob is DEFINED by exactly one transport:
 *
 *   - `config: true`  - a `llamaServerManager` config key put on the llama-server
 *                       command line on relaunch. -> `launchConfig`
 *   - `env: 'NAME'`   - an environment variable handed to `ollama serve` on
 *                       restart. -> `launchEnv`
 *   - `cli: '--flag'` - a launch flag on a re-run daemon: `lms load` (LM Studio)
 *                       or `mtplx serve` (MTPLX). -> `launchArgs`
 *   - `wire: 'field'` - a field merged into each measurement request body.
 *                       -> `requestBody`
 *
 * `applies` ('launch' vs 'request') and the user-facing `note` are DERIVED from
 * the transport by `decorate`, so they cannot disagree; a knob with no transport
 * fails `localModelTuning.test.js`. Do NOT add a knob just to document how a
 * daemon was started. A reading taken under an unsettable knob still describes
 * itself via the store's per-record `tuningLabel` (see `compareTunings`).
 *
 * The `wire` tier is EMPTY on purpose: llama.cpp, Ollama and LM Studio pick these
 * settings at model load, and Ollama's OpenAI-compatible endpoint drops unknown
 * body fields. It is kept for a runtime that honours per-request knobs (vLLM).
 *
 * ## Sweepable knobs (`sweep` / `sweepWith`)
 *
 * `sweep: [value, ...]` names candidates a machine-driven sweep should TRY, and
 * `sweepWith: { otherKnob: value }` names co-knobs required for the candidate to
 * take effect. `tuningGridFor` builds the grid; a knob with no `sweep` is never varied.
 *
 * vLLM declares no knobs: it is a container from the shipped compose stack, so
 * there is no launch line to put a flag on.
 *
 * ## Verifying an `mtplx serve` flag before declaring it
 *
 * `mtplx serve` exits before binding on an unrecognized flag (the LLMs page
 * reports "the server would not start"), and argparse rejects an unlisted
 * `choices` value the same way. So each knob was read off MTPLX's own argument
 * parser, across a spread of releases since installs upgrade independently:
 * `mtplx serve --help` where MTPLX is installed, otherwise upstream
 * `mtplx/cli.py` (github.com/youssofal/MTPLX) and `mtplx/profiles.py`
 * (`PROFILE_CHOICES`). The six below were confirmed at v1.0.0, v2.0.0, v2.5.4
 * and v2.9.0, with one exception noted on `profile`. Prefer a flag with that history.
 *
 * ## The sentinel contract
 *
 * An ABSENT knob means "whatever the daemon defaults to", never coerced to 0,
 * `false` or a guess. `normalizeTuning` therefore drops empty input, and the
 * signature of an untuned run is `''` (byte-identical to the pre-tuning store key).
 *
 * `''` is a CLAIM that the reading was taken at backend defaults, so an EMPTY
 * launch set is itself a request: `localModelAssessments` hands it to the
 * runtime's applier wherever it can honour it (`resetsOnEmpty`) and the daemon is
 * relaunched WITHOUT its current tuning. Skipping that would file a still-tuned
 * daemon as "Backend defaults" and corrupt `compareTunings`.
 *
 * **Adding the first `wire` knob breaks an assumption.** While that tier is
 * empty, a non-empty `tuningKey` implies a non-empty LAUNCH set, so
 * `getAssessmentReport` and the client's `tuningNoticeChip` read `tuningKey` as
 * "did this run request launch tuning?" when wording a `tuningApplied: false` row.
 * Split on `launchTuning(backend, tuning)` rather than the key at that point.
 */

/**
 * KV-cache quantization types llama.cpp accepts for `--cache-type-k/-v`: only the
 * three universally compiled in, since an unsupported type makes the server exit
 * on launch. Ollama's `OLLAMA_KV_CACHE_TYPE` takes the same spellings.
 */
export const CACHE_TYPES = Object.freeze(['f16', 'q8_0', 'q4_0']);

/**
 * The command a `cli` knob's flag lands on, per runtime; the note must name the
 * binary the user would see in `ps`.
 */
const CLI_COMMAND = {
  lmstudio: (flag) => `PortOS reloads the model with \`lms load ${flag}\`.`,
  mtplx: (flag) => `PortOS relaunches \`mtplx serve\` with \`${flag}\` on its command line.`,
};

/**
 * The user-facing sentence for a knob: what PortOS will DO with it, derived from
 * the transport so the form, catalog and applying code cannot drift. Shipped to
 * the client on the spec.
 */
const noteFor = (runtimeId, spec) => {
  if (spec.wire) return `Sent with each measurement request as \`${spec.wire}\`.`;
  if (spec.env) return `PortOS restarts the server with ${spec.env} set.`;
  // A `cli` runtime with no entry above names the flag alone rather than borrowing another runtime's command.
  if (spec.cli) {
    const describe = CLI_COMMAND[runtimeId];
    return describe ? describe(spec.cli) : `PortOS puts \`${spec.cli}\` on the server's launch line and relaunches it.`;
  }
  return "PortOS puts this on the server's launch line and relaunches it.";
};

// `applies` and `note` are computed from the transport, never hand-written.
const decorate = (runtimeId, spec) => Object.freeze({
  ...spec,
  applies: spec.wire ? 'request' : 'launch',
  note: noteFor(runtimeId, spec),
});

/**
 * Tuning knobs per runtime, in UI render order. `hint` is user-facing and says
 * what the knob trades away.
 */
const RAW_SPECS = {
  llama: [
    { id: 'ctxSize', label: 'Context size', type: 'number', config: true, min: 512, max: 1048576, unit: 'tokens', hint: 'KV cache is allocated for the whole window up front — a larger one costs memory even when prompts are short.' },
    { id: 'nGpuLayers', label: 'GPU layers', type: 'number', config: true, min: 0, max: 999, hint: 'Layers offloaded to the GPU. Fewer layers frees VRAM for a bigger context at the cost of throughput.' },
    { id: 'parallel', label: 'Parallel slots', type: 'number', config: true, min: 1, max: 16, hint: 'Request slots llama-server reserves VRAM for. It divides the context window across them — 1 is right for a TUI agent (one long session). Raising it shrinks per-request context.' },
    { id: 'batchSize', label: 'Batch size', type: 'number', config: true, min: 1, max: 8192, sweep: [4096], hint: 'Logical prompt batch (-b). Raising it speeds up prefill on long prompts and raises peak memory.' },
    { id: 'ubatchSize', label: 'Micro-batch size', type: 'number', config: true, min: 1, max: 8192, sweep: [1024], hint: 'Physical micro-batch (-ub). The single knob that most often moves long-context throughput.' },
    { id: 'threads', label: 'CPU threads', type: 'number', config: true, min: 1, max: 256, hint: 'Threads for the CPU-resident layers. More is not always faster once you pass the physical core count.' },
    { id: 'flashAttn', label: 'Flash attention', type: 'boolean', config: true, sweep: [true], hint: 'Fused attention kernel. Usually faster and lighter on memory, but not every build/GPU supports it.' },
    { id: 'cacheTypeK', label: 'KV cache type (K)', type: 'enum', config: true, options: CACHE_TYPES, sweep: ['q8_0'], hint: 'Quantizing the key cache buys context length with a little quality.' },
    // No `sweep`: llama.cpp refuses a quantized V cache without flash attention, so it would fail to launch.
    { id: 'cacheTypeV', label: 'KV cache type (V)', type: 'enum', config: true, options: CACHE_TYPES, hint: 'Quantizing the value cache buys context length with a little quality.' },
    { id: 'draftMax', label: 'Draft tokens', type: 'number', config: true, min: 0, max: 64, sweep: [3], hint: 'Speculative-decoding lookahead (`--spec-draft-n-max`). Only does anything when a drafter model is loaded.' },
  ],
  // Every Ollama knob is daemon-wide environment applied by restarting `ollama serve`; a body `num_ctx` is dropped by its OpenAI-compatible endpoint.
  ollama: [
    { id: 'numCtx', label: 'Context size', type: 'number', env: 'OLLAMA_CONTEXT_LENGTH', min: 512, max: 1048576, unit: 'tokens', hint: 'The window every model loads with. Larger costs VRAM up front, and past what fits Ollama offloads to CPU instead of failing.' },
    { id: 'flashAttention', label: 'Flash attention', type: 'boolean', env: 'OLLAMA_FLASH_ATTENTION', sweep: [true], hint: 'Fused attention kernel. Usually faster and lighter on memory, and a prerequisite for a quantized KV cache.' },
    // `sweepWith`: Ollama honours OLLAMA_KV_CACHE_TYPE ONLY with flash attention on (see grid note).
    { id: 'kvCacheType', label: 'KV cache type', type: 'enum', env: 'OLLAMA_KV_CACHE_TYPE', options: CACHE_TYPES, sweep: ['q8_0'], sweepWith: { flashAttention: true }, hint: 'Quantizing the KV cache buys context length with a little quality. Ollama honours it only with flash attention on.' },
    { id: 'numParallel', label: 'Parallel requests', type: 'number', env: 'OLLAMA_NUM_PARALLEL', min: 1, max: 16, hint: 'Request slots the daemon serves at once. Each slot claims its own share of the context window, so raising it shrinks the window per request.' },
  ],
  // LM Studio load-time settings, applied by reloading through `lms load`; toggles with no CLI flag are not offered.
  lmstudio: [
    { id: 'contextLength', label: 'Context length', type: 'number', cli: '--context-length', min: 512, max: 1048576, unit: 'tokens', hint: 'The window the model is loaded with. LM Studio refuses a load that does not fit rather than silently shrinking it.' },
    { id: 'gpuOffload', label: 'GPU offload', type: 'number', cli: '--gpu', min: 0, max: 1, step: 0.05, sweep: [1], hint: 'Fraction of layers on the GPU (0 = CPU only, 1 = full offload). Lower frees VRAM for a bigger context at the cost of throughput.' },
    { id: 'parallel', label: 'Parallel requests', type: 'number', cli: '--parallel', min: 1, max: 16, hint: 'Predictions the model runs at once. Higher total throughput, slower per prediction.' },
  ],
  // `mtplx serve` flags, applied by relaunching the PM2 daemon. Ordered context ->
  // decode -> memory -> preset. Verify upstream's parser before adding one (see top).
  mtplx: [
    { id: 'contextWindow', label: 'Context window', type: 'number', cli: '--context-window', min: 512, max: 1048576, unit: 'tokens', hint: 'Overrides the window MTPLX reads from the model config. Larger costs unified memory up front, and past what fits the server will not load.' },
    { id: 'depth', label: 'MTP depth', type: 'number', cli: '--depth', min: 1, max: 8, hint: 'Tokens the MTP sidecar drafts per verify step. Deeper wins more when the draft is accepted and costs more when it is rejected — the knob MTPLX\'s own `mtplx tune` sweeps.' },
    { id: 'generationMode', label: 'Decode mode', type: 'enum', cli: '--generation-mode', options: ['mtp', 'ar'], hint: 'Native multi-token speculative decode, or plain target-only autoregressive. The comparison that answers whether MTP is actually paying off for this model here.' },
    { id: 'kvQuant', label: 'KV cache quantization', type: 'enum', cli: '--kv-quant', options: ['off', 'q8', 'q4'], hint: 'Quantizing the paged KV cache buys context length with a little quality. q4 is the smallest at every length but re-dequantizes each decode step, so long-context decode gets slower.' },
    { id: 'batchingPreset', label: 'Batching preset', type: 'enum', cli: '--batching-preset', options: ['solo', 'latency', 'agent', 'throughput'], hint: 'How the server trades per-request latency against total throughput. `solo` is the cleanest baseline for a single-stream measurement.' },
    // `turbo` arrived in MTPLX v2.0.0; offered anyway since an older install gets
    // the refusal-and-restore path, not a dead daemon. Diagnostic profiles are
    // valid but not what a throughput sweep asks, so they are left out.
    { id: 'profile', label: 'Runtime profile', type: 'enum', cli: '--profile', options: ['sustained', 'turbo', 'performance-cold', 'stable'], hint: 'MTPLX\'s own bundle of runtime settings. `turbo` targets peak rate on the quantized flagships; `sustained` holds up over a long run. Diagnostic profiles are deliberately not offered.' },
  ],
  // PortOS does not start vLLM (a compose-stack container), so no launch line; kept empty so the runtime still enumerates.
  vllm: [],
};

export const TUNING_SPECS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_SPECS).map(([runtime, specs]) => [
    runtime,
    Object.freeze(specs.map((spec) => decorate(runtime, spec))),
  ])
));

/** Knob specs for one runtime, or `[]` for a runtime with none declared. */
export const tuningSpecsFor = (runtimeId) => TUNING_SPECS[runtimeId] || [];

const _specById = (runtimeId, id) => tuningSpecsFor(runtimeId).find((s) => s.id === id) || null;

const clamp = (value, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/** Coerce one raw value against its spec; `undefined` drops the knob rather than substituting a default the daemon never saw. */
function coerceValue(spec, raw) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (spec.type === 'enum') {
    const value = String(raw);
    return spec.options.includes(value) ? value : undefined;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const clamped = clamp(num, spec.min, spec.max);
  // Integer knobs round rather than truncate (`-ub 511.6` is not a thing).
  return spec.step ? Number(clamped.toFixed(2)) : Math.round(clamped);
}

/**
 * Reduce a raw tuning object to the knobs this runtime declares, coerced and
 * clamped. Unknown keys are dropped: they cannot be applied.
 *
 * @param {string} runtimeId
 * @param {object|null|undefined} tuning
 * @returns {object} `{}` when nothing usable was supplied — which means "daemon
 *   defaults", NOT "every knob set to zero".
 */
export function normalizeTuning(runtimeId, tuning) {
  if (!tuning || typeof tuning !== 'object') return {};
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    const value = coerceValue(spec, tuning[spec.id]);
    if (value !== undefined) out[spec.id] = value;
  }
  return out;
}

/**
 * Stable identity for a tuning set: sorted `id=value` pairs. `''` for an empty
 * set, so an untuned assessment keys as it did before tuning existed.
 */
export function tuningSignature(tuning) {
  const entries = Object.entries(tuning || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
}

const formatValue = (spec, value) => {
  if (spec.type === 'boolean') return value ? 'on' : 'off';
  if (spec.type === 'number' && spec.unit === 'tokens' && value >= 1024) return `${Math.round(value / 1024)}k`;
  return String(value);
};

/**
 * Human label for a tuning set, e.g. `Context size 32k · Micro-batch size 512`.
 * `null` when nothing was tuned (the caller renders "backend defaults"). Uses the
 * CURRENT catalog; stored readings keep the `tuningLabel` they were measured under.
 */
export function describeTuning(runtimeId, tuning) {
  const parts = tuningSpecsFor(runtimeId)
    .filter((spec) => tuning?.[spec.id] !== undefined && tuning?.[spec.id] !== null)
    .map((spec) => `${spec.label} ${formatValue(spec, tuning[spec.id])}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
/**
 * Default cap on tunings ONE sweep queues, baseline included. Each variant is a
 * full measurement (daemon restart plus bounded generations), so minutes of GPU.
 */
export const DEFAULT_TUNING_GRID_VARIANTS = 6;

/**
 * The knob combinations worth measuring for one runtime: backend defaults first,
 * then ONE variant per knob that declares a `sweep` candidate.
 *
 * One knob at a time: a full cross-product is thousands of runs, while a
 * single-knob grid answers "was that knob worth it?" (`compareTunings`'s
 * `deltaPercent`); the user stacks winners by re-sweeping. The exception is
 * `sweepWith`, naming co-knobs a runtime requires for the candidate to take
 * effect (Ollama honours `OLLAMA_KV_CACHE_TYPE` only with flash attention on),
 * since otherwise the variant would re-measure the baseline under a wrong label.
 *
 * A knob with no `sweep` is absent from the grid: `ctxSize` changes what is
 * measured, `threads`/`nGpuLayers` have no machine-independent candidate, and a
 * quantized V cache does not launch without flash attention.
 *
 * The returned length IS the run count, so a caller can name it in a consent gate
 * (AI Provider Usage Policy). `maxVariants` truncates in catalog order and is
 * in-process only; no wire path may shrink the grid, or the count would differ
 * from what consent named.
 *
 * @param {string} runtimeId
 * @param {{ maxVariants?: number }} [options]
 * @returns {Array<{ key: string, label: string|null, tuning: object }>} always at
 *   least the baseline (`key: ''`, `label: null`, "backend defaults"); a runtime
 *   with no sweepable knobs returns only that, meaning "nothing to compare here".
 */
export function tuningGridFor(runtimeId, { maxVariants = DEFAULT_TUNING_GRID_VARIANTS } = {}) {
  const cap = Number.isFinite(maxVariants) && maxVariants >= 1 ? Math.floor(maxVariants) : DEFAULT_TUNING_GRID_VARIANTS;
  // The baseline is required: without it every `deltaPercent` is relative to another variant.
  const grid = [{ key: '', label: null, tuning: {} }];
  const seen = new Set(['']);
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!Array.isArray(spec.sweep)) continue;
    for (const candidate of spec.sweep) {
      if (grid.length >= cap) return grid;
      // Through `normalizeTuning` so a candidate the catalog would clamp or reject cannot enter the grid.
      const tuning = normalizeTuning(runtimeId, { ...(spec.sweepWith || {}), [spec.id]: candidate });
      const key = tuningSignature(tuning);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      grid.push({ key, label: describeTuning(runtimeId, tuning), tuning });
    }
  }
  return grid;
}

/**
 * The subset of a tuning set applied at LAUNCH (the daemon must be (re)started).
 * The renderers below walk the CATALOG, so an undeclared knob cannot reach a
 * launch line and order matches the form.
 */
export function launchTuning(runtimeId, tuning) {
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (spec.applies !== 'launch') continue;
    const value = tuning?.[spec.id];
    if (value !== undefined && value !== null && value !== '') out[spec.id] = value;
  }
  return out;
}

/** Launch knobs rendered as a llama-server CONFIG object (the shape `startLlamaServer` takes). */
export function launchConfig(runtimeId, tuning) {
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!spec.config) continue;
    const value = tuning?.[spec.id];
    if (value !== undefined && value !== null && value !== '') out[spec.id] = value;
  }
  return out;
}

/**
 * Launch knobs rendered as the daemon's ENVIRONMENT (Ollama), e.g.
 * `{ OLLAMA_FLASH_ATTENTION: '1' }`. Booleans render as `1`/`0` so an
 * explicitly-off toggle overrides a daemon default that may be on; values are strings.
 */
export function launchEnv(runtimeId, tuning) {
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!spec.env) continue;
    const value = tuning?.[spec.id];
    if (value === undefined || value === null || value === '') continue;
    out[spec.env] = spec.type === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  return out;
}

/**
 * Launch knobs rendered as COMMAND-LINE arguments (`lms load`), flattened to the
 * `['--context-length', '8192']` shape `spawn` takes. A boolean is a bare flag
 * when on and omitted when off (a CLI has no "explicitly off" spelling).
 */
export function launchArgs(runtimeId, tuning) {
  const out = [];
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!spec.cli) continue;
    const value = tuning?.[spec.id];
    if (value === undefined || value === null || value === '') continue;
    if (spec.type === 'boolean') {
      if (value) out.push(spec.cli);
      continue;
    }
    out.push(spec.cli, String(value));
  }
  return out;
}

/**
 * The request-applied knobs under their WIRE names, ready to merge into a
 * chat-completions body. Empty for every runtime today (see the `wire` note at
 * the top); the wire name lives on the spec so a knob cannot declare itself
 * request-applied without naming the field the daemon reads.
 */
export function requestBody(runtimeId, tuning) {
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!spec.wire) continue;
    const value = tuning?.[spec.id];
    if (value !== undefined && value !== null && value !== '') out[spec.wire] = value;
  }
  return out;
}

// The label the record was MEASURED under; a knob that later leaves the catalog must not relabel an old reading.
const labelOf = (a) => a?.tuningLabel || describeTuning(a?.backend, a?.tuning) || 'Backend defaults';

const throughputOf = (a) => {
  const value = a?.performance?.meanCharsPerSecond;
  return Number.isFinite(value) ? value : null;
};

// Token rates are the better signal only when every variant has an exact
// daemon-reported count; otherwise fall back to chars/s, which every assessment can measure.
const tokenThroughputOf = (a) => {
  const value = a?.performance?.meanTokensPerSecond;
  return Number.isFinite(value) && a?.performance?.tokensEstimated !== true ? value : null;
};

/**
 * Group measured assessments by (backend, model) and report which tuning won.
 *
 * Only models with TWO OR MORE tunings that both produced throughput appear: a
 * single reading has nothing to compare against, and presenting it as a "best
 * tuning" would dress one measurement up as a conclusion.
 *
 * `deltaPercent` is each variant's throughput relative to the winner, so the
 * table answers "was that knob worth it?" rather than just listing numbers.
 *
 * @param {Array<object>} assessments records from the store
 * @returns {Array<{backend:string, modelId:string, best:object, variants:Array<object>}>}
 */
export function compareTunings(assessments) {
  const groups = new Map();
  for (const assessment of Array.isArray(assessments) ? assessments : []) {
    if (!assessment?.backend || !assessment?.modelId) continue;
    if (throughputOf(assessment) === null) continue;
    const key = `${assessment.backend}:${assessment.modelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(assessment);
  }

  const rows = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const useTokens = list.every((assessment) => tokenThroughputOf(assessment) !== null);
    const metric = useTokens ? 'tokensPerSecond' : 'charsPerSecond';
    const rateOf = useTokens ? tokenThroughputOf : throughputOf;
    const sorted = [...list].sort((a, b) => rateOf(b) - rateOf(a));
    const winner = rateOf(sorted[0]);
    rows.push({
      backend: sorted[0].backend,
      modelId: sorted[0].modelId,
      metric,
      metricLabel: useTokens ? 'tokens/s' : 'chars/s',
      best: {
        tuning: sorted[0].tuning || {},
        label: labelOf(sorted[0]),
        charsPerSecond: throughputOf(sorted[0]),
        tokensPerSecond: tokenThroughputOf(sorted[0]),
        rate: winner,
      },
      variants: sorted.map((a) => ({
        tuning: a.tuning || {},
        label: labelOf(a),
        charsPerSecond: throughputOf(a),
        tokensPerSecond: tokenThroughputOf(a),
        rate: rateOf(a),
        metric,
        tokensEstimated: a?.performance?.tokensEstimated === true,
        maxWorkingContextTokens: Number.isFinite(a.performance?.maxWorkingContextTokens)
          ? a.performance.maxWorkingContextTokens
          : null,
        assessedAt: a.assessedAt || null,
        // Relative to the winner: 100 is the best measured tuning.
        deltaPercent: winner > 0 ? Number(((rateOf(a) / winner) * 100).toFixed(1)) : null,
      })),
    });
  }
  return rows.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
