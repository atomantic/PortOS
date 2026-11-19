/**
 * Slashdo invocation resolver (#3089).
 *
 * A CoS task can name a bundled slashdo workflow (`plan-task`, `next`, …). Invoking
 * it is NOT a prefix swap: slashdo installs per host CLI (`lib/slashdo/src/environments.js`):
 * | Host CLI                 | namespacing   | invocation                     |
 * |--------------------------|---------------|--------------------------------|
 * | Claude Code              | `subdirectory`| `/do:<cmd> <args>`             |
 * | OpenCode                 | `flat`        | `/do-<cmd> <args>`             |
 * | Codex / Grok / Antigravity | `directory` | Agent Skill, selected by NAME  |
 *
 * There is no `$do:<cmd>` form. The provider is only known at spawn time, so a task
 * persists the bare name in `metadata.slashdoCommand` and this module resolves the
 * invocation when the prompt is built. Every host gets the bundled procedure
 * regardless of a global install; pinned reviewer choices prune unreachable variants.
 */
import { isTruthyMeta } from './metadataFlags.js';
import { isClaudeProvider, isOpencodeProvider } from './provider/providerModels.js';
import { inferTuiCommand } from './provider/providerVendors.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { REVIEWER_CLI_BINARIES } from './reviewerConfig.js';

/** slashdo's command namespace — `commands/do/<cmd>.md` in the submodule. */
export const SLASHDO_NAMESPACE = 'do';

/**
 * Inline budget for a resolved command body, in characters (~6k tokens). Under it
 * the body is inlined; over it, file-tool hosts get a pointer to a resolved copy on
 * disk. Deferred bundles are always staged (relative references need a filesystem base).
 */
export const SLASHDO_INLINE_BUDGET_CHARS = 24000;

/**
 * Reviewer-specific libraries that can be omitted once the run's reviewers are
 * pinned. CLI reviewers share localAgent; local-model reviewers share localModel.
 * Keep the multi-reviewer dispatcher for every non-empty list, even one reviewer.
 */
export const SLASHDO_REVIEWER_INCLUDES = Object.freeze({
  copilot: 'copilot-review-loop',
  username: 'github-reviewer-loop',
  localAgent: 'local-agent-review-loop',
  localModel: 'ollama-review-loop',
  multi: 'multi-reviewer-loop',
});

/** Every reviewer-variant include name — the prunable universe. */
export const SLASHDO_REVIEWER_INCLUDE_NAMES = Object.freeze(Object.values(SLASHDO_REVIEWER_INCLUDES));

/**
 * Reviewer slugs that drive slashdo's shared local-agent (spawnable CLI) loop.
 * PortOS-only CLI reviewers (`opencode`, `kilo`, `kimi`) are members too: pruning
 * their include would leave PortOS's inlined CLI Reviewer Procedure with nothing to point at.
 * Derived directly from `REVIEWER_CLI_BINARIES` so the two lists cannot drift.
 */
const LOCAL_AGENT_REVIEWERS = new Set(Object.keys(REVIEWER_CLI_BINARIES));
/** Reviewer slugs that drive slashdo's local-model (Ollama-style) loop. */
const LOCAL_MODEL_REVIEWERS = new Set(['ollama', 'lmstudio', 'mtplx']);
/**
 * slashdo's `--review-with` vocabulary mapped to PortOS slugs (slashdo spells
 * antigravity `agy`, with `gemini` an alias; `cursor-agent` aliases `cursor`).
 *
 * Deliberately NOT the full `REVIEWER_VALUES`: a PORTOS_ONLY slug has no slashdo
 * counterpart and aborts the command, so it means a hand-written argument and
 * falls to the unresolvable branch. `cmd[<invocation>]` is likewise absent: it
 * maps to no PortOS reviewer, so the run keeps every include.
 */
