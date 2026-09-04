/**
 * Review-Loop reviewer vocabulary: which reviewers exist, what each one's
 * CLI/model/effort contract is, and how a reviewer set renders into slashdo's
 * `--review-with` argv (`buildReviewWithArgs`) and into the human-readable
 * reviewer notes spliced into agent prompts (`buildReviewerPinNote` /
 * `buildReviewerEffortNote`).
 *
 * Split out of cosValidation.js (issue #5702), which keeps the CoS Zod schemas
 * and re-exports everything here (`export * from './reviewerConfig.js'`) so
 * existing deep imports of cosValidation.js / validation.js keep working.
 * This module must stay Zod-free — it is pure reviewer domain vocabulary.
 */
import { isPlainObject } from './objects.js';
import { EFFORT_LEVELS, effortLevelsForProvider, buildEffortArgs, foldCursorEffortIntoModel, splitAntigravityModel, commandBasename, isConfiguredDefaultModel } from './providerModels.js';
import { ANTIGRAVITY_COMMAND } from './antigravity.js';
import { CURSOR_COMMAND } from './cursor.js';

// Reviewer choices for the Review Loop. `copilot` requests a native GitHub
// Copilot review; `claude`/`antigravity`/`codex`/`grok`/`cursor`/`opencode`/`kimi`
// instruct the review-loop follow-up agent to invoke the named CLI to critique the
// PR diff; `lmstudio`/`ollama`/`mtplx` route the diff through PortOS's local
// code-review endpoint (`POST /api/code-review/local`) which runs the configured
// local LLM model.
//
// The roster deliberately covers EVERY coding-agent vendor PortOS can already
// spawn (`PROVIDER_VENDORS` in providerVendors.js) plus every OpenAI-compatible
// local backend it manages, so the provider a user is told is their best local
// coding agent is also selectable as their reviewer. `opencode` is the one CLI
// whose model flag is `-m` rather than `--model` (see REVIEWER_MODEL_FLAGS), and
// `opencode`/`kimi`/`mtplx` — like `lmstudio` — have no slashdo counterpart, so
// they are PORTOS_ONLY_REVIEWERS.
// Mirrored in client/src/components/cos/constants.js → REVIEWER_OPTIONS.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'grok', 'cursor', 'opencode', 'kimi', 'lmstudio', 'ollama', 'mtplx'];
export const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = ['copilot'];
// Reviewers that resolve to a local-LLM backend (rather than a CLI or GitHub
// bot). Used by the code-review endpoint, settings panel, and prompt builder
// to gate model-id resolution.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama', 'mtplx'];
// Reviewers PortOS serves ITSELF, with no counterpart in slashdo's reviewer
// vocabulary (`copilot`/`codex`/`agy`/`claude`/`grok`/`cursor`/`ollama`/`@login`):
// `lmstudio`/`mtplx` run through `POST /api/code-review/local`, which takes their
// model in the request body, and `opencode`/`kimi` are CLIs PortOS's own review
// procedure spawns. slashdo has no such slug, so none can carry a `[<model>]`
// bracket or appear in a `--review-with` list (an unknown value aborts the
// command). One constant so a future addition can't be fixed in one of those two
// places and missed in the other — `splitSlashdoReviewerTokens` is the shared
// partition every emitter goes through.
export const PORTOS_ONLY_REVIEWERS = ['lmstudio', 'mtplx', 'opencode', 'kimi'];
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
// `opencode` runs `opencode run -m <provider/model>` and `kimi` runs
// `kimi --model <id>`; neither offers a pickable effort, so they widen this roster
// past EFFORT_SELECTABLE_REVIEWERS the same way `grok` does. `reviewerModelFlag`
// owns which of `--model`/`-m` each one spells.
// Copilot/local-LLM reviewers are excluded — the former has no CLI, the latter
// get their model injected server-side by `POST /api/code-review/local`. Add a
// reviewer here when its CLI gains model selection; the `<reviewer>Model`
// settings scalar is generated from this roster (codeReviewSettingsSchema).
export const MODEL_CAPABLE_CLI_REVIEWERS = ['codex', 'claude', 'antigravity', 'grok', 'cursor', 'opencode', 'kimi'];
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
  opencode: 'opencode',
  kimi: 'kimi',
};

