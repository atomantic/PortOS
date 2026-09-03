import {
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  ANTIGRAVITY_EFFORT_LEVELS,
  CURSOR_EFFORT_LEVELS,
  GROK_EFFORT_LEVELS
} from '../utils/providers';

/**
 * Client mirrors of the reviewer vocabulary in `server/lib/reviewerConfig.js` —
 * the roster itself, its aliases and defaults, the review-username pattern and
 * cap, the max-rounds ceiling, the stop-mode list, and the per-reviewer PIN
 * vocabularies (which reviewers can carry a model or an effort pin, and which
 * values each one accepts).
 *
 * **Why these live in a leaf module rather than in `components/cos/constants.js`.**
 * The server suite pins this mirror against the server's own derived ladders (see
 * the `client mirror of the reviewer effort ladders` test in
 * `server/lib/reviewerConfig.test.js`) — a level offered here but rejected there
 * would show the user a pin that silently never persists, and the reverse would
 * hide a tier their CLI accepts. That test runs in the SERVER workspace, which has
 * no client dependencies installed, so anything it imports must not reach for one.
 * `components/cos/constants.js` imports `lucide-react` for its tab/state icons, so
 * importing the mirror from there fails CI with `Cannot find package
 * 'lucide-react'` even though the icons have nothing to do with reviewer pins.
 * Keeping the mirror in a dependency-free leaf lets the drift gate import it.
 *
 * `constants.js` re-exports every name here, so existing client imports are
 * unaffected.
 */

// CLI reviewers whose binary takes a model id. Mirror of
// MODEL_CAPABLE_CLI_REVIEWERS (`antigravity` runs `agy --model <id>`, `grok` runs
// `grok --model <id>`, Cursor runs `cursor-agent --model <id>`, and `opencode`
// runs `opencode run -m <provider/model>` — the server owns which flag spells it,
// see `reviewerModelFlag`). This roster is deliberately wider than
// EFFORT_SELECTABLE_REVIEWERS below: `grok`/`opencode`/`kimi` take a model but no
// pickable effort, and Cursor takes both while carrying its effort INSIDE the
// model id rather than as a separate flag.
export const MODEL_CAPABLE_CLI_REVIEWERS = ['codex', 'claude', 'antigravity', 'grok', 'cursor', 'opencode', 'kimi'];

// The local-LLM backends, which take both a model and an effort.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama', 'mtplx'];

// Every reviewer whose model the user can pick per row in ReviewerPicker — the
// model-capable CLIs plus the local-LLM backends. Mirror of
// MODEL_SELECTABLE_REVIEWERS; keep in sync so the picker only offers a Model cell
// where the server would keep the pin. `copilot` and `@username` take no model.
export const MODEL_SELECTABLE_REVIEWERS = [...MODEL_CAPABLE_CLI_REVIEWERS, ...LOCAL_LLM_REVIEWERS];

// Upper bound on a pinned reviewer model id. Mirror of MAX_REVIEWER_MODEL_LENGTH —
// a longer id is dropped server-side, so the input must not accept one.
export const MAX_REVIEWER_MODEL_LENGTH = 200;

// Reasoning-effort ladder for the local-LLM reviewers — the OpenAI-compatible
// `reasoning_effort` tier names both LM Studio and Ollama accept. Mirror of
// LOCAL_LLM_EFFORT_LEVELS.
export const LOCAL_LLM_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

// The effort ladder each reviewer offers, or absent when it has no effort control
// (`copilot` is a GitHub review, and an
// `@username` reviewer is a person). A ladder means the level is PICKABLE, not
// that the CLI takes an `--effort` flag — `cursor` accepts one only as a
// parameter of its model id, which the server folds in when it builds the
// invocation. The CLI ladders come from the same
// providers.js constants the server derives its own from, so the picker can only
// offer a level the reviewer's binary actually accepts (`agy` really does reject
// `--effort max`).
export const REVIEWER_EFFORT_LEVELS = Object.freeze({
  claude: CLAUDE_EFFORT_LEVELS,
  codex: CODEX_EFFORT_LEVELS,
  antigravity: ANTIGRAVITY_EFFORT_LEVELS,
  cursor: CURSOR_EFFORT_LEVELS,
  grok: GROK_EFFORT_LEVELS,
  lmstudio: LOCAL_LLM_EFFORT_LEVELS,
  ollama: LOCAL_LLM_EFFORT_LEVELS,
  mtplx: LOCAL_LLM_EFFORT_LEVELS,
});

// Every reviewer whose effort the user can pick per row in ReviewerPicker.
// Mirror of EFFORT_SELECTABLE_REVIEWERS.
export const EFFORT_SELECTABLE_REVIEWERS = Object.freeze(Object.keys(REVIEWER_EFFORT_LEVELS));

// Reviewer slug aliases. `gemini` is the historical name for the Antigravity CLI,
// `cursor-agent` the binary name for `cursor`. Mirror of REVIEWER_ALIASES in
// `server/lib/reviewerConfig.js` — a legacy slug the client stops resolving turns
// a stored reviewer into a row the picker can no longer show.
export const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };

