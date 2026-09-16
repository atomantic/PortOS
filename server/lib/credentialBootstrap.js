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
 * Wrapping also changes TEARDOWN, so every site that spawns a long-lived child
 * here owes a second thing: the direct child is then the WRAPPER, and nothing
 * obliges it to `exec`-replace itself, so a per-pid SIGTERM can leave the
 * harness running. `needsProcessGroup` + `trackDetachedGroup` /
 * `signalDetachedGroups` / `processGroupKillable` below are that half of the
 * contract — see `needsProcessGroup` (#7496).
 *
 * Imports only `bufferedSpawn.js` and `agentExecutionProfiles.js` (both of
 * which `cliProviderRun.js` already depends on directly) so any spawn site —
 * including the standalone `portos-autofixer` process via `cliProviderRun.js`
 * — can import this module without dragging in the AI toolkit or data layer.
 */

import { IS_WIN32, resolveWindowsExecutable, prepareWindowsSafeSpawn, killProcessTree } from './bufferedSpawn.js';
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
 * `wrapped` reports whether the wrap actually applied — including the
 * public-review skip, so a posture that is deliberately NOT wrapped also keeps
 * the unwrapped teardown. It matters for process teardown, not argv: once a
 * bootstrap CLI sits in front of the harness, the direct child PortOS holds is
 * the WRAPPER, and `<bootstrap> run <harness> -- <args>` is the shape of a
 * supervising parent. A plain SIGTERM to the direct child then leaves the
 * harness running. See `needsProcessGroup` (#7496).
 *
 * @param {{safetyProfile?: string|null}} [options] - the run's execution
 *   profile; a public-review posture is returned unwrapped (see module doc)
 * @returns {{command: string, args: string[], wrapped: boolean}}
 */
export function applyCredentialBootstrap(provider, command, args, { safetyProfile = null } = {}) {
  const bootstrap = provider?.credentialBootstrap;
  const harnessArgs = Array.isArray(args) ? args : [];
  if (!hasCredentialBootstrap(provider) || isPublicReviewRestrictedProfile(safetyProfile)) {
    return { command, args: harnessArgs, wrapped: false };
  }
  const harnessId = (typeof bootstrap.harnessId === 'string' && bootstrap.harnessId) || command;
  const separator = (typeof bootstrap.argsSeparator === 'string' && bootstrap.argsSeparator && harnessArgs.length > 0)
    ? [bootstrap.argsSeparator] : [];
  return {
    command: bootstrap.command,
    args: [...(Array.isArray(bootstrap.args) ? bootstrap.args : []), harnessId, ...separator, ...harnessArgs],
    wrapped: true,
  };
}

/**
 * Should this spawn get its own process group, so stop/timeout/cancel reaches
 * the harness BEHIND the bootstrap wrapper and not just the wrapper itself?
 *
 * Stop/timeout/cancel is a safety control: a harness that survives it keeps
 * running — possibly with `--dangerously-skip-permissions` in a worktree,
 * holding a freshly minted credential — after PortOS has finalized the run and
 * released the lane. On POSIX a signal to the direct child's pid reaches only
 * that pid, so a forking wrapper that does not forward SIGTERM orphans the
 * harness. Spawning `detached: true` puts wrapper and harness in one process
 * group that `killProcessTree(child, sig, { processGroup: true })` signals
 * whole.
 *
 * POSIX-only, deliberately:
 *   - On Windows `killProcessTree` already uses `taskkill /T`, which is
 *     tree-wide rather than group-based, so the hole does not exist there.
 *   - `detached: true` on Windows opens a new console window per spawn.
 *
 * False for an unwrapped spawn — including a public-review posture, which is
 * never wrapped — so nothing changes for those: the harness is the direct child
 * there and today's per-pid signal is exact.
 *
 * @param {boolean} wrapped - the `wrapped` flag from applyCredentialBootstrap/resolveCliSpawn
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @returns {boolean}
 */
export function needsProcessGroup(wrapped, isWin32 = IS_WIN32) {
  return Boolean(wrapped) && !isWin32;
}

/**
 * pids of the children this process spawned into their own process group.
 *
 * Detaching is what makes stop/timeout/cancel reach the harness, but it also
 * moves the child OUT of the server's process group — so a shutdown driven by a
 * signal aimed at THAT group (Ctrl-C at an `npm start` terminal, `kill -<pgid>`)
 * no longer reaches it. pm2's TreeKill walks the pid tree and is unaffected.
 * This set is what lets the shutdown handler restore exactly that lost reach,
 * across every detached spawn site at once, rather than each registry (agents,
 * runs, vision calls, ask calls) having to be swept separately and one forgotten.
 */
const detachedGroupPids = new Set();

/**
 * Remember a detached child's process group until it closes. No-op — and the
 * child is returned untouched — when the spawn was not detached.
 *
 * Keyed by pid rather than by handle so the shutdown sweep needs nothing but
 * `process.kill`.
 *
 * Cleared on `close` — NOT on `exit`, and adding `exit` would defeat the whole
 * point. `exit` fires when the WRAPPER is reaped; `close` waits for its stdio to
 * close, which the harness is still holding precisely in the case this registry
 * exists for (a wrapper that forked and left the harness running). Forgetting the
 * group at `exit` would drop it exactly when the harness is its only member —
 * the orphan we are trying to reach.
 *
 * That deferral does not risk signalling a recycled pid: `kill(-pid)` addresses a
 * process GROUP, and a pgid cannot be reallocated while its group still has a
 * member. So as long as anything in the group is alive the number stays ours,
 * and once the group empties the harness's descriptors are closed, so `close`
 * has fired. `error` covers a child that never started and will emit neither.
 *
 * @template T
 * @param {T & {pid?: number, once?: Function}} child
 * @param {boolean} processGroup - the `needsProcessGroup` result used for this spawn
 * @returns {T} the same child, for call-site chaining
 */
export function trackDetachedGroup(child, processGroup) {
  if (!processGroup || !child?.pid || typeof child.once !== 'function') return child;
  const { pid } = child;
  detachedGroupPids.add(pid);
  const forget = () => detachedGroupPids.delete(pid);
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

/**
 * SIGTERM every live detached process group. Best-effort and synchronous: it
 * runs inside the graceful-shutdown window, where an already-dead group (ESRCH)
 * is not a fault and nothing may propagate out of a signal handler.
 *
 * @param {NodeJS.Signals} [signal]
 * @param {(label: string, err: Error) => void} [logFailure]
 * @returns {number} how many groups were signalled
 */
export function signalDetachedGroups(signal = 'SIGTERM', logFailure = null) {
  let signalled = 0;
  for (const pid of detachedGroupPids) {
    try { process.kill(-pid, signal); signalled += 1; }
    catch (err) { if (err?.code !== 'ESRCH') logFailure?.(`⚠️ Group ${signal} for pid ${pid}`, err); }
  }
  return signalled;
}

/** Test-only: drop every tracked group without signalling it. */
export function resetDetachedGroupsForTests() {
  detachedGroupPids.clear();
}

/**
 * Wrap a spawned child in the minimal `{ pid, killed, kill(signal) }` shape the
 * aiToolkit runner's external-run registry consumes (`registerExternalRun`),
 * so its `stopRun` — the /runs Stop button — signals the whole process group
 * instead of the wrapper alone.
 *
 * The toolkit carries its OWN self-contained `killProcessTree` with no
 * `processGroup` option (see `server/lib/aiToolkit/AGENTS.md` — that directory
 * imports nothing out to PortOS), and it reaches a non-ChildProcess killable
 * through the handle's own `.kill()`. Handing it this adapter is therefore how
 * a host-owned group kill reaches a toolkit-driven stop without editing the
 * vendored copy. Returns the child UNCHANGED when `processGroup` is false, so
 * an unwrapped run registers exactly what it registers today.
 *
 * @param {import('child_process').ChildProcess|{pid?: number, kill: Function}} child
 * @param {boolean} processGroup
 */
export function processGroupKillable(child, processGroup) {
  if (!processGroup) return child;
  return {
    get pid() { return child.pid; },
    get killed() { return child.killed; },
    kill: (signal) => killProcessTree(child, signal || 'SIGTERM', { processGroup: true }),
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
 * @returns {{command: string, args: string[], wrapped: boolean}} `wrapped` is
 *   carried through from `applyCredentialBootstrap` — see `needsProcessGroup`
 */
export function resolveCliSpawn(provider, command, args, childEnv, options = {}) {
  const bootstrapped = applyCredentialBootstrap(provider, command, args, options);
  const resolvedCommand = resolveWindowsExecutable(bootstrapped.command, undefined, childEnv) || bootstrapped.command;
  return { ...prepareWindowsSafeSpawn(resolvedCommand, bootstrapped.args), wrapped: bootstrapped.wrapped };
}