// The `--model` flag a CLI reviewer's binary actually spells. Only a reviewer
// that deviates from `--model` appears; `reviewerModelFlag` supplies the default
// for the rest. `opencode` takes its model as `opencode run -m <provider/model>`
// (mirroring `opencodeCliArgs` in providerVendors.js) — rendering `--model`
// there would have the follow-up agent probe for a flag that is not the
// documented one.
const REVIEWER_MODEL_FLAGS = { opencode: '-m' };

/**
 * The flag a CLI reviewer's pinned model must be passed with (`--model` unless
 * that reviewer's binary spells it differently). Accepts the `gemini` alias.
 *
 * @param {string} reviewer - reviewer slug
 * @returns {string}
 */
export function reviewerModelFlag(reviewer) {
  const slug = typeof reviewer === 'string' ? reviewer.trim().toLowerCase() : '';
  return REVIEWER_MODEL_FLAGS[REVIEWER_ALIASES[slug] ?? slug] || '--model';
}

/**
 * Is this reviewer a CLI the agent spawns itself? Derived by EXCLUSION rather
 * than from REVIEWER_CLI_BINARIES so a newly added CLI reviewer still drives the
 * review loop before anyone remembers to map its binary (the map's coverage is
 * pinned separately by reviewerConfig.test.js).
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
 * silently dropped. reviewerConfig.test.js pins the map's coverage so the window
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

// The task-metadata keys that TOGETHER form a task-local reviewer override —
// everything the picker writes, and so everything its "Use system Code Review
// Defaults" reset has to remove. A key missing here leaves a pin behind after a
// reset the user believes cleared it.
// Mirrored in client/src/lib/reviewerPins.js.
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

// The subset `resolveReviewerConfig` actually READS. `reviewStopMode` and
// `reviewerApplies` are deliberately absent: they are slashdo run flags, and a
// claim flow has no flag string to put them in (the claim prompt gets a reviewer
// CSV), so neither can change which reviewers a claim runs. Keying the reported
// `source` on the full roster would label a task `task-override` for a stop-mode
// the user set years ago and then send them to clear an "override" that is not
// supplying the list they are looking at.
export const REVIEWER_LIST_OVERRIDE_KEYS = Object.freeze(
  REVIEWER_OVERRIDE_KEYS.filter((key) => key !== 'reviewStopMode' && key !== 'reviewerApplies')
);

/**
 * Does this task metadata pin any part of the reviewer list itself (as opposed
 * to a run flag)? Key PRESENCE is the signal, not truthiness: an explicitly
 * empty `optionalReviewers: []` or `reviewerModels: {}` is a real override — it
 * clears the defaults' value — so collapsing it into "nothing configured" would
 * report the wrong source.
 */
