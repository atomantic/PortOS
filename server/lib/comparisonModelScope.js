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

// Effort and mode suffixes a harness appends to a model id. Stripped from the
// tail repeatedly, so `claude-opus-5-thinking-xhigh` reduces to `claude-opus-5`.
const SUFFIXES = ['thinking', 'reasoning', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'free', 'contributor', 'spark'];

// Local-runtime quantization / packaging suffixes — same weights as the
// benchmarked model, so they resolve to the same catalog slug.
const QUANTIZATIONS = ['4bit', '8bit', 'fp8', 'mxfp4', 'awq', 'gguf', 'optimized-speed'];

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

// Provider entries that name a routing policy or a local runtime rather than a
// benchmarked model.
const NOT_A_MODEL = /^(auto|.*\/auto|.*-configured-default|composer-.*|big-pickle|stealth\/.*|mtplx-.*|dflash|.*-dflash2)$/i;

/** Normalize one provider model id to a catalog model slug, or '' if it is not one. */
export function catalogSlugForProviderModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return '';
  let slug = modelId.trim().toLowerCase();
  if (NOT_A_MODEL.test(slug)) return '';

  slug = slug.replace(/\[[^\]]*\]$/, ''); // context-window marker, e.g. [1m]
  for (const prefix of PREFIXES) if (slug.startsWith(prefix)) { slug = slug.slice(prefix.length); break; }
  slug = slug.slice(slug.lastIndexOf('/') + 1); // vendor / gateway namespace

  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    for (const suffix of [...QUANTIZATIONS, ...SUFFIXES]) {
      if (slug.endsWith(`-${suffix}`)) {
        slug = slug.slice(0, -(suffix.length + 1));
        trimmed = true;
      }
    }
  }

  // `claude-sonnet-4-6` / `claude-fable-5-1` spell a version with a dash; the
  // index spells it with a dot. Only a trailing single-digit pair is a version.
  slug = slug.replace(/-(\d+)-(\d+)$/, '-$1.$2');
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