const SLASHDO_REVIEWER_SLUGS = Object.freeze({
  copilot: 'copilot',
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
  cursor: 'cursor',
  pi: 'pi',
  'cursor-agent': 'cursor',
  agy: 'antigravity',
  gemini: 'antigravity',
  antigravity: 'antigravity',
  opencode: 'opencode',
  zen: 'opencode',
  'opencode-zen': 'opencode',
  ollama: 'ollama',
});

/** Reviewer slugs slashdo rejects a `[<model>]` bracket on. */
const BRACKET_FREE_SLASHDO_REVIEWERS = new Set(['copilot']);
const REVIEW_WITH_FLAG = '--review-with';
/** slashdo's explicit "no external reviewer this run" tombstone. */
const REVIEW_WITH_NONE = 'none';
/** Shell constructs whose expansion we can't see; such a value is unresolvable. */
const UNEXPANDABLE_VALUE_RE = /[$`\\]/;
/** GitHub login charset plus the optional `[bot]` App suffix, per slashdo. */
const REVIEWER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
const ENTRY_MAX_RE = /^max=\d+$/;
const ENTRY_EFFORT_RE = /^effort=(?:low|medium|high|xhigh|max)$/;

/** The sentinel for "an explicit flag is there, but we can't read it safely". */
const UNRESOLVED_REVIEW_WITH = Object.freeze({ explicit: true, unresolved: true, reviewers: Object.freeze([]), usernames: Object.freeze([]) });

/**
 * Split into argv-style tokens honoring quotes, so `agy[Gemini 3.5 Flash]` stays
 * one token. Null when a quote is left open.
 * @param {string} args
 * @returns {string[]|null}
 */
function tokenizeSlashdoArgs(args) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Split a `--review-with` value on commas BETWEEN entries, not inside a
 * `[<model>]` bracket. Null when a bracket is left open.
 * @param {string} value
 * @returns {string[]|null}
 */
function splitReviewerEntries(value) {
  const entries = [];
  let current = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (depth < 0) return null; }
    if (ch === ',' && depth === 0) { entries.push(current); current = ''; continue; }
    current += ch;
  }
  if (depth !== 0) return null;
  entries.push(current);
  return entries;
}

/**
 * Strip per-entry `~` suffixes (`~opt`, `~max=<n>`, `~effort=<level>`), matched only
 * OUTSIDE the outermost brackets (a model id may contain `~`). Values are
 * discarded: they ride the explicit argument verbatim; this only decides whether
 * slashdo would accept the entry.
 * @param {string} entry
 * @returns {string|null} suffix-free token, or null when a suffix would be rejected
 */
function stripEntrySuffixes(entry) {
  const open = entry.indexOf('[');
  const close = entry.lastIndexOf(']');
  if (open !== -1 && close < open) return null;
  const tilde = entry.indexOf('~', close === -1 ? 0 : close + 1);
  if (tilde === -1) return entry;
  const seen = new Set();
  for (const suffix of entry.slice(tilde + 1).split('~')) {
    const kind = suffix === 'opt' ? 'opt'
      : ENTRY_MAX_RE.test(suffix) ? 'max'
        : ENTRY_EFFORT_RE.test(suffix) ? 'effort' : null;
    if (!kind || seen.has(kind)) return null;
    seen.add(kind);
  }
  return entry.slice(0, tilde);
}

/**
 * Resolve one suffix-free entry to a PortOS reviewer slug or `@login`.
 * @param {string} token
 * @returns {{reviewer: string}|{username: string}|null} null when slashdo would
 *   reject it or PortOS can't map it
 */
function resolveReviewerEntry(token) {
  if (!token) return null;
  if (token.startsWith('@')) {
    const login = token.slice(1);
    // slashdo rejects `@login[…]`; `[bot]` is part of the login, not a model.
    return REVIEWER_LOGIN_RE.test(login) ? { username: login } : null;
  }
  const open = token.indexOf('[');
  if (open !== -1 && !token.endsWith(']')) return null;
  const slug = (open === -1 ? token : token.slice(0, open)).toLowerCase();
  const reviewer = SLASHDO_REVIEWER_SLUGS[slug];
  if (!reviewer) return null;
  if (open !== -1 && BRACKET_FREE_SLASHDO_REVIEWERS.has(reviewer)) return null;
  return { reviewer };
}

/**
 * The reviewer contract an EXPLICIT `--review-with` in `slashdoArgs` declares (#6261).
 * slashdo's precedence puts a typed flag above every saved default and PortOS
 * passes `slashdoArgs` verbatim, so this flag, not `resolveReviewerConfig`,
 * governs the run; pruning or pinning from metadata instead yields a prompt that
 * requests one reviewer but carries another's loop.
 *
 * Outcomes:
 * - `null` — no explicit flag; the metadata/defaults contract governs.
 * - `{ unresolved: true }` — flag present but unsafely readable (open quote or
 *   bracket, shell expansion, slug/suffix outside slashdo's grammar, conflicting
 *   repeats). Prune and pin NOTHING.
 * - `{ none: true }` or resolved `{ reviewers, usernames }` — the explicit selection.
 *
 * Suffix values and `[<model>]` brackets are validated but not returned: they
 * travel in the verbatim argument.
 *
 * @param {unknown} args - the task's raw `metadata.slashdoArgs`
 * @returns {{explicit: true, unresolved?: true, none?: true, reviewers: string[],
 *   usernames: string[]}|null}
 */
export function parseExplicitReviewWith(args) {
  if (typeof args !== 'string' || !args.includes(REVIEW_WITH_FLAG)) return null;
  const tokens = tokenizeSlashdoArgs(args);
  if (!tokens) return UNRESOLVED_REVIEW_WITH;

  const values = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === REVIEW_WITH_FLAG) {
      const next = tokens[i + 1];
      // A missing value, or the next flag.
      if (next === undefined || next.startsWith('-')) return UNRESOLVED_REVIEW_WITH;
      values.push(next);
      i += 1;
    } else if (token.startsWith(`${REVIEW_WITH_FLAG}=`)) {
      values.push(token.slice(REVIEW_WITH_FLAG.length + 1));
    }
    // `--review-with-foo` is a different flag.
  }
  if (!values.length) return null;
  // Repeats are outside slashdo's documented grammar unless they agree.
  if (new Set(values).size > 1) return UNRESOLVED_REVIEW_WITH;

  const value = values[0];
  if (!value || UNEXPANDABLE_VALUE_RE.test(value)) return UNRESOLVED_REVIEW_WITH;
  if (value.toLowerCase() === REVIEW_WITH_NONE) {
    return { explicit: true, none: true, reviewers: [], usernames: [] };
  }

  const entries = splitReviewerEntries(value);
  if (!entries) return UNRESOLVED_REVIEW_WITH;
  const reviewers = [];
  const usernames = [];
  for (const entry of entries) {
    const bare = stripEntrySuffixes(entry.trim());
    const resolved = bare === null ? null : resolveReviewerEntry(bare);
    if (!resolved) return UNRESOLVED_REVIEW_WITH;
    if (resolved.username) {
      if (!usernames.some(u => u.toLowerCase() === resolved.username.toLowerCase())) usernames.push(resolved.username);
    } else if (!reviewers.includes(resolved.reviewer)) reviewers.push(resolved.reviewer);
  }
  return { explicit: true, none: false, reviewers, usernames };
}


/**
 * Which reviewer-variant includes a run can never reach — the `skipIncludes` set
 * for `loadSlashdoFile`. Prunes NOTHING for any uncertain set (non-array, empty,
 * unknown slug): an over-pruned prompt is worse than a fat one.
 *
 * @param {Object} [opts]
 * @param {string[]|null} [opts.reviewers] - resolved keyed reviewer slugs
 * @param {string[]} [opts.usernames] - resolved `@login` reviewers
 * @returns {string[]} include names safe to omit (possibly empty)
 */
export function unreachableReviewerIncludes({ reviewers = null, usernames = [] } = {}) {
  if (!Array.isArray(reviewers)) return [];
  const users = Array.isArray(usernames) ? usernames.filter(Boolean) : [];
  if (!reviewers.length && !users.length) return [];

  const keep = new Set();
  for (const slug of reviewers) {
    if (slug === 'copilot') keep.add(SLASHDO_REVIEWER_INCLUDES.copilot);
    else if (LOCAL_AGENT_REVIEWERS.has(slug)) keep.add(SLASHDO_REVIEWER_INCLUDES.localAgent);
    else if (LOCAL_MODEL_REVIEWERS.has(slug)) keep.add(SLASHDO_REVIEWER_INCLUDES.localModel);
    // Unrecognized slug: this mapping is behind the enum; keep everything.
    else return [];
  }
  if (users.length) keep.add(SLASHDO_REVIEWER_INCLUDES.username);
  // Always kept: every non-empty reviewer list dispatches through the wrapper.
  keep.add(SLASHDO_REVIEWER_INCLUDES.multi);

  return SLASHDO_REVIEWER_INCLUDE_NAMES.filter(name => !keep.has(name));
}

/** The shapes slashdo's installer produces: two typed slash commands and an Agent Skill selected by name. */
export const SLASHDO_INVOCATION_STYLES = Object.freeze({
  SLASH_NAMESPACED: 'slash-namespaced',
  SLASH_FLAT: 'slash-flat',
  SKILL: 'skill',
});

/** Bare command names are file-path segments — keep them inert. */
const COMMAND_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** True for a well-formed bare command name; rejects anything that could escape `commands/do/` (the value is joined into a path). */
export function isValidSlashdoCommand(name) {
  return typeof name === 'string' && COMMAND_NAME_RE.test(name);
}

/** Flat/skill name (`do/plan-task` → `do-plan-task`); mirrors `getSkillName` in lib/slashdo/src/transformer.js. */
export function slashdoSkillName(command) {
  return `${SLASHDO_NAMESPACE}-${command}`;
}

/**
 * Which invocation shape a provider gets: the single home for the provider→shape
 * decision (`canTypeSlashCommands` and the completion `mode` derive from it).
 *
 * Uses the shared provider predicates, so renamed/path-configured binaries are
 * recognised. Unidentified providers get `skill` (the caller inlines the
 * procedure, so it always works). `leanMode` (`claude --bare`) also gets `skill`:
 * it skips project command discovery.
 *
 * `assumeClaudeWhenUnknown`, for a provider with no launch command:
 * - `false` (rendering a task invocation): strict; "unknown" must not read as Claude.
 * - `true` (may a spawned agent TYPE `/do:pr`): resolve `inferTuiCommand(provider.id)`,
 *   the fallback the spawners actually apply, so a custom id launches `claude` and
 *   is capable while `codex-tui` is not.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @param {boolean} [opts.assumeClaudeWhenUnknown=false]
 * @returns {string} one of SLASHDO_INVOCATION_STYLES
 */
export function resolveSlashdoStyle({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  assumeClaudeWhenUnknown = false,
} = {}) {
  // Only the spawner posture infers a blank command; strict leaves it blank (not Claude).
  const command = (assumeClaudeWhenUnknown && !providerCommand)
    ? inferTuiCommand(providerId)
    : providerCommand;
  const provider = { id: providerId, command };
  if (isOpencodeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_FLAT;
  if (leanMode) return SLASHDO_INVOCATION_STYLES.SKILL;
  if (isClaudeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
  // Codex / Grok / Antigravity install Agent Skills; so does anything unidentified.
  return SLASHDO_INVOCATION_STYLES.SKILL;
}

/**
 * True when a session can be handed a typed Claude Code slash command (slashdo
 * `/do:pr` and built-ins like `/simplify`). `SLASH_NAMESPACED` is exactly that
 * case: OpenCode gets `SLASH_FLAT`; codex/grok/antigravity and lean `--bare`
 * sessions get `SKILL`.
 *
 * Single home for the completion-workflow gates in `agentPromptBuilder.js`.
 * Defaults `assumeClaudeWhenUnknown` to `true` (unlike `resolveSlashdoStyle`)
 * because callers describe a CLI/TUI session about to be spawned, where every
 * spawner resolves a blank command to `claude`; the HTTP-API path passes `false`.
 *
 * @param {Object} [opts] - same shape as `resolveSlashdoStyle`
 * @returns {boolean}
 */
export function canTypeSlashCommands({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  assumeClaudeWhenUnknown = true,
} = {}) {
  return resolveSlashdoStyle({ providerId, providerCommand, leanMode, assumeClaudeWhenUnknown })
    === SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
}

/**
 * Provider types spawned as a local coding harness (shell, file tools, git/gh on
 * PATH); an HTTP `api` provider can never drive its own PR. Built from
 * `PROVIDER_TYPES`: a typo'd literal silently returns false and PortOS would double-drive the PR.
 */
const HARNESS_PROVIDER_TYPES = new Set([PROVIDER_TYPES.CLI, PROVIDER_TYPES.TUI]);

/**
 * True when a spawned session can drive the WHOLE change-request lifecycle itself
 * (commit, push, PR, review loop, merge).
 *
 * Weaker than `canTypeSlashCommands`: Agent-Skills hosts can't TYPE `/do:pr` but
 * are full harnesses that can run `gh pr create`; telling them to stop cost an
 * extra agent and queue hop. `leanMode` is excluded: a small `--bare` model
 * fumbles multi-step flows and a half-run merge is worse than a clean handoff.
 *
 * HOST half only; the combined per-run answer is stamped as `metadata.prOpenedBy`
 * (see `promptOpensOwnPr` in services/promptSections/completion.js, and `resolvePrOpenedBy`).
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.providerType] - `'tui' | 'cli' | 'api'`
 * @param {boolean} [opts.leanMode]
 * @returns {boolean}
 */
export function agentOwnsPrWorkflow({ providerType = null, leanMode = false } = {}) {
  if (leanMode) return false;
  return HARNESS_PROVIDER_TYPES.has(providerType);
}

/**
 * WHO opens a run's pull request, per the prompt the run was given. Stamped on the
 * agent record at spawn as `metadata.prOpenedBy`; `promptOpensOwnPr`
 * (services/promptSections/completion.js) is the single producer.
 * - `agent-slashdo` — handed `/do:pr` (push, open, review, merge in one command).
 * - `agent-inline` — handed plain `git`/`gh` steps plus the inline Review Loop /
 *   **Merge Gate**; only this value owes the merge-gate check (#5876).
 * - `portos` — told NOT to open a PR; post-completion cleanup does.
 */
export const PR_OPENED_BY = Object.freeze({
  AGENT_SLASHDO: 'agent-slashdo',
  AGENT_INLINE: 'agent-inline',
  PORTOS: 'portos',
});

const PR_OPENED_BY_VALUES = new Set(Object.values(PR_OPENED_BY));

/**
 * The stamp for a COMPLETED agent, read off its record, accepting every shape a
 * record can carry (other installs upgrade on their own schedule).
 *
 * 1. `metadata.prOpenedBy` is authoritative: cleanup acts on what the prompt said.
 *    An unrecognized value (newer install) falls through to the legacy rules.
 * 2. Legacy boolean `metadata.ownsPrWorkflow`: `true` → `agent-inline`, `false` →
 *    `portos`. Deliberately NOT mapped to `agent-slashdo`: on a slashdo-capable host
 *    `false` is ambiguous between a defect and a correct exclusion (read-only /
 *    discard-worktree runs PortOS owns), and only the task, which this leaf
 *    doesn't see, tells them apart.
 * 3. Otherwise `portos`, or `agent-slashdo` for a slashdo-capable host (the old
 *    builder's gate was `canTypeSlashCommands`).
 *
 * @param {Object} opts
 * @param {string|undefined} opts.persistedPrOpenedBy - `metadata.prOpenedBy`
 * @param {boolean|undefined} [opts.persistedOwnsPrWorkflow] - legacy boolean
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @returns {string} a `PR_OPENED_BY` value
 */
export function resolvePrOpenedBy({
  persistedPrOpenedBy,
  persistedOwnsPrWorkflow,
  providerId = null,
  providerCommand = null,
  leanMode = false,
}) {
  if (PR_OPENED_BY_VALUES.has(persistedPrOpenedBy)) return persistedPrOpenedBy;
  if (typeof persistedOwnsPrWorkflow === 'boolean') {
    return persistedOwnsPrWorkflow ? PR_OPENED_BY.AGENT_INLINE : PR_OPENED_BY.PORTOS;
  }
  return canTypeSlashCommands({ providerId, providerCommand, leanMode })
    ? PR_OPENED_BY.AGENT_SLASHDO
    : PR_OPENED_BY.PORTOS;
}

/**
 * The PR answers a spawned run needs, from ONE reading of the task, persisted
 * prompt verdict and provider. Both in-process spawners call it once and pass the
 * result to `runSpawnerCompletionCleanup`, so ownership and the cleanup acting on
 * it can't disagree.
 *
 * `agentOpensOwnPr` and `prClaimExpected` are deliberately separate: a harness that
 * owns the workflow but can't TYPE `/do:pr` is backstopped by cleanup, which opens
 * the PR if skipped, so finalize must not fail it for a PR about to exist (#3358).
 * `prClaimExpected` stays the raw slash-command capability, matching
 * agentLifecycle.js: "will a PR already exist when finalize looks?".
 *
 * @param {Object} opts
 * @param {Object} opts.task
 * @param {string|undefined} opts.persistedPrOpenedBy - `metadata.prOpenedBy`
 * @param {boolean|undefined} [opts.persistedOwnsPrWorkflow] - legacy boolean
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @returns {{ taskOpenPR: boolean, prOpenedBy: string, agentOpensOwnPr: boolean, prClaimExpected: boolean }}
 */
export function resolvePrOwnership({
  task,
  persistedPrOpenedBy,
  persistedOwnsPrWorkflow,
  providerId = null,
  providerCommand = null,
  leanMode = false,
}) {
  const taskOpenPR = isTruthyMeta(task?.metadata?.openPR);
  const prOpenedBy = resolvePrOpenedBy({
    persistedPrOpenedBy, persistedOwnsPrWorkflow, providerId, providerCommand, leanMode,
  });
  return {
    taskOpenPR,
    prOpenedBy,
    agentOpensOwnPr: taskOpenPR && prOpenedBy !== PR_OPENED_BY.PORTOS,
    prClaimExpected: taskOpenPR && canTypeSlashCommands({ providerId, providerCommand, leanMode }),
  };
}

/**
 * Resolve the concrete invocation for a slashdo-backed task.
 * @param {Object} opts
 * @param {string} opts.command - bare command name (`plan-task`)
 * @param {string} [opts.args] - free-form arguments
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @returns {{ command: string, skillName: string, style: string, args: string,
 *   invocation: string }|null} null when `command` is missing or malformed
 */
export function resolveSlashdoInvocation({
  command,
  args = '',
  providerId = null,
  providerCommand = null,
  leanMode = false,
} = {}) {
  if (!isValidSlashdoCommand(command)) return null;

  const style = resolveSlashdoStyle({ providerId, providerCommand, leanMode });
  const skillName = slashdoSkillName(command);
  const trimmedArgs = typeof args === 'string' ? args.trim() : '';
  const suffix = trimmedArgs ? ` ${trimmedArgs}` : '';

  const invocation = style === SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED
    ? `/${SLASHDO_NAMESPACE}:${command}${suffix}`
    : style === SLASHDO_INVOCATION_STYLES.SLASH_FLAT
      ? `/${skillName}${suffix}`
      : `Use the \`${skillName}\` skill${trimmedArgs ? ` on: ${trimmedArgs}` : ''}`;

  return { command, skillName, style, args: trimmedArgs, invocation };
}