export function hasReviewerOverride(metadata) {
  return isPlainObject(metadata) && REVIEWER_LIST_OVERRIDE_KEYS.some((key) => key in metadata);
}

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
export function normalizeReviewerModel(raw, reviewer = null) {
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
    reviewers: prioritizeToolFreeReviewers(normalizeReviewers(metadata, defaultReviewers)),
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
 * Put tool-free local-LLM reviewers ahead of every reviewer that can execute
 * tools or reach a forge. Public issue comments and contributor diffs cross the
 * trust boundary in that first pass; later reviewers see a chain that has
 * already received a no-tool inspection. Stable partitioning preserves the
 * user's order within the local and non-local groups.
 */
export function prioritizeToolFreeReviewers(reviewers) {
  const normalized = Array.isArray(reviewers) ? reviewers : [];
  return [
    ...normalized.filter((reviewer) => LOCAL_LLM_REVIEWERS.includes(reviewer)),
    ...normalized.filter((reviewer) => !LOCAL_LLM_REVIEWERS.includes(reviewer)),
  ];
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
      return model ? `\`${binary} ${reviewerModelFlag(r)} ${model}\`` : null;
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
 * Partition emitted `--review-with` tokens into the ones slashdo can parse and
 * the ones PortOS serves itself.
 *
 * slashdo's parser ABORTS the whole command on an unknown `--review-with` value,
 * so a PORTOS_ONLY_REVIEWERS slug in that flag doesn't degrade the run — it kills
 * it, and the PR the invocation existed to open never gets created. Every emitter
 * of that flag therefore drops those slugs and names them separately, alongside
 * the Local Reviewer Procedure that actually runs them.
 *
 * An `@login` entry is always a valid slashdo reviewer. `portosOnly` is reported
 * by BARE slug — the `[<model>]`/`~<suffix>` decoration is slashdo grammar, and
 * these reviewers never reach a slashdo parser.
 *
 * @param {string[]} tokens - emitted reviewer tokens (decorated or bare)
 * @returns {{flagTokens: string[], portosOnly: string[]}}
 */
export function splitSlashdoReviewerTokens(tokens) {
  const trimmed = (Array.isArray(tokens) ? tokens : []).map(t => String(t).trim()).filter(Boolean);
  const isSlashdoToken = t => t.startsWith('@') || !PORTOS_ONLY_REVIEWERS.includes(reviewerTokenSlug(t));
  return {
    flagTokens: trimmed.filter(isSlashdoToken),
    portosOnly: [...new Set(trimmed.filter(t => !isSlashdoToken(t)).map(reviewerTokenSlug))],
  };
}

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
  const { flagTokens, portosOnly } = splitSlashdoReviewerTokens(csv.split(','));

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
 * - A `PORTOS_ONLY_REVIEWERS` slug (`lmstudio`/`mtplx`/`opencode`/`kimi`) is
 *   DROPPED from the emitted list: slashdo aborts on an unknown `--review-with`
 *   value, so emitting one would kill the whole invocation rather than degrade
 *   it. With nothing left to name, no flag is emitted at all.
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
  const configured = [...keyed, ...users.map(u => `@${u}`)];
  // PortOS-only reviewers are dropped rather than emitted — see the doc comment
  // above and `splitSlashdoReviewerTokens`. The surrounding prompt still names the
  // full reviewer list and the Local Reviewer Procedure that runs them.
  const combined = splitSlashdoReviewerTokens(configured).flagTokens;
  const optSet = optionalReviewerSet(optionalReviewers);
  const maxLookup = reviewerMaxRoundsLookup(reviewerMaxRounds);
  const modelLookup = reviewerModelLookup(reviewerModels);
  const effortLookup = reviewerEffortLookup(reviewerEfforts);
  // The lone-default-copilot suppression only applies when copilot carries NO
  // per-entry suffix — a `copilot~opt` / `copilot~max=2` / `copilot~effort=high` list must still
  // emit the flag to carry that suffix.
  //
  // Measured against the CONFIGURED list, not the emitted one. Suppressing the
  // flag hands `--review-with` to the host's saved slashdo defaults, which name
  // some other reviewer set — right for a run that asked for nothing but the
  // default copilot, wrong for `[lmstudio, copilot]`, where the user chose this
  // pair and only lmstudio's slug is unemittable. Reading the filtered list here
  // would silently swap copilot out for whatever `.slashdo.json` happens to say.
  const isDefaultOnly = configured.length === 1 && configured[0] === DEFAULT_REVIEWER
    && !optSet.has(DEFAULT_REVIEWER) && maxLookup.get(DEFAULT_REVIEWER) === undefined
    && effortLookup.get(DEFAULT_REVIEWER) === undefined;
  const hasNonCopilot = combined.some(r => !r.startsWith('@') && r !== DEFAULT_REVIEWER);
  const parts = [];
  // Nothing slashdo can parse (a list of PortOS-only reviewers): emit no flag at
  // all rather than a bare `--review-with`.
  if (!isDefaultOnly && combined.length) parts.push(`--review-with ${combined.map(t => markSuffixes(t, optSet, maxLookup, modelLookup, effortLookup)).join(',')}`);
  if (combined.length >= 2) {
    if (stopMode === 'on-findings') parts.push('--review-stop-on-findings');
    else if (stopMode === 'on-clean') parts.push('--review-stop-on-clean');
  }
  if (reviewerApplies && hasNonCopilot) parts.push('--reviewer-applies');
  return parts.join(' ');
}

/**
 * The reviewer slug an AI provider config would review as, or `null` when the
 * provider is nothing the Review Loop can run (a hosted API provider with no
 * spawnable CLI, an unrecognized binary).
 *
 * Two ways in, matching how the two reviewer kinds are actually identified:
 * a local-LLM reviewer is named by PROVIDER ID (`ollama`/`lmstudio`/`mtplx` —
 * it has no binary; `POST /api/code-review/local` talks to the daemon), and a
 * CLI reviewer is named by the BINARY its provider spawns, looked up through
 * `REVIEWER_CLI_BINARIES` so the slug↔executable mapping stays in one table
 * (`antigravity` is the stored slug, `agy` the command — see that constant).
 *
 * An Ollama/SGLang-backed `claude` or `opencode` wrapper resolves to the
 * `claude` / `opencode` reviewer on purpose: the reviewer runs the same binary
 * against the same environment, and its model pin is free text precisely so a
 * locally-served id can be named.
 *
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {string|null}
 */
export function reviewerForProvider(provider) {
  if (!isPlainObject(provider)) return null;
  const id = typeof provider.id === 'string' ? provider.id.trim().toLowerCase() : '';
  if (LOCAL_LLM_REVIEWERS.includes(id)) return id;
  const command = commandBasename(provider.command);
  if (!command) return null;
  return Object.entries(REVIEWER_CLI_BINARIES).find(([, binary]) => binary === command)?.[0] || null;
}

/**
 * Code Review Defaults derived from the install's DEFAULT AI provider — the
 * reviewer chain an install gets before anyone opens Settings › Code Reviewers.
 *
 * The historical fallback was a hardcoded `['copilot']`, which is wrong on two
 * counts: an install with no GitHub Copilot subscription gets a review that
 * never arrives, and an install that has already told PortOS which agent it
 * wants to run gets a different one for review with no way to have known. So
 * the fallback follows the active provider instead — same vendor, same model,
 * same reasoning effort — and only falls back to `DEFAULT_REVIEWERS` when the
 * provider maps to no reviewer at all (a hosted API provider, or none set).
 *
 * The model is dropped when it is a `*-configured-default` sentinel: that
 * string is a marker meaning "whatever the CLI is configured for", not an id
 * the reviewer's `--model` could take. The effort is dropped when it falls
 * outside that reviewer's own ladder, the same drop-don't-clamp rule
 * `normalizeReviewerEffort` applies everywhere else.
 *
 * Returns `null` (not a partial object) when there is nothing to derive, so the
 * caller can tell "no provider-derived default" from "derived, with no pins".
 *
 * @param {{id?:string, command?:string, defaultModel?:string, effort?:string}|null|undefined} provider
 * @returns {{reviewer: string, model: string|null, effort: string|null}|null}
 */
export function codeReviewDefaultsFromProvider(provider) {
  const reviewer = reviewerForProvider(provider);
  if (!reviewer) return null;
  const rawModel = provider.defaultModel;
  return {
    reviewer,
    model: isConfiguredDefaultModel(rawModel) ? null : (normalizeReviewerModel(rawModel, reviewer) ?? null),
    effort: normalizeReviewerEffort(provider.effort, reviewer) ?? null,
  };
}
