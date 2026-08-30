/**
 * Chief-of-Staff (CoS) Zod schemas + reviewer config (split out of validation.js,
 * issue #1831).
 *
 * Covers CoS tasks, the Review-Loop reviewer vocabulary + helpers
 * (`normalizeReviewers` / `buildReviewWithArgs`), the Code-Review settings slice,
 * recurring jobs, loops, learning insights, and the task-metadata sanitizer.
 * validation.js re-exports everything here (flat) so existing deep imports keep
 * working; the barrel surfaces it as the `cosValidation` namespace.
 */
import { z } from 'zod';
import { emptyToUndefined, emptyToNull } from './zodCompat.js';
import { isPlainObject } from './objects.js';
import { EFFORT_LEVELS, effortLevelsForProvider, buildEffortArgs, foldCursorEffortIntoModel, splitAntigravityModel } from './providerModels.js';
import { ANTIGRAVITY_COMMAND } from './antigravity.js';
import { CURSOR_COMMAND } from './cursor.js';
import { isValidSlashdoCommand } from './slashdoInvocation.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';
import { AGENT_RUN_EVENT_KINDS, RUN_EVENT_READ_LIMITS } from './agentRunEvents.js';
import { recurrenceRuleSchema } from './recurrenceValidation.js';
import { TASK_DATA_INPUT_DEFINITIONS, TASK_DATA_INPUT_IDS } from './taskDataInputCatalog.js';

export { TASK_DATA_INPUT_DEFINITIONS, TASK_DATA_INPUT_IDS } from './taskDataInputCatalog.js';

// =============================================================================
// COS TASK SCHEMAS
// =============================================================================

// Reviewer choices for the Review Loop. `copilot` requests a native GitHub
// Copilot review; `claude`/`antigravity`/`codex`/`grok`/`cursor` instruct the review-loop
// follow-up agent to invoke the named CLI to critique the PR diff; `lmstudio`/`ollama`
// route the diff through PortOS's local code-review endpoint
// (`POST /api/code-review/local`) which runs the configured local LLM model.
// Mirrored in client/src/components/cos/constants.js → REVIEWER_OPTIONS.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'grok', 'cursor', 'lmstudio', 'ollama'];
export const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = ['copilot'];
// Reviewers that resolve to a local-LLM backend (rather than a CLI or GitHub
// bot). Used by the code-review endpoint, settings panel, and prompt builder
// to gate model-id resolution.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama'];
// Reviewers PortOS serves ITSELF, with no counterpart in slashdo's reviewer
// vocabulary: `lmstudio` runs through `POST /api/code-review/local`, which takes
// its model in the request body. slashdo has no such slug, so it can neither
// carry a `[<model>]` bracket nor appear in a `--review-with` list (an unknown
// value aborts the command). One constant so a future addition can't be fixed
// in one of those two places and missed in the other.
export const PORTOS_ONLY_REVIEWERS = ['lmstudio'];
// CLI reviewers whose binary accepts a `--model <id>` tier the user can pin on
// the Code Review Defaults panel (stored as a `<reviewer>Model` settings scalar,
// e.g. `codexModel` / `claudeModel` / `antigravityModel`). The review-loop
// follow-up threads each as a reviewer-keyed model map
// (`reviewLoopReviewerModels`) so the prompt emits `<reviewer> --model <id>` per
// configured reviewer. `claude` covers both a normal Claude tier and an
// Ollama-backed `claude` (see isOllamaClaudeProvider) where `--model` selects the
// local Ollama model. `antigravity` runs `agy --model <id>`; an effort-suffixed
// agy id is reconciled with the effort pin by `pairReviewerModelsAndEfforts`.
// `grok` runs `grok --model <id>` (slashdo's `grok[<model>]` bracket); it takes a
// model but NO effort at all, which is why this roster and
// EFFORT_SELECTABLE_REVIEWERS are genuinely different sets rather than two names
// for one list. `cursor` runs `cursor-agent --model <id>` and DOES take an
// effort — but as a parameter of the model id (`gpt-5[effort=max]`), not a flag,
// so its pin rides this roster's `--model` rather than an `--effort` argv.
// Copilot/local-LLM reviewers are excluded — the former has no CLI, the latter
// get their model injected server-side by `POST /api/code-review/local`. Add a
// reviewer here when its CLI gains model selection; the `<reviewer>Model`
// settings scalar is generated from this roster (codeReviewSettingsSchema).
export const MODEL_CAPABLE_CLI_REVIEWERS = ['codex', 'claude', 'antigravity', 'grok', 'cursor'];
// Every reviewer whose model the user can PICK in the UI: the model-capable CLIs
// above (threaded into the follow-up prompt as `<reviewer> --model <id>`) plus the
// local-LLM backends (whose id is injected server-side by
// `POST /api/code-review/local`, or emitted as slashdo's `[<model>]` bracket for a
// claim flow). `copilot` and `@username` reviewers are excluded — neither is a
// model-taking backend, matching slashdo rejecting `copilot[…]`/`@login[…]`.
export const MODEL_SELECTABLE_REVIEWERS = [...MODEL_CAPABLE_CLI_REVIEWERS, ...LOCAL_LLM_REVIEWERS];
// The executable a CLI reviewer's slug actually resolves to on PATH. Every slug
// except `antigravity` names its own binary; `antigravity` is the STORED,
// federated reviewer identity (aliased from the older `gemini`) while the
// shipped executable is `agy` — there is no `antigravity` command. A prompt that
// names only the slug sends the follow-up agent looking for a binary that does
// not exist: one CoS review-loop agent probed `command -v antigravity`, found
// nothing, declared "no reviewer available", and merged its own PR on a
// self-review. Prompt builders must resolve the slug through
// `reviewerCliBinary()` before telling an agent what to invoke.
// A reviewer absent from this map has no spawnable CLI (`copilot` is a GitHub
// API review, `lmstudio`/`ollama` go through `POST /api/code-review/local`).
export const REVIEWER_CLI_BINARIES = {
  claude: 'claude',
  antigravity: ANTIGRAVITY_COMMAND,
  codex: 'codex',
  grok: 'grok',
  cursor: CURSOR_COMMAND,
};

/**
 * Is this reviewer a CLI the agent spawns itself? Derived by EXCLUSION rather
 * than from REVIEWER_CLI_BINARIES so a newly added CLI reviewer still drives the
 * review loop before anyone remembers to map its binary (the map's coverage is
 * pinned separately by cosValidation.test.js).
 *
 * The one definition of the rule — the prompt builder and the coverage test both
 * call it, so neither can re-implement (and quietly diverge from) it.
 *
 * @param {string} reviewer - reviewer slug
 * @returns {boolean}
 */
export function isCliReviewer(reviewer) {
  return reviewer !== DEFAULT_REVIEWER && !LOCAL_LLM_REVIEWERS.includes(reviewer);
}

/**
 * The PATH executable for a CLI reviewer slug, or `null` when the reviewer is
 * not a spawnable CLI. Accepts the `gemini` alias.
 *
 * A null here means "no binary is mapped", NOT "not a CLI" — use isCliReviewer
 * for that question. The two can disagree for exactly one reviewer: a new CLI
 * reviewer added to REVIEWER_VALUES before its REVIEWER_CLI_BINARIES entry.
 * That reviewer still drives the loop (isCliReviewer says yes) and its prompt
 * falls back to naming the slug — the pre-existing behavior — rather than being
 * silently dropped. cosValidation.test.js pins the map's coverage so the window
 * closes at review time.
 *
 * @param {string} reviewer - reviewer slug (`antigravity`, `gemini`, `codex`, …)
 * @returns {string|null}
 */
export function reviewerCliBinary(reviewer) {
  if (typeof reviewer !== 'string') return null;
  const slug = reviewer.trim().toLowerCase();
  return REVIEWER_CLI_BINARIES[REVIEWER_ALIASES[slug] || slug] || null;
}

/**
 * Render a reviewer slug for an agent prompt as the command it must actually
 * run, keeping the slug visible so the text still lines up with the configured
 * reviewer list and slashdo's `--review-with` token.
 *
 * `antigravity` → ``​`agy` (the `antigravity` reviewer)``; every other reviewer,
 * whose binary equals its slug, → ``​`codex` `` with no redundant restatement.
 *
 * @param {string} reviewer - reviewer slug
 * @returns {string} markdown fragment
 */
export function describeReviewerCli(reviewer) {
  if (typeof reviewer !== 'string' || !reviewer) return '';
  const binary = reviewerCliBinary(reviewer);
  if (!binary || binary === reviewer) return `\`${reviewer}\``;
  return `\`${binary}\` (the \`${reviewer}\` reviewer)`;
}
// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`).
export const REVIEW_STOP_MODES = ['all', 'on-findings', 'on-clean'];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

// Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
// reviewers to gate merging — a class distinct from the fixed REVIEWER_VALUES
// enum (which either invoke a CLI, hit the local-LLM endpoint, or request the
// native Copilot reviewer). Usernames are appended to slashdo's `--review-with`
// as `@user` tokens after the keyed reviewers; the review-loop follow-up prompt
// instructs the agent to request each as a PR reviewer and gate the merge on it.
//
// Stored WITHOUT the leading `@` (added back only in the flag string). The
// charset is deliberately shell-safe — a GitHub username (1–39 chars,
// alphanumeric + single hyphens, no leading/trailing hyphen) optionally followed
// by a `/team-slug` for org-team mentions. No shell metacharacters, so the token
// stays inert wherever it lands in a command string.
export const MAX_REVIEW_USERNAMES = 20;
const REVIEW_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;

/**
 * Normalize a raw list of reviewer usernames: strip an optional leading `@`,
 * trim, drop anything that isn't a shell-safe GitHub username/team slug,
 * case-insensitively dedupe (GitHub logins are case-insensitive) while
 * preserving first-occurrence order, and cap at MAX_REVIEW_USERNAMES. Returns
 * a clean array of usernames WITHOUT the `@` prefix. Non-array input → [].
 */
export function normalizeReviewUsernames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/^@+/, '');
    if (!trimmed || !REVIEW_USERNAME_RE.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_REVIEW_USERNAMES) break;
  }
  return out;
}

/**
 * Resolve reviewer usernames with task-over-default precedence: a task-level
 * list (even explicitly empty) overrides the Code Review Defaults; only fall
 * back to the defaults when the task didn't pin its own. Mirrors how
 * `normalizeReviewers`'s fallback param works for the keyed reviewers.
 */
export function resolveReviewUsernames(metadataUsernames, defaultUsernames) {
  return Array.isArray(metadataUsernames)
    ? normalizeReviewUsernames(metadataUsernames)
    : normalizeReviewUsernames(defaultUsernames);
}

/**
 * Normalize ONE raw reviewer identity to the exact token `--review-with` emits:
 * a keyed slug from `REVIEWER_VALUES` (aliasing `gemini` → `antigravity`) or an
 * `@<username>`. Returns null for anything else. Single definition of the token
 * identity shared by `normalizeOptionalReviewers` and
 * `normalizeReviewerMaxRounds`, so the `~opt` set and the `~max=<n>` map can't
 * disagree about what a reviewer is called.
 */
function normalizeReviewerToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) {
    const [user] = normalizeReviewUsernames([trimmed]);
    return user ? `@${user}` : null;
  }
  const slug = REVIEWER_ALIASES[trimmed] ?? trimmed;
  return REVIEWER_VALUES.includes(slug) ? slug : null;
}

/**
 * Reviewer identities the user marked OPTIONAL (non-blocking). slashdo's `~opt`
 * suffix is appended to each matching `--review-with` token, so an *inconclusive*
 * verdict from that reviewer (timeout / no-verdict / partial) no longer gates the
 * merge — a hard-error from it still does (slashdo `lib/multi-reviewer-loop.md`).
 * This is the escape hatch for a valuable-but-flaky reviewer (a local Ollama
 * model that often returns nothing) that would otherwise strand every PR on an
 * `inconclusive` aggregate.
 *
 * Each entry mirrors an *emitted* `--review-with` token so the builder's
 * membership test is a plain lookup: a keyed slug from `REVIEWER_VALUES`
 * (`ollama`, `lmstudio`, …) or an `@<username>`. Normalizes like the sibling
 * helpers — drop non-strings/unknown slugs/unsafe usernames, alias `gemini` →
 * `antigravity`, dedupe case-insensitively preserving order. Non-array → undefined
 * (an omitted field isn't persisted as an empty override).
 */
