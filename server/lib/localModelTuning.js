/**
 * Launch/runtime tuning knobs for the local model runtimes PortOS can measure.
 *
 * A measured assessment answers "how did this model behave here?". That question
 * is incomplete without "…configured how?" — the same GGUF on the same machine
 * streams at wildly different rates depending on the micro-batch size, whether
 * flash attention is on, and how much of the KV cache is quantized. Recording a
 * throughput number with no record of the launch line makes two readings of the
 * same model look like noise when they are actually two different setups.
 *
 * This module is the pure half of that: the per-runtime knob catalog, the
 * normalizer that turns a request body into a knob set, and the stable signature
 * that lets several tunings of ONE model coexist in the store and be ranked
 * against each other.
 *
 * ## Only knobs PortOS can actually SET (read before adding a knob)
 *
 * The point of a tuning sweep is to learn what flags this install should pass a
 * given model. A knob PortOS cannot apply teaches nothing: the user types a
 * number, the daemon runs exactly as it did before, and the reading is filed
 * under a configuration that never existed. So the catalog holds ONLY knobs with
 * a code path that reaches the daemon, and a knob is DEFINED by the transport
 * that carries it — exactly one of:
 *
 *   - `config: true`  — a `llamaServerManager` config key PortOS puts on the
 *                       llama-server command line and relaunches. → `launchConfig`
 *   - `env: 'NAME'`   — an environment variable PortOS hands `ollama serve`
 *                       when it restarts the daemon. → `launchEnv`
 *   - `cli: '--flag'` — a launch flag PortOS puts on the command line of a
 *                       daemon it re-runs: `lms load` for LM Studio, `mtplx
 *                       serve` for MTPLX. → `launchArgs`
 *   - `wire: 'field'` — a field PortOS merges into each measurement request
 *                       body. → `requestBody`
 *
 * The transport is the ONLY thing a spec literal declares about application:
 * `applies` ('launch' vs 'request') and the user-facing `note` are DERIVED from
 * it by `decorate` below, so the two can never disagree and a new knob has one
 * field to get right. A knob declared without a transport renders through
 * nothing — which `localModelTuning.test.js` fails on. Do NOT add a knob just to
 * document how a daemon was started; that dresses an unapplied setting up as an
 * applied one. (An older revision had an `applies: 'record'` tier for exactly
 * that, covering LM Studio, MTPLX, vLLM and half of Ollama. It was removed
 * because "PortOS cannot set this" knobs are not testable and crowded out the
 * ones that are. A reading taken under one still describes itself: the store
 * persists each record's `tuningLabel` at measure time — see `compareTunings`.)
 *
 * The `wire` tier is currently EMPTY and that is deliberate, not an oversight:
 * llama.cpp, Ollama, and LM Studio all pick these settings when the model loads,
 * and Ollama's OpenAI-compatible endpoint silently drops unknown body fields. It
 * is kept because a runtime that does honour per-request knobs (vLLM) is the
 * likely next entry.
 *
 * ## Sweepable knobs (`sweep` / `sweepWith`)
 *
 * A knob may also name the values a machine-driven sweep should TRY:
 * `sweep: [value, …]` are the candidates, and `sweepWith: { otherKnob: value }`
 * names co-knobs the runtime requires for a candidate to take effect at all.
 * `tuningGridFor` builds the candidate grid from those fields — see its comment
 * for why the grid is one knob at a time and what a missing `sweep` means. A
 * knob with no `sweep` is simply never varied by a sweep.
 *
 * vLLM therefore declares no knobs: PortOS does not start it — it is a container
 * from the shipped compose stack, so there is no launch line to put a flag on.
 * Add knobs there once PortOS manages that container's lifecycle.
 *
 * ## Verifying an `mtplx serve` flag before declaring it
 *
 * This matters more here than for the other runtimes: `mtplx serve` exits before
 * it binds on a flag it does not recognize, which the LLMs page reports to the
 * user as "the server would not start". The enum SPELLINGS carry the same risk —
 * argparse rejects an unlisted `choices` value exactly as it rejects an unknown
 * flag.
 *
 * So each knob below was read off MTPLX's own argument parser rather than its
 * feature docs, at a spread of releases rather than only the newest, since other
 * installs upgrade on their own schedule. Reproduce it the same way before
 * adding one — on a machine with MTPLX, `mtplx serve --help`; otherwise read
 * upstream `mtplx/cli.py` (github.com/youssofal/MTPLX), where the `serve`
 * subparser and the `_add_batching_args` / `_add_paged_kv_quant_args` helpers it
 * calls define these flags, and `mtplx/profiles.py` defines `PROFILE_CHOICES`.
 * The six below and their options were confirmed present and unchanged at tags
 * v1.0.0, v2.0.0, v2.5.4 and v2.9.0, with one exception noted on `profile`.
 * Prefer a flag with that kind of history over one new in the current release.
 *
 * ## The sentinel contract
 *
 * An ABSENT knob means "whatever the daemon defaults to", which is not a value
 * we can name — it is never coerced to 0, `false`, or a guessed default. That is
 * why `normalizeTuning` drops empty input instead of filling it in, and why the
 * signature of an untuned run is `''` (so its store key is byte-identical to the
 * pre-tuning key, and existing records keep resolving).
 *
 * `''` is a CLAIM, not merely an absence: the record says the reading was taken
 * at backend defaults. So an EMPTY launch set is a request in its own right —
 * `localModelAssessments` hands it to the runtime's applier wherever that
 * applier can honour it (`resetsOnEmpty`), and the daemon is relaunched WITHOUT
 * the tuning it is currently carrying. Skipping that for an untuned run is what
 * filed a still-tuned daemon as "Backend defaults" and let `compareTunings` rank
 * every real tuning against a configuration that never ran (#4759, #4763).
 *
 * **Adding the first `wire` knob breaks an assumption two call sites make.**
 * While that tier is empty, a non-empty `tuningKey` implies a non-empty LAUNCH
 * set, so `getAssessmentReport` and the client's `tuningNoticeChip` both read
 * `tuningKey` as "did this run request launch tuning?" when wording a
 * `tuningApplied: false` row. A request-only tuning would have a non-empty key
 * and an empty launch set, so a failed reset on that run would be described as
 * "the requested tuning was not applied". Split those two on
 * `launchTuning(backend, tuning)` rather than on the key when that day comes.
 */

