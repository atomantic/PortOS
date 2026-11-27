/**
 * Browser-safe reviewer identities, pin limits, effort ladders and normalizers shared by settings and the review loop.
 */

import { ANTIGRAVITY_COMMAND } from './aiToolkit/internal/antigravity.js';
import { CURSOR_COMMAND } from './aiToolkit/internal/cursor.js';
import { isPlainObject } from './objects.js';
import { antigravityModelEffortLevels, effortLevelsForProvider } from './provider/providerModels.js';

// Reviewer choices for the Review Loop. `copilot` requests a native GitHub Copilot review;
// CLI reviewers critique the PR diff, and local LLMs run through `POST /api/code-review/local`.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'grok', 'cursor', 'pi', 'opencode', 'kilo', 'kimi', 'lmstudio', 'ollama', 'mtplx'];
// Provider records retain their own identity instead of collapsing to a harness.
export const isProviderReviewer = (value) => typeof value === 'string' && /^provider:[a-z0-9][a-z0-9-]{0,79}$/.test(value);
export const isReviewer = (value) => REVIEWER_VALUES.includes(value) || isProviderReviewer(value);

export const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = [];
// Reviewers slashdo's `--reviewer-applies` actually reaches. Its loop forces every OTHER local CLI
// back to review-only and reverts what it wrote — codex is the one with a verified write-isolated
// profile — and the flag is meaningless for the cloud (`copilot`, `@login`) and non-agentic
// (`ollama`) paths, so a list without one of these emits no flag rather than a promise slashdo
// drops.
export const APPLY_CAPABLE_REVIEWERS = Object.freeze(['codex']);

export const normalizeReviewerSlug = (reviewer) => {
  if (typeof reviewer !== 'string') return '';
  const slug = reviewer.trim().toLowerCase();
  return REVIEWER_ALIASES[slug] || slug;
};

export const isApplyCapableReviewer = (slug) => APPLY_CAPABLE_REVIEWERS.includes(normalizeReviewerSlug(slug));

// Reviewers that resolve to a local-LLM backend (rather than a CLI or GitHub bot). Used by the
// code-review endpoint, settings panel, and prompt builder to gate model-id resolution.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama', 'mtplx'];
// Reviewers PortOS serves ITSELF, with no counterpart in slashdo's reviewer vocabulary
// (`copilot`/`codex`/`agy`/`claude`/`grok`/`pi`/`cursor`/`opencode`/ `ollama`/`@login`):
// `lmstudio`/`mtplx` run through `POST /api/code-review/local`, which takes their model in the
// request body, and `kilo`/`kimi` are CLIs PortOS's own review procedure spawns. slashdo has no
// such slug, so none can carry a `[<model>]` bracket or appear in a `--review-with` list (an
// unknown value aborts the command). `opencode` left this set when slashdo added it (v3.38.0,
// `--review-with opencode`, aliases `zen`/`opencode-zen`); PortOS was still dropping it from the
// flag and silently reviewing with whatever the host's saved defaults named.
export const PORTOS_ONLY_REVIEWERS = ['lmstudio', 'mtplx', 'kilo', 'kimi'];
// CLI reviewers whose binary accepts a `--model <id>` tier the user can pin on the Code Review
// Defaults panel (stored as a `<reviewer>Model` settings scalar, e.g. `codexModel` / `claudeModel`
// / `antigravityModel`).
export const MODEL_CAPABLE_CLI_REVIEWERS = ['codex', 'claude', 'antigravity', 'grok', 'cursor', 'pi', 'opencode', 'kilo', 'kimi'];
// Every reviewer whose model the user can PICK in the UI: the model-capable CLIs above (threaded
// into the follow-up prompt as `<reviewer> --model <id>`) plus the local-LLM backends (whose id is
// injected server-side by `POST /api/code-review/local`, or emitted as slashdo's `[<model>]`
// bracket for a claim flow). `copilot` and `@username` reviewers are excluded — neither is a
// model-taking backend, matching slashdo rejecting `copilot[…]`/`@login[…]`.
export const MODEL_SELECTABLE_REVIEWERS = [...MODEL_CAPABLE_CLI_REVIEWERS, ...LOCAL_LLM_REVIEWERS];

// CLI command names supply the harness-specific effort ladders and the review invocation.
export const REVIEWER_CLI_BINARIES = {
  claude: 'claude',
  antigravity: ANTIGRAVITY_COMMAND,
  codex: 'codex',
  grok: 'grok',
  cursor: CURSOR_COMMAND,
  pi: 'pi',
  opencode: 'opencode',
  kilo: 'kilo',
  kimi: 'kimi',
};

