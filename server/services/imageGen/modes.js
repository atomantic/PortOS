/**
 * Image Gen — mode enum.
 *
 * Standalone so the dispatcher (`index.js`) and the provider modules
 * (`codex.js`, `local.js`, `external.js`) can both import without forming a
 * cycle (index.js already imports from each provider).
 *
 * `IMAGE_GEN_MODE.X` is the preferred form at branching/tagging sites.
 * `IMAGE_GEN_MODES` is the alphabet for Zod / OpenAI tool-spec enums.
 * Single source of truth: derive the array from `Object.values(...)`.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  EXTERNAL: 'external',
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
});

export const IMAGE_GEN_MODES = Object.freeze(Object.values(IMAGE_GEN_MODE));

// Cloud-CLI backends (codex `$imagegen`, grok `image_gen`) — each render
// shells out to an external child that spends remote quota, not local GPU.
// The mediaJobQueue routes these through its parallel cloud lane (they don't
// serialize on the MLX runtime) and async callers treat them like local:
// generateImage returns a job descriptor before the file lands.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK]);

// Modes the mediaJobQueue can run (external SD-API stays synchronous — a
// remote HTTP call with no local single-flight constraint to absorb). Single
// source for the pipeline routes' Zod enums and batch-render guards, so a
// future backend is one edit here instead of a sweep of enum literals.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.LOCAL, ...CLOUD_IMAGE_GEN_MODES]);

// Cloud-CLI providers expose no numeric i2i denoise knob, so map the
// local-runner-style strength (0..1, lower = more faithful to the source)
// onto a phrase the model reliably honors. Mirrors
// PROOF_AS_BASE_DEFAULT_STRENGTH (0.25) defaulting toward
// composition-preserving edits. Lives here (the shared no-dependency module)
// so codex.js and grok.js both import it without a provider→provider import.
export const describeFidelity = (strength) => {
  const n = Number.isFinite(strength) ? Math.max(0, Math.min(1, Number(strength))) : 0.25;
  if (n <= 0.2) return 'preserve composition, characters, and layout exactly — only refine detail and resolution';
  if (n <= 0.4) return 'preserve composition and characters while adding rendered detail at higher fidelity';
  if (n <= 0.7) return 'use the attached image as a strong reference while refining art and detail';
  return 'use the attached image as a loose reference; you may reinterpret freely';
};

// Shipped defaults for the Codex imagegen backend. Codex's built-in image_gen
// tool otherwise runs whatever model its logged-in session defaults to — often
// the heaviest, most expensive tier — at default reasoning effort. Pin the cheap
// `gpt-5.6-luna` model at `low` reasoning effort so every media-pipeline render
// pays the light path by default. Applied as a code-level default (not a
// settings migration) so it reaches every install and federated peer with no
// per-install bookkeeping; an explicit `imageGen.codex.model` / `.effort` in
// Settings still wins. Effort is one of providerModels' CODEX_EFFORT_LEVELS.
export const CODEX_IMAGEGEN_DEFAULT_MODEL = 'gpt-5.6-luna';
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// The local runner's fallback model id when neither the request nor
// settings.imageGen.local.modelId names one (local.js's parameter default).
// Exported so provenance writers (sprite candidate sidecars, #2896) can
// record the model that actually ran without hardcoding a second copy.
export const LOCAL_IMAGEGEN_DEFAULT_MODEL = 'dev';

/**
 * Resolve the queue-capable image mode for a render request: the per-request
 * override (honored only when that backend is enabled/available), else the
 * saved dispatcher default, else codex → grok → local. External never queues.
 * Hoisted from the pipeline visual stages (#2896) so sprite renders and any
 * future queued surface share one enable-gating ladder — see issue #2881 for
 * the wider param-assembly consolidation.
 */
export function resolveQueueImageMode(requested, settings) {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  if (requested === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (requested === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const settingsMode = settings?.imageGen?.mode;
  if (settingsMode === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (settingsMode === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (settingsMode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (grokEnabled) return IMAGE_GEN_MODE.GROK;
  return IMAGE_GEN_MODE.LOCAL;
}