/**
 * KV-cache quantization types llama.cpp accepts for `--cache-type-k/-v`. Kept to
 * the three that are universally compiled in; an exotic type the local build
 * lacks would make the server exit on launch, which reads to the user as "this
 * model does not fit". Ollama's `OLLAMA_KV_CACHE_TYPE` takes the same spellings.
 */
const CACHE_TYPES = ['f16', 'q8_0', 'q4_0'];

/**
 * The command a `cli` knob's flag lands on, per runtime. Two runtimes now share
 * the `cli` transport but re-run different binaries, and the note has to name the
 * one the user would see in `ps` — "PortOS reloads the model with `lms load …`"
 * on an MTPLX knob would describe a command that never runs.
 */
const CLI_COMMAND = {
  lmstudio: (flag) => `PortOS reloads the model with \`lms load ${flag}\`.`,
  mtplx: (flag) => `PortOS relaunches \`mtplx serve\` with \`${flag}\` on its command line.`,
};

/**
 * The user-facing sentence for a knob: what PortOS will DO with it, naming the
 * flag or variable it becomes. Derived from the transport so the form, the
 * catalog, and the code that applies it cannot drift — and shipped to the client
 * on the spec, so the note lives with the module that owns the transport rather
 * than being re-derived in the UI.
 */
const noteFor = (runtimeId, spec) => {
  if (spec.wire) return `Sent with each measurement request as \`${spec.wire}\`.`;
  if (spec.env) return `PortOS restarts the server with ${spec.env} set.`;
  // A `cli` runtime with no entry above falls back to naming the flag alone
  // rather than borrowing another runtime's command — vague, but never wrong.
  if (spec.cli) {
    const describe = CLI_COMMAND[runtimeId];
    return describe ? describe(spec.cli) : `PortOS puts \`${spec.cli}\` on the server's launch line and relaunches it.`;
  }
  return "PortOS puts this on the server's launch line and relaunches it.";
};

// `applies` and `note` are computed, never written by hand — see the transport
// rule above. A spec with no transport gets `applies: 'launch'` and a note it
// cannot honour, which is what the catalog guard test exists to catch.
const decorate = (runtimeId, spec) => Object.freeze({
  ...spec,
  applies: spec.wire ? 'request' : 'launch',
  note: noteFor(runtimeId, spec),
});