/** The "read it on disk" line for a body too large to paste; shared so every pointer carries the read-in-sections instruction. */
export function oversizedBodyPointer(bodyPath, body) {
  return `The procedure entrypoint is on disk at \`${bodyPath}\` (${Math.round(body.length / 1000)}KB). READ THAT FILE before you start. Follow its phase order and required reads; read long procedures in sections as needed.`;
}

/**
 * Render the prompt section for a resolved slashdo invocation. Pure: the caller
 * loads `body` (via `loadSlashdoFile`).
 *
 * The procedure accompanies every invocation style, so managed apps need no global
 * install. A staged body always renders as a pointer (supporting files resolve
 * relative to that entrypoint); `bodyPath` is passed only for hosts with file
 * tools, API providers inline a self-contained body.
 *
 * `reviewWith` is mandatory whenever the body was pruned: otherwise a run that
 * resolves another reviewer from saved defaults would lack its loop and the agent
 * would improvise it.
 *
 * @param {ReturnType<typeof resolveSlashdoInvocation>} resolved
 * @param {string|null} [body] - the command's markdown
 * @param {Object} [opts]
 * @param {string|null} [opts.bodyPath=null] - resolved on-disk copy; file-tool hosts only
 * @param {string} [opts.reviewWith=''] - reviewer CSV to pin; required when pruned
 *   unless `explicitReviewWith`
 * @param {boolean} [opts.explicitReviewWith=false] - invocation already carries
 *   `--review-with` and body was pruned to match; exclusive with `reviewWith`
 *   (restating would duplicate every suffix)
 * @param {string} [opts.reviewerEffortNote=''] - per-reviewer effort prose; non-empty
 *   only when `reviewWith` is NOT emitted (its `~effort=` suffix carries it otherwise)
 * @param {boolean} [opts.includeTaskContext=false] - keep the task-context bridge
 *   even with explicit flags
 * @returns {string} markdown section, or '' when `resolved` is null
 */
