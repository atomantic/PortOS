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
 * Skill-style hosts (and any provider we can't positively identify) get the
 * command's markdown body inlined into the prompt instead — the provider-agnostic
 * fallback that works even when that environment has no slashdo install at all.
 *
 * Those bodies are large (38KB–317KB expanded), so two size controls apply
 * (#3110): unreachable reviewer variants are pruned out of the body
 * (`unreachableReviewerIncludes`), and whatever is still over
 * `SLASHDO_INLINE_BUDGET_CHARS` is handed to file-tool hosts as a path to a
 * resolved copy on disk rather than pasted (`buildSlashdoSection`'s `bodyPath`).
 */
import { isClaudeProvider, isOpencodeProvider } from './providerModels.js';
import { inferTuiCommand } from './tuiHandshake.js';
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
 * 24,000 chars ≈ 6k tokens. Every current bundled command is far over it even
 * after pruning (`review` measures 258,260 chars raw, 198,997 pruned to one
 * reviewer, 112,269 with every reviewer include dropped), which is the intent:
 * the budget exists so a future SMALL command still inlines. The budget-pin test
 * in `slashdoInvocation.test.js` asserts this against the measured sizes, so a
 * slashdo release that shrinks a command can't silently flip it back to inlining
 * without someone noticing.
 */
export const SLASHDO_INLINE_BUDGET_CHARS = 24000;

/**
 * slashdo lib includes that are REVIEWER VARIANTS — one loop per reviewer kind,
 * all five pasted into `review` / `better` / `pr` / `release` / `depfree` though
 * a given run drives exactly one. Pruning the unreachable ones is where the real
 * prompt saving is — pruning to a single CLI reviewer measured -23% on `review`,
 * -27% on `pr`, -28% on `depfree`; the file pointer is the backstop for the rest.
 *
 * Keyed by the PortOS reviewer slug (`REVIEWER_VALUES` in `reviewerConfig.js`) so
 * the keep-set derives from already-resolved run settings. `copilot` and the
 * arbitrary-`@login` loop are GitHub-side; `claude`/`codex`/`antigravity`/`grok`/`cursor`
 * all share slashdo's one local-agent loop; `ollama`/`lmstudio` are the
 * local-model loop.
 *
 * `multi-reviewer-loop` is the ORCHESTRATION WRAPPER, not a per-reviewer variant:
 * slashdo's commands hand off to it for any non-empty reviewer list, and its own
 * spec says `{REVIEW_AGENTS}` "may contain a single entry". So it is listed here
 * (it is prunable in principle — a run with no reviewers at all doesn't reach it)
 * but `unreachableReviewerIncludes` never drops it once a reviewer resolves.
 * Pruning it for a lone reviewer left the inner loop with nothing to dispatch it.
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
export const LOCAL_AGENT_REVIEWERS = new Set(['claude', 'codex', 'antigravity', 'grok', 'cursor', 'opencode', 'kimi']);
/** Reviewer slugs that drive slashdo's local-model (Ollama-style) loop. */
const LOCAL_MODEL_REVIEWERS = new Set(['ollama', 'lmstudio', 'mtplx']);

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
 * provider→slashdo-shape decision (`hasSlashdo` / `tuiSlashdoFree` in
 * `agentPromptBuilder.js` derive from this rather than re-deriving it).
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
 * `agentPromptBuilder.js` (formerly three inline provider-id allowlists:
 * `hasSlashdo`, `tuiSlashdoFree`, and the guideline-bullet `slashdoFree`). It
 * uses the `assumeClaudeWhenUnknown` posture because those gates describe a
 * session the spawners are about to launch, and every spawner resolves a blank
 * command to `claude`.
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
 * The prompt builder, `agentCompletionCleanup`, and the spawners must all agree
 * on this answer or PortOS double-fires `gh pr create` — so the spawn path
 * persists the resolved value on the agent record (`metadata.ownsPrWorkflow`)
 * and cleanup reads it back rather than re-deriving it.
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
 * The same answer for a COMPLETED agent, read off its record.
 *
 * `metadata.ownsPrWorkflow` is stamped at spawn time from the resolved provider,
 * and is authoritative: cleanup must act on what the prompt actually said, not
 * on a fresh derivation that could disagree with it.
 *
 * A record written before #3733 carries no such key. Those runs really were
 * prompted by the old builder, whose gate was `canTypeSlashCommands` — so that
 * is the correct answer for them, and it lives here next to the predicate rather
 * than inline in a service, where the next caller would miss it.
 *
 * @param {Object} opts
 * @param {boolean|undefined} opts.persisted - `metadata.ownsPrWorkflow`
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @returns {boolean}
 */
export function resolveOwnsPrWorkflow({ persisted, providerId = null, providerCommand = null, leanMode = false }) {
  if (typeof persisted === 'boolean') return persisted;
  return canTypeSlashCommands({ providerId, providerCommand, leanMode });
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
  return `The full procedure is on disk at \`${bodyPath}\` (${Math.round(body.length / 1000)}KB) — too large to paste here. READ THAT FILE before you start and follow it exactly rather than improvising. It is long: read it in sections as you need them, and do not assume a step you have not read.`;
}

/**
 * Render the prompt section for a resolved slashdo invocation. Pure — the
 * caller loads `body` (via `loadSlashdoFile`) and passes it in, so this module
 * stays side-effect free.
 *
 * The body is inlined for EVERY style, not just `skill`. PortOS bundles slashdo
 * as a submodule and only exposes it as slash commands through the repo-local
 * `.claude/commands/do/` symlinks — which exist in the PortOS checkout, not in
 * the managed-app workspaces most CoS tasks run in, and only for Claude Code.
 * So a typed invocation is a shortcut for hosts that happen to have slashdo
 * installed, never the thing the prompt depends on. Same posture as every other
 * slashdo consumer here (`loadSlashdoCommand`, the `/do:rpr` and review-loop
 * inlining), which is why the submodule exists at all: no global install required.
 *
 * **Over-budget bodies become a pointer (#3110).** When `bodyPath` names a
 * resolved copy on disk and the body exceeds `SLASHDO_INLINE_BUDGET_CHARS`, the
 * section emits the path instead of the text and the agent reads it on demand.
 * This is NOT a token saving by itself — an agent that follows the whole
 * procedure pays the same tokens through `Read`. It is worth doing because a host
 * that can invoke slashdo natively, or that only needs part of the procedure,
 * skips the cost entirely; the prompt-size win comes from pruning unreachable
 * reviewer variants BEFORE this check (`unreachableReviewerIncludes`).
 * `bodyPath` is only ever passed for a host with file tools — an HTTP `api`
 * provider has none, so it always inlines.
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
 *   Required when `body` had reviewer variants pruned out of it.
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
  if (reviewWith) {
    lines.push(
      '',
      `Run this workflow with \`--review-with ${reviewWith}\` — the procedure you were given carries ONLY those reviewers' loops (the others were omitted as unreachable). Do not substitute a different reviewer from a saved slashdo default.`
    );
  }
  if (reviewerEffortNote) {
    lines.push('', reviewerEffortNote);
  }
  if (body && bodyPath && body.length > SLASHDO_INLINE_BUDGET_CHARS) {
    lines.push('', oversizedBodyPointer(bodyPath, body));
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