/**
 * The PATH executable for a CLI reviewer slug, or `null` when the reviewer is not a spawnable CLI.
 * Accepts the `gemini` alias.
 * @param {string} reviewer - reviewer slug (`antigravity`, `gemini`, `codex`, …)
 * @returns {string|null}
 */
export function reviewerCliBinary(reviewer) {
  if (typeof reviewer !== 'string') return null;
  return REVIEWER_CLI_BINARIES[normalizeReviewerSlug(reviewer)] || null;
}

// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`).
export const REVIEW_STOP_MODES = ['all', 'on-findings', 'on-clean'];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

// The task-metadata keys that TOGETHER form a task-local reviewer override — everything the picker
// writes, and so everything its "Use system Code Review Defaults" reset has to remove. A key
// missing here leaves a pin behind after a reset the user believes cleared it.
export const REVIEWER_OVERRIDE_KEYS = Object.freeze([
  // Legacy singular, still stored on schedules saved before the list existed.
  'reviewer',
  'reviewers',
  'usernames',
  'optionalReviewers',
  'reviewerMaxRounds',
  'reviewerModels',
  'reviewerEfforts',
  'reviewStopMode',
  'reviewerApplies',
]);

// The subset `resolveReviewerConfig` actually READS. `reviewStopMode` and `reviewerApplies` are
// deliberately absent: they are slashdo run flags, and a claim flow has no flag string to put them
// in (the claim prompt gets a reviewer CSV), so neither can change which reviewers a claim runs.
export const REVIEWER_LIST_OVERRIDE_KEYS = Object.freeze(
  REVIEWER_OVERRIDE_KEYS.filter((key) => key !== 'reviewStopMode' && key !== 'reviewerApplies')
);

/**
 * Does this task metadata pin any part of the reviewer list itself (as opposed to a run flag)? Key
 * PRESENCE is the signal, not truthiness: an explicitly empty `optionalReviewers: []` or
 * `reviewerModels: {}` is a real override — it clears the defaults' value — so collapsing it into
 * "nothing configured" would report the wrong source.
 */
export function hasReviewerOverride(metadata) {
  return isPlainObject(metadata) && REVIEWER_LIST_OVERRIDE_KEYS.some((key) => key in metadata);
}

// Forge usernames are stored without the `@` prefix and requested as PR reviewers.
export const MAX_REVIEW_USERNAMES = 20;
const REVIEW_USERNAME_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,254})(?:\/[A-Za-z0-9._-]{1,100})?$/;

export function cleanReviewUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@+/, '');
  return trimmed && REVIEW_USERNAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * Normalize a raw list of reviewer usernames: strip an optional leading `@`, trim, drop anything
 * that isn't a shell-safe GitHub/GitLab username/team slug, case-insensitively dedupe (GitHub
 * logins are case-insensitive) while preserving first-occurrence order, and cap at
 * MAX_REVIEW_USERNAMES. Returns a clean array of usernames WITHOUT the `@` prefix.
 */
export function normalizeReviewUsernames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const trimmed = cleanReviewUsername(raw);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_REVIEW_USERNAMES) break;
  }
  return out;
}

// Ceiling on a per-reviewer `~max=<n>` cap. slashdo's inner loops carry their own 10-iteration
// safety guardrail, so a budget above it can never be spent — accepting one would just be a lie in
// the flag string.
export const MAX_REVIEWER_MAX_ROUNDS = 10;

// Upper bound on a pinned reviewer model id. Generous (Bedrock/Ollama ids get long) but present so
// a hand-edited settings.json can't smuggle in a blob that then round-trips the TASKS.md store.
export const MAX_REVIEWER_MODEL_LENGTH = 200;

// Characters a model id may not contain, because they are STRUCTURAL in the emitted
// `--review-with` token and there is no escape for them: - `]` would close the `[<model>]`
// selector early (`foo]~opt` → a corrupt entry whose remainder slashdo then parses as suffixes), -
// `[` would open a nested one, - `,` would split the entry list, turning one reviewer into two
// bogus ones, - whitespace that breaks lines would split the single-line flag string. Everything
// else stays legal on purpose: the value is free-form in slashdo's grammar (`agy[Gemini 3.5 Flash
// (High)]` is valid), and the field has to accept whatever id the user's environment actually
// needs.
export const REVIEWER_MODEL_FORBIDDEN_RE = /[[\],\r\n\t]/;

// Reviewers whose slashdo `--review-with` entry accepts a `[<model>]` bracket
// (`lib/multi-reviewer-loop.md`: codex/claude/agy/grok/cursor/ollama). A PORTOS_ONLY_REVIEWERS
// entry has no slashdo counterpart at all, so a pinned model for it never becomes a bracket, and
// `copilot`/`@login` entries reject one outright.
export const BRACKET_MODEL_REVIEWERS = MODEL_SELECTABLE_REVIEWERS.filter(r => !PORTOS_ONLY_REVIEWERS.includes(r));