export function normalizeOptionalReviewers(list) {
  if (!Array.isArray(list)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const token = normalizeReviewerToken(raw);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/**
 * Resolve optional (non-blocking) reviewers with task-over-default precedence:
 * a task-level list (even explicitly empty) overrides the Code Review Defaults;
 * only fall back to the defaults when the task didn't pin its own. Mirrors
 * `resolveReviewUsernames`.
 */
export function resolveOptionalReviewers(metadataOptional, defaultOptional) {
  return Array.isArray(metadataOptional)
    ? (normalizeOptionalReviewers(metadataOptional) || [])
    : (normalizeOptionalReviewers(defaultOptional) || []);
}

/**
 * Factory for the token-keyed per-reviewer PIN normalizers (`~max=<n>` caps,
 * model ids, reasoning efforts). All three share one contract and only differ in
 * how they validate a single value, so the contract lives here once:
 *
 * - Non-object input → `undefined`, so an omitted field isn't persisted as an
 *   empty override (an explicitly empty `{}` IS kept — it's a real "clear the
 *   defaults for this task" choice).
 * - Keys are normalized to the exact token `--review-with` emits
 *   (`normalizeReviewerToken`), so the maps can't disagree about what a reviewer
 *   is called; unknown tokens are dropped.
 * - First spelling wins for two names of one reviewer (`gemini`/`antigravity`,
 *   `@Bot`/`@bot`) — mirrors `normalizeOptionalReviewers`' dedupe.
 * - A value `normalizeOne` rejects is DROPPED, never coerced — for every pin
 *   kind, "absent" and "a falsy value" mean different things downstream.
 *
 * `Object.create(null)` while building so a reviewer token can't collide with
 * `Object.prototype` keys; spread on return so callers get a plain object.
 *
 * @param {(value: unknown, token: string) => unknown} normalizeOne - returns the
 *   validated value, or a falsy value to drop the entry.
 */
function keyedReviewerPinNormalizer(normalizeOne) {
  return (map) => {
    if (!isPlainObject(map)) return undefined;
    const out = Object.create(null);
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const token = normalizeReviewerToken(rawKey);
      if (!token) continue;
      const value = normalizeOne(rawValue, token);
      if (!value && value !== 0) continue;
      if (Object.prototype.hasOwnProperty.call(out, token)) continue;
      out[token] = value;
    }
    return { ...out };
  };
}

/**
 * Factory for the matching task-over-default resolvers: a task-level map — even
 * an explicitly empty one — overrides the Code Review Defaults; only an
 * absent/malformed one falls back. Mirrors `resolveOptionalReviewers`.
 *
 * @param {(map: unknown) => Object|undefined} normalizeMap - the normalizer this
 *   pin kind was built with.
 */
function keyedReviewerPinResolver(normalizeMap) {
  return (metadataMap, defaultMap) => (isPlainObject(metadataMap)
    ? (normalizeMap(metadataMap) || {})
    : (normalizeMap(defaultMap) || {}));
}

// Ceiling on a per-reviewer `~max=<n>` cap. slashdo's inner loops carry their own
// 10-iteration safety guardrail, so a budget above it can never be spent —
// accepting one would just be a lie in the flag string.
export const MAX_REVIEWER_MAX_ROUNDS = 10;

/**
 * Per-reviewer iteration caps — slashdo's `~max=<n>` suffix (v3.25.0). Caps how
 * many review → fix → re-review cycles ONE reviewer runs before it stops, so a
 * slow local model can be included in a chain without paying for its otherwise
 * hardcoded 3 rounds (`--review-with claude~max=2,ollama~max=1,codex~max=3`).
 * Stored as a token-keyed map (`{ ollama: 1, '@flaky-bot': 0 }`) rather than a
 * list because the cap carries a value; the key is the same *emitted*
 * `--review-with` token `normalizeOptionalReviewers` uses.
 *
 * **Absent ≠ 0.** slashdo reads `~max=0` as "loop until this reviewer is clean"
 * (bounded by its own 10-round guardrail), which is the OPPOSITE of "no cap
 * requested" (that keeps slashdo's built-in default of 3 for CLI/Ollama
 * reviewers). So a missing key and an explicit `0` must never collapse: an entry
 * whose value isn't a usable cap is DROPPED rather than coerced to `0`.
 * Drops unknown tokens, non-integers, negatives, and anything above
 * MAX_REVIEWER_MAX_ROUNDS so a hand-edited settings.json can't smuggle in an
 * unbounded budget. Non-object input → undefined (an omitted field isn't
 * persisted as an empty override).
 *
 * `0` is the one pin value that is falsy AND meaningful, which is why the shared
 * factory keeps it explicitly.
 */
export const normalizeReviewerMaxRounds = keyedReviewerPinNormalizer((rawValue) => (
  // Only a genuine non-negative integer is a cap. A string "2", null, NaN, or
  // 1.5 is not — and must NOT fall through to 0, which slashdo reads as
  // "unlimited".
  (Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= MAX_REVIEWER_MAX_ROUNDS)
    ? rawValue
    : undefined
));

/**
 * Resolve per-reviewer iteration caps with task-over-default precedence: a
 * task-level map (even explicitly empty) overrides the Code Review Defaults;
 * only fall back to the defaults when the task didn't pin its own. Mirrors
 * `resolveOptionalReviewers`.
 */
export const resolveReviewerMaxRounds = keyedReviewerPinResolver(normalizeReviewerMaxRounds);

// Upper bound on a pinned reviewer model id. Generous (Bedrock/Ollama ids get
// long) but present so a hand-edited settings.json can't smuggle in a blob that
// then round-trips the TASKS.md store.
export const MAX_REVIEWER_MODEL_LENGTH = 200;

// Characters a model id may not contain, because they are STRUCTURAL in the
// emitted `--review-with` token and there is no escape for them:
//  - `]` would close the `[<model>]` selector early (`foo]~opt` → a corrupt entry
//    whose remainder slashdo then parses as suffixes),
//  - `[` would open a nested one,
//  - `,` would split the entry list, turning one reviewer into two bogus ones,
//  - whitespace that breaks lines would split the single-line flag string.
// Everything else stays legal on purpose: the value is free-form in slashdo's
// grammar (`agy[Gemini 3.5 Flash (High)]` is valid), and the field has to accept
// whatever id the user's environment actually needs. A space is fine; a newline is
// not.
const REVIEWER_MODEL_FORBIDDEN_RE = /[[\],\r\n\t]/;

/**
 * Validate ONE reviewer model id — the single definition shared by the
 * token-keyed map normalizer, the `<reviewer>Model` settings scalars, and the
 * defaults→map adapter, so a pin can't be accepted by one path and dropped by
 * another (which would show the user a stored pin that never reaches a reviewer).
 *
 * Returns the trimmed id, or `undefined` when it isn't usable: a non-string, a
 * blank/whitespace-only value (absent ≠ `''` — a `--model ` with no id would break
 * the invocation), an over-long one, one carrying a structural delimiter, or one
 * naming a reviewer that takes no model. Pass `reviewer` to apply that last check.
 */
function normalizeReviewerModel(raw, reviewer = null) {
  if (reviewer !== null && !MODEL_SELECTABLE_REVIEWERS.includes(reviewer)) return undefined;
  if (typeof raw !== 'string') return undefined;
  const model = raw.trim();
  if (!model || model.length > MAX_REVIEWER_MODEL_LENGTH) return undefined;
  if (REVIEWER_MODEL_FORBIDDEN_RE.test(model)) return undefined;
  return model;
}

// Reviewers whose slashdo `--review-with` entry accepts a `[<model>]` bracket
// (`lib/multi-reviewer-loop.md`: codex/claude/agy/grok/cursor/ollama). A
// PORTOS_ONLY_REVIEWERS entry has no slashdo counterpart at all, so a pinned
// model for it never becomes a bracket, and `copilot`/`@login` entries reject
// one outright.
export const BRACKET_MODEL_REVIEWERS = MODEL_SELECTABLE_REVIEWERS.filter(r => !PORTOS_ONLY_REVIEWERS.includes(r));

/**
 * Per-reviewer model pins — the model id ONE reviewer runs with, keyed by the
 * same emitted `--review-with` token as `normalizeOptionalReviewers` /
 * `normalizeReviewerMaxRounds` (e.g. `{ codex: 'gpt-5.6-sol', ollama: 'qwen2.5:7b' }`).
 *
 * The value is free-text on purpose: a reviewer CLI is spawned by the *agent*,
 * not by PortOS's argv builder, so the id the user needs is environment-specific
 * (a Bedrock-form Claude id on a Bedrock box, an installed Ollama model for an
 * Ollama-backed `claude`). We validate the shape, not the catalog.
 *
 * Only MODEL_SELECTABLE_REVIEWERS can carry a pin — `copilot` has no CLI and a
 * `@username` reviewer is a human/bot, mirroring slashdo rejecting `copilot[…]`
 * and `@login[…]`. An absent key means "let that reviewer pick its own default",
 * which is NOT the same as an empty string, so a blank/whitespace value is
 * DROPPED rather than persisted as `''` (a `--model ` with no id would break the
 * reviewer invocation). Non-object input → undefined, so an omitted field isn't
 * persisted as an empty override.
 *
 * An id carrying a character that is structural in the emitted token
 * (REVIEWER_MODEL_FORBIDDEN_RE — `[`, `]`, `,`, line breaks) is dropped rather
 * than emitted: there's no escape for them inside `[<model>]`, so `foo]~opt` would
 * close the selector early and leave slashdo parsing the remainder as a suffix.
 * Dropping is the safe failure — the reviewer falls back to its own default model
 * instead of running against a corrupt reviewer list.
 */
export const normalizeReviewerModels = keyedReviewerPinNormalizer(normalizeReviewerModel);

/**
 * Resolve per-reviewer model pins with task-over-default precedence: a
 * task-level map (even explicitly empty) overrides the Code Review Defaults;
 * only fall back to the defaults when the task didn't pin its own. Mirrors
 * `resolveReviewerMaxRounds`.
 */
export const resolveReviewerModels = keyedReviewerPinResolver(normalizeReviewerModels);

/**
 * Fold the Code Review Defaults' per-reviewer model SCALARS
 * (`codexModel` / `claudeModel` / `lmstudioModel` / `ollamaModel`) into the
 * token-keyed map shape the resolvers and the picker UI both speak.
 *
 * The scalars are the persisted settings encoding and stay that way — they cross
 * installs, and rewriting them to a map would need a migration for zero gain.
 * This is the one adapter between the two shapes; everything downstream works in
 * map form.
 */
export function reviewerModelsFromDefaults(defaults) {
  const out = {};
  for (const r of MODEL_SELECTABLE_REVIEWERS) {
    // Re-checked here, not trusted: settings.json is hand-editable, and a value
    // stored before the scalars were validated must not surface as a pin the token
    // builders would then drop.
    const model = normalizeReviewerModel(defaults?.[`${r}Model`], r);
    if (model) out[r] = model;
  }
  return out;
}

// Reasoning-effort ladder for the local-LLM reviewers. Their review request goes
// out as an OpenAI-compatible `/v1/chat/completions` call, whose `reasoning_effort`
// field both LM Studio and Ollama accept for thinking models — but only over the
// low/medium/high tier names. The wider CLI ladder (`minimal`/`xhigh`/`max`/
// `ultra`) is vendor-CLI vocabulary that an OpenAI-shaped backend can reject, so
// the local reviewers get their own, narrower set.
export const LOCAL_LLM_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

/**
 * Reviewer slug → the reasoning-effort ladder that reviewer accepts. Only
 * reviewers WITH an effort control appear: `copilot` is a GitHub review, `grok`'s
 * CLI has no effort control of any kind, and an `@username` reviewer is a person.
 *
 * A ladder here means "the user can PICK a level", not "the CLI takes an
 * `--effort` flag" — `cursor` accepts a level only as a variant baked into its
 * model id, so it appears here while `reviewerEffortArgs` returns `[]` for it
 * and `reviewerModelArg` folds the level into `--model` instead.
 *
 * Built once at module load and DERIVED from `effortLevelsForProvider` rather
 * than restated, so a reviewer's ladder here is exactly the one
 * `reviewerEffortArgs` (and the agent-spawn argv builder) will accept — a CLI
 * that gains or loses a tier moves both at once. The lookup goes through
 * `reviewerCliBinary` because that's what identifies the CLI: the `antigravity`
 * slug names no executable, `agy` does.
 *
 * Mirrored in `client/src/components/cos/constants.js` (pinned by a parity test)
 * so the picker only offers a level the server would keep.
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
 * Every reviewer the user can pick an effort for — the effort-capable CLIs
 * (`claude`, `codex`, `antigravity`, `cursor`) plus the local-LLM backends.
 */
export const EFFORT_SELECTABLE_REVIEWERS = Object.freeze(Object.keys(REVIEWER_EFFORT_LEVELS));

/**
 * The ladder for ONE reviewer token, or `null` when it takes no effort. Accepts
 * the `gemini` alias; an `@username` token resolves to null like any non-reviewer.
 *
 * @param {string} reviewer - reviewer slug
 * @returns {readonly string[]|null}
 */
export function reviewerEffortLevels(reviewer) {
  if (typeof reviewer !== 'string') return null;
  const slug = reviewer.trim().toLowerCase();
  return REVIEWER_EFFORT_LEVELS[REVIEWER_ALIASES[slug] ?? slug] || null;
}

/**
 * Validate ONE reviewer effort — the single definition shared by the token-keyed
 * map normalizer and the `<reviewer>Effort` settings scalars, so a level can't be
 * accepted by one path and dropped by another.
 *
 * `reviewer` is REQUIRED — this is the tight branch by design. Defaulting it to
 * "any known effort" would validate against the union of every ladder, so a
 * caller that forgot the argument would quietly accept `ollama: 'ultra'` and
 * `antigravity: 'max'`, the exact values the drop-don't-clamp contract exists to
 * reject.
 *
 * Returns the level, or `undefined` when it isn't usable: a non-string, a level
 * outside that reviewer's own ladder (`agy` really does reject `--effort max`),
 * or a reviewer with no effort control at all. Deliberately NOT clamped the way
 * `resolveCliEffort` clamps a provider pin: this value is user-chosen from a
 * per-reviewer list, so an out-of-ladder entry means the stored config is stale
 * or hand-edited, and silently reviewing at a *different* effort than the one
 * displayed is worse than falling back to the reviewer's own default.
 */
export function normalizeReviewerEffort(raw, reviewer) {
  if (typeof raw !== 'string') return undefined;
  const effort = raw.trim().toLowerCase();
  if (!effort) return undefined;
  return reviewerEffortLevels(reviewer)?.includes(effort) ? effort : undefined;
}

/**
 * Per-reviewer reasoning-effort pins — how hard ONE reviewer thinks, keyed by the
 * same emitted `--review-with` token as `normalizeReviewerModels` (e.g.
 * `{ codex: 'high', ollama: 'low' }`).
 *
 * Three carriers, depending on who invokes the reviewer. On a slashdo invocation
 * it rides the emitted token as `~effort=<level>` (`markSuffixes`), which slashdo
 * turns into the reviewer's own flag. Where PortOS drives the invocation itself it
 * is spelled out instead: the review-loop follow-up prompt's CLI command line
 * (`codex -c model_reasoning_effort=high`, `claude --effort high`) and the
 * `reasoning_effort` field of the local reviewer's `/api/code-review/local` body.
 *
 * An absent key means "let that reviewer use its own default effort", which is
 * NOT the same as a blank string, so an unusable value is DROPPED rather than
 * persisted. Non-object input → undefined, so an omitted field isn't persisted as
 * an empty override.
 */
export const normalizeReviewerEfforts = keyedReviewerPinNormalizer(normalizeReviewerEffort);

/**
 * Resolve per-reviewer effort pins with task-over-default precedence: a
 * task-level map (even explicitly empty) overrides the Code Review Defaults;
 * only fall back to the defaults when the task didn't pin its own. Mirrors
 * `resolveReviewerModels`.
 */
export const resolveReviewerEfforts = keyedReviewerPinResolver(normalizeReviewerEfforts);

/**
 * Resolve a task's whole reviewer configuration against the Code Review Defaults
 * in one call — the reviewer list plus every per-reviewer pin, each with the same
 * task-over-default precedence its own resolver defines.
 *
 * The prompt builder resolves this set at three separate spawn paths (the review
 * follow-up, the claim prompt, and the light/cleanup prompt). Hand-copying six
 * resolver calls per site meant adding a pin kind was a three-site edit where a
 * missed site is silent: the pin is configured, persisted, and displayed, but
 * never reaches the reviewer, and no test fails. One bundle, one edit.
 *
 * Shape matches `resolveReviewLoopOptions`'s in `services/codeReview.js`, minus
 * the stop-mode/applies fields that come from elsewhere at these call sites.
 */
export function resolveReviewerConfig(metadata, codeReviewDefaults, defaultReviewers) {
  return {
    reviewers: normalizeReviewers(metadata, defaultReviewers),
    usernames: resolveReviewUsernames(metadata?.usernames, codeReviewDefaults?.usernames),
    optionalReviewers: resolveOptionalReviewers(metadata?.optionalReviewers, codeReviewDefaults?.optionalReviewers),
    reviewerMaxRounds: resolveReviewerMaxRounds(metadata?.reviewerMaxRounds, codeReviewDefaults?.reviewerMaxRounds),
    ...resolveReviewerPins(metadata, codeReviewDefaults)
  };
}

/** The reviewer a claim flow falls back to when its resolved list is unusable. */
const CLAIM_REVIEWER_FALLBACK = ['codex'];

/**
 * Constrain an already-resolved reviewer list to what an UNATTENDED claim run can
 * actually invoke: `copilot` is a forge-side PR reviewer with no CLI, so a claim
 * agent told to "review with copilot" has nothing to run and stalls (#2507).
 * An empty result falls back to `codex` rather than to `DEFAULT_REVIEWERS`
 * (which is `copilot`, the very thing being removed).
 */
export function claimSafeReviewers(reviewers) {
  const kept = (Array.isArray(reviewers) ? reviewers : []).filter((reviewer) => reviewer !== 'copilot');
  return kept.length ? kept : [...CLAIM_REVIEWER_FALLBACK];
}

/**
 * `resolveReviewerConfig` plus the claim flow's copilot guard and the emitted
 * `--review-with` token list — the ONE resolver a claim prompt's reviewer text
 * and a claim task's persisted `reviewers` metadata both go through, so the two
 * cannot name different reviewers.
 *
 * The generators resolve their list before a task record exists (they read
 * schedule metadata + Code Review Defaults); the prompt builder resolves it from
 * the persisted task metadata at spawn time. Feeding both the same function is
 * what makes `reviewerConfigMetadata`'s round-trip exact.
 */
export function resolveClaimReviewerConfig(metadata, codeReviewDefaults, defaultReviewers) {
  const config = resolveReviewerConfig(metadata, codeReviewDefaults, defaultReviewers);
  const reviewers = claimSafeReviewers(config.reviewers);
  return {
    ...config,
    reviewers,
    csv: buildReviewersCsv(reviewers, config.usernames, config.optionalReviewers, config.reviewerMaxRounds, config.reviewerModels, config.reviewerEfforts)
  };
}

/**
 * The reviewer fields a task must PERSIST so a later
 * `resolveReviewerConfig(task.metadata, …)` resolves the same list its prompt
 * names, instead of re-deriving the install-wide Code Review Defaults (#4770).
 *
 * All six travel together: resolving only `reviewers` still lets the usernames,
 * `~opt` set, and the three keyed pins fall back to the defaults, which is the
 * same disagreement one field down. Sanitized on the way out so a hand-crafted
 * request body can't smuggle an unrecognized key onto the task record, and every
 * value is re-validated rather than trusted.
 */
export function reviewerConfigMetadata(config) {
  return sanitizeTaskMetadata({
    reviewers: config?.reviewers,
    usernames: config?.usernames,
    optionalReviewers: config?.optionalReviewers,
    reviewerMaxRounds: config?.reviewerMaxRounds,
    reviewerModels: config?.reviewerModels,
    reviewerEfforts: config?.reviewerEfforts
  }) || {};
}

/**
 * Resolve the model and effort pins TOGETHER — `{ reviewerModels, reviewerEfforts }`
 * with task-over-default precedence, already reconciled into a pair the reviewer's
 * CLI accepts (`pairReviewerModelsAndEfforts`).
 *
 * The two are never legitimately resolved apart: an `antigravity` model id can
 * carry its effort as a suffix, so whoever resolves the models must also be
 * holding the efforts to hand the suffix to. Resolving them separately is the
 * footgun — three prompt-building sites in `cosTaskGenerator.js` had already
 * hand-copied the pair of calls, and each would have emitted an
 * `agy --model <suffixed-id> --effort <tier>` invocation agy rejects. This is the
 * one call every site makes instead.
 *
 * Deliberately NOT expressed on `lib/llmRoutePin.js` (#4793). That module owns a
 * single `{ providerId, model, effort }` triple; a reviewer pin is two maps keyed
 * by reviewer slug, with no provider dimension at all — the slug IS the routing
 * key — and its precedence is whole-MAP (an explicitly empty task map overrides
 * the defaults), not per-field. Its effort is also validated against each
 * reviewer's OWN ladder via `normalizeReviewerEffort`, which is strictly narrower
 * than the union `EFFORT_LEVELS` enum the shared schema uses: `agy` really does
 * reject `--effort max`. There is no shape the two can meet in without losing
 * that narrowing, so this stays hand-rolled.
 *
 * @param {Object} [pins] - task metadata (or explicit options) carrying
 *   `reviewerModels` / `reviewerEfforts` maps; an absent map falls back to the
 *   Code Review Defaults, an explicitly empty one overrides them.
 * @param {Object} [codeReviewDefaults] - the `<reviewer>Model` / `<reviewer>Effort` scalars
 * @returns {{reviewerModels: Object<string,string>, reviewerEfforts: Object<string,string>}}
 */
export function resolveReviewerPins(pins, codeReviewDefaults) {
  return pairReviewerModelsAndEfforts(
    resolveReviewerModels(pins?.reviewerModels, reviewerModelsFromDefaults(codeReviewDefaults)),
    resolveReviewerEfforts(pins?.reviewerEfforts, reviewerEffortsFromDefaults(codeReviewDefaults))
  );
}

/**
 * Reconcile the resolved model and effort pins into a pair the reviewer's CLI
 * will actually accept, and return them as `{ reviewerModels, reviewerEfforts }`.
 *
 * Only `antigravity` needs reconciling. `agy models` enumerates its reasoning
 * tiers as separate model ids (`gemini-3.6-flash-high`), so a hand-typed pin can
 * carry an effort inside the model — and `agy` validates the PAIR, so
 * `--model gemini-3.6-flash-high --effort high` is not the same thing as the
 * `--model <base> --effort high` it expects. Splitting here mirrors what
 * `resolveAntigravityModelAndEffort` already does for PortOS's own agy spawns:
 * the base id becomes the model, and the baked tier supplies the effort ONLY when
 * the user pinned none (an explicit pick always wins).
 *
 * Applied once inside `resolveReviewerPins` rather than at each emission site, so
 * the slashdo `agy[<model>]` bracket, the effort instruction, and the review-loop
 * prompt's literal command line all describe the same invocation.
 *
 * @param {Object<string,string>} [reviewerModels]
 * @param {Object<string,string>} [reviewerEfforts]
 * @returns {{reviewerModels: Object<string,string>, reviewerEfforts: Object<string,string>}}
 */
export function pairReviewerModelsAndEfforts(reviewerModels, reviewerEfforts) {
  const models = { ...(reviewerModels || {}) };
  const efforts = { ...(reviewerEfforts || {}) };
  const { base, effort } = splitAntigravityModel(models.antigravity);
  if (effort && base) {
    models.antigravity = base;
    if (!normalizeReviewerEffort(efforts.antigravity, 'antigravity')) efforts.antigravity = effort;
  }
  return { reviewerModels: models, reviewerEfforts: efforts };
}

/**
 * Every token-keyed per-reviewer pin, as `[metadataKey, normalizeMap]`.
 *
 * The three pins share one persist contract, so the two places that copy them
 * out of caller input — `sanitizeTaskMetadata` here and `addTask` in
 * `cosTaskStore.js` — iterate this table instead of hand-copying a block per
 * pin. Adding a fourth pin kind is then a one-line change that reaches both
 * persist paths at once; a hand-copied block missed at one site would silently
 * drop the pin at write time while every other layer still carried it.
 *
 * Shared semantics for all three: the value is a MAP keyed by the emitted
 * `--review-with` token, and an explicitly empty map is KEPT — that's a real
 * "override the Code Review Defaults back to each reviewer's own default" choice,
 * distinct from an absent key (fall back to the defaults). Individual entries the
 * normalizer can't validate are DROPPED rather than coerced, so a hand-edited
 * settings.json can't smuggle in a cap slashdo would read as "loop until clean"
 * (`~max=0`), a model a reviewer doesn't take, or an effort level its CLI rejects.
 */
export const KEYED_REVIEWER_PINS = [
  ['reviewerMaxRounds', normalizeReviewerMaxRounds],
  ['reviewerModels', normalizeReviewerModels],
  ['reviewerEfforts', normalizeReviewerEfforts]
];

/**
 * Fold the Code Review Defaults' per-reviewer effort SCALARS (`codexEffort` /
 * `claudeEffort` / `antigravityEffort` / `lmstudioEffort` / `ollamaEffort`) into
 * the token-keyed map shape the resolvers and the picker UI both speak — the
 * effort twin of `reviewerModelsFromDefaults`, and the one adapter between the
 * two shapes.
 */
export function reviewerEffortsFromDefaults(defaults) {
  const out = {};
  for (const r of EFFORT_SELECTABLE_REVIEWERS) {
    // Re-checked, not trusted: settings.json is hand-editable, and a stale level
    // must not surface as a pin the invocation builders would then drop.
    const effort = normalizeReviewerEffort(defaults?.[`${r}Effort`], r);
    if (effort) out[r] = effort;
  }
  return out;
}

/**
 * The argv fragment a CLI reviewer takes for a reasoning-effort override —
 * `['--effort', 'high']` for claude/agy, `['-c', 'model_reasoning_effort=high']`
 * for codex, `[]` for everything else. Delegates to `buildEffortArgs` so the flag
 * shape has exactly one home (the spawn builders use the same one).
 *
 * **`cursor` is deliberately `[]` despite having a ladder.** `cursor-agent` has
 * no `--effort` flag and exits non-zero on one, so its level rides `--model`
 * instead — build that with `reviewerModelArg`. Anything that renders a cursor
 * invocation must call BOTH, or it will silently drop the pin (or, worse,
 * hand-roll the `--effort` this returns nothing for).
 *
 * **Normalizes first, deliberately.** `buildEffortArgs` CLAMPS an out-of-ladder
 * value (`agy` + `max` → `--effort high`), which is right for a provider pin the
 * user set against a different provider, but wrong here: a reviewer effort is
 * chosen from that reviewer's own list, so an out-of-ladder value means stale or
 * hand-edited state — and emitting a clamped flag would run the review at an
 * effort the picker displays as `unsupported`. Dropping to the reviewer's own
 * default is the honest failure, matching `normalizeReviewerEffort`'s contract.
 * The normalize is here rather than left to callers because this function is
 * reached with raw task metadata (`reviewLoopReviewerEfforts`), which no
 * normalizer has necessarily touched.
 *
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} effort
 * @returns {string[]}
 */
export function reviewerEffortArgs(reviewer, effort) {
  const binary = reviewerCliBinary(reviewer);
  if (!binary) return [];
  const level = normalizeReviewerEffort(effort, reviewer);
  if (!level) return [];
  return buildEffortArgs(level, { id: reviewer, command: binary });
}

/**
 * The id a CLI reviewer's `--model` flag should carry, or `null` when there is
 * no model to pin. The twin of `reviewerEffortArgs`: together they are the whole
 * invocation a pinned reviewer needs, and the ONLY place that knows which of the
 * two carries a cursor effort.
 *
 * For every reviewer but `cursor` this is just the pinned id, threaded verbatim
 * (the id is environment-specific free text — see `normalizeReviewerModels`).
 * For `cursor` the effort is folded in as Cursor's native model variant
 * (`gpt-5` + `max` → `gpt-5[effort=max]`), matching slashdo's own fold, because
 * `cursor-agent` has no `--effort` flag. A cursor effort with no model pinned
 * returns `null` — there is nothing to attach the variant to, and emitting a
 * flag cursor rejects is worse than letting it use its default tier. (The picker
 * says so on the row, so the dropped tier isn't silent to the user.)
 *
 * The extend-an-existing-bracket and leave-an-`effort=`-alone arms of the fold
 * can't be reached by a STORED reviewer pin today — `normalizeReviewerModel`
 * rejects `[`/`]`/`,` because they're structural in the emitted `--review-with`
 * token. They serve the paths that don't go through that gate: a provider's own
 * `defaultModel` and hand-written task metadata.
 *
 * @param {string} reviewer - reviewer slug
 * @param {string|null|undefined} model - the pinned model id
 * @param {string|null|undefined} [effort] - the pinned effort (cursor only)
 * @returns {string|null}
 */
export function reviewerModelArg(reviewer, model, effort) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return null;
  const slug = typeof reviewer === 'string' ? reviewer.trim().toLowerCase() : '';
  if ((REVIEWER_ALIASES[slug] ?? slug) !== 'cursor') return id;
  const level = normalizeReviewerEffort(effort, 'cursor');
  return level ? foldCursorEffortIntoModel(id, level) : id;
}