export function buildSlashdoSection(resolved, body = null, {
  bodyPath = null,
  reviewWith = '',
  reviewerEffortNote = '',
  includeTaskContext = false,
  explicitReviewWith = false,
} = {}) {
  if (!resolved) return '';

  // Without explicit args the workflow operates on the task described above.
  const target = resolved.args && !includeTaskContext ? '' : ' Apply it to the task described above.';

  const lines = ['### Slashdo Workflow'];
  if (resolved.style === SLASHDO_INVOCATION_STYLES.SKILL) {
    lines.push(
      `This task runs the bundled slashdo **${resolved.skillName}** workflow. ${resolved.invocation}.${target}`,
      'Your CLI exposes slashdo as Agent Skills — selected by name, with no slash-command form to type.'
    );
  } else {
    lines.push(
      `This task runs the bundled slashdo **${resolved.skillName}** workflow.${target} If your CLI has slashdo installed you can invoke it directly:`,
      '',
      '```',
      resolved.invocation,
      '```'
    );
  }
  if (explicitReviewWith) {
    // Point AT the verbatim flag; restating it would duplicate each per-reviewer suffix.
    lines.push(
      '',
      'The `--review-with` value in the invocation above is authoritative for this run: the procedure you were given carries ONLY the reviewer loops that value can reach (the rest were omitted as unreachable). Do not substitute a different reviewer from a saved slashdo default.'
    );
  } else if (reviewWith) {
    lines.push(
      '',
      `Run this workflow with \`--review-with ${reviewWith}\` — the procedure you were given carries ONLY those reviewers' loops (the others were omitted as unreachable). Do not substitute a different reviewer from a saved slashdo default.`
    );
  }
  if (reviewerEffortNote) {
    lines.push('', reviewerEffortNote);
  }
  if (body && bodyPath) {
    lines.push('', oversizedBodyPointer(bodyPath, body),
      'Resolve each supporting-file path relative to the file containing that reference. Read each required reference only when its phase or condition applies; do not preload the bundle.');
  } else if (body) {
    lines.push(
      '',
      'The full procedure is inlined below — follow it exactly rather than improvising:',
      '',
      body.trim()
    );
  }
  return lines.join('\n');
}