// The canonical slug for a reviewer token: lower-cased, trimmed, aliases resolved.
// `''` for a non-string. `@username` tokens ride through as-is (they're no
// reviewer slug, so no lookup keyed on this can match one). Exported because any
// caller that keys behavior on "is this the Antigravity reviewer?" must resolve
// the `gemini` alias the same way the ladder lookup below does.
export const normalizeReviewerSlug = (reviewer) => {
  if (typeof reviewer !== 'string') return '';
  const slug = reviewer.trim().toLowerCase();
  return REVIEWER_ALIASES[slug] || slug;
};

// The ladder for one reviewer token, or `null` when it takes no effort. Accepts
// the `gemini` alias and `@username` tokens (both → null for the latter).
export const reviewerEffortLevels = (reviewer) =>
  REVIEWER_EFFORT_LEVELS[normalizeReviewerSlug(reviewer)] || null;

// Characters that are STRUCTURAL in slashdo's emitted `--review-with` token and
// have no escape inside the `[<model>]` selector, so the server drops an id
// containing one (mirror of REVIEWER_MODEL_FORBIDDEN_RE). Stripped as the user
// types rather than silently accepted, so the field can't display a pin the server
// would refuse to store. A space is deliberately legal — `agy[Gemini 3.5 Flash
// (High)]` is a valid entry.
const REVIEWER_MODEL_FORBIDDEN_RE = /[[\],\r\n\t]/g;

// Strip the structural characters from a typed model id. Trimming is left to the
// caller: an id being typed may legitimately have a trailing space mid-entry.
export const sanitizeReviewerModelInput = (raw) =>
  typeof raw === 'string' ? raw.replace(REVIEWER_MODEL_FORBIDDEN_RE, '') : '';

// =============================================================================
// REVIEWER ROSTER, DEFAULTS, AND CAPS
//
// Every constant below mirrors `server/lib/reviewerConfig.js` and is pinned by
// the `client mirror of the reviewer vocabulary` drift test in
// `server/lib/reviewerConfig.test.js`. They live in this leaf rather than in
// `components/cos/constants.js` for the same reason as the pin vocabularies
// above: that module imports `lucide-react`, so the server suite cannot import
// it, and anything left there is guarded by a comment instead of a test.
// =============================================================================

// The reviewer roster, and the client's SOURCE OF TRUTH for it: `REVIEWER_OPTIONS`
// in `components/cos/constants.js` is derived from this list, so the picker can
// never offer a slug the server's enum would reject. Mirror of REVIEWER_VALUES —
// a reviewer listed here but unknown to the server leaves the user configuring a
// review-loop reviewer that never runs; the reverse hides one their install has.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'grok', 'cursor', 'opencode', 'kimi', 'lmstudio', 'ollama', 'mtplx'];

// The reviewer a task falls back to when none is configured. Mirror of
// DEFAULT_REVIEWER / DEFAULT_REVIEWERS.
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = [DEFAULT_REVIEWER];

// Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
// reviewers to gate merging, appended to slashdo's `--review-with` after the
// keyed reviewers. Mirror of `normalizeReviewUsernames` + MAX_REVIEW_USERNAMES —
// the picker has to reject exactly the tokens the server drops, or the user sees
// a saved reviewer that never persisted. Stored WITHOUT the leading `@` (added
// back only for display / the flag string).
export const MAX_REVIEW_USERNAMES = 20;
const REVIEW_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;

// Validate a single raw username entry (strip `@`, trim). Returns the clean
// token or null if it isn't a shell-safe GitHub username/team slug.
export function cleanReviewUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@+/, '');
  return trimmed && REVIEW_USERNAME_RE.test(trimmed) ? trimmed : null;
}

// Normalize a raw list: drop invalid tokens, case-insensitively dedupe while
// preserving order, cap at MAX_REVIEW_USERNAMES. Returns clean usernames sans `@`.
export function normalizeReviewUsernames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const clean = cleanReviewUsername(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_REVIEW_USERNAMES) break;
  }
  return out;
}

// Upper bound on a per-reviewer `~max=<n>` round cap. Mirror of
// MAX_REVIEWER_MAX_ROUNDS — a value above it is dropped server-side, so the input
// must not offer one. `0` is valid and means "loop until clean" (slashdo's
// unlimited mode, bounded by its own guardrail); blank/absent means "no cap
// requested" and keeps slashdo's built-in default.
export const MAX_REVIEWER_MAX_ROUNDS = 10;

// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`). The
// `value`s mirror REVIEW_STOP_MODES; the labels/descriptions are UI copy. A mode
// the UI offers but the server's enum rejects 400s on save.
export const REVIEW_STOP_MODES = [
  { value: 'all', label: 'Run all', description: 'Run every reviewer in order before merging (default)' },
  { value: 'on-findings', label: 'Stop on first fix', description: 'Stop after the first reviewer that landed a fix' },
  { value: 'on-clean', label: 'Stop on first clean', description: 'Stop after the first reviewer that reports zero findings' }
];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

// Resolve task metadata to an ordered, deduped reviewer list (mirror of the
// server's normalizeReviewers): prefers `reviewers`, falls back to the legacy
// single `reviewer`, defaults to DEFAULT_REVIEWERS.
export function normalizeReviewers(meta) {
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
  return out.length ? out : [...DEFAULT_REVIEWERS];
}
