/**
 * Map a PortOS provider model id onto an Artificial Analysis catalog slug.
 *
 * The comparison catalog is a public benchmark index of the whole industry —
 * hundreds of models, most of which PortOS can never dispatch (retired
 * generations like claude-2.0, research checkpoints, models behind harnesses we
 * do not ship). The chart is only useful when it is scoped to models the user
 * can actually select in Settings > AI Providers > Models, so the model pills
 * default to that scope and everything else is opt-in.
 *
 * Provider model ids are written for the harness that runs them, not for the
 * benchmark index, so the two namespaces have to be reconciled:
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
 * cases where the two namespaces genuinely disagree on a name. A provider id
 * that maps to no catalog slug simply contributes nothing to the scope.
 */

import { isConfiguredDefaultModel } from './providerModels.js';

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

/**
 * The catalog's own spelling of a model slug.
 *
 * Sources spell a version with either a dash or a dot — Artificial Analysis
 * minted Fable 5.1's max row as `claude-fable-5-1` and its other efforts as
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
