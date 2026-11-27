/** Enforce tool, image-read and repair postures for one-shot provider invocations. */
import { PROVIDER_TYPES } from '../aiToolkit/constants.js';
import { PROVIDER_VENDORS } from './providerVendorRegistry.js';
import { stripApprovalBypassArgs } from './providerOneShotRecipes.js';
import { providerLabel } from './providerTypes.js';
import { isCodexCommand } from '../codex.js';
import {
  isClaudeCommand,
  CODEX_WORKSPACE_NETWORK_KEY,
  CODEX_WORKSPACE_WRITABLE_ROOTS_KEY,
  CODEX_PLUGINS_FEATURE_KEY,
  CODEX_APPS_FEATURE_KEY,
  CODEX_HOOKS_FEATURE_KEY,
} from './providerModels.js';

/**
 * Make a built one-shot CLI argv tool-free (#9008), for callers that hand the
 * model text they do not control — Ask and AI app detection. Run it on the
 * FINAL argv (after the vendor builder, before prompt delivery), because
 * several builders append their vendor's bypass flag themselves.
 *
 * Every approval-bypass switch is removed for every vendor. A vendor with a
 * maintained tool-disable switch (claude, grok, pi) then gets it appended and
 * reports `toolFree: true`; every other CLI — including agy, codex, opencode,
 * kilo and cursor, whose tool posture has no argv off switch — reports
 * `toolFree: false`, which callers treat as host control. An API provider runs
 * no process, so its argv is returned unchanged with `toolFree: true`.
 * OpenCode's tool-free runner also needs a config overlay, so this argv-only
 * check cannot admit it on its own.
 *
 * @param {object} provider - provider record (type, command)
 * @param {string[]} [args] - the built argv
 * @returns {{ args: string[], toolFree: boolean }}
 */
export function toolFreeOneShotArgs(provider, args = []) {
  if (provider?.type === PROVIDER_TYPES.API) return { args: [...args], toolFree: true };
  const spec = PROVIDER_VENDORS.find((v) => v.toolFreeOneShot?.matchCommand(provider?.command))?.toolFreeOneShot;
  const { args: stripped, removed } = stripApprovalBypassArgs(args, spec?.bypassAliases);
  if (spec?.toolFreeArgs) return { args: spec.toolFreeArgs(stripped), toolFree: true };
  if (spec?.sandboxArgs) return { args: spec.sandboxArgs(stripped), toolFree: false, readOnlySandbox: true };
  return { args: removed && spec?.afterStrip ? spec.afterStrip(stripped) : stripped, toolFree: false };
}

// Autofixer repair posture (#12487). Claude keeps file Read/Edit/Write only:
// acceptEdits auto-approves edits inside the working directory and nothing
// else, and neither project MCP servers nor project settings (hooks) load.
const CLAUDE_REPAIR_ARGS = [
  '--restricted', '--safe-mode',
  '--permission-mode', 'acceptEdits',
  '--tools', 'Read,Edit,Write,Grep,Glob',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome', '--disable-slash-commands',
  '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch',
];
// Codex's OS sandbox confines its shell commands to the working directory
// with network off. MCP servers, plugins and apps run outside that sandbox
// (computer-use, node_repl), and an `mcp_servers` override cannot clear them,
// so the user's config.toml is not loaded at all (auth still is) and the
// plugin/app surfaces are disabled.
const CODEX_REPAIR_ARGS = [
  '--sandbox', 'workspace-write', '--ignore-user-config', '--ignore-rules',
  '-c', `${CODEX_WORKSPACE_NETWORK_KEY}=false`, '-c', `${CODEX_WORKSPACE_WRITABLE_ROOTS_KEY}=[]`,
  '-c', `${CODEX_PLUGINS_FEATURE_KEY}=false`, '-c', `${CODEX_APPS_FEATURE_KEY}=false`,
  '-c', `${CODEX_HOOKS_FEATURE_KEY}=false`,
];

