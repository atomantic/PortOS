/**
 * Spawn working-directory resolution for provider runs and agents.
 *
 * Every AI provider run and CoS agent gets a `workspacePath` (the selected
 * app's repoPath) and spawns its CLI/TUI with that as the child's cwd. When the
 * value is missing the spawn falls back to the PortOS repo root — which is a
 * reasonable default, but used to be *silent*: a prompt like "create
 * HelloWorld.md" then wrote into the PortOS checkout while the UI still showed
 * the app as the selected workspace, with nothing anywhere saying which
 * directory had actually been used (issue #3180).
 *
 * This module makes that decision explicit and loud in the two ways that
 * matter: it logs the effective cwd for every spawn, and it rejects a workspace
 * that was requested but does not exist on disk (a typo'd or moved repo path)
 * rather than quietly running somewhere else.
 *
 * Note this can only catch a workspace that *resolved to something wrong*. The
 * other half of #3180 — an app that resolves to no path at all — has to be
 * caught where the app is looked up, because "no path" arrives here
 * indistinguishable from "no app selected". `getAppWorkspace` returns `null`
 * for that case rather than silently substituting the PortOS root.
 *
 * `withSpawnCwdEnv` covers the remaining failure mode: a CLI that resolves its
 * own working directory from the inherited `PWD` env var rather than from the
 * cwd it was actually spawned in (issue #3193).
 */

import { statSync } from 'fs';
import { expandHome } from './fileUtils.js';

/**
 * Resolve the working directory for a spawned run or agent.
 *
 * @param {string|undefined|null} workspacePath - caller-supplied workspace (app repoPath)
 * @param {string} fallbackRoot - directory to use when no workspace was supplied
 * @param {string} [label] - short run/agent identifier used in the log line
 * @returns {string} the directory to hand to `spawn`/`pty.spawn` as `cwd`
 * @throws {Error} when `workspacePath` was supplied but is not an existing directory
 */
export function resolveSpawnCwd(workspacePath, fallbackRoot, label = 'run') {
  // "Nothing was supplied" and "something blank was supplied" are different
  // answers and must not collapse. `repoPath` is validated only as
  // `z.string().min(1)`, so an app can hold "   " — that is a MISCONFIGURED
  // workspace, not an absent one. Deciding on the trimmed value would turn it
  // back into the fallback root and silently run in the PortOS checkout: the
  // exact bug this module exists to prevent, reachable through the one input
  // the schema still lets through.
  const supplied = typeof workspacePath === 'string' && workspacePath.length > 0;
  if (!supplied) {
    console.log(`📂 ${label} cwd: ${fallbackRoot} (no workspace selected)`);
    return fallbackRoot;
  }

  // expandHome so a repoPath saved as `~/Projects/App` resolves instead of
  // hard-failing as "does not exist" — every other user-supplied-path boundary
  // in the repo expands it too.
  const requested = expandHome(workspacePath.trim());
  if (!requested) {
    throw new Error(
      `Workspace path is blank: the Repository Path for this app is only whitespace. `
      + `Set it to the repo folder (Apps → edit → Repository Path) and run again.`
    );
  }

  // Fail loudly instead of silently running in the PortOS checkout. A bad
  // repoPath is a configuration error the user can fix; running the agent
  // somewhere else and reporting success is not recoverable after the fact.
  const stats = statSync(requested, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(
      `Workspace path does not exist: ${requested}. `
      + `Fix the Repository Path for this app (Apps → edit → Repository Path) and run again.`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Workspace path is not a directory: ${requested}. `
      + `Set the app's Repository Path to the repo folder, not a file.`
    );
  }

  console.log(`📂 ${label} cwd: ${requested}`);
  return requested;
}

// Windows environment-variable names are case-insensitive, so a spread of
// `process.env` can surface this variable as `Pwd`/`pwd`. Adding a separate
// `PWD` key to that object would hand the child two spellings of one variable
// with no defined winner — so every case variant is dropped before the correct
// value is set.
const PWD_KEY_RE = /^pwd$/i;

/**
 * Return a copy of `env` whose `PWD` names the directory the child will
 * actually run in.
 *
 * Passing `cwd` to `spawn()` changes the child's real working directory but
 * does NOT rewrite `PWD` in the inherited environment — that variable is
 * maintained by the shell, so a child spawned from the long-running PortOS
 * server inherits `PWD=<the PortOS checkout>` no matter where it was pointed.
 * Most CLIs never notice, because they read `process.cwd()`. OpenCode does:
 * `opencode run` resolves its project root as `process.env.PWD ?? process.cwd()`
 * (`packages/opencode/src/cli/cmd/run.ts`), so it ran every PortOS agent in the
 * PortOS folder while the spawn logs correctly reported the app's workspace —
 * "create HelloWorld.md" landed in the PortOS checkout, and asking the agent to
 * print its own working directory printed the PortOS path (issue #3193,
 * follow-up to #3180). Codex/Claude/Gemini were unaffected, which is why the
 * bug looked OpenCode-specific.
 *
 * Upstream closed that behavior as won't-fix and documented exporting a correct
 * `PWD` as the supported workaround, so PortOS pins it at every spawn site.
 * This is the right fix generally, not just for OpenCode: a `PWD` that
 * disagrees with the child's actual cwd is wrong for any process that reads it,
 * and pinning it costs nothing for the ones that don't.
 *
 * @param {NodeJS.ProcessEnv|object} env - env the child would otherwise receive
 * @param {string|undefined|null} cwd - the directory being passed to `spawn` as `cwd`
 * @returns {object} a copy of `env` with `PWD` set to `cwd` (unchanged copy when `cwd` is absent)
 */
export function withSpawnCwdEnv(env, cwd) {
  const next = {};
  const pin = typeof cwd === 'string' && cwd.length > 0;
  for (const [key, value] of Object.entries(env || {})) {
    // Only strip the stale variants when there's a real value to replace them
    // with — otherwise a caller that spawns without an explicit cwd would have
    // its inherited PWD deleted, which is a different (and equally wrong) lie.
    if (pin && PWD_KEY_RE.test(key)) continue;
    next[key] = value;
  }
  if (pin) next.PWD = cwd;
  return next;
}