/**
 * Prose instruction carrying the per-reviewer effort pins into a prompt whose
 * agent spawns the reviewer CLI ITSELF — the claim flows (which run each
 * configured reviewer by hand, no `--review-with` anywhere in the prompt) and a
 * slashdo invocation that pins no reviewer list.
 *
 * **Not for an invocation that pins `--review-with`.** slashdo's entry grammar is
 * `<agent>[<model>](~opt|~max=<n>|~effort=<level>)*`, and `markSuffixes` emits
 * that `~effort=` suffix, so the pin already reaches the CLI the loop spawns.
 * Restating it as prose there is worse than silent: the agent passes the flag a
 * second time, or hand-runs a reviewer the loop was about to run. Pass the
 * emitted `--review-with` text as `reviewWith` and this returns '' when it sees
 * the suffix — one check, so a caller can't decide wrong.
 *
 * Scoped to CLI reviewers on purpose — `ollama`/`lmstudio` have no binary to
 * name (their effort rides the `POST /api/code-review/local` body instead).
 *
 * `cursor` needs its MODEL to say anything at all: its level is a variant of the
 * model id, never a flag, so pass `reviewerModels` — a cursor pin with no model
 * emits nothing rather than an `--effort` its CLI rejects.
 *
 * @param {string[]} reviewers - the reviewer slugs the invocation emits
 * @param {Object<string, string>} [reviewerEfforts] - token-keyed effort pins
 * @param {Object} [options]
 * @param {string} [options.reviewWith] - the `--review-with` text this prompt
 *   emits, if any. A `~effort=` in it means slashdo already carries the pin.
 * @param {Object<string, string>} [options.reviewerModels] - token-keyed model
 *   pins, needed only to render a cursor invocation (see above)
 * @returns {string} a single sentence, or '' when nothing is left to say
 */