/**
 * Saved provider argv for a file-editing repair driven by untrusted input
 * (autofixer crash logs), or null when the vendor has no enforced restricted
 * mode. Build from the fixed recipe: arbitrary saved options can restore MCP,
 * plugins, hooks or writable roots even after a sandbox flag is overridden.
 * Model and effort still come from the provider's fields in the vendor builder.
 * The result replaces `provider.args`; the vendor builder adds `-p -` / `-`.
 *
 * @param {object} provider - provider record (command, args)
 * @returns {{ mode: 'claude-disallowed-tools'|'codex-workspace-write', args: string[] } | null}
 */
export function restrictedRepairArgs(provider) {
  const command = provider?.command;
  if (!command) return null;
  if (isClaudeCommand(command)) {
    return { mode: 'claude-disallowed-tools', args: [...CLAUDE_REPAIR_ARGS] };
  }
  if (isCodexCommand(command)) {
    return { mode: 'codex-workspace-write', args: ['exec', ...CODEX_REPAIR_ARGS] };
  }
  return null;
}

/**
 * Whether a one-shot call on `provider` can run without host authority: an API
 * provider, or a headless CLI whose vendor has a tool-disable switch. A TUI
 * record is never tool-free — its interactive argv comes from the TUI spawn
 * path, which this module does not make tool-free.
 */
export function isToolFreeOneShotProvider(provider) {
  if (provider?.type === PROVIDER_TYPES.API) return true;
  return provider?.type === PROVIDER_TYPES.CLI && toolFreeOneShotArgs(provider).toolFree;
}

/**
 * A one-shot over untrusted text that must look at a staged image file (#15576).
 * Vendors that read images with a file tool (claude, grok) keep only that read
 * tool; codex attaches with `-i` under its read-only sandbox; an API provider
 * sends the image inline. Returns null when the vendor has no such posture, so
 * the caller fails closed rather than running with every tool on.
 *
 * @param {object} provider - provider record (type, command)
 * @param {string[]} [args] - the built vision argv
 * @returns {{ args: string[], imageRead: 'inline'|'attach'|'read-tool' } | null}
 */
export function imageReadOneShotArgs(provider, args = []) {
  if (provider?.type === PROVIDER_TYPES.API) return { args: [...args], imageRead: 'inline' };
  if (provider?.type !== PROVIDER_TYPES.CLI) return null;
  const spec = PROVIDER_VENDORS.find((v) => v.toolFreeOneShot?.matchCommand(provider?.command))?.toolFreeOneShot;
  const { args: stripped } = stripApprovalBypassArgs(args, spec?.bypassAliases);
  if (spec?.imageReadArgs) return { args: spec.imageReadArgs(stripped), imageRead: 'read-tool' };
  if (spec?.sandboxArgs) return { args: spec.sandboxArgs(stripped), imageRead: 'attach' };
  return null;
}

/** Whether a provider can run {@link imageReadOneShotArgs}: look at an image without host-writing tools. */
export const canReadImagesOneShot = (provider) => imageReadOneShotArgs(provider) !== null;

/**
 * Whether a headless CLI one-shot is held to an OS read-only sandbox (codex)
 * though it cannot disable its tools. Weaker than tool-free: read tools remain.
 */
function isReadOnlySandboxOneShotProvider(provider) {
  return provider?.type === PROVIDER_TYPES.CLI && toolFreeOneShotArgs(provider).readOnlySandbox === true;
}

/** Providers music-video code authoring may use: tool-free, or read-only sandboxed. */
export function isAuthoringOneShotProvider(provider) {
  return isToolFreeOneShotProvider(provider) || isReadOnlySandboxOneShotProvider(provider);
}

/**
 * The refusal for a one-shot over caller text whose provider cannot be made
 * tool-free and whose caller lacks host control, or null when it may run.
 * A plain `{ status, code, message }` so this module stays free of the server's
 * error classes; callers wrap it in a `ServerError`.
 *
 * @param {object} provider
 * @param {boolean} hasHostControl - the caller's server-derived authority
 */
export function toolFreeOneShotRefusal(provider, hasHostControl) {
  if (hasHostControl === true || isToolFreeOneShotProvider(provider)) return null;
  return {
    status: 403,
    code: 'HOST_CONTROL_FORBIDDEN',
    message: `Provider '${providerLabel(provider)}' cannot run without tools, so using it here requires host control: an operator session, or a local connection when no password is set. Choose an API provider or a tool-free CLI instead.`,
  };
}