/**
 * Tuning knobs per runtime, in the order a UI should render them.
 *
 * `hint` is user-facing: it says what the knob trades away, because the point of
 * a tuning sweep is finding the trade that suits this machine, not maximizing
 * any single number.
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
    // No `sweep` on purpose: llama.cpp refuses a quantized V cache unless flash
    // attention is on, so a V-only variant would fail to launch rather than
    // measure anything. The `flashAttn` variant above is the honest single knob.
    { id: 'cacheTypeV', label: 'KV cache type (V)', type: 'enum', config: true, options: CACHE_TYPES, hint: 'Quantizing the value cache buys context length with a little quality.' },
    { id: 'draftMax', label: 'Draft tokens', type: 'number', config: true, min: 0, max: 64, sweep: [3], hint: 'Speculative-decoding lookahead (`--spec-draft-n-max`). Only does anything when a drafter model is loaded.' },
  ],
  // Every Ollama knob is daemon-wide environment, applied by restarting
  // `ollama serve` — including the context window. A `num_ctx` in the request
  // body is NOT an alternative: Ollama's OpenAI-compatible endpoint drops
  // unknown fields, and the model still loads at the daemon default.
  ollama: [
    { id: 'numCtx', label: 'Context size', type: 'number', env: 'OLLAMA_CONTEXT_LENGTH', min: 512, max: 1048576, unit: 'tokens', hint: 'The window every model loads with. Larger costs VRAM up front, and past what fits Ollama offloads to CPU instead of failing.' },
    { id: 'flashAttention', label: 'Flash attention', type: 'boolean', env: 'OLLAMA_FLASH_ATTENTION', sweep: [true], hint: 'Fused attention kernel. Usually faster and lighter on memory, and a prerequisite for a quantized KV cache.' },
    // `sweepWith` rather than a bare `sweep`: Ollama honours OLLAMA_KV_CACHE_TYPE
    // ONLY with flash attention on, so a kv-only variant would re-measure the
    // baseline under a label claiming otherwise — see the grid note below.
    { id: 'kvCacheType', label: 'KV cache type', type: 'enum', env: 'OLLAMA_KV_CACHE_TYPE', options: CACHE_TYPES, sweep: ['q8_0'], sweepWith: { flashAttention: true }, hint: 'Quantizing the KV cache buys context length with a little quality. Ollama honours it only with flash attention on.' },
    { id: 'numParallel', label: 'Parallel requests', type: 'number', env: 'OLLAMA_NUM_PARALLEL', min: 1, max: 16, hint: 'Request slots the daemon serves at once. Each slot claims its own share of the context window, so raising it shrinks the window per request.' },
  ],
  // LM Studio's load-time settings, applied by reloading the model through
  // `lms load`. The app's other toggles (eval batch size, flash attention) have
  // no CLI flag, so they are not offered — see the transport rule above.
  lmstudio: [
    { id: 'contextLength', label: 'Context length', type: 'number', cli: '--context-length', min: 512, max: 1048576, unit: 'tokens', hint: 'The window the model is loaded with. LM Studio refuses a load that does not fit rather than silently shrinking it.' },
    { id: 'gpuOffload', label: 'GPU offload', type: 'number', cli: '--gpu', min: 0, max: 1, step: 0.05, sweep: [1], hint: 'Fraction of layers on the GPU (0 = CPU only, 1 = full offload). Lower frees VRAM for a bigger context at the cost of throughput.' },
    { id: 'parallel', label: 'Parallel requests', type: 'number', cli: '--parallel', min: 1, max: 16, hint: 'Predictions the model runs at once. Higher total throughput, slower per prediction.' },
  ],
  // `mtplx serve` flags, applied by relaunching the PM2 daemon on a new command
  // line. Ordered context → decode → memory → preset, so the form reads from the
  // knob that decides whether a prompt fits down to the ones that trade latency
  // for throughput. Every flag verified against upstream's own argument parser —
  // see the verification note at the top of this file before adding another.
  mtplx: [
    { id: 'contextWindow', label: 'Context window', type: 'number', cli: '--context-window', min: 512, max: 1048576, unit: 'tokens', hint: 'Overrides the window MTPLX reads from the model config. Larger costs unified memory up front, and past what fits the server will not load.' },
    { id: 'depth', label: 'MTP depth', type: 'number', cli: '--depth', min: 1, max: 8, hint: 'Tokens the MTP sidecar drafts per verify step. Deeper wins more when the draft is accepted and costs more when it is rejected — the knob MTPLX\'s own `mtplx tune` sweeps.' },
    { id: 'generationMode', label: 'Decode mode', type: 'enum', cli: '--generation-mode', options: ['mtp', 'ar'], hint: 'Native multi-token speculative decode, or plain target-only autoregressive. The comparison that answers whether MTP is actually paying off for this model here.' },
    { id: 'kvQuant', label: 'KV cache quantization', type: 'enum', cli: '--kv-quant', options: ['off', 'q8', 'q4'], hint: 'Quantizing the paged KV cache buys context length with a little quality. q4 is the smallest at every length but re-dequantizes each decode step, so long-context decode gets slower.' },
    { id: 'batchingPreset', label: 'Batching preset', type: 'enum', cli: '--batching-preset', options: ['solo', 'latency', 'agent', 'throughput'], hint: 'How the server trades per-request latency against total throughput. `solo` is the cleanest baseline for a single-stream measurement.' },
    // `turbo` is the one option not present at every tag checked — it arrived in
    // MTPLX v2.0.0. Offered anyway: an install old enough to reject it gets the
    // refusal-and-restore path, not a dead daemon, and pinning the catalog to
    // the oldest release would cost every current install the knob that matters
    // most. The diagnostic profiles ('exact', 'max-diagnostic') are valid but
    // are not what a throughput sweep is asking, so they are left out.
    { id: 'profile', label: 'Runtime profile', type: 'enum', cli: '--profile', options: ['sustained', 'turbo', 'performance-cold', 'stable'], hint: 'MTPLX\'s own bundle of runtime settings. `turbo` targets peak rate on the quantized flagships; `sustained` holds up over a long run. Diagnostic profiles are deliberately not offered.' },
  ],
  // PortOS does not start vLLM at all — it is a container from the shipped
  // compose stack — so it has no launch line to put a flag on. Left
  // present-and-empty rather than absent so the runtime still enumerates.
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

const specById = (runtimeId, id) => tuningSpecsFor(runtimeId).find((s) => s.id === id) || null;

const clamp = (value, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/**
 * Coerce one raw value against its spec. Returns `undefined` for anything that
 * cannot be read as a value — which drops the knob entirely rather than
 * substituting a default the daemon never saw.
 */
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
  // Integer knobs (everything but a utilization fraction) round rather than
  // truncate — a launch line takes whole numbers, and `-ub 511.6` is not a thing.
  return spec.step ? Number(clamped.toFixed(2)) : Math.round(clamped);
}