export function buildReviewerEffortNote(reviewers, reviewerEfforts = {}, { reviewWith = '', reviewerModels = {} } = {}) {
  if (typeof reviewWith === 'string' && reviewWith.includes('~effort=')) return '';
  const efforts = normalizeReviewerEfforts(reviewerEfforts) || {};
  const models = normalizeReviewerModels(reviewerModels) || {};
  const entries = (Array.isArray(reviewers) ? reviewers : [])
    .map((r) => {
      // No binary, nothing to name: `lmstudio`/`ollama` reach their backend over
      // HTTP, and copilot/@username aren't commands at all. Checked FIRST so no
      // branch below can render a `null` command into a prompt.
      const binary = reviewerCliBinary(r);
      if (!binary) return null;
      const args = reviewerEffortArgs(r, efforts[r]);
      if (args.length) return `\`${binary} ${args.join(' ')}\``;
      // No effort ARGV, but the reviewer may still carry the level inside
      // --model (cursor). Gated on the effort pin so this stays an effort note:
      // a model-only pin is not this sentence's business.
      if (!normalizeReviewerEffort(efforts[r], r)) return null;
      const model = reviewerModelArg(r, models[r], efforts[r]);
      return model ? `\`${binary} --model ${model}\`` : null;
    })
    .filter(Boolean);
  if (!entries.length) return '';
  return `Invoke each reviewer CLI at its pinned reasoning effort: ${entries.join(', ')}. Pass the flag yourself when you spawn the reviewer — nothing else in this prompt applies it (a \`~effort=<level>\` suffix in a reviewer list is slashdo's own grammar, which only its \`--review-with\` parses).`;
}

// Examples of slashdo commands that run a review loop and therefore resolve
// `--review-with` from a saved default when the invocation doesn't pin one.
// EXAMPLES, deliberately — the rule is stated over "any `/do:*` that reviews"
// because the real roster is larger and moves with the submodule (`/do:review`,
// `/do:better`, `/do:better-swift`, `/do:depfree`, `/do:release` all read it
// too). A hand-maintained enumeration is the part that rots, and a command
// missing from it would read as exempt.
const REVIEW_LOOP_SLASHDO_EXAMPLES_MD = ['/do:pr', '/do:next', '/do:review', '/do:rpr']
  .map(command => `\`${command}\``).join(', ');

/**
 * The reviewer slug inside an emitted `--review-with` token, without its
 * `[<model>]` / `~<suffix>` decoration — the inverse of `markSuffixes`, which is
 * the only thing that ever builds one. Kept beside its emitter, and pinned to it
 * by a round-trip test, so a grammar change can't silently mis-slug here.
 */
export const reviewerTokenSlug = (token) => String(token).split('[')[0].split('~')[0].trim().toLowerCase();

/**
 * Prose block pinning a claim prompt's reviewer list against slashdo's SAVED
 * defaults.
 *
 * The claim flows hand-run their reviewers, so the prompt names the list and
 * emits no flag. But the claim agent is usually a Claude Code session with
 * slashdo installed, and reaching for `/do:pr` mid-flow is a short step from
 * the phase text — at which point slashdo resolves `--review-with` from the
 * host's saved defaults (`.slashdo.json` at the repo root, or the host CLI's
 * `.slashdo-config.json`), i.e. some OTHER user-level reviewer set, plus
 * whatever `merge` default rides with it. That silently replaces the reviewers
 * PortOS resolved for this run. So state the pin once, in the prompt, with the
 * exact token list to pass.
 *
 * `reviewersCsv` must be the text `buildReviewersCsv` emits — the same
 * `<agent>[<model>]~opt~max=<n>~effort=<level>` grammar `--review-with` parses —
 * so the agent can paste it verbatim.
 *
 * Unlike `buildReviewWithArgs` this does NOT suppress a lone bare `copilot`
 * (the #2507 stall): every claim path resolves its list through
 * `claimSafeReviewers`, which strips `copilot` and falls back to `codex`,
 * so the suppressed case cannot reach here. A future caller that skips that
 * normalizer has to add the guard rather than assume it.
 *
 * @param {string} reviewersCsv - the emitted reviewer token list
 * @returns {string} a Markdown block, or '' when there is no list to pin
 */
