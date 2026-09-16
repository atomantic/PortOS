/**
 * Generic "credential bootstrap" wrapping for a CLI/TUI provider whose auth is
 * provisioned by an external CLI at spawn time, rather than a static `apiKey`
 * PortOS stores — e.g. a company-internal tool that mints a short-lived token
 * for an OpenAI-compatible proxy and execs the harness itself once it's ready.
 * PortOS never needs to understand the credential, the proxy, or how the
 * bootstrap CLI hands the token to its child: it only needs to spawn the
 * bootstrap CLI in front of the harness invocation instead of the harness
 * directly, exactly the way a person would type `<bootstrap> run <harness>
 * <harness args...>` at a shell.
 *
 * `provider.command`/`args` keep naming the actual harness (claude, opencode,
 * …) everywhere else in the codebase — vendor detection, prompt-delivery
 * convention, and the TUI's own ready-text heuristics all key off it, and
 * would silently break if the harness's identity were replaced by the
 * bootstrap binary's. So every spawn site keeps resolving the harness's own
 * command/args exactly as it does today, and only asks this module for the
 * pair to actually hand to `spawn`/`pty.spawn`, right before that call. The
 * one heuristic that must key on the SPAWNED pair instead is anything that
 * observes the launching shell rather than the harness — a login shell's
 * `command not found` names the bootstrap binary, so a PATH probe or a
 * missing-binary detector reads `spawnCommand`, never `command`.
 *
 * EVERY site that spawns a provider's `command` must go through here — a site
 * that spawns the bare harness runs it with no credential, and the harness
 * then falls through to whatever ambient vendor auth the machine has, sending
 * the prompt to the wrong backend with no error. Wrapped sites: the headless
 * runners (`runner.js`, `cliProviderRun.js`, `visionCli.js`, `askService.js`,
 * `opencodeTask.js`), the agent spawners (`agentCliSpawning.js`,
 * `agentTuiSpawning.js`), the one-shot TUI runner (`tuiPromptRunner.js`), the
 * "Launch in Shell" line (`tuiShellLaunch.js`), the TUI usage scrape
 * (`providerUsage.js`), and the readiness probes (`providerPrerequisites.js`,
 * the toolkit's `testProvider`).
 *
 * A public-review posture (`isPublicReviewRestrictedProfile`) is NEVER
 * wrapped, at any site: the vendor's enforced no-tool/sandboxed recipe IS the
 * sandbox, and its argv and env allowlists are both defeated by handing the
 * recipe to a user-configured binary that mints and re-injects a credential.
 * The skip lives here rather than at each call site so a new spawn site can't
 * forget it.
 *
 * Imports only `bufferedSpawn.js` and `agentExecutionProfiles.js` (both of
 * which `cliProviderRun.js` already depends on directly) so any spawn site —
 * including the standalone `portos-autofixer` process via `cliProviderRun.js`
 * — can import this module without dragging in the AI toolkit or data layer.
 */

import { resolveWindowsExecutable, prepareWindowsSafeSpawn } from './bufferedSpawn.js';
import { isPublicReviewRestrictedProfile } from './agentExecutionProfiles.js';

/** True when a provider names a bootstrap CLI to wrap its harness spawn. */
export function hasCredentialBootstrap(provider) {
  return typeof provider?.credentialBootstrap?.command === 'string' && provider.credentialBootstrap.command.length > 0;
}

/**
 * The command+args PortOS should actually spawn for this provider: the
 * bootstrap CLI in front of the harness invocation when configured, or the
 * harness invocation unchanged otherwise. Pure — never touches the filesystem
 * or PATH; Windows shim resolution still happens downstream, against whichever
 * command this returns.
 *
 * Shape: `<bootstrap.command> <bootstrap.args...> <harnessId> [<bootstrap.argsSeparator>] <args...>`.
 *
 * `argsSeparator` exists because a wrapper CLI commonly needs its own flags
 * kept apart from the harness's — e.g. `<bootstrap> run <harness> -- <harness
 * args>` — and without a configurable separator the harness's own flags would
 * be parsed as the bootstrap CLI's.
 *
 * `harnessId` exists because a bootstrap CLI's own name for a harness is not
 * always the binary PortOS spawns — e.g. a tool may want `claude-code` where
 * `provider.command` is the literal binary `claude`. Defaults to `command`
 * (the harness binary) when unset, which covers a bootstrap CLI that takes
 * the binary name directly.
 *
 * @param {{credentialBootstrap?: {command: string, args?: string[], harnessId?: string, argsSeparator?: string}}|null|undefined} provider
 * @param {string} command - the harness binary PortOS would otherwise spawn
 * @param {string[]} [args] - the harness's own argv
 * @param {{safetyProfile?: string|null}} [options] - the run's execution
 *   profile; a public-review posture is returned unwrapped (see module doc)
 * @returns {{command: string, args: string[]}}
 */
export function applyCredentialBootstrap(provider, command, args, { safetyProfile = null } = {}) {
  const bootstrap = provider?.credentialBootstrap;
  const harnessArgs = Array.isArray(args) ? args : [];
  if (!hasCredentialBootstrap(provider) || isPublicReviewRestrictedProfile(safetyProfile)) return { command, args: harnessArgs };
  const harnessId = (typeof bootstrap.harnessId === 'string' && bootstrap.harnessId) || command;
  const separator = (typeof bootstrap.argsSeparator === 'string' && bootstrap.argsSeparator && harnessArgs.length > 0)
    ? [bootstrap.argsSeparator] : [];
  return {
    command: bootstrap.command,
    args: [...(Array.isArray(bootstrap.args) ? bootstrap.args : []), harnessId, ...separator, ...harnessArgs],
  };
}

/**
 * `applyCredentialBootstrap` + Windows shim resolution in one call — the
 * shape every headless spawn site needs immediately before its literal
 * `spawn()` call. Mirrors why `cliChildEnv.js`'s `buildCliChildEnv` exists:
 * three sites (`runner.js`, `cliProviderRun.js`, `visionCli.js`) independently
 * repeated the same "wrap, then resolve, then prepare" sequence with the same
 * explanatory comment — precisely the copy-paste `cliChildEnv.js`'s own
 * docblock describes for env composition, one layer up for argv.
 *
 * TUI/PTY spawn sites (`agentTuiSpawning.js`, `tuiPromptRunner.js`) do their
 * own Windows resolution (or none) and are NOT expected to call this — see
 * their own `applyCredentialBootstrap` call sites.
 *
 * @param {object|null|undefined} provider
 * @param {string} command - the harness binary PortOS would otherwise spawn
 * @param {string[]} args - the harness's own argv
 * @param {NodeJS.ProcessEnv} childEnv - resolved against this so a
 *   provider-configured PATH override is honored
 * @param {{safetyProfile?: string|null}} [options] - forwarded to `applyCredentialBootstrap`
 * @returns {{command: string, args: string[]}}
 */
export function resolveCliSpawn(provider, command, args, childEnv, options = {}) {
  const bootstrapped = applyCredentialBootstrap(provider, command, args, options);
  const resolvedCommand = resolveWindowsExecutable(bootstrapped.command, undefined, childEnv) || bootstrapped.command;
  return prepareWindowsSafeSpawn(resolvedCommand, bootstrapped.args);
}
