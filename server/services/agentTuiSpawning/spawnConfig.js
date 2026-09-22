/**
 * Agent TUI spawn config
 *
 * The PURE launch-shape builder: provider + model + posture in, the argv /
 * command-line quadruple out. No PTY, no session, no timers — nothing here
 * observes or mutates a live run.
 *
 * Extracted from `agentTuiSpawning.js` so "what command does this provider
 * launch?" is answerable without loading the live session state machine
 * (`sessionController.js`). The two concerns had drifted into one closure's
 * neighbourhood purely by history: a vendor-recipe change and a paste-retry
 * change touched the same file for no shared reason.
 */

import { formatShellCommandLine } from '../../lib/shellCd.js';
import { resolveInteractiveShell } from '../../lib/interactiveShellResolver.js';
import { buildCodexAgentThreadArgs, isClaudeCommand, applyLeanClaudeArgs } from '../../lib/providerModels.js';
import { isCodexCommand } from '../../lib/codex.js';
import { applyCredentialBootstrap } from '../../lib/credentialBootstrap.js';
import { buildVendorSpawnConfig, injectTuiModelAndEffort, supportsTuiPublicReviewPosture } from '../../lib/providerVendors.js';
import { publicReviewPostureForProfile } from '../../lib/agentExecutionProfiles.js';
import { DEFAULT_TUI_PROMPT_DELAY_MS, inferTuiCommand, applyCommandDefaults } from '../../lib/tuiHandshake.js';

export function buildTuiSpawnConfig(provider, model, {
  systemPromptFile = null,
  effort = null,
  maxConcurrentThreads = null,
  safetyProfile = null,
  shell = resolveInteractiveShell(),
} = {}) {
  // A public-content stage's argv is the vendor's maintained recipe, never the
  // generic assembly below — that path forwards `provider.args` and applies
  // `applyCommandDefaults`, either of which can hand a contributor-controlled
  // review a saved `--dangerously-skip-permissions`. `tui: true` tells the
  // recipe to drop only the flags that require `--print` and keep every
  // enforcement flag. Fail closed when the pairing declares no attachable recipe: the
  // caller is supposed to have asked `supportsTuiPublicReviewPosture` first, so
  // reaching this is a routing bug and must not silently open a PTY whose
  // posture is decorative.
  const posture = publicReviewPostureForProfile(safetyProfile);
  if (posture) {
    if (!supportsTuiPublicReviewPosture(provider, posture)) {
      throw new Error(`Provider '${provider?.id || provider?.command || 'unknown'}' cannot run an attachable ${posture} session`);
    }
    const recipe = buildVendorSpawnConfig(provider, {
      effectiveModel: model,
      effort,
      maxConcurrentThreads,
      systemPromptFile,
      safetyProfile,
      tui: true,
    });
    // A `sandboxed-actions` posture never gets credential-bootstrap-wrapped —
    // the enforced recipe above IS the sandbox there, and it is spelled entirely
    // in argv. A `no-tool` posture IS wrapped, because spawned bare it would
    // carry no credential at all (#7720). `applyCredentialBootstrap` owns that
    // split (keyed on `safetyProfile`); either way this branch returns the same
    // shape as every other, with `command`/`args` still naming the harness.
    const { command: spawnCommand, args: spawnArgs } = applyCredentialBootstrap(provider, recipe.command, recipe.args, { safetyProfile });
    return {
      command: recipe.command,
      args: recipe.args,
      spawnCommand,
      spawnArgs,
      commandLine: formatShellCommandLine(spawnCommand, spawnArgs, shell),
      promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    };
  }
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])], provider);
  // Model+effort injection (including the antigravity-validates-the-pair special
  // case) is shared with tuiHandshake.js#buildTuiInvocation via
  // providerVendors.js#injectTuiModelAndEffort, so the two spawn paths can't
  // drift — they already had once, on cursor, before #3618.
  let args = injectTuiModelAndEffort(command, baseArgs, provider, model, effort);
  if (isCodexCommand(command)) {
    args = [...args, ...buildCodexAgentThreadArgs(maxConcurrentThreads)];
  }
  // Lean mode for Ollama-backed claude sessions (no-op otherwise) — must come
  // before the system-prompt flag so `--bare` is present when the contract
  // file rides along.
  args = applyLeanClaudeArgs(provider, args, command);
  if (systemPromptFile && isClaudeCommand(command)) {
    args = [...args, '--append-system-prompt-file', systemPromptFile];
  }
  // `command`/`args` keep naming the harness itself — every consumer of this
  // config (ready-text detection, permission-dialog handling, error messages)
  // keys off them by identity. `spawnCommand`/`spawnArgs` are what actually
  // gets launched: the bootstrap CLI in front of the harness invocation for a
  // credential-bootstrap-configured provider (see credentialBootstrap.js), or
  // an identical copy otherwise. `commandLine` (used both to type the harness
  // into a login shell and to display "what's running") is built from the
  // SPAWNED pair so it always matches the real process.
  const { command: spawnCommand, args: spawnArgs } = applyCredentialBootstrap(provider, command, args);
  const commandLine = formatShellCommandLine(spawnCommand, spawnArgs, shell);

  return {
    command,
    args,
    spawnCommand,
    spawnArgs,
    commandLine,
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS
  };
}
