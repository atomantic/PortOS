/**
 * Map a PortOS provider model id onto a canonical model identity.
 *
 * The reference catalog can cover models PortOS cannot dispatch (retired
 * generations, research checkpoints, and models behind unsupported harnesses).
 * Shipped reference rows are scoped to models the user can actually select in
 * Settings > AI Providers > Models.
 *
 * Provider model ids are written for the harness that runs them, so aliases
 * used in model metadata and price references have to be reconciled:
 *
 *   us.anthropic.claude-sonnet-5      Bedrock region prefix
 *   global.anthropic.claude-opus-5[1m]  region prefix + context-window suffix
 *   moonshotai/kimi-k2.5              vendor namespace
 *   opencode/muse-spark-1.3-contributor-free  gateway namespace + tier suffix
 *   claude-opus-5-thinking-xhigh      effort/mode suffixes
 *   claude-sonnet-4-6                 dashed version ("4-6" is really 4.6)
 *   claude-haiku-4-5                  family/version order flipped vs the index
 *
 * Everything here is textual normalization plus a small alias table for the
 * cases where the namespaces genuinely disagree on a name. A provider id that
 * maps to no canonical model identity simply contributes nothing to the scope.
 *
 * A LOCAL install id is the exception: any id the `localLlmCatalog.js` catalog
 * recognizes at all is resolved by lookup against the `benchmarkModel` its
 * entry declares — or to no slug, when it declares none — never by the rules
 * below, which were written for hosted ids and read a GGUF repo name wrong.
 */

import { isConfiguredDefaultModel } from './providerModels.js';
import { BACKENDS, LOCAL_LLM_CATALOG, entryIdsForBackend, normalizeBackendModelId } from './localLlmCatalog.js';

/**
 * Every install id the local-LLM catalog recognizes, mapped to the benchmark
 * name that entry DECLARES. Local ids get a lookup rather than the textual
 * normalization below because a local id names a *build* of the weights, and
 * the difference between a build marker and model identity is not decidable
 * from the text: stripping `-Reasoning` off Cisco's GGUF lands on a different
 * Cisco model, and folding `qwen3.8:27b-mlx` onto `qwen3.8-27b` would plot the
 * hosted API's price and throughput under a 4-bit local build. An entry with no
 * `benchmarkModel` contributes nothing, which is the honest default.
 *
 * Keyed on the catalog's own id normalization, so a tag the user pulled under a
 * retired alias still resolves.
 */
const LOCAL_INSTALL_IDS = new Map(
  BACKENDS.flatMap(backend => LOCAL_LLM_CATALOG
    .filter(entry => entry.benchmarkModel)
    .flatMap(entry => entryIdsForBackend(entry, backend)
      .map(id => [`${backend}:${normalizeBackendModelId(backend, id)}`, entry.benchmarkModel])))
);

// Every install id the local-LLM catalog recognizes at all, declared or not.
// A local-shaped id must never reach the hosted-id textual rules below even
// when its entry declares no `benchmarkModel` — those rules read a GGUF repo
// name wrong (see file header), which is exactly the case an undeclared entry
// is asking to be routed around.
const LOCAL_CATALOG_IDS = new Set(
  BACKENDS.flatMap(backend => LOCAL_LLM_CATALOG
    .flatMap(entry => entryIdsForBackend(entry, backend)
      .map(id => `${backend}:${normalizeBackendModelId(backend, id)}`)))
);

/** The benchmark name a local install id declares, or '' if none does. */
function catalogSlugForLocalModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return '';
  for (const backend of BACKENDS) {
    const declared = LOCAL_INSTALL_IDS.get(`${backend}:${normalizeBackendModelId(backend, modelId)}`);
    if (declared) return declared;
  }
  return '';
}

/** Benchmark names every catalog entry declares — the local half of seed scope. */
export const localCatalogBenchmarkModels = () =>
  new Set(LOCAL_LLM_CATALOG.map(entry => entry.benchmarkModel).filter(Boolean));

// Effort and mode suffixes a harness appends to a model id, plus the
// local-runtime quantization/packaging suffixes that name the same weights as
// the benchmarked model. Stripped as one repeated tail, so
// `claude-opus-5-thinking-xhigh` reduces to `claude-opus-5`.
const SUFFIXES = ['thinking', 'reasoning', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'free', 'contributor', 'spark'];
const QUANTIZATIONS = ['4bit', '8bit', 'fp8', 'mxfp4', 'awq', 'gguf', 'optimized-speed'];
const TAIL = new RegExp(`(?:-(?:${[...QUANTIZATIONS, ...SUFFIXES].join('|')}))+$`);

// Namespace prefixes that address a gateway or region rather than the model.
const PREFIXES = ['us.anthropic.', 'global.anthropic.', 'anthropic.', 'us.', 'global.'];