// Reasoning-effort ladder for the local-LLM reviewers. Their review request goes out as an
// OpenAI-compatible `/v1/chat/completions` call, whose `reasoning_effort` field both LM Studio and
// Ollama accept for thinking models — but only over the low/medium/high tier names.
export const LOCAL_LLM_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

/**
 * Reviewer slug → the reasoning-effort ladder, for reviewers with an effort control.
 */
export const REVIEWER_EFFORT_LEVELS = Object.freeze(Object.fromEntries(
  REVIEWER_VALUES
    .map((slug) => {
      if (LOCAL_LLM_REVIEWERS.includes(slug)) return [slug, LOCAL_LLM_EFFORT_LEVELS];
      const binary = reviewerCliBinary(slug);
      return [slug, binary ? effortLevelsForProvider({ id: slug, command: binary }) : null];
    })
    .filter(([, levels]) => levels?.length)
));

/**
 * Every reviewer the user can pick an effort for — the effort-capable CLIs (`claude`, `codex`,
 * `antigravity`, `cursor`) plus the local-LLM backends.
 */
export const EFFORT_SELECTABLE_REVIEWERS = Object.freeze(Object.keys(REVIEWER_EFFORT_LEVELS));

/**
 * The ladder for ONE reviewer token, or `null` when it takes no effort. Accepts the `gemini`
 * alias; an `@username` token resolves to null like any non-reviewer.
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} [model] - optional pinned model id
 * @returns {readonly string[]|null}
 */
export function reviewerEffortLevels(reviewer, model = null, catalog = []) {
  if (typeof reviewer !== 'string') return null;
  const normalized = normalizeReviewerSlug(reviewer);

  if (normalized === 'antigravity') return antigravityModelEffortLevels(model, catalog) ?? REVIEWER_EFFORT_LEVELS.antigravity;
  // For codex, derive the ladder from the model if provided
  if (normalized === 'codex' && model) {
    return effortLevelsForProvider({ id: normalized, command: reviewerCliBinary(normalized), models: catalog }, model);
  }

  return REVIEWER_EFFORT_LEVELS[normalized] || null;
}

/**
 * Resolve a provider record (or provider ID) to a canonical reviewer slug (e.g. 'codex', 'claude',
 * 'antigravity', etc.).
 * @param {object|string} provider
 * @param {string} [providerId]
 * @returns {string|null}
 */
export function resolveProviderReviewerSlug(provider, providerId = null) {
  if (provider && typeof provider === 'object') {
    const candidates = [
      provider.harnessId && provider.harnessId !== 'direct' ? provider.harnessId : null,
      provider.command === ANTIGRAVITY_COMMAND ? 'antigravity' : provider.command,
      provider.executionSourceProviderId && !provider.executionSourceProviderId.startsWith('selection-')
        ? provider.executionSourceProviderId.replace(/-(cli|tui)$/, '')
        : null,
      provider.id ? provider.id.replace(/-(cli|tui)$/, '') : null,
      provider.id
    ].filter(Boolean);

    for (const raw of candidates) {
      if (typeof raw !== 'string') continue;
      const normalized = REVIEWER_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
      if (REVIEWER_VALUES.includes(normalized)) {
        return normalized;
      }
    }
  }

  const rawId = typeof provider === 'string' ? provider : (providerId || (provider?.id ?? null));
  if (typeof rawId === 'string' && rawId) {
    const stripped = rawId.replace(/^provider:/, '').replace(/-(cli|tui)$/, '').toLowerCase();
    const normalized = REVIEWER_ALIASES[stripped] || stripped;
    if (REVIEWER_VALUES.includes(normalized)) return normalized;
    for (const v of REVIEWER_VALUES) {
      if (stripped === v || stripped.startsWith(`${v}-`) || stripped.endsWith(`-${v}`)) {
        return v;
      }
    }
  }
  return null;
}

/**
 * Resolve task metadata to an ordered, deduped reviewer list. Prefers the new `reviewers` array;
 * falls back to the legacy single `reviewer` string.
 */
export function normalizeReviewers(meta, fallback = DEFAULT_REVIEWERS) {
  const raw = isPlainObject(meta) ? meta : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const out = normalizeReviewerList(source);
  if (out.length) return out;
  const fallbackList = normalizeReviewerList(fallback);
  return fallbackList.length ? [...fallbackList] : [...DEFAULT_REVIEWERS];
}

export function normalizeReviewerList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const normalized = REVIEWER_ALIASES[raw] || raw;
    if (isReviewer(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}