export function buildReviewerPinNote(reviewersCsv) {
  const csv = typeof reviewersCsv === 'string' ? reviewersCsv.trim() : '';
  if (!csv) return '';
  // A `@login` entry is always a valid slashdo reviewer; a keyed one is valid
  // unless PortOS serves it itself. Emitting a PORTOS_ONLY_REVIEWERS slug in a
  // `--review-with` list would abort the command outright, so it is dropped from
  // the flag text and named separately with the procedure that DOES run it.
  const tokens = csv.split(',').map(t => t.trim()).filter(Boolean);
  const flagTokens = tokens.filter(t => t.startsWith('@') || !PORTOS_ONLY_REVIEWERS.includes(reviewerTokenSlug(t)));
  // Named by bare slug: the `[<model>]`/`~<suffix>` decoration is slashdo
  // grammar, and these reviewers never reach a slashdo parser.
  const portosOnly = [...new Set(tokens.filter(t => !flagTokens.includes(t)).map(reviewerTokenSlug))];

  return [
    '## Reviewer pin — use the reviewers PortOS configured',
    `PortOS resolved this run's reviewers from its own configuration: \`${csv}\`. That list is authoritative for every review in this run — it is the same list the phases above name. Never substitute a different reviewer set for it.`,
    flagTokens.length
      && `**A saved slashdo default must never stand in for it.** If you invoke ANY slashdo \`/do:*\` command that runs a review loop (${REVIEW_LOOP_SLASHDO_EXAMPLES_MD}, and others), pass \`--review-with ${flagTokens.join(',')}\` explicitly. A bare invocation resolves \`--review-with\` from the host's saved defaults instead — \`.slashdo.json\` at the repo root, or the host CLI's \`.slashdo-config.json\` — which name a different reviewer set and can carry an auto-merge default this run never asked for.`,
    flagTokens.length
      && 'Pass those tokens exactly as written: their `[<model>]`, `~opt`, `~max=<n>`, and `~effort=<level>` suffixes are slashdo grammar and already carry each reviewer\'s pinned model, optional/blocking status, round cap, and reasoning effort — so do not also apply those by hand on that path.',
    portosOnly.length
      && `PortOS runs \`${portosOnly.join('`, `')}\` itself — no slashdo slug, so never a \`--review-with\` value. That review happens through the Local Reviewer Procedure below, and leaving it out of a slashdo invocation is not permission to skip it.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the set of lowercased optional-reviewer tokens for a fast membership
 * test in the builders. Tolerates the raw (unnormalized) list.
 */
function optionalReviewerSet(optionalReviewers) {
  return new Set((normalizeOptionalReviewers(optionalReviewers) || []).map(t => t.toLowerCase()));
}

/**
 * Build a lowercased-token → cap lookup for the builders. Tolerates the raw
 * (unnormalized) map. A `Map` (not a plain object) so a reviewer token can never
 * collide with `Object.prototype` keys, and so `.get()` distinguishes an absent
 * cap (`undefined`) from an explicit `0`.
 */
function reviewerMaxRoundsLookup(reviewerMaxRounds) {
  const normalized = normalizeReviewerMaxRounds(reviewerMaxRounds) || {};
  return new Map(Object.entries(normalized).map(([token, max]) => [token.toLowerCase(), max]));
}

/**
 * Build a lowercased-token → model-id lookup for the builders. Tolerates the raw
 * (unnormalized) map. A `Map` for the same reasons as the cap lookup.
 */
function reviewerModelLookup(reviewerModels) {
  const normalized = normalizeReviewerModels(reviewerModels) || {};
  return new Map(Object.entries(normalized).map(([token, model]) => [token.toLowerCase(), model]));
}

/**
 * Build a lowercased-token → effort-level lookup for the builders. Tolerates the raw
 * (unnormalized) map. A `Map` for the same reasons as the cap and model lookups.
 */
function reviewerEffortLookup(reviewerEfforts) {
  const normalized = normalizeReviewerEfforts(reviewerEfforts) || {};
  return new Map(Object.entries(normalized).map(([token, effort]) => [token.toLowerCase(), effort]));
}

/**
 * Render one emitted `--review-with` entry: the reviewer token, its optional
 * `[<model>]` selector, then slashdo's per-entry suffixes in canonical storage
 * order — `~opt`, `~max=<n>`, then `~effort=<level>`.
 *
 * Order matters. slashdo's grammar is
 * `entry := ( <agent> [ "[" <model> "]" ] | "@" <login> ) ( "~opt" | "~max=" <n> | "~effort=" <level> )*`
 * and its parser strips the `~` suffixes from the RIGHT before reading the
 * bracket — so the bracket has to sit between the slug and the suffixes.
 *
 * A reviewer with no pinned model emits no bracket, which is what leaves that
 * reviewer's own default in place; likewise a reviewer with no cap emits no
 * `~max` at all (`~max=0` is a real, distinct value meaning "loop until clean"), and
 * a reviewer with no effort level emits no `~effort`.
 * Only BRACKET_MODEL_REVIEWERS get a bracket — `copilot`/`@login` reject one, and
 * PortOS's `lmstudio` reviewer has no slashdo slug at all (its model rides in the
 * `POST /api/code-review/local` body instead).
 */
function markSuffixes(token, optSet, maxLookup, modelLookup, effortLookup) {
  const key = token.toLowerCase();
  const max = maxLookup?.get(key);
  const model = BRACKET_MODEL_REVIEWERS.includes(key) ? modelLookup?.get(key) : undefined;
  const effort = effortLookup?.get(key);
  return `${token}${model ? `[${model}]` : ''}${optSet.has(key) ? '~opt' : ''}${max === undefined ? '' : `~max=${max}`}${effort ? `~effort=${effort}` : ''}`;
}

/**
 * Resolve task metadata to an ordered, deduped reviewer list. Prefers the new
 * `reviewers` array; falls back to the legacy single `reviewer` string. When
 * the metadata yields nothing, returns `fallback` (default `['copilot']`) —
 * pass the settings-resolved defaults here so a Review Loop run picks up the
 * user's Code Review Defaults instead of the hardcoded copilot when the task
 * itself didn't pin reviewers. Filters to known reviewers and preserves
 * first-occurrence order.
 */
export function normalizeReviewers(meta, fallback = DEFAULT_REVIEWERS) {
  const raw = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const seen = new Set();
  const out = [];
  for (const r of source) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  if (out.length) return out;
  const fallbackList = [];
  const fallbackSeen = new Set();
  for (const r of Array.isArray(fallback) ? fallback : []) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !fallbackSeen.has(normalized)) {
      fallbackSeen.add(normalized);
      fallbackList.push(normalized);
    }
  }
  return fallbackList.length ? [...fallbackList] : [...DEFAULT_REVIEWERS];
}

/**
 * Resolve the keyed (enum) reviewer list, honoring the "username-only" case: an
 * EXPLICITLY empty keyed list with username reviewers present (e.g. copilot was
 * stripped on a non-GitHub forge) stays empty rather than falling back to the
 * copilot default normalizeReviewers would apply. Absent/legacy input still
 * normalizes to the default. Single source for the guard shared by
 * `buildReviewWithArgs` and the review-loop follow-up prompt builder.
 */
export function resolveKeyedReviewers(reviewers, hasUsernames) {
  if (Array.isArray(reviewers) && reviewers.length === 0 && hasUsernames) return [];
  return normalizeReviewers({ reviewers });
}

/**
 * Build the comma-separated reviewer token list used to fill the `{reviewers}`
 * placeholder in claim/plan prompts: keyed reviewers (falling back to the
 * default when empty) followed by `@user` tokens for the reviewer usernames.
 * Reviewers in `optionalReviewers` get slashdo's `~opt` non-blocking suffix, and
 * reviewers carrying a `reviewerMaxRounds` cap get `~max=<n>` after it. A
 * reviewer with a `reviewerModels` pin gets slashdo's `[<model>]` selector
 * between the slug and those suffixes, and a reviewer with a `reviewerEfforts` pin
 * gets `~effort=<level>`.
 * The flag-string variant is `buildReviewWithArgs`.
 */
export function buildReviewersCsv(reviewers, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}) {
  const keyed = Array.isArray(reviewers) && reviewers.length ? reviewers : [...DEFAULT_REVIEWERS];
  const users = normalizeReviewUsernames(usernames);
  const optSet = optionalReviewerSet(optionalReviewers);
  const maxLookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const modelLookup = reviewerModelLookup(reviewerModels);
  const effortLookup = reviewerEffortLookup(reviewerEfforts);
  const combined = [...keyed, ...users.map(u => `@${u}`)];
  return combined.map(t => markSuffixes(t, optSet, maxLookup, modelLookup, effortLookup)).join(',');
}

/**
 * Build the slashdo review flag string for an ordered reviewer list plus any
 * arbitrary GitHub reviewer usernames.
 * - `--review-with a,b,@user` only when the effective list isn't the lone default
 *   copilot (any username, or any non-default keyed reviewer, forces it on).
 *   Usernames are appended as `@user` tokens after the keyed reviewers.
 * - `--review-stop-on-*` only when the effective list is 2+ (stop-mode is
 *   meaningless for one).
 * - `--reviewer-applies` only when a non-copilot KEYED reviewer is present (a
 *   username reviewer is an external PR reviewer, not a CLI that applies fixes).
 * - Reviewers in `optionalReviewers` get slashdo's `~opt` non-blocking suffix on
 *   their emitted token, so an inconclusive verdict from them doesn't gate the
 *   merge. Reviewers with a `reviewerMaxRounds` cap get `~max=<n>` after it,
 *   a reviewer with a `reviewerModels` pin gets a `[<model>]` selector before both,
 *   and a reviewer with a `reviewerEfforts` pin gets `~effort=<level>`.
 *   A lone default `copilot` that is marked optional, carries a cap, or carries an
 *   effort DOES force the flag on (otherwise the suffix — the whole point — would be
 *   dropped with the flag).
 *
 * Everything past `reviewers` is an options object: the two reviewer-name lists
 * (`usernames` / `optionalReviewers`) and the three per-reviewer lookup maps
 * (`reviewerMaxRounds` / `reviewerModels` / `reviewerEfforts`) are same-shaped.
 *
 * @param {string[]} reviewers - ordered keyed reviewer slugs
 * @param {Object} [options]
 * @param {string} [options.stopMode] - review stop mode (`all` / `on-findings` / `on-clean`)
 * @param {boolean} [options.reviewerApplies] - emit `--reviewer-applies`
 * @param {string[]} [options.usernames] - GitHub reviewer usernames (emitted as `@user`)
 * @param {string[]} [options.optionalReviewers] - reviewers that get the `~opt` suffix
 * @param {Object<string, number>} [options.reviewerMaxRounds] - per-reviewer `~max=<n>` caps
 * @param {Object<string, string>} [options.reviewerModels] - per-reviewer `[<model>]` pins
 * @param {Object<string, string>} [options.reviewerEfforts] - per-reviewer `~effort=<level>` pins
 * @returns {string} the slashdo review flag string (possibly empty)
 */
export function buildReviewWithArgs(reviewers, {
  stopMode = DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies = false,
  usernames = [],
  optionalReviewers = [],
  reviewerMaxRounds = {},
  reviewerModels = {},
  reviewerEfforts = {},
} = {}) {
  const users = normalizeReviewUsernames(usernames);
  const keyed = resolveKeyedReviewers(reviewers, users.length > 0);
  const combined = [...keyed, ...users.map(u => `@${u}`)];
  const optSet = optionalReviewerSet(optionalReviewers);
  const maxLookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const modelLookup = reviewerModelLookup(reviewerModels);
  const effortLookup = reviewerEffortLookup(reviewerEfforts);
  // The lone-default-copilot suppression only applies when copilot carries NO
  // per-entry suffix — a `copilot~opt` / `copilot~max=2` / `copilot~effort=high` list must still
  // emit the flag to carry that suffix.
  const isDefaultOnly = combined.length === 1 && combined[0] === DEFAULT_REVIEWER
    && !optSet.has(DEFAULT_REVIEWER) && maxLookup.get(DEFAULT_REVIEWER) === undefined
    && effortLookup.get(DEFAULT_REVIEWER) === undefined;
  const hasNonCopilot = keyed.some(r => r !== DEFAULT_REVIEWER);
  const parts = [];
  if (!isDefaultOnly) parts.push(`--review-with ${combined.map(t => markSuffixes(t, optSet, maxLookup, modelLookup, effortLookup)).join(',')}`);
  if (combined.length >= 2) {
    if (stopMode === 'on-findings') parts.push('--review-stop-on-findings');
    else if (stopMode === 'on-clean') parts.push('--review-stop-on-clean');
  }
  if (reviewerApplies && hasNonCopilot) parts.push('--reviewer-applies');
  return parts.join(' ');
}

// A generic file attachment uploaded via POST /api/attachments and referenced
// by the returned metadata — matches the fileInfo shape TaskAddForm.jsx sends
// (client/src/utils/fileUpload.js uploadAttachmentFile).
const cosTaskAttachmentSchema = z.object({
  filename: z.string(),
  originalName: z.string().optional(),
  path: z.string(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
});

// Structured auto-fix diagnostics (#2328) — the record autoFixer.buildFixDiagnostics
// attaches to error-driven tasks so downstream telemetry can break auto-fix outcomes
// out by fallback tier / category / failure reason. Server-internal today (autoFixer
// calls addTask directly), but validated for schema parity now that addTask persists
// it as first-class metadata.
const cosTaskDiagnosticsSchema = z.object({
  triggerEvent: z.string().optional(),
  target: z.string().optional(),
  errorType: z.string().optional(),
  category: z.string().optional(),
  tier: z.number().optional(),
  fixStrategy: z.string().optional(),
  failureReason: z.string().optional(),
}).passthrough();

// Reasoning-effort override for effort-capable CLIs (claude/codex). On create,
// '' from a form's "Default" option → undefined (no override persisted). On
// update, ''/null must survive as null so the store's legacy-field normalizer
// deletes the pin (absent-vs-cleared, AGENTS.md) — emptyToUndefined would drop
// the clear signal at the route's `!== undefined` gate and make a set effort
// permanent through the API.
const effortInputSchema = z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional());
const effortUpdateSchema = z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional());
// Federated instance this task is PINNED to (#4520) — only that instance's CoS
// evaluator claims and runs it. On create, '' from the picker's "Any instance"
// option → undefined (no pin persisted). On update, ''/null must survive as null
// so the route can clear an existing pin (absent-vs-cleared, AGENTS.md).
// Bounded-but-format-free on purpose: the id vocabulary is whatever the peers in
// this install's registry advertise, and the route is what checks membership.
const INSTANCE_ID_MAX_LENGTH = 128;
const targetInstanceIdInputSchema = z.preprocess(emptyToUndefined, z.string().trim().min(1).max(INSTANCE_ID_MAX_LENGTH).optional());
const targetInstanceIdUpdateSchema = z.preprocess(emptyToNull, z.string().trim().min(1).max(INSTANCE_ID_MAX_LENGTH).nullable().optional());
const taskTemperatureInputSchema = z.number().min(0).max(2).optional();
const taskTemperatureUpdateSchema = z.number().min(0).max(2).nullable().optional();

// A bare slashdo command name (`plan-task`, `pr-better`). Shared by the task
// schema and the quick-template schemas. `isValidSlashdoCommand` is the single
// definition of the shape — it also gates `loadSlashdoFile`'s path join.
const slashdoCommandSchema = z.string().refine(isValidSlashdoCommand, {
  message: 'must be a bare slashdo command name (lowercase, digits, hyphens)',
});

// The app Issues tab already fetched the selected forge issue while listing the
// page. Keep that payload bounded when it is carried into a manual claim so the
// prompt cannot be inflated by a hand-crafted request. The generator truncates
// direct service calls too; this is the route boundary for browser requests.
const prefetchedIssueContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000).optional(),
  body: z.string().max(12_000).optional(),
  url: z.string().max(2048).optional(),
});

// Optional guidance entered on the managed-app Issues tab. It is appended to
// the selected claim prompt, not stored as the task's human note, so it reaches
// the agent even though the claim prompt is assembled before queueing.
export const CLAIM_OVERRIDE_CONTEXT_MAX_CHARS = 4_000;
const claimOverrideContextSchema = z.preprocess(
  v => typeof v === 'string' ? (v.trim() || undefined) : v,
  z.string().max(CLAIM_OVERRIDE_CONTEXT_MAX_CHARS).optional()
);

export const createCosTaskSchema = z.object({
  description: z.string().min(1),
  diagnostics: cosTaskDiagnosticsSchema.optional(),
  priority: z.string().optional(),
  // `context` is the one-line human note; `prompt` is the full agent-facing
  // payload (#4153). A producer that passes a multi-line `context` is still
  // accepted — `cosTaskStore.addTask` routes it to `metadata.prompt`.
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: effortInputSchema,
  temperature: taskTemperatureInputSchema,
  thinking: z.boolean().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdInputSchema,
  type: z.string().optional().default('user'),
  approvalRequired: z.boolean().optional(),
  screenshots: z.array(z.string()).optional(),
  attachments: z.array(cosTaskAttachmentSchema).optional(),
  position: z.enum(['top', 'bottom']).optional().default('bottom'),
  createJiraTicket: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  jiraTicketId: z.string().optional(),
  jiraTicketUrl: z.string().optional(),
  useWorktree: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  whenDone: z.enum(['commit-push', 'leave-uncommitted']).optional(),
  // Read-only planning mode: investigate the codebase and file the issue, but
  // do not start implementation delivery. The task store expands this into
  // the safe no-worktree/no-PR/no-simplify posture before persistence.
  planOnly: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  openPR: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
  simplify: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // The slashdo catalog's deliverable posture (#3636): whether this run is
  // EXPECTED to leave commits in its worktree. A report-shaped workflow
  // (`/do:review`) carries `false` so downstream bookkeeping does not treat its
  // correctly-clean tree as missing code work. Carried onto the task by
  // `cosTaskStore.js` only on a strict boolean — absent means "no opinion".
  worktreeChangesExpected: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewLoop: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewer: z.preprocess(
    v => v === '' ? undefined : (typeof v === 'string' ? (REVIEWER_ALIASES[v] ?? v) : v),
    z.enum(REVIEWER_VALUES).optional()
  ),
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
  ),
  reviewStopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // Arbitrary GitHub reviewer usernames requested as PR reviewers to gate the
  // merge. Normalized (strip `@`, drop unsafe/duplicate tokens) so the schema
  // can't accept a shell-unsafe or oversized list. Absent → undefined (not `[]`)
  // so an omitted field isn't persisted as an empty override.
  usernames: z.preprocess(
    v => Array.isArray(v) ? normalizeReviewUsernames(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Reviewer identities (keyed slugs and/or `@username`) marked non-blocking —
  // emitted with slashdo's `~opt` suffix. Normalized so a hand-crafted request
  // can't smuggle junk in. Absent → undefined (not `[]`).
  optionalReviewers: z.preprocess(
    v => Array.isArray(v) ? normalizeOptionalReviewers(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Per-reviewer iteration caps (slashdo `~max=<n>`), keyed by the emitted
  // `--review-with` token. Normalized so a hand-crafted request can't smuggle in
  // an unbounded or non-integer budget. Absent → undefined (not `{}`); an entry
  // with no usable cap is dropped rather than coerced to `0` (which slashdo reads
  // as "loop until clean").
  reviewerMaxRounds: z.preprocess(
    v => normalizeReviewerMaxRounds(v),
    z.record(z.number().int().min(0).max(MAX_REVIEWER_MAX_ROUNDS)).optional()
  ),
  // Per-reviewer model pins, keyed by the emitted `--review-with` token — the
  // model id ONE reviewer runs with (emitted as slashdo's `[<model>]`, or threaded
  // into the follow-up prompt as `<reviewer> --model <id>`). Normalized so a
  // hand-crafted request can't pin a model on a reviewer that takes none, or
  // persist a blank id. Absent → undefined (not `{}`).
  reviewerModels: z.preprocess(
    v => normalizeReviewerModels(v),
    z.record(z.string().min(1).max(MAX_REVIEWER_MODEL_LENGTH)).optional()
  ),
  // Per-reviewer reasoning-effort pins, keyed by the emitted `--review-with`
  // token — how hard ONE reviewer thinks (`codex -c model_reasoning_effort=high`,
  // `claude --effort high`, or a local reviewer's `reasoning_effort` body field).
  // Normalized so a hand-crafted request can't pin an effort on a reviewer that
  // takes none, or a level that reviewer's CLI rejects. Absent → undefined (not `{}`).
  reviewerEfforts: z.preprocess(
    v => normalizeReviewerEfforts(v),
    z.record(z.enum(EFFORT_LEVELS)).optional()
  ),
  // Bundled slashdo workflow this task runs (#3089) — the BARE command name,
  // never a rendered `/do:x` string (see slashdoInvocation.js).
  slashdoCommand: z.preprocess(emptyToUndefined, slashdoCommandSchema.optional()),
  // Explicit arguments for the workflow. Absent → the prompt builder falls back
  // to the task description, which is what the task form sends.
  slashdoArgs: z.preprocess(emptyToUndefined, z.string().max(4000).optional()),
});

export const updateCosTaskSchema = z.object({
  description: z.string().min(1).optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: effortUpdateSchema,
  temperature: taskTemperatureUpdateSchema,
  thinking: z.boolean().nullable().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdUpdateSchema,
  blockedReason: z.string().optional(),
  type: z.string().optional().default('user'),
});

// Worker's dispute of a reviewer rejection (#2441). `reason` is the required
// case; `evidence` is optional supporting detail; `reviewer` names which reviewer
// verdict is being disputed (constrained to the known reviewer vocab). Bounds are
// generous but present so a hand-crafted request can't smuggle in an unbounded
// blob that then round-trips the TASKS.md store.
export const challengeTaskSchema = z.object({
  reason: z.string().trim().min(1).max(5000),
  evidence: z.string().trim().max(20_000).optional(),
  reviewer: z.enum(REVIEWER_VALUES).optional(),
});

// Automatic re-check request (#2471). Instead of a human `outcome`, the resolver
// re-runs a local-LLM reviewer against the current diff and derives the verdict
// from its fresh findings (classifyRecheckOutcome in cosChallenge.js). `model` is
// optional — falls back to the Code Review Defaults for the backend. Only the
// in-process local reviewers are supported here; CLI reviewers (claude/codex) are
// re-run by the follow-up agent itself, which then resolves with an explicit
// `outcome`.
export const challengeRecheckSchema = z.object({
  backend: z.enum(LOCAL_LLM_REVIEWERS),
  model: z.string().trim().min(1).optional(),
  diff: z.string().min(1).max(500_000),
});

// Resolution of a parked challenge (#2441, #2471). Either the caller supplies an
// explicit `outcome` (manual verdict) OR a `recheck` object (auto re-run a
// reviewer and derive the verdict) — exactly one, never both. `outcome` mirrors
// CHALLENGE_OUTCOMES in server/services/cosChallenge.js (source of truth; a parity
// test keeps them in lockstep). `upheld` overturns the rejection (task → pending);
// `escalated` surfaces the unresolved dispute to the user (task → blocked +
// arbitration task).
export const resolveChallengeSchema = z.object({
  outcome: z.enum(['upheld', 'escalated']).optional(),
  recheck: challengeRecheckSchema.optional(),
  note: z.string().trim().max(5000).optional(),
  resolvedBy: z.string().trim().max(200).optional(),
}).refine(
  (v) => (v.outcome != null) !== (v.recheck != null),
  { message: 'Provide exactly one of `outcome` or `recheck`.', path: ['outcome'] },
);

// =============================================================================
// LOOP SCHEMAS
// =============================================================================

export const createLoopSchema = z.object({
  prompt: z.string().min(1),
  interval: z.union([z.string().min(1), z.number().positive()]),
  name: z.string().optional(),
  cwd: z.string().optional(),
  providerId: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  timeout: z.number().positive().optional(),
  runImmediately: z.boolean().optional(),
});

// =============================================================================
// TASK SCHEDULE SCHEMAS
// =============================================================================

// Provenance of a schedule config's stored prompt. `promptCustomized` alone cannot
// tell a deliberate user pin from a flag the legacy migration inferred, so the
// self-heal in taskScheduleStore.js reads this instead (#5432):
//   'user'            — written by updateTaskInterval from an explicit prompt write.
//   'legacy-inferred' — written by the legacy migration's "differs from every known
//                       shipped default" branch.
// Absent/null is pre-existing state and is treated as 'legacy-inferred', so an
// install upgrading into this keeps today's self-heal behavior. Additive and
// absent-tolerant, so no migration is required.
export const PROMPT_SOURCES = ['user', 'legacy-inferred'];

// Empty string from a client clears the provenance rather than 400ing, matching
// the clearable-null convention the other schedule overrides use.
export const promptSourceSchema = z.preprocess(emptyToNull, z.enum(PROMPT_SOURCES).nullable().optional());

// =============================================================================
// COS JOB SCHEMAS
// =============================================================================

// Deterministic context sources that can be preloaded before a scheduled agent
// starts. The ids are persisted on both built-in schedule entries and custom
// agent jobs; taskDataInputs.js owns the I/O behind each id. Keep this catalog
// descriptive and side-effect-free so APIs can expose it directly to every
// configuration surface without duplicating labels or capabilities in clients.
export const taskDataInputsSchema = z.array(z.enum(TASK_DATA_INPUT_IDS))
  .max(TASK_DATA_INPUT_IDS.length)
  .transform((ids) => [...new Set(ids)]);

export const createCosJobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['agent', 'shell', 'script']).optional(),
  interval: z.string().optional(),
  intervalMs: z.number().positive().int().optional(),
  // Null actively clears a pinned time/cron mode on update. The jobs UI has
  // always emitted null for the inactive mode; accepting it here lets updateJob
  // distinguish "clear this field" from an omitted field it should preserve.
  scheduledTime: z.string().nullable().optional(),
  cronExpression: z.string().nullable().optional(),
  // Optional calendar rule for schedules that need an anchored interval (for
  // example every two weeks). cronExpression remains the compatibility preview
  // and the raw/custom path.
  cronSchedule: recurrenceRuleSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.string().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  promptTemplate: z.string().optional(),
  // Deterministic repository/tracker context appended before the agent starts.
  // An empty array actively clears every selection on update; absent preserves
  // the stored selection.
  dataInputs: taskDataInputsSchema.optional(),
  command: z.string().optional(),
  triggerAction: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  // Optional AI provider + model override for agent jobs. Empty string from the
  // UI picker → null so a PUT can actively clear the override back to the active
  // provider/default model (updateJob only skips `undefined`). Forwarded into the
  // generated task's metadata as `provider`/`model` by generateTaskFromJob.
  providerId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional reasoning-effort override (claude/codex). Mirrors providerId's
  // clearable-null semantics — '' from the UI picker → null so a PUT can reset it
  // back to the provider default. Forwarded into the generated task's metadata as
  // `effort` by generateTaskFromJob; no-op'd at spawn for non-effort providers.
  effort: effortUpdateSchema,
  // Optional managed-app scope. Empty string from the UI picker → null so a PUT
  // can actively un-scope a job back to global (updateJob only skips `undefined`,
  // so undefined would silently preserve the old scope). Absent key stays
  // undefined (preserve existing on PUT, default null on create).
  appId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional git-workflow options for app-scoped agent jobs.
  taskMetadata: z.object({
    useWorktree: z.boolean().optional(),
    openPR: z.boolean().optional(),
    prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
    simplify: z.boolean().optional(),
    // Absent = true for code-shaped work. `false` marks a report-shaped job whose
    // deliverable is intentionally outside the worktree — see
    // ALLOWED_TASK_METADATA_KEYS below and agentTuiSpawning.js (#3102).
    worktreeChangesExpected: z.boolean().optional(),
    // PortOS-owned audits may succeed after proving the branch is empty; the
    // finalizer still requires the forge/no-commit proof before honoring this.
    noChangeSuccess: z.boolean().optional(),
  }).optional(),
});

export const updateCosJobSchema = createCosJobSchema.partial().extend({
  weekdaysOnly: z.boolean().optional(),
});

// =============================================================================
// COS LEARNING SCHEMAS
// =============================================================================

export const recordLearningInsightSchema = z.object({
  type: z.string().optional(),
  message: z.string().min(1),
  taskType: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

export const dismissRecommendationSchema = z.object({
  id: z.string().min(1),
  snapshot: z.unknown().optional(),
});

export const restoreRecommendationSchema = z.object({
  id: z.string().min(1),
});

export const generateWeeklyDigestSchema = z.object({
  weekId: z.string().optional(),
});

// =============================================================================
// QUICK TASK TEMPLATE SCHEMAS (#3089)
// =============================================================================

// Run-shape defaults a template implies. Every key is optional and each one is
// a tri-state: ABSENT means "leave the form's current toggle alone", `false`
// means "turn it off". Collapsing absent to false would make every template
// silently clear toggles it never intended to touch.
// `.strict()`, so every run-shape key a built-in (or user-saved) template may
// carry must be listed here — including the catalog's deliverable posture
// `worktreeChangesExpected`, or saving such a template 400s.
export const taskTemplateSettingsSchema = z.object({
  useWorktree: z.boolean().optional(),
  openPR: z.boolean().optional(),
  simplify: z.boolean().optional(),
  worktreeChangesExpected: z.boolean().optional(),
}).strict();

export const createTaskTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().min(1).max(4000),
  icon: z.string().max(16).optional(),
  context: z.string().max(4000).optional(),
  category: z.string().max(60).optional(),
  provider: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
  effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
  app: z.string().max(200).optional(),
  slashdoCommand: z.preprocess(emptyToUndefined, slashdoCommandSchema.optional()),
  settings: taskTemplateSettingsSchema.optional(),
}).strict();

// PUT accepts any subset — the route only forwards the keys actually present.
export const updateTaskTemplateSchema = createTaskTemplateSchema.partial();

// POST /templates/from-task snapshots a live task into a user template. Only the
// fields createTemplateFromTask actually reads are accepted.
export const taskTemplateFromTaskSchema = z.object({
  task: z.object({
    description: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    provider: z.string().max(120).optional(),
    model: z.string().max(200).optional(),
    effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
    app: z.string().max(200).optional(),
  }),
  templateName: z.string().trim().min(1).max(120).optional(),
});

// Global Code Review Loop defaults (settings.codeReview). Surfaced on the AI
// Providers page; TaskAddForm + ScheduleTab seed from this when the user
// hasn't already chosen a per-task / per-task-type reviewer list. The follow-
// up spawner reads it as the fallback for `reviewers` when none are passed in.
// `lmstudioModel` / `ollamaModel` are the installed model ids the local-LLM
// reviewer should run with (empty/undefined = pick the active default model).
// `codexModel` / `claudeModel` / `antigravityModel` are per-CLI-reviewer model
// tiers (see MODEL_CAPABLE_CLI_REVIEWERS) threaded into the review-loop follow-up
// prompt as `<reviewer> --model <id>` (empty/undefined = let that CLI pick its
// own default).
// `claudeModel` doubles as the Ollama model id when the user runs an
// Ollama-backed `claude` (isOllamaClaudeProvider) as their reviewer.
export const codeReviewSettingsSchema = z.object({
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
  ),
  // Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
  // reviewers to gate the merge, appended to `--review-with` after the keyed
  // reviewers. Normalized so a hand-edited settings.json can't smuggle in a
  // shell-unsafe or oversized token list. Absent → undefined (not `[]`).
  usernames: z.preprocess(
    v => Array.isArray(v) ? normalizeReviewUsernames(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Reviewer identities (keyed slugs and/or `@username`) marked non-blocking —
  // emitted with slashdo's `~opt` suffix so an inconclusive verdict from them
  // doesn't gate the merge (a hard-error still does). Absent → undefined.
  optionalReviewers: z.preprocess(
    v => Array.isArray(v) ? normalizeOptionalReviewers(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Per-reviewer iteration caps (slashdo `~max=<n>`) keyed by emitted token —
  // e.g. `{ ollama: 1 }` buys one review-and-fix pass from a slow local model.
  // Absent → undefined; an unusable entry is dropped, never coerced to `0`.
  reviewerMaxRounds: z.preprocess(
    v => normalizeReviewerMaxRounds(v),
    z.record(z.number().int().min(0).max(MAX_REVIEWER_MAX_ROUNDS)).optional()
  ),
  stopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.boolean().optional(),
  // Each scalar runs through the same shape check as a task-level pin
  // (`normalizeReviewerModel`), so a stored default can't carry an id the token
  // builders would silently drop — the picker would otherwise DISPLAY a pin that
  // never reaches a reviewer. An unusable value clears the field (undefined)
  // rather than persisting: same "absent = that reviewer's own default" contract.
  //
  // GENERATED from the roster, not hand-listed: this object is `.strict()`, so a
  // reviewer that gains model selection (`antigravity`, #3728) would have its
  // PATCH REJECTED until someone remembered to add a line here — while every other
  // site derives its `<reviewer>Model` key from MODEL_SELECTABLE_REVIEWERS and
  // would already be carrying the pin.
  ...Object.fromEntries(MODEL_SELECTABLE_REVIEWERS.map(reviewer => [
    `${reviewer}Model`,
    z.preprocess(v => normalizeReviewerModel(v, reviewer), z.string().optional()),
  ])),
  // Per-reviewer reasoning-effort defaults, one scalar per effort-capable reviewer
  // (the model scalars' twin — same rationale for staying scalars: the encoding
  // crosses installs). Each is checked against that reviewer's OWN ladder, so
  // `antigravityEffort: 'max'` — a level `agy` rejects — clears rather than
  // persisting a pin no invocation would carry.
  //
  // Generated from the roster for the same reason as the model scalars above.
  ...Object.fromEntries(EFFORT_SELECTABLE_REVIEWERS.map(reviewer => [
    `${reviewer}Effort`,
    z.preprocess(v => normalizeReviewerEffort(v, reviewer), z.string().optional()),
  ])),
}).strict();

// =============================================================================
// TASK METADATA SANITIZATION
// =============================================================================

// Agent behavior flags that can be overridden per-pipeline-stage
export const PIPELINE_BEHAVIOR_FLAGS = ['useWorktree', 'openPR', 'prCompletion', 'simplify', 'reviewLoop'];

// Absolute cap on total agent spawns per task (across all retry types)
export const MAX_TOTAL_SPAWNS = 5;

// `cleanupMerged` / `openPr` / `resolveConflicts` / `autoMerge` /
// `finishAbandoned` are the per-app action toggles for the `branch-reconcile`
// task type (`finishAbandoned` governs committing + shipping the uncommitted
// work left in a dead agent's worktree); `autoClose` is
// the `issue-reconcile` toggle (ON unless explicitly false — OFF forbids the
// coordinator from closing an issue or filing a follow-up, leaving it to only
// comment + release the claim). Each lives in the shared task-metadata
// allowlist — like `prAuthorFilter` / `issueAuthorFilter` — so a per-app
// override can disable an individual rectification behavior and survive
// sanitizeTaskMetadata.

// repo-sync's per-app / per-schedule action toggles. Each is ON unless
// explicitly `false` (branch-reconcile's opt-out convention), EXCEPT
// `reapRemotes`, which mutates `origin` and is therefore opt-IN. Lives here so
// the sanitizer's allowlist and services/repoSync.js read ONE list — the two
// drifting would silently drop a toggle at the app-override boundary.
export const REPO_SYNC_ACTION_KEYS = ['syncPush', 'syncPull', 'switchDefault', 'cleanupMerged', 'dropStashes', 'reapRemotes'];

const ALLOWED_TASK_METADATA_KEYS = [
  ...PIPELINE_BEHAVIOR_FLAGS, 'readOnly', 'claimFlow',
  'cleanupMerged', 'openPr', 'resolveConflicts', 'autoMerge', 'finishAbandoned', 'autoClose',
  // repo-sync's action toggles (REPO_SYNC_ACTION_KEYS above): publish branches
  // strictly ahead of their upstream, fast-forward the default branch, return the
  // checkout to it, delete merged branches, drop provably-redundant stashes, and
  // (opt-IN, since it mutates origin) reap merged orphan remote branches.
  // `cleanupMerged` deliberately reuses branch-reconcile's NAME because it means
  // the same thing — but task metadata is stored per task type, so the two are
  // independent settings. Turning it off on branch-reconcile does NOT turn it off
  // here; each task type carries its own value.
  ...REPO_SYNC_ACTION_KEYS,
  // repo-sync's per-app opt-OUT. The sweep is install-wide by design, so it
  // needs a key of its own rather than reading the per-app `enabled` flag next
  // to it: createApp SEEDS `{ enabled: false }` for every task type, so
  // `enabled` cannot distinguish "leave this repo alone" from "never configured",
  // and reading it would exclude every app on a fresh install. `enabled` still
  // governs whether the app gets its own SCHEDULED repo-sync run; this governs
  // whether the install-wide sweep visits its checkout.
  'skipRepoSync',
  // Throwaway-worktree posture for programmatic-I/O reasoning tasks (layered-
  // intelligence): the worktree is discarded without a merge or PR so a reasoning
  // agent can't land code. See agentWorktreeCleanup.js.
  'discardWorktree',
  // Whether a successful run is EXPECTED to leave file changes in the worktree
  // (#3102). Default (absent) = true for code-shaped work. `false` marks a task
  // type whose deliverable is outside the repo — e.g. a reference-watch run
  // against a GitHub/GitLab/JIRA work tracker files its proposals as issues and,
  // per the prompt, edits no application code, so a clean worktree is expected.
  'worktreeChangesExpected',
  // Allows a PortOS-owned audit's verified-empty-branch contract to survive
  // app task-type override sanitization. The finalizer also requires the
  // autonomous-job marker and a live forge proof before honoring it.
  'noChangeSuccess',
  // Audit-type toggle: file tracker issues (no code) vs implement the fix.
  // Dispatch stamps `noCodeOutput` when this is true. See server/lib/auditCatalog.js.
  'fileIssues',
  // Dispatch gate: when true, the generated system task is always awaiting-
  // approve — including an explicit Run Now. Absent/false keeps the default
  // (Run Now consents; unattended runs follow confidence/safety-kind).
  'requireApproval'
];

// pr-watcher author-gate values. 'self' = PRs opened by the gh-authenticated
// user (the PortOS operator / their automation); 'others' = everyone else;
// 'any' = no gate. Kept here so both the sanitizer and the prWatcher service
// agree on the vocabulary.
export const PR_AUTHOR_FILTERS = ['any', 'self', 'others'];

// claim-issue author-gate values. 'self' = only claim issues YOU filed (the
// gh/glab-authenticated `@me` account — the slashdo `/do:next --self` security
// boundary, and the default so a shared/multi-contributor tracker never
// auto-feeds third-party issues into an agent); 'collaborators' = you PLUS every
// account with repo/project access (a trusted-team widening of 'self' — the
// people who could already push code are not a lower trust tier than the issues
// they file); 'owner' = only claim issues filed by the repository
// owner/creator; 'any' = claim any open issue regardless of who filed it. Kept
// here so both the sanitizer and the claim-issue prompt-builder agree on the
// vocabulary.
export const ISSUE_AUTHOR_FILTERS = ['self', 'collaborators', 'owner', 'any'];

// repo-sync verify-mode vocabulary — when the coordinator agent is dispatched
// after the deterministic sweep. 'always' verifies every run; 'when-changed'
// (the default) verifies only a run that actually mutated a checkout, so a sweep
// over an already-clean machine makes no provider call at all; 'never' dispatches
// only when the sweep left something unresolved. An ESCALATION dispatches under
// every mode. Kept here so the sanitizer and services/repoSync.js agree on the
// vocabulary — and so the static task registry can name the default without
// importing the git-heavy service (it is deliberately dependency-light).
export const REPO_SYNC_VERIFY_MODES = ['always', 'when-changed', 'never'];
export const DEFAULT_REPO_SYNC_VERIFY_MODE = 'when-changed';

// `issueExcludeLabels` — extra labels a user wants left for human contributors
// (e.g. `good first issue`) rather than auto-claimed by claim-issue/claim-work.
// Unioned with the fixed NON_ACTIONABLE_ISSUE_LABELS set at read time
// (perpetualWork.js#isActionableIssue) — never replacing it. Capped well below
// GitHub/GitLab's own per-issue label limits; this is a short curated list, not
// an arbitrary label dump.
export const MAX_ISSUE_EXCLUDE_LABELS = 20;

// Per-entry length cap. GitHub caps a label name at 50 chars; GitLab allows up
// to 255. Cap at GitLab's (larger) limit rather than GitHub's — a GitHub
// label can never exceed 50 anyway, so the wider cap is a no-op there, while
// capping at 50 would silently truncate a valid long GitLab label to a prefix
// that never matches the real label, making the exclusion silently no-op.
const MAX_ISSUE_EXCLUDE_LABEL_LENGTH = 255;

/**
 * Normalize a raw `issueExcludeLabels` list: keep only non-empty strings,
 * trim, cap length per entry (GitLab's label name limit — the larger of the
 * two forges', see MAX_ISSUE_EXCLUDE_LABEL_LENGTH), case-insensitively
 * dedupe (labels are compared lowercased at read time), and cap the list at
 * MAX_ISSUE_EXCLUDE_LABELS. Unlike reviewer usernames, label text is
 * free-form ("good first issue") so no character-class restriction is
 * applied beyond trimming. Non-array input → [].
 */
export function normalizeIssueExcludeLabels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().slice(0, MAX_ISSUE_EXCLUDE_LABEL_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_ISSUE_EXCLUDE_LABELS) break;
  }
  return out;
}

// claim-issue `--swarm` fan-out size. Mirrors slashdo `/do:next --swarm=<N>`,
// which clamps N to 1..6 and treats bare `--swarm` as 3. Here a swarmCount of
// 0 (or absent) means swarm OFF (the default one-issue-per-run flow); a value
// of 2..6 turns on swarm with that many parallel claim agents. 1 is collapsed
// to off (a one-agent swarm is just the single-issue flow with overhead), so
// the smallest meaningful swarm is 2. Kept here so the sanitizer and the
// claim-issue prompt-builder agree on the vocabulary.
export const SWARM_COUNT_MIN = 2;
export const SWARM_COUNT_MAX = 6;

// branch-reconcile coordinator batch size. Unlike claim-issue's swarm count,
// this is the number of already-classified branches one coordinator receives
// in a run. A one-branch batch is valid, and the scheduler supplies the default
// when the key is absent so old task records remain compatible.
export const BRANCHES_PER_AGENT_MIN = 1;
export const BRANCHES_PER_AGENT_MAX = 6;

// POST /api/cos/tasks/slashdo — a `/do:*` button click from an app's Agent
// Operations panel. The run-settings fields are PICKED from createCosTaskSchema
// rather than restated, so the drawer's provider/model/effort/simplify/reviewer
// knobs stay in lockstep with the Add Task form's (one vocabulary, one set of
// preprocessors). `command` is only shape-checked here — the route owns the
// allowed-command map and its 400 message. The remaining fields are `/do:next`
// specific: `target` pins the run to ONE work item (empty ⇒ the agent picks),
// `issueContext` carries title/body already fetched by the app Issues tab, and
// `issueAuthorFilter` overrides the app's configured claim-work gate. The
// optional `overrideContext` is user guidance appended to the selected claim
// prompt, rather than the queue's one-line human note.
export const slashdoTaskSchema = createCosTaskSchema
  .pick({
    model: true, provider: true, effort: true, simplify: true,
    reviewers: true, usernames: true, optionalReviewers: true, reviewerMaxRounds: true,
    reviewerModels: true, reviewerEfforts: true
  })
  .extend({
    command: z.string().min(1),
    app: z.string().min(1),
    target: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
    // Content already fetched by the managed-app Issues tab for a manually
    // targeted forge claim. `buildClaimWorkTask` embeds it in the agent prompt;
    // scheduled/self-claim flows omit it and continue to read live issue state.
    issueContext: prefetchedIssueContextSchema.optional(),
    overrideContext: claimOverrideContextSchema,
    issueAuthorFilter: z.enum(ISSUE_AUTHOR_FILTERS).optional(),
  });

// POST /api/cos/agents/:id/resume — the resume dialog's edits for a paused
// agent's next run. PICKED from createCosTaskSchema for the same reason
// slashdoTaskSchema is: one vocabulary and one set of preprocessors for the
// provider/model/effort knobs, whichever form supplied them. Every field is
// optional — the resume requeues the paused agent's OWN task, so an untouched
// dialog is a valid "resume exactly as it was". `description` only matters on
// the fallback path where the paused task is gone and a fresh one is queued.
export const resumeCosAgentSchema = createCosTaskSchema
  .pick({ description: true, context: true, model: true, provider: true, effort: true, app: true, screenshots: true })
  .partial();

/**
 * Sanitize taskMetadata to an allow-list of agent-option keys. Boolean flags
 * (`useWorktree`/`openPR`/`simplify`/`reviewLoop`/`readOnly`/`claimFlow`/
 * `reviewerApplies`)
 * are kept only when actually boolean; constrained values include `prCompletion`,
 * reviewers, reviewer usernames, and `reviewStopMode` — plus a validated pipeline
 * object. Prevents prototype pollution and reserved-field overrides.
 * Returns a clean plain object or null if input is empty/invalid.
 */
export function sanitizeTaskMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = Object.create(null);
  let hasKeys = false;
  for (const key of ALLOWED_TASK_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === 'boolean') {
      clean[key] = raw[key];
      hasKeys = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'prCompletion') && PR_COMPLETION_VALUES.includes(raw.prCompletion)) {
    clean.prCompletion = raw.prCompletion;
    hasKeys = true;
  }
  // `reviewer` is a legacy single constrained string.
  const normalizedReviewer = REVIEWER_ALIASES[raw.reviewer] || raw.reviewer;
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewer') && REVIEWER_VALUES.includes(normalizedReviewer)) {
    clean.reviewer = normalizedReviewer;
    hasKeys = true;
  }
  // `reviewers` is the ordered multi-reviewer list — filter to known values, dedupe, preserve order.
  if (Array.isArray(raw.reviewers)) {
    const seen = new Set();
    const list = [];
    for (const r of raw.reviewers) {
      const normalized = REVIEWER_ALIASES[r] || r;
      if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); list.push(normalized); }
    }
    if (list.length) { clean.reviewers = list; hasKeys = true; }
  }
  // `usernames` is the arbitrary GitHub reviewer-username list — normalize to
  // shell-safe, deduped, capped tokens (strips `@`, drops bogus entries). Unlike
  // `reviewers` above, an explicitly empty array is KEPT (not dropped): for
  // usernames, `[]` is a meaningful "no external gate for this task/type" choice
  // that must override the Code Review Defaults, matching resolveReviewUsernames'
  // `Array.isArray` override contract and the task-form/global-panel surfaces.
  if (Array.isArray(raw.usernames)) {
    clean.usernames = normalizeReviewUsernames(raw.usernames);
    hasKeys = true;
  }
  // `optionalReviewers` marks reviewers non-blocking (slashdo `~opt`). Like
  // `usernames`, an explicitly empty array is KEPT so a task/type can override
  // the Code Review Defaults' optional set back to "none optional."
  if (Array.isArray(raw.optionalReviewers)) {
    clean.optionalReviewers = normalizeOptionalReviewers(raw.optionalReviewers) || [];
    hasKeys = true;
  }
  // The token-keyed per-reviewer pins (caps / model / effort). Like
  // `optionalReviewers`, an explicitly empty MAP is KEPT so a task/type can
  // override the Code Review Defaults back to "each reviewer's own default" —
  // see KEYED_REVIEWER_PINS for the shared contract.
  for (const [key, normalizeMap] of KEYED_REVIEWER_PINS) {
    if (!isPlainObject(raw[key])) continue;
    clean[key] = normalizeMap(raw[key]) || {};
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewStopMode') && REVIEW_STOP_MODES.includes(raw.reviewStopMode)) {
    clean.reviewStopMode = raw.reviewStopMode;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewerApplies') && typeof raw.reviewerApplies === 'boolean') {
    clean.reviewerApplies = raw.reviewerApplies;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'whenDone') && ['commit-push', 'leave-uncommitted'].includes(raw.whenDone)) {
    clean.whenDone = raw.whenDone;
    hasKeys = true;
  }
  // `prAuthorFilter` gates pr-watcher dispatch on PR authorship — constrained
  // to a known value so a hand-edited config can't smuggle in an arbitrary
  // string the watcher would silently treat as "any".
  if (Object.prototype.hasOwnProperty.call(raw, 'prAuthorFilter') && PR_AUTHOR_FILTERS.includes(raw.prAuthorFilter)) {
    clean.prAuthorFilter = raw.prAuthorFilter;
    hasKeys = true;
  }
  // `verifyMode` decides when repo-sync dispatches its coordinator agent after a
  // clean deterministic pass — constrained, so an arbitrary string can't reach the
  // dispatch gate (which would fall back to the default anyway, silently).
  if (Object.prototype.hasOwnProperty.call(raw, 'verifyMode') && REPO_SYNC_VERIFY_MODES.includes(raw.verifyMode)) {
    clean.verifyMode = raw.verifyMode;
    hasKeys = true;
  }
  // `issueAuthorFilter` gates claim-issue dispatch on issue authorship —
  // constrained to a known value so a hand-edited config can't smuggle in an
  // arbitrary string the claim flow would silently treat as "owner".
  if (Object.prototype.hasOwnProperty.call(raw, 'issueAuthorFilter') && ISSUE_AUTHOR_FILTERS.includes(raw.issueAuthorFilter)) {
    clean.issueAuthorFilter = raw.issueAuthorFilter;
    hasKeys = true;
  }
  // `issueExcludeLabels` — like `usernames`/`optionalReviewers` above, an
  // explicitly empty array is KEPT (not dropped): `[]` is a meaningful "no
  // extra exclusions for this task/type" choice that must override a global
  // default's non-empty list, not silently inherit it.
  if (Array.isArray(raw.issueExcludeLabels)) {
    clean.issueExcludeLabels = normalizeIssueExcludeLabels(raw.issueExcludeLabels);
    hasKeys = true;
  }
  // `swarmCount` turns claim-issue `--swarm` fan-out on (2..6 parallel agents)
  // or off. 0 is kept as an explicit "off" (so a per-app override can disable
  // swarm even when the global default has it on — `0` = off, absent = inherit);
  // 2..6 is the swarm size. 1/non-integer/out-of-range are dropped, so a
  // hand-edited config can't smuggle in an unbounded swarm size. The prompt
  // builder treats anything below SWARM_COUNT_MIN as off (resolveSwarmBlock).
  if (Object.prototype.hasOwnProperty.call(raw, 'swarmCount')
      && Number.isInteger(raw.swarmCount)
      && (raw.swarmCount === 0
        || (raw.swarmCount >= SWARM_COUNT_MIN && raw.swarmCount <= SWARM_COUNT_MAX))) {
    clean.swarmCount = raw.swarmCount;
    hasKeys = true;
  }
  // `branchesPerAgent` bounds the branch-reconcile prompt to a deterministic
  // prefix of the prioritized in-flight set. It is separate from swarmCount:
  // branch-reconcile runs one coordinator over a batch, while claim-issue fans
  // out independent issue agents. Absent means inherit; there is no "off"
  // value because the task default intentionally supplies a safe batch size.
  if (Object.prototype.hasOwnProperty.call(raw, 'branchesPerAgent')
      && Number.isInteger(raw.branchesPerAgent)
      && raw.branchesPerAgent >= BRANCHES_PER_AGENT_MIN
      && raw.branchesPerAgent <= BRANCHES_PER_AGENT_MAX) {
    clean.branchesPerAgent = raw.branchesPerAgent;
    hasKeys = true;
  }
  // Pass through pipeline config (validated shape: object with stages array)
  if (raw.pipeline && typeof raw.pipeline === 'object' && Array.isArray(raw.pipeline.stages)) {
    clean.pipeline = raw.pipeline;
    hasKeys = true;
  }
  return hasKeys ? { ...clean } : null;
}

// =============================================================================
// CoS RUN EVENT LEDGER (read-only diagnostics, #4540)
// =============================================================================

// Query bounds for the read-only run-event diagnostics under
// `/api/agents/activity/run-events`. `z.coerce` because these arrive as query
// strings; the `limit` ceiling IS the ledger's own `RUN_EVENT_READ_LIMITS.max`
// (imported, not copied — a literal here would drift into 400-ing requests the
// service would happily serve, or clamping ones it would refuse).
export const runEventsQuerySchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  kind: z.enum(AGENT_RUN_EVENT_KINDS).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();

export const runEventProjectionsQuerySchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();

// A projection id is either a run id or the `agent:<agentId>` fallback key a
// run that never got an id folds under (see `runEventKey`).
export const runEventProjectionIdSchema = z.object({
  id: z.string().min(1).max(140)
});

// Reconciliation report/repair (#4540). `runId` narrows to one run; `limit`
// shares the ledger's read ceiling because the projections being reconciled
// come straight off that read path — a separate ceiling here could only
// disagree with it.
export const runEventReconcileSchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();