/**
 * Reduce a raw tuning object to the knobs this runtime declares, coerced and
 * clamped. Unknown keys are dropped silently: they cannot be applied, and
 * persisting them would put an un-renderable field in the store forever.
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
 * Stable identity for a tuning set: sorted `id=value` pairs.
 *
 * `''` for an empty set — deliberately, so an untuned assessment keys exactly
 * as it did before tuning existed and every record already on disk keeps
 * resolving without a migration.
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
 * `null` when nothing was tuned — the caller renders "backend defaults" rather
 * than an empty string that reads like a missing value.
 *
 * Describes the tuning as the CURRENT catalog understands it, which is right for
 * the run being measured. It is NOT how a stored reading describes itself: each
 * record persists the `tuningLabel` it was measured under, so a knob that later
 * leaves the catalog cannot silently relabel an old measurement.
 */
export function describeTuning(runtimeId, tuning) {
  const parts = tuningSpecsFor(runtimeId)
    .filter((spec) => tuning?.[spec.id] !== undefined && tuning?.[spec.id] !== null)
    .map((spec) => `${spec.label} ${formatValue(spec, tuning[spec.id])}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Default cap on how many tunings ONE sweep will queue, baseline included.
 *
 * Every variant is a full measurement — a daemon restart plus one bounded
 * generation per context size, so minutes of GPU each. Six is the point where a
 * sweep is still something you can start and read the same evening.
 */
export const DEFAULT_TUNING_GRID_VARIANTS = 6;

/**
 * The knob combinations worth measuring for one runtime: backend defaults first,
 * then ONE variant per knob that declares a `sweep` candidate.
 *
 * ## Why one knob at a time
 *
 * A full cross-product of the llama.cpp catalog is thousands of runs at minutes
 * each. A single-knob grid answers the question the comparison table actually
 * reports — "was that knob worth it?", via `compareTunings`'s `deltaPercent` —
 * and the user stacks winners by re-sweeping from the one that won.
 *
 * The ONE exception is a knob whose runtime documents a hard prerequisite:
 * `sweepWith` names the co-knobs that must be set for the candidate to take
 * effect (Ollama honours `OLLAMA_KV_CACHE_TYPE` only with flash attention on).
 * Without it that variant would re-measure the baseline under a label claiming
 * a quantized cache — a wrong answer, which is worse than a two-knob variant.
 *
 * A knob with no `sweep` is deliberately absent from the grid: `ctxSize` changes
 * what is being measured rather than how fast it runs, `threads`/`nGpuLayers`
 * have no machine-independent candidate, and a quantized V cache does not launch
 * without flash attention.
 *
 * The returned length IS the run count, so a caller can name it in a consent
 * gate before anything starts — which the AI Provider Usage Policy (root
 * CLAUDE.md) requires of any batch of provider calls. `maxVariants` truncates in
 * catalog order; nothing here reports the grid as exhaustive. It is an
 * in-process option only — there is no wire path that shrinks the grid, because
 * a request that could would run a different count than consent named.
 *
 * @param {string} runtimeId
 * @param {{ maxVariants?: number }} [options]
 * @returns {Array<{ key: string, label: string|null, tuning: object }>} always at
 *   least the baseline — `key: ''`, `label: null`, meaning "backend defaults".
 *   A runtime with no sweepable knobs returns exactly that one entry, which a
 *   caller must read as "nothing to compare here", not as a one-variant sweep.
 */
export function tuningGridFor(runtimeId, { maxVariants = DEFAULT_TUNING_GRID_VARIANTS } = {}) {
  const cap = Number.isFinite(maxVariants) && maxVariants >= 1 ? Math.floor(maxVariants) : DEFAULT_TUNING_GRID_VARIANTS;
  // The baseline is not optional: without it every variant's `deltaPercent` is
  // relative to another variant, and "was that knob worth it?" has no answer.
  const grid = [{ key: '', label: null, tuning: {} }];
  const seen = new Set(['']);
  for (const spec of tuningSpecsFor(runtimeId)) {
    if (!Array.isArray(spec.sweep)) continue;
    for (const candidate of spec.sweep) {
      if (grid.length >= cap) return grid;
      // Through `normalizeTuning` like any other tuning, so a candidate that the
      // catalog would clamp or reject cannot enter the grid unvalidated.
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
 * The subset of a tuning set PortOS applies at LAUNCH — the daemon has to be
 * (re)started for these to take effect, whatever the transport.
 *
 * All four renderers below walk the CATALOG rather than the tuning, so a knob
 * the runtime does not declare cannot reach a launch line, and the rendered
 * order is the order the form showed.
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

/**
 * Launch knobs rendered as a llama-server CONFIG object — knob id to value,
 * which is the shape `llamaServerManager.startLlamaServer` takes.
 */
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
 * `{ OLLAMA_FLASH_ATTENTION: '1' }`.
 *
 * Booleans render as `1`/`0` because that is what Ollama parses, and an
 * explicitly-off toggle has to survive as an override of a daemon default that
 * may be on. Every value is a string, since that is what a child process
 * environment holds.
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
 * `['--context-length', '8192']` shape `spawn` takes.
 *
 * A boolean renders as a bare flag when on and is omitted when off — a CLI has
 * no spelling for "explicitly off" that is not just the default.
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
 * The request-applied knobs, rendered under their WIRE names, ready to merge
 * into a chat-completions body.
 *
 * Empty for every runtime today — see the note on the `wire` tier at the top of
 * this file. The wire name lives on the spec rather than in a lookup table here
 * so a knob cannot declare itself request-applied without also naming the field
 * the daemon reads.
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

// The label the record was MEASURED under, which is what a comparison table has
// to show. Re-deriving it from the raw tuning would silently relabel a reading
// whose knob has since left the catalog — the record is the authority on the
// configuration it describes, not today's catalog.
const labelOf = (a) => a?.tuningLabel || describeTuning(a?.backend, a?.tuning) || 'Backend defaults';

const throughputOf = (a) => {
  const value = a?.performance?.meanCharsPerSecond;
  return Number.isFinite(value) ? value : null;
};

// Token rates are the better tuning signal only when every variant has an
// exact daemon-reported count. A frame-count estimate is useful evidence, but
// mixing it with tokenizer counts would make the winner depend on reporting
// behavior rather than runtime speed. Fall back to chars/s for that group — it
// is the unit every assessment can measure without a tokenizer.
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
        // Relative to the winner, so 100 is the best measured tuning and 74
        // means "a quarter slower than the best this model managed here".
        deltaPercent: winner > 0 ? Number(((rateOf(a) / winner) * 100).toFixed(1)) : null,
      })),
    });
  }
  return rows.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
