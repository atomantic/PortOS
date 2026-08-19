import {
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  ANTIGRAVITY_EFFORT_LEVELS,
  CURSOR_EFFORT_LEVELS
} from '../utils/providers';

/**
 * Client mirrors of the per-reviewer PIN vocabularies in
 * `server/lib/cosValidation.js` — which reviewers can carry a model or an effort
 * pin, and which values each one accepts.
 *
 * **Why these live in a leaf module rather than in `components/cos/constants.js`.**
 * The server suite pins this mirror against the server's own derived ladders (see
 * the `client mirror of the reviewer effort ladders` test in
 * `server/lib/cosValidation.test.js`) — a level offered here but rejected there
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

// CLI reviewers whose binary takes a `--model <id>` tier. Mirror of
// MODEL_CAPABLE_CLI_REVIEWERS (`antigravity` runs `agy --model <id>`, `grok` runs
// `grok --model <id>`, and Cursor runs `cursor-agent --model <id>` — `grok` takes
// a model but no effort at all, so this roster is deliberately wider than
// EFFORT_SELECTABLE_REVIEWERS below; Cursor takes both, but carries its effort
// INSIDE the model id rather than as a separate flag).
export const MODEL_CAPABLE_CLI_REVIEWERS = ['codex', 'claude', 'antigravity', 'grok', 'cursor'];

// The local-LLM backends, which take both a model and an effort.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama'];

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
// (`copilot` is a GitHub review, `grok`'s CLI has no effort control at all, and an
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
  lmstudio: LOCAL_LLM_EFFORT_LEVELS,
  ollama: LOCAL_LLM_EFFORT_LEVELS,
});

// Every reviewer whose effort the user can pick per row in ReviewerPicker.
// Mirror of EFFORT_SELECTABLE_REVIEWERS.
export const EFFORT_SELECTABLE_REVIEWERS = Object.freeze(Object.keys(REVIEWER_EFFORT_LEVELS));

// Reviewer slug aliases. `gemini` is the historical name for the Antigravity CLI.
const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };

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
