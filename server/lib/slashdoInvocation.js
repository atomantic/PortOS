/**
 * Slashdo invocation resolver (#3089).
 *
 * A CoS task can name a bundled slashdo workflow (`plan-task`, `next`, `review`,
 * …) instead of hand-written prose. How an agent actually *invokes* that workflow
 * is NOT a prefix swap — slashdo installs itself differently per host CLI
 * (`lib/slashdo/src/environments.js`), so the same command lands in three shapes:
 *
 * | Host CLI                 | namespacing   | invocation                     |
 * |--------------------------|---------------|--------------------------------|
 * | Claude Code              | `subdirectory`| `/do:<cmd> <args>`             |
 * | OpenCode                 | `flat`        | `/do-<cmd> <args>`             |
 * | Codex / Grok / Antigravity | `directory` | Agent Skill, selected by NAME  |
 *
 * There is no `$do:<cmd>` form. Because the provider is only known at spawn
 * time (the task form's provider select defaults to "Auto"), a task persists the
 * bare command name in `metadata.slashdoCommand` and this module resolves the
 * concrete invocation when the prompt is built.
 *
 * Every host receives the bundled procedure independently of a global install.
 * File-tool hosts read an entrypoint and phase-specific supporting files; API
 * providers receive a self-contained body. Explicitly pinned reviewer choices
 * prune unreachable variants before either form is rendered.
 */
import { isClaudeProvider, isOpencodeProvider } from './providerModels.js';
import { inferTuiCommand } from './providerVendors.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';

/** slashdo's command namespace — `commands/do/<cmd>.md` in the submodule. */
export const SLASHDO_NAMESPACE = 'do';

/**
 * Inline budget for a resolved command body, in characters (issue #3110).
 *
 * Under it the body is inlined as before — the section stays self-contained and
 * the agent needs no extra file read. Over it, a host with file tools gets a
 * pointer at a resolved copy on disk instead (see `buildSlashdoSection`).
 *
 * 24,000 chars is approximately 6k tokens. Deferred bundles are always staged
 * because their relative references need a filesystem base, even when the
 * entrypoint is under this limit. Small self-contained commands stay inline.
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
 *
 * PortOS-only CLI reviewers (`opencode`, `kimi`) are members too: slashdo has no
 * slug for them, but the include they'd need is the same generic spawn-a-CLI
 * review procedure, and pruning it would leave PortOS's own inlined CLI Reviewer
 * Procedure with nothing to point at. `lmstudio`/`mtplx` sit in
 * LOCAL_MODEL_REVIEWERS for the same reason.
 *
 * Kept here rather than imported from reviewerConfig.js, whose importer
 * cosValidation.js imports THIS module — an import back would be a cycle.
 * Exported so reviewerConfig.test.js can pin it against `REVIEWER_CLI_BINARIES`
 * (whose keys are the same roster); a reviewer added to one and not the other
 * is a drift the test catches.
 */
export const LOCAL_AGENT_REVIEWERS = new Set(['claude', 'codex', 'antigravity', 'grok', 'cursor', 'pi', 'opencode', 'kimi']);
/** Reviewer slugs that drive slashdo's local-model (Ollama-style) loop. */
const LOCAL_MODEL_REVIEWERS = new Set(['ollama', 'lmstudio', 'mtplx']);
/**
 * slashdo's own `--review-with` reviewer vocabulary, mapped to the PortOS slug
 * `unreachableReviewerIncludes` is keyed by. slashdo spells antigravity `agy`
 * and accepts `gemini`/`antigravity` as aliases for it; `cursor-agent` is an
 * alias for `cursor`. PortOS stores the long names.
 *
 * Kept local rather than imported from `reviewerConfig.js` for the same reason
 * `LOCAL_AGENT_REVIEWERS` is: `cosValidation.js` (which re-exports that module)
 * imports THIS one, so the arrow can only point one way.
 *
 * Deliberately NOT the full `REVIEWER_VALUES` roster — a `PORTOS_ONLY_REVIEWERS`
 * slug (`lmstudio`/`mtplx`/`opencode`/`kimi`) has no slashdo counterpart and
 * aborts the command, so seeing one in an explicit flag means the argument was
 * hand-written against a grammar we don't own. That falls through to the
 * unresolvable branch, which prunes nothing.
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
  ollama: 'ollama',
});

/** Reviewer slugs slashdo rejects a `[<model>]` bracket on. */
const BRACKET_FREE_SLASHDO_REVIEWERS = new Set(['copilot']);
const REVIEW_WITH_FLAG = '--review-with';
/** slashdo's explicit "no external reviewer this run" tombstone. */
const REVIEW_WITH_NONE = 'none';
/**
 * Shell constructs whose expansion we cannot see. A value carrying one is not a
 * reviewer list we can resolve — the agent's shell decides what it becomes.
 */
