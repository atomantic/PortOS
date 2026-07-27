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
 */
import { isClaudeCommand, isClaudeProvider, isOpencodeProvider } from './providerModels.js';
import { inferTuiCommand } from './tuiHandshake.js';

/** slashdo's command namespace — `commands/do/<cmd>.md` in the submodule. */
export const SLASHDO_NAMESPACE = 'do';

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
 * provider→slashdo-shape decision. `hasSlashdo` / `tuiSlashdoFree` in
 * `agentPromptBuilder.js` derive from this rather than re-deriving it.
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
 * **Blank-command posture (`resolveBlankCommand`).** A provider with NO launch
 * command is ambiguous, and the two questions built on this resolver need
 * opposite readings of it:
 *   - "How do I PHRASE a workflow invocation?" (the default, `false`): a blank
 *     command is NOT Claude. `isClaudeProvider` refuses it deliberately —
 *     printing `/do:<cmd>` for a host we can't identify hands it a line of prose
 *     it can't run, while the `skill` fallback always works because the caller
 *     inlines the procedure.
 *   - "Can this host TYPE `/do:pr`?" (`true`): the spawners resolve a blank
 *     command from the provider id — `inferTuiCommand` for a TUI,
 *     `buildCliSpawnConfig`'s default branch for a CLI — so the honest answer
 *     depends on what will actually launch. `claude-ollama` with no command
 *     spawns `claude` (slash commands work); a blank-command `codex-tui` spawns
 *     `codex` (they don't).
 * Passing `true` runs the blank command through `inferTuiCommand` first rather
 * than assuming Claude, so a blank-command codex/gemini/kimi provider is
 * correctly classified `skill` instead of being handed an uninvokable `/do:pr`.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @param {boolean} [opts.resolveBlankCommand] - infer a blank/absent command from
 *   the provider id, matching what the spawners actually launch. Default `false`.
 * @returns {string} one of SLASHDO_INVOCATION_STYLES
 */
export function resolveSlashdoStyle({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  resolveBlankCommand = false,
} = {}) {
  // Only the spawner posture substitutes an inferred command; the default leaves
  // a blank command blank so `isClaudeProvider` can refuse it.
  const command = (resolveBlankCommand && !providerCommand)
    ? inferTuiCommand(providerId)
    : providerCommand;
  const provider = { id: providerId, command };
  if (isOpencodeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_FLAT;
  // With a resolved command, identify on the COMMAND alone: the id already fed
  // the inference above, and consulting it again would let a `claude-*`-prefixed
  // id (e.g. `claude-codex`) override the binary it actually spawns.
  const isClaude = resolveBlankCommand
    ? isClaudeCommand(command)
    : isClaudeProvider(provider);
  if (!leanMode && isClaude) return SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
  // Codex / Grok / Antigravity install Agent Skills, not slash commands — as
  // does anything we can't positively identify.
  return SLASHDO_INVOCATION_STYLES.SKILL;
}

/**
 * True when a host CLI can be told to **type** a `/do:<cmd>` slash command —
 * i.e. its style is `slash-namespaced`, the Claude Code shape PortOS's own
 * completion workflows (`/simplify`, `/do:pr`, `/do:push`) are written in.
 *
 * The one gate `agentPromptBuilder.js`'s completion sections use, replacing the
 * two inline provider-id allowlists that drifted from this resolver (#3108).
 * Runs with the spawner blank-command posture, because the question is about the
 * process that will actually launch.
 *
 * @param {Object} [opts] - same shape as `resolveSlashdoStyle`
 * @returns {boolean}
 */
export function hostTypesSlashdoCommands(opts = {}) {
  return resolveSlashdoStyle({ ...opts, resolveBlankCommand: true })
    === SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
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
 * @param {ReturnType<typeof resolveSlashdoInvocation>} resolved
 * @param {string|null} [body] - the command's markdown
 * @returns {string} markdown section, or '' when `resolved` is null
 */
export function buildSlashdoSection(resolved, body = null) {
  if (!resolved) return '';

  // Without explicit args the workflow operates on the task described above —
  // say so rather than re-printing the whole description inside the invocation.
  const target = resolved.args ? '' : ' Apply it to the task described above.';

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
  if (body) {
    lines.push(
      '',
      'The full procedure is inlined below — follow it exactly rather than improvising:',
      '',
      body.trim()
    );
  }
  return lines.join('\n');
}
