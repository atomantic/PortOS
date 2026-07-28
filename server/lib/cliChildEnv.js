/**
 * Child-environment composition for every AI-CLI spawn.
 *
 * Five spawn sites — `services/runner.js` (Run Prompt), `lib/cliProviderRun.js`
 * (fire-and-collect), `services/agentCliSpawning.js` (CoS agents),
 * `lib/tuiPromptRunner.js` (PTY TUI runs), and `cos-runner/index.js`
 * (`POST /spawn`) — each independently rebuilt the same env tuple:
 *
 *   { ...baseEnv, ...providerEnv, ...opencodeEnv }
 *     → pin PWD to the spawn cwd
 *     → strip CLAUDECODE
 *     → prepend the pm2 guard shim   (agent-spawning sites only)
 *
 * Three separate fixes each paid an N-file sweep to keep those five in step:
 * the OpenCode declared-models map (#2190/#2243), the `CLAUDECODE` strip, and
 * the `PWD` pin (#3193). Every time, the guard against missing a site was
 * "a reviewer noticed" or a source-grep test. This module owns the composition
 * so the next env-level concern is a one-file change (#3194).
 *
 * **Precedence is the load-bearing part.** The sites do NOT all layer their
 * extras the same way, and flattening them into one order would silently change
 * which value wins:
 *
 *   - `agentCliSpawning` puts `forgeTokenEnv`/`claudeSettingsEnv` BEFORE
 *     `provider.envVars`, so an explicit provider `GH_TOKEN` still overrides the
 *     repo-owner-pinned one.
 *   - `tuiPromptRunner` puts `TERM`/`COLORTERM` AFTER everything, so the PTY
 *     always gets a truecolor terminal regardless of provider config.
 *
 * Hence two distinct slots — `before` (lower precedence than the provider) and
 * `extra` (higher) — rather than one `extra`. `cliChildEnv.test.js` asserts the
 * exact composed order for each of the five call sites.
 *
 * Deliberately NOT in scope: a `spawnAiCli({ command, args, cwd, env })` wrapper
 * that would also own cwd resolution and the Windows `.cmd` shim. The eight
 * spawn shapes differ too much (child_process vs node-pty, stdio variants,
 * kill-tree wiring) to fold in the same change. `lib/aiToolkit/runner.js` is
 * also out of scope: it is vendored and must not import out to other PortOS
 * modules (see `lib/aiToolkit/CLAUDE.md`), so it keeps its inline pin.
 */

import { withSpawnCwdEnv } from './spawnCwd.js';
import { buildOpencodeEnvVars } from './opencodeConfig.js';
import { agentGuardEnv } from './agentGuard/index.js';

/**
 * Compose the environment an AI-CLI child process is spawned with.
 *
 * Layering, lowest precedence first:
 *   `baseEnv` → `before` → `provider.envVars` → OpenCode env → `extra`
 * then `PWD` is pinned to `cwd`, `CLAUDECODE` is stripped, and — only when
 * `guard` is true — the pm2 guard shim is prepended to the final `PATH`.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv|object} [options.baseEnv=process.env] - env to start from.
 *   Callers that must not leak host credentials to an autonomous agent (e.g. the
 *   autofixer) pass a sanitized allowlist here; every later layer still overlays it.
 * @param {object|null} [options.before] - env spread AFTER `baseEnv` but BEFORE
 *   `provider.envVars`, so a provider-configured value still wins over it
 *   (forgeTokenEnv, claudeSettingsEnv).
 * @param {{command?:string, envVars?:object, models?:string[], defaultModel?:string|null, ollamaBacked?:boolean}|null} [options.provider]
 *   - the provider record. `provider.envVars` is layered in, and the provider's
 *   command/ollamaBacked flags decide whether an OpenCode config is built.
 * @param {string|null} [options.model] - the model being run this invocation, used
 *   to build the OpenCode declared-models map. Pass `provider.defaultModel` when
 *   the site has no per-call model.
 * @param {string|undefined|null} options.cwd - the directory being handed to
 *   `spawn`/`pty.spawn`; `PWD` is pinned to it (see `withSpawnCwdEnv`, #3193).
 * @param {object|null} [options.extra] - env spread LAST, so it overrides every
 *   other layer including `provider.envVars` (TERM/COLORTERM for a PTY).
 * @param {boolean} [options.guard=false] - prepend the pm2 guard shim onto the
 *   final `PATH` so an unrestricted agent can't `pm2 kill` the shared daemon.
 *   Only the two agent-spawning sites opt in; the Run Prompt / fire-and-collect
 *   paths keep today's unguarded behavior.
 * @returns {object} a fresh env object safe to hand straight to `spawn`
 */
export function buildCliChildEnv({
  baseEnv = process.env,
  before = null,
  provider = null,
  model = null,
  cwd,
  extra = null,
  guard = false,
} = {}) {
  // buildOpencodeEnvVars rebuilds OPENCODE_CONFIG_CONTENT with a declared models
  // map for OpenCode Ollama providers (an empty object for everyone else) so the
  // injected `--model ollama/<id>` isn't rejected as "not valid" — see #2190.
  // It comes after provider.envVars to override the provider's STATIC
  // OPENCODE_CONFIG_CONTENT, which it was built from.
  const env = withSpawnCwdEnv(
    {
      ...baseEnv,
      ...(before || {}),
      ...(provider?.envVars || {}),
      ...buildOpencodeEnvVars(provider, model),
      ...(extra || {}),
    },
    cwd,
  );

  // CLAUDECODE is set when PortOS itself runs inside Claude Code; passing it
  // through would make a spawned Claude CLI think it's nested inside the parent
  // session.
  delete env.CLAUDECODE;

  // Must be applied to the FINAL PATH (after every override above), or a
  // provider-configured PATH would drop the shim back off the front.
  if (guard) Object.assign(env, agentGuardEnv(env));

  return env;
}