const UNEXPANDABLE_VALUE_RE = /[$`\\]/;
/** GitHub login charset plus the optional `[bot]` App suffix, per slashdo. */
const REVIEWER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
const ENTRY_MAX_RE = /^max=\d+$/;
const ENTRY_EFFORT_RE = /^effort=(?:low|medium|high|xhigh|max)$/;

/** The sentinel for "an explicit flag is there, but we can't read it safely". */
const UNRESOLVED_REVIEW_WITH = Object.freeze({ explicit: true, unresolved: true, reviewers: Object.freeze([]), usernames: Object.freeze([]) });

/**
 * Split a free-form argument string into argv-style tokens, honoring single and
 * double quotes so a bracketed model id with spaces (`agy[Gemini 3.5 Flash]`)
 * survives as one token.
 * @param {string} args
 * @returns {string[]|null} null when a quote is left open (nothing safe to read)
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
 * Split a `--review-with` value on the commas BETWEEN entries — never on one
 * inside a `[<model>]` bracket, whose value is free-form.
 * @param {string} value
 * @returns {string[]|null} null when a bracket is left open
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
 * Strip slashdo's per-entry `~` suffixes (`~opt`, `~max=<n>`, `~effort=<level>`)
 * off an entry and return the bare slug/login. Suffixes are matched only OUTSIDE
 * the outermost brackets, because a model id may itself contain a `~`.
 *
 * The suffix VALUES are deliberately discarded: they ride the explicit argument
 * verbatim into the invocation, so PortOS never re-emits them. This only has to
 * decide whether the entry is one slashdo would accept.
 *
 * @param {string} entry
 * @returns {string|null} the suffix-free token, or null when a suffix is one
 *   slashdo would reject (unknown, repeated, or malformed)
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
 * Resolve one suffix-free `--review-with` entry to the PortOS reviewer slug (or
 * `@login`) it names.
 * @param {string} token
 * @returns {{reviewer: string}|{username: string}|null} null when slashdo itself
 *   would reject the entry, or when it names something PortOS can't map
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
 * The reviewer contract an EXPLICIT `--review-with` in a task's `slashdoArgs`
 * declares (#6261).
 *
 * slashdo's own precedence puts a typed flag above every saved or inherited
 * default (`lib/review-config-defaults.md`), and PortOS passes `slashdoArgs`
 * through verbatim — so when that flag is present it, not `resolveReviewerConfig`,
 * is what the run will actually use. Pruning the body or pinning a `--review-with`
 * from task metadata instead is how a prompt ends up requesting one reviewer,
 * omitting its loop, and instructing the agent to use another.
 *
 * Three outcomes, and the caller must treat them differently:
 * - `null` — no explicit flag; the metadata/defaults contract governs as before.
 * - `{ unresolved: true }` — a flag is there but this parser can't safely read it
 *   (an open quote or bracket, a shell expansion, a slug or suffix outside
 *   slashdo's grammar, conflicting repeats). Preserve the arguments and prune and
 *   pin NOTHING: a grammar we don't fully own is exactly the case where guessing
 *   drops the loop the run needs.
 * - `{ none: true }` or a resolved `{ reviewers, usernames }` — the explicit
 *   selection, already mapped to PortOS slugs.
 *
 * Suffix values (`~opt` / `~max=<n>` / `~effort=<level>`) and `[<model>]` brackets
 * are validated but not returned: they travel in the verbatim argument, so
 * re-emitting them would state the same pin twice.
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
      // A missing value, or the next flag where the value should be.
      if (next === undefined || next.startsWith('-')) return UNRESOLVED_REVIEW_WITH;
      values.push(next);
      i += 1;
    } else if (token.startsWith(`${REVIEW_WITH_FLAG}=`)) {
      values.push(token.slice(REVIEW_WITH_FLAG.length + 1));
    }
    // Anything else starting with the same prefix (`--review-with-foo`) is a
    // different flag — not ours to read.
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
 * Which reviewer-variant includes a run can never reach, given its resolved
 * reviewers — the `skipIncludes` set for `loadSlashdoFile` (#3110).
 *
 * **Defaults to pruning NOTHING** whenever the reviewer set isn't a resolved,
 * recognized list: no array, an empty array, or a list naming a slug this
 * mapping doesn't know. An over-pruned prompt that drops the loop the agent
 * actually needs is far worse than a fat one, so every uncertain case keeps
 * everything.
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
    // An unrecognized slug means this mapping is behind the reviewer enum —
    // keep everything rather than guess which loop it needs.
    else return [];
  }
  if (users.length) keep.add(SLASHDO_REVIEWER_INCLUDES.username);
  // Always kept: slashdo's commands dispatch EVERY non-empty reviewer list
  // through the wrapper, single-entry lists included (see SLASHDO_REVIEWER_INCLUDES).
  keep.add(SLASHDO_REVIEWER_INCLUDES.multi);

  return SLASHDO_REVIEWER_INCLUDE_NAMES.filter(name => !keep.has(name));
}

/**
 * The three invocation shapes slashdo's installer produces. `slash-namespaced`
 * and `slash-flat` are typed as a slash command by the host CLI; `skill` is an
 * Agent Skill the model selects by name/description (no prefix, nothing to type).
 */
export const SLASHDO_INVOCATION_STYLES = Object.freeze({
  SLASH_NAMESPACED: 'slash-namespaced',
  SLASH_FLAT: 'slash-flat',
  SKILL: 'skill',
});

/** Bare slashdo command names are file-path segments — keep them inert. */
const COMMAND_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * True when `name` is a well-formed bare slashdo command (`plan-task`, `pr-better`).
 * Rejects anything that could escape `commands/do/` — the value reaches
 * `loadSlashdoFile`, which joins it into a path.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidSlashdoCommand(name) {
  return typeof name === 'string' && COMMAND_NAME_RE.test(name);
}

/**
 * The flat/skill name slashdo's installer gives a command in `flat` and
 * `directory` environments: `do/plan-task` → `do-plan-task`. Mirrors
 * `getSkillName` in `lib/slashdo/src/transformer.js`.
 * @param {string} command - bare command name (`plan-task`)
 * @returns {string}
 */
export function slashdoSkillName(command) {
  return `${SLASHDO_NAMESPACE}-${command}`;
}

/**
 * Which invocation shape a provider gets — the single home for the
 * provider→slashdo-shape decision (`agentPromptBuilder.js`'s
 * `canTypeSlashCommands` capability flag, and the completion `mode` it feeds,
 * derive from this rather than re-deriving it).
 *
 * Detection reuses the shared provider predicates, so a path-configured or
 * renamed binary is recognised. An unidentified provider falls through to
 * `skill`; guessing `/do:<cmd>` for an unknown host would hand it a line of
 * prose it can't run, while `skill` always works because the caller inlines the
 * procedure.
 *
 * `leanMode` (small local models behind `claude --bare`) also resolves to
 * `skill`: the lean session skips project command discovery, so `/do:<cmd>`
 * would resolve to nothing.
 *
 * **Unknown-command posture (`assumeClaudeWhenUnknown`).** A provider with no
 * launch command is genuinely ambiguous, and the two kinds of caller want
 * opposite answers:
 * - **Rendering an invocation for a task** (default, `false`): stay strict, like
 *   `isClaudeProvider`. Printing `/do:next` for a host that turns out not to be
 *   Claude hands the agent an uninvokable line; `skill` + the inlined body works
 *   everywhere, so "unknown" must not read as Claude.
 * - **Deciding whether a spawned agent may TYPE `/do:pr`** (`true`): the answer
 *   must match the command the spawners will ACTUALLY launch, which for a blank
 *   `provider.command` is `inferTuiCommand(provider.id)` — the same fallback
 *   `agentTuiSpawning.js` and `buildCliSpawnConfig` both apply. So this posture
 *   resolves the command the spawner would pick rather than guessing: a custom
 *   provider id with no command launches `claude` and IS slashdo-capable, while
 *   `codex-tui` with no command launches `codex` and is not.
 * Only the blank-command case is affected — a provider that names its command
 * resolves the same under either posture.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @param {boolean} [opts.assumeClaudeWhenUnknown=false] - when the provider names
 *   no command, resolve the one the spawners would infer from its id instead of
 *   falling through to `skill`.
 * @returns {string} one of SLASHDO_INVOCATION_STYLES
 */
export function resolveSlashdoStyle({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  assumeClaudeWhenUnknown = false,
} = {}) {
  // A blank command is only resolved for the spawner posture; the strict default
  // deliberately leaves it blank so `isClaudeProvider` won't read it as Claude.
  const command = (assumeClaudeWhenUnknown && !providerCommand)
    ? inferTuiCommand(providerId)
    : providerCommand;
  const provider = { id: providerId, command };
  if (isOpencodeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_FLAT;
  if (leanMode) return SLASHDO_INVOCATION_STYLES.SKILL;
  if (isClaudeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
  // Codex / Grok / Antigravity install Agent Skills, not slash commands — as
  // does anything we can't positively identify.
  return SLASHDO_INVOCATION_STYLES.SKILL;
}

/**
 * True when a session can be handed a typed Claude Code slash command — both the
 * slashdo ones (`/do:pr`, `/do:push`) and Claude's own built-ins (`/simplify`).
 * `SLASH_NAMESPACED` is exactly the Claude-Code-with-project-commands case, so
 * one predicate answers both: OpenCode gets `SLASH_FLAT` (no `/do:pr`, no
 * `/simplify`), codex/grok/antigravity get `SKILL`, and a lean `--bare` session
 * gets `SKILL` because it skips command discovery entirely.
 *
 * This is the single home for the completion-workflow gates in
 * `agentPromptBuilder.js` (formerly three inline provider-id allowlists, and
 * later a trio of per-shape capability flags the completion sections
 * re-derived; both collapsed to this predicate plus the resolved completion
 * `mode` — see #6873). It uses the `assumeClaudeWhenUnknown` posture because
 * those gates describe a session the spawners are about to launch, and every
 * spawner resolves a blank command to `claude`.
 *
 * `assumeClaudeWhenUnknown` defaults to `true` here (unlike `resolveSlashdoStyle`)
 * because the callers are describing a CLI/TUI session about to be spawned. An
 * HTTP-API provider is never spawned as a local CLI, so the API path passes
 * `false` — a blank provider there is not a latent `claude`.
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
 * Provider types spawned as a local coding harness — a real shell, real file
 * tools, and a PATH that has `git` / `gh` / the reviewer CLIs on it. An HTTP
 * `api` provider has none of that, so it can never drive its own PR.
 *
 * Built from `PROVIDER_TYPES` rather than string literals: a typo'd literal here
 * silently returns `false` and PortOS starts double-driving the PR.
 */
const HARNESS_PROVIDER_TYPES = new Set([PROVIDER_TYPES.CLI, PROVIDER_TYPES.TUI]);

/**
 * True when a spawned session can drive the WHOLE change-request lifecycle
 * itself — commit, push, open the PR, run the configured review loop, merge
 * (#3733).
 *
 * This is a strictly weaker question than `canTypeSlashCommands`, and
 * conflating the two is what stranded every agy / grok / codex run in a
 * two-agent handoff. Those hosts can't TYPE `/do:pr` (slashdo installs there as
 * Agent Skills, not slash commands), so they used to be told "commit and stop"
 * — PortOS then opened the PR after the run and queued a separate `sys-rl-*`
 * follow-up agent just to run the review loop. But not typing a slash command
 * says nothing about running `gh pr create`: these are full coding harnesses,
 * and the follow-up agent they hand off TO is routinely one of them driving the
 * exact same inlined slashdo procedure. So the split bought nothing and cost a
 * whole extra agent, a cold context, and a queue hop per task.
 *
 * `leanMode` is the one local harness excluded: a small Ollama-backed model
 * behind `claude --bare` fumbles multi-step flows, and a half-run merge
 * procedure is worse than a clean handoff.
 *
 * This is the HOST half of the question only. Whether a given run's prompt
 * actually handed it the PR depends on the task shape too, and that combined
 * answer is stamped on the agent record as `metadata.prOpenedBy` — see
 * `promptOpensOwnPr` in `services/promptSections/completion.js`, which is the
 * predicate the prompt itself is rendered from, and `resolvePrOpenedBy` below,
 * which reads the stamp back at cleanup time.
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
 * WHO opens a run's pull request, per the prompt that run was actually given.
 * Stamped on the agent record at spawn time as `metadata.prOpenedBy` and read
 * back by cleanup; `promptOpensOwnPr` (services/promptSections/completion.js)
 * is the single producer.
 *
 * Three values rather than a boolean because the two agent-owned cases behave
 * differently downstream and a boolean kept collapsing them:
 * - `agent-slashdo` — the completion section handed it `/do:pr`, which pushes,
 *   opens, reviews and merges the PR in one command.
 * - `agent-inline`  — the completion section handed it the plain `git`/`gh`
 *   steps plus the inline Review Loop / **Merge Gate** section. Only this value
 *   owes the #5876 merge-gate check, because only this prompt has that section.
 * - `portos`        — the prompt told the agent NOT to open a PR; the
 *   post-completion cleanup opens it.
 */
export const PR_OPENED_BY = Object.freeze({
  AGENT_SLASHDO: 'agent-slashdo',
  AGENT_INLINE: 'agent-inline',
  PORTOS: 'portos',
});

const PR_OPENED_BY_VALUES = new Set(Object.values(PR_OPENED_BY));

/**
 * The stamp for a COMPLETED agent, read off its record — accepting every shape
 * a record can carry, because other installs upgrade on their own schedule and
 * their older records keep arriving here.
 *
 * 1. `metadata.prOpenedBy` (this version) is authoritative: cleanup must act on
 *    what the prompt actually said, not on a fresh derivation that could
 *    disagree with it.
 * 2. A slashdo-capable host resolves to `agent-slashdo` whatever else the record
 *    carries. This is where #6869 lands on legacy data: the #3733 boolean
 *    `metadata.ownsPrWorkflow` answered "did the prompt render the INLINE PR
 *    section", which is `false` for exactly the hosts that run `/do:pr` — so
 *    reading that boolean at face value for a Claude record is what had cleanup
 *    re-push and re-create a PR the agent had already opened.
 * 3. Otherwise the #3733 boolean, when the record has one: a slashdo-free
 *    harness stamped `true` really was told to run `gh pr create` itself.
 * 4. Otherwise `portos` — which for a record written before #3733 (no key at
 *    all) is the same answer the old `canTypeSlashCommands` fallback gave, since
 *    rule 2 already claimed every slashdo-capable one.
 *
 * @param {Object} opts
 * @param {string|undefined} opts.persistedPrOpenedBy - `metadata.prOpenedBy`
 * @param {boolean|undefined} [opts.persistedOwnsPrWorkflow] - the legacy
 *   `metadata.ownsPrWorkflow` boolean (#3733)
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
  if (canTypeSlashCommands({ providerId, providerCommand, leanMode })) return PR_OPENED_BY.AGENT_SLASHDO;
  if (persistedOwnsPrWorkflow === true) return PR_OPENED_BY.AGENT_INLINE;
  return PR_OPENED_BY.PORTOS;
}

/**
 * The PR answers a spawned run needs, from ONE reading of the task, the
 * persisted prompt verdict and the provider descriptor. Both in-process spawners
 * call this once — the TUI `finish()` path up front, because its merge-gate contract check (#5876)
 * reads the ownership answer before the run completes; the direct-CLI `close` handler
 * at exit — and hand the result to `runSpawnerCompletionCleanup`, so the
 * ownership question and the cleanup that acts on it can never read different
 * answers (#3733).
 *
 * `agentOpensOwnPr` (did the prompt hand this run its own push → PR → merge?)
 * and `prClaimExpected` (does finalize verify a PR claim for it?) are
 * deliberately two predicates: a harness that owns the workflow but cannot TYPE
 * `/do:pr` is backstopped by cleanup, which re-checks the forge and opens the PR
 * itself when the agent skipped it — failing it at finalize for a PR that is
 * about to exist would turn a recovered hand-off into a false needs-attention
 * (#3358). `prClaimExpected` therefore stays the raw slash-command capability,
 * matching the runner path's own derivation in `agentLifecycle.js`; it asks
 * "will a PR already be there when finalize looks?", not "who was told to open
 * one".
 *
 * @param {Object} opts
 * @param {Object} opts.task
 * @param {(value: unknown) => boolean} opts.isTruthyMeta
 * @param {string|undefined} opts.persistedPrOpenedBy - `metadata.prOpenedBy`
 * @param {boolean|undefined} [opts.persistedOwnsPrWorkflow] - the legacy
 *   `metadata.ownsPrWorkflow` boolean (#3733)
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @returns {{ taskOpenPR: boolean, prOpenedBy: string, agentOpensOwnPr: boolean, prClaimExpected: boolean }}
 */
export function resolvePrOwnership({
  task,
  isTruthyMeta,
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
 *
 * @param {Object} opts
 * @param {string} opts.command - bare command name (`plan-task`)
 * @param {string} [opts.args] - free-form arguments (the task description)
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand] - the provider's launch command
 * @param {boolean} [opts.leanMode]
 * @returns {{ command: string, skillName: string, style: string, args: string,
 *   invocation: string }|null} null when `command` is missing or not a
 *   well-formed slashdo command name.
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

/**
 * The "it's on disk, go read it" line for a procedure body too large to paste
 * (#3110). Shared so every pointer an agent meets reads the same — a second
 * hand-typed copy is how one caller ends up omitting the read-it-in-sections
 * instruction that makes a 40KB file usable.
 *
 * @param {string} bodyPath - absolute path to the resolved copy
 * @param {string} body - the body itself, for its size
 * @returns {string}
 */
export function oversizedBodyPointer(bodyPath, body) {
  return `The procedure entrypoint is on disk at \`${bodyPath}\` (${Math.round(body.length / 1000)}KB). READ THAT FILE before you start. Follow its phase order and required reads; read long procedures in sections as needed.`;
}

