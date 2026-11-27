/** Fixed vendor argv and option stripping for restricted one-shot prompts. */
import { GROK_NO_TOOL_ARGS, GROK_IMAGE_READ_ARGS } from '../grok.js';

// Approval/permission-bypass switches, in every vendor's spelling. A one-shot
// text call (Ask, AI app detection) hands the model caller-supplied text, so it
// must never carry one: with it, the CLI is an agent that runs shell commands
// with the PortOS user's privileges. Boolean flags; a `--flag=value` spelling is
// dropped too. Short aliases are vendor-specific (`-f` is not a bypass
// everywhere), so they live on the vendor rows as `bypassAliases`.
const APPROVAL_BYPASS_FLAGS = [
  '--dangerously-skip-permissions', // claude, agy
  '--allow-dangerously-skip-permissions', // claude
  '--dangerously-bypass-approvals-and-sandbox', // codex
  '--full-auto', // codex
  '--yolo', // codex, cursor, kimi
  '--auto', // kilo, kimi
  '--approve', // pi
  '--force', // cursor
  '--auto-review', // cursor
  '--always-approve', // grok
  '--yes-always', // aider
  '--allow-all-tools', // copilot
];
// Valued options whose VALUE is the bypass (`--permission-mode bypassPermissions`
// for claude and grok, codex's unsandboxed mode).
const APPROVAL_BYPASS_VALUES = new Map([
  ['--permission-mode', 'bypassPermissions'],
  ['--sandbox', 'danger-full-access'],
  ['-s', 'danger-full-access'],
]);

const flagMatches = (arg, flag) => arg === flag || arg.startsWith(`${flag}=`);

/**
 * Remove each option in `flags` together with its value(s): the joined
 * `--flag=value` spelling, or the separate tokens that follow it. `variadic`
 * options consume every following token up to the next flag (Claude's
 * `--tools <tools...>`); the others consume exactly one.
 */
function dropOptions(args, flags, { variadic = false } = {}) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = typeof arg === 'string' && flags.find((f) => flagMatches(arg, f));
    if (!flag) {
      out.push(arg);
      continue;
    }
    if (arg !== flag) continue; // joined form carries its own value
    if (!variadic) {
      i += 1;
      continue;
    }
    while (i + 1 < args.length && !(typeof args[i + 1] === 'string' && args[i + 1].startsWith('-'))) i += 1;
  }
  return out;
}

/** Strip every approval-bypass switch. `removed` says whether one was present. */
export function stripApprovalBypassArgs(args, aliases = []) {
  const booleans = [...APPROVAL_BYPASS_FLAGS, ...aliases];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') { out.push(arg); continue; }
    if (booleans.some((f) => flagMatches(arg, f))) continue;
    const valued = [...APPROVAL_BYPASS_VALUES].find(([flag]) => flagMatches(arg, flag));
    if (valued) {
      const [flag, bypass] = valued;
      if (arg === `${flag}=${bypass}`) continue;
      if (arg === flag && args[i + 1] === bypass) { i += 1; continue; }
    }
    out.push(arg);
  }
  return { args: out, removed: out.length !== args.length };
}

// Claude Code: no built-in tools, no MCP servers (a project `.mcp.json` would
// otherwise start processes), and only the USER's settings — a project or local
// `.claude/settings*.json` in the working directory can declare hooks, which
// run shell commands without any tool call, and print mode skips the trust
// dialog that would otherwise gate them. `--restricted` is not used: it also
// drops user settings, where a Bedrock or gateway install keeps its env.
const CLAUDE_TOOL_FREE_ARGS = [
  '--tools', '',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', 'user',
];
// Keep structured Messages events in the child pipe and disable native transcript writes.
export function claudeMessagesOneShotArgs(args) {
  const booleans = ['--verbose', '--include-partial-messages', '--no-session-persistence'];
  return [
    ...dropOptions(args, ['--output-format']).filter((arg) => typeof arg !== 'string' || !booleans.some((flag) => flagMatches(arg, flag))),
    '--output-format', 'stream-json', ...booleans,
  ];
}

export function claudeToolFreeArgs(args) {
  const cleared = dropOptions(
    dropOptions(args, ['--tools', '--allowedTools', '--allowed-tools', '--mcp-config'], { variadic: true }),
    ['--setting-sources'],
  ).filter((arg) => arg !== '--strict-mcp-config');
  return [...cleared, ...CLAUDE_TOOL_FREE_ARGS];
}

// Claude Code reading a staged image (#15576): the tool-free posture, but the
// Read tool stays inside the staged-image directory under restricted mode.
export function claudeImageReadArgs(args) {
  const confined = dropOptions(dropOptions(claudeToolFreeArgs(args), ['--add-dir'], { variadic: true }), ['--settings']);
  const at = confined.lastIndexOf('--tools');
  return [...confined.slice(0, at), '--restricted', '--tools', 'Read', ...confined.slice(at + 2)];
}

// Grok's read-only permission mode with every built-in tool removed — the same
// posture its no-tool public-review recipe enforces (#14476).
export function grokToolFreeArgs(args) {
  return [...dropOptions(args, ['--permission-mode', '--tools', '--disallowed-tools']), ...GROK_NO_TOOL_ARGS];
}

export function grokImageReadArgs(args) {
  return [...dropOptions(args, ['--permission-mode', '--tools', '--disallowed-tools']), ...GROK_IMAGE_READ_ARGS];
}

// Pi: `--no-builtin-tools` alone leaves extension tools enabled, so extensions
// and skills go too (the no-tool public-review recipe's rule).
const PI_TOOL_FREE_ARGS = ['--no-approve', '--no-tools', '--no-builtin-tools', '--no-extensions', '--no-skills'];
export function piToolFreeArgs(args) {
  return [...args.filter((arg) => !PI_TOOL_FREE_ARGS.includes(arg)), ...PI_TOOL_FREE_ARGS];
}

// ─── codex ──────────────────────────────────────────────────────────────────

// Codex has no tool-disable switch, so a one-shot is never `toolFree`. It can
// still be confined: OS-level read-only sandbox (no writes, no mutating
// commands), no session persisted, no user config re-routing the run. Callers
// that only need that bound (music-video code authoring over the user's own
// brief) accept it through `isReadOnlySandboxOneShotProvider`; the Ask/app-detect
// host-control guard keeps treating codex as non-tool-free.
const CODEX_READ_ONLY_ONE_SHOT_ARGS = ['--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];
export function codexReadOnlyOneShotArgs(args) {
  const cleared = dropOptions(args, ['--sandbox', '-s']).filter((arg) => !CODEX_READ_ONLY_ONE_SHOT_ARGS.includes(arg));
  // Options precede the stdin-prompt marker, which stays last.
  const tail = cleared.at(-1) === '-' ? ['-'] : [];
  return [...cleared.slice(0, cleared.length - tail.length), ...CODEX_READ_ONLY_ONE_SHOT_ARGS, ...tail];
}