// Names the two namespaces spell differently on purpose.
const ALIASES = new Map([
  ['claude-haiku-4-5', 'claude-4.5-haiku'],
  ['claude-haiku-4.5', 'claude-4.5-haiku'],
  ['claude-sonnet-4.5', 'claude-4.5-sonnet'],
  ['claude-opus-4.1', 'claude-4.1-opus'],
  ['claude-opus-4', 'claude-4-opus'],
  ['claude-sonnet-4', 'claude-4-sonnet'],
  ['claude-4.6-sonnet', 'claude-sonnet-4.6'],
  ['gptoss-20b', 'gpt-oss-20b'],
  ['gptoss-120b', 'gpt-oss-120b'],
  ['gemini-3.1-pro', 'gemini-3.1-pro-preview'],
  ['grok-3-mini', 'grok-3-mini-reasoning'],
  ['kimi-k2-instruct', 'kimi-k2'],
  ['ling-3.0-flash-fin', 'ling-3.0-flash'],
  ['nemotron-3-ultra', 'nemotron-3-ultra-550b-a55b'],
  ['claude-fable-5-1', 'claude-fable-5.1'],
]);

// Routing policies and local runtime aliases that name no benchmarked model.
// The "use the CLI's own default" sentinels are owned by providerModels.js.
const NOT_A_MODEL = /^(auto|.*\/auto|composer-.*|big-pickle|stealth\/.*|mtplx-.*|dflash|.*-dflash2)$/i;

// normalizeBackendModelId's LM Studio path reduces an id to its last path
// segment (vendor stripped) and drops a trailing `-gguf` — the same shape as
// a namespaced hosted id (`vendor/model-name`), so a bare match against
// LOCAL_CATALOG_IDS alone would misclassify a hosted id that happens to share
// a model name with an installed GGUF/MLX build (e.g. `google/gemma-4-31b-it`
// vs. the catalog's `lmstudio-community/gemma-4-31B-it-GGUF`). Every real
// local LM Studio id in the catalog carries one of these packaging markers,
// so requiring one here is a genuine local-shape signal, not a coincidence.
const LOCAL_LMSTUDIO_MARKER = new RegExp(`(?:${['mlx', ...QUANTIZATIONS].join('|')})`, 'i');

/** Whether the catalog recognizes `modelId` as SOME install, on either backend. */
function isLocalCatalogId(modelId) {
  if (typeof modelId !== 'string' || !modelId) return false;
  if (LOCAL_CATALOG_IDS.has(`ollama:${normalizeBackendModelId('ollama', modelId)}`)) return true;
  return LOCAL_LMSTUDIO_MARKER.test(modelId) &&
    LOCAL_CATALOG_IDS.has(`lmstudio:${normalizeBackendModelId('lmstudio', modelId)}`);
}

/**
 * The catalog's own spelling of a model slug.
 *
 * Model sources spell a version with either a dash or a dot — the old public
 * index minted Fable 5.1's max row as `claude-fable-5-1` and its other efforts as
 * `claude-fable-5.1`, which split one reasoning curve into two series. Only a
 * trailing all-digit pair is a version, so `qwen3-235b-a22b-2507` and
 * `deepseek-r1-0528` are left alone.
 *
 * Applied both where the sync mints a slug and where a migration repairs stored
 * rows, so the two cannot disagree about what a model is called.
 */
export function canonicalCatalogModelSlug(slug) {
  if (typeof slug !== 'string' || !slug) return '';
  return slug.replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/** Normalize one provider model id to a catalog model slug, or '' if it is not one. */
export function catalogSlugForProviderModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return '';
  let slug = modelId.trim().toLowerCase();
  if (isConfiguredDefaultModel(slug) || NOT_A_MODEL.test(slug)) return '';
  // A local-shaped id never reaches the rules below, declared or not: they were
  // written for hosted ids and mis-strip a GGUF repo name. A declared entry
  // resolves to its reviewed benchmark name; an undeclared one resolves to ''.
  if (isLocalCatalogId(modelId)) return catalogSlugForLocalModel(modelId);

  slug = slug.replace(/\[[^\]]*\]$/, ''); // context-window marker, e.g. [1m]
  const prefix = PREFIXES.find(candidate => slug.startsWith(candidate));
  if (prefix) slug = slug.slice(prefix.length);
  slug = slug.slice(slug.lastIndexOf('/') + 1); // vendor / gateway namespace
  // Re-test after stripping: a routing alias reaches us namespaced
  // (`opencode/big-pickle`), which the anchored pattern misses in its full form.
  // The first test still has to happen before stripping, because some patterns
  // (`stealth/…`) match only the namespaced form.
  if (NOT_A_MODEL.test(slug)) return '';
  slug = canonicalCatalogModelSlug(slug.replace(TAIL, ''));
  return ALIASES.get(slug) || slug;
}

/**
 * Catalog slugs reachable through the given provider inventory (the `inventory`
 * array the comparison API returns: `[{ models: [{ model, efforts }] }]`).
 */
export function providerCatalogSlugs(inventory = []) {
  const slugs = new Set();
  for (const provider of inventory) {
    for (const entry of provider?.models || []) {
      const slug = catalogSlugForProviderModel(typeof entry === 'string' ? entry : entry?.model);
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}