/**
 * Render the prompt section for a resolved slashdo invocation. Pure — the
 * caller loads `body` (via `loadSlashdoFile`) and passes it in, so this module
 * stays side-effect free.
 *
 * The procedure accompanies every invocation style: managed apps need no global
 * slashdo install or PortOS project-command symlinks.
 *
 * A staged body always renders as a pointer, including a short entrypoint with
 * deferred references. Supporting files resolve relative to that entrypoint.
 * `bodyPath` is only passed for hosts with file tools; API providers inline an
 * eager, self-contained body.
 *
 * **`reviewWith` is mandatory whenever the body was pruned.** A pruned body has
 * only the reviewer loop(s) the caller pruned FOR; if the run then resolved some
 * other reviewer from slashdo's own saved defaults, that loop would be missing
 * and the agent would improvise it. Emitting the pin makes the body and the run
 * agree. Callers that prune nothing pass nothing.
 *
 * @param {ReturnType<typeof resolveSlashdoInvocation>} resolved
 * @param {string|null} [body] - the command's markdown
 * @param {Object} [opts]
 * @param {string|null} [opts.bodyPath=null] - absolute path to a resolved copy of
 *   `body`. Pass only when the host has file tools.
 * @param {string} [opts.reviewWith=''] - reviewer CSV to pin (`codex,copilot`).
 *   Required when `body` had reviewer variants pruned out of it AND the invocation
 *   does not already carry its own `--review-with` (see `explicitReviewWith`).
 * @param {boolean} [opts.explicitReviewWith=false] - the invocation's own arguments
 *   carry an explicit `--review-with`, and `body` was pruned to match it (#6261).
 *   Mutually exclusive with `reviewWith`: restating the value PortOS already passes
 *   verbatim would emit every `~opt` / `~max=` / `~effort=` suffix twice.
 * @param {string} [opts.reviewerEffortNote=''] - the per-reviewer reasoning-effort
 *   instruction (`buildReviewerEffortNote`). Non-empty only when `reviewWith` is
 *   NOT emitted: a pinned CSV carries each effort as slashdo's `~effort=<level>`
 *   suffix, so the prose would just have the agent pass the flag twice. Unpinned,
 *   the workflow resolves reviewers itself and this is the pin's only route to the
 *   CLI it spawns.
 * @param {boolean} [opts.includeTaskContext=false] - keep the task-context bridge
 *   even when the invocation has explicit flags instead of a free-text target
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

  // Without explicit args the workflow operates on the task described above —
  // say so rather than re-printing the whole description inside the invocation.
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
    // The invocation above already carries the flag verbatim, so the pin points AT
    // it rather than repeating it: slashdo's own precedence puts an explicit flag
    // above every saved default, and restating the value would emit each
    // per-reviewer suffix a second time.
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
