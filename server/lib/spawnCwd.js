/**
 * Spawn working-directory resolution for provider runs and agents.
 *
 * Every provider run and CoS agent gets a `workspacePath` (the selected app's repoPath) used as the child's cwd; a missing value falls back to the PortOS repo root, which was once *silent* (a prompt like "create HelloWorld.md" wrote into the PortOS checkout while the UI showed the app as selected, #3180). This module makes the decision explicit: it logs the effective cwd for every spawn and rejects a workspace that was requested but doesn't exist (a typo'd or moved repo path). It can only catch a workspace that *resolved to something wrong*; an app resolving to no path is indistinguishable here from "no app selected", so `getAppWorkspace` returns `null` rather than substituting the PortOS root. `withSpawnCwdEnv` covers a CLI that resolves its own cwd from the inherited `PWD` env var (#3193).
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { statSync } from 'fs';
import { rm } from 'fs/promises';
import { expandHome } from './paths.js';
import { isTruthyMeta } from './metadataFlags.js';

/**
 * Creative Director treatment/plan/evaluate tasks are HTTP-PATCH deliverables (`noCodeOutput`) that never asked for a worktree. With `cwd = PATHS.root` Claude Code / Codex would discover the PortOS repo's AGENTS.md
 * files (the bloat the API path skips via `skipClaudeMd`); a per-agent scratch dir with no AGENTS.md is the provider-agnostic fix (#4650). `useWorktree: true` keeps the worktree (explicit isolation wins); CD production tasks always set `false`.
 */
export function usesCreativeDirectorScratchCwd(task) {
  if (!task?.metadata?.creativeDirector) return false;
  return !isTruthyMeta(task.metadata.useWorktree);
}

/** Isolated cwd for a CD-marked CLI/TUI run, under the OS temp dir, NOT the checkout (`data/cos/agents` is inside the git tree, so parent-directory walks would find AGENTS.md). `agentId` is required (a missing id would collapse every CD run onto one folder). */
export function creativeDirectorScratchCwd(agentId) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new Error('creativeDirectorScratchCwd requires a non-empty agentId');
  }
  return join(tmpdir(), 'portos-cd-cwd', agentId);
}

/** Best-effort: missing dirs are a no-op (`force: true`). */
export async function removeCreativeDirectorScratchCwd(agentId) {
  await rm(creativeDirectorScratchCwd(agentId), { recursive: true, force: true });
}

/** Spawn-site cwd for a CoS agent: CD scratch tasks always resolve to the per-agent scratch path (even if handed `PATHS.root`); everyone else keeps `workspacePath || fallbackRoot`. */
export function resolveAgentCliCwd({ workspacePath, fallbackRoot, task, agentId } = {}) {
  if (usesCreativeDirectorScratchCwd(task)) return creativeDirectorScratchCwd(agentId);
  return workspacePath && typeof workspacePath === 'string' ? workspacePath : fallbackRoot;
}

/**
 * Resolve the working directory for a spawned run or agent.
 *
 * @param {string|undefined|null} workspacePath - caller-supplied workspace (app repoPath)
 * @param {string} fallbackRoot - directory to use when no workspace was supplied
 * @param {string} [label] - short run/agent identifier used in the log line
 * @param {{ log?: boolean }} [options] - `log: false` when the caller logs the final directory itself (an agent prep resolves the source repo and may replace it with a worktree)
 * @returns {string} the directory to hand to `spawn`/`pty.spawn` as `cwd`
 * @throws {Error} when `workspacePath` was supplied but is not an existing directory
 */
export function resolveSpawnCwd(workspacePath, fallbackRoot, label = 'run', { log = true } = {}) {
  // "Nothing supplied" and "something blank supplied" must not collapse: `repoPath` is only `z.string().min(1)`, so an app can hold "   ", a MISCONFIGURED workspace; deciding on the trimmed value would fall back to the PortOS checkout, the bug this module prevents.
  const supplied = typeof workspacePath === 'string' && workspacePath.length > 0;
  if (!supplied) {
    if (log) console.log(`📂 ${label} cwd: ${fallbackRoot} (no workspace selected)`);
    return fallbackRoot;
  }

  // expandHome so `~/Projects/App` resolves instead of failing as "does not exist" (every other user-supplied-path boundary expands it).
  const requested = expandHome(workspacePath.trim());
  if (!requested) {
    throw new Error(
      `Workspace path is blank: the Repository Path for this app is only whitespace. `
      + `Set it to the repo folder (Apps → edit → Repository Path) and run again.`
    );
  }

  // Fail loudly: a bad repoPath is a fixable configuration error; running somewhere else and reporting success is not recoverable.
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

  if (log) console.log(`📂 ${label} cwd: ${requested}`);
  return requested;
}

// Windows env names are case-insensitive, so a `process.env` spread can surface `Pwd`/`pwd`; adding a separate `PWD` would give the child two spellings with no defined winner, so every case variant is dropped first.
const PWD_KEY_RE = /^pwd$/i;

/**
 * Return a copy of `env` whose `PWD` names the directory the child will actually run in. `spawn({ cwd })` changes the real working directory but does NOT rewrite the inherited `PWD` (maintained by the shell), so a child of the
 * PortOS server inherits `PWD=<PortOS checkout>`. Most CLIs read `process.cwd()`, but `opencode run` resolves its root as `process.env.PWD ?? process.cwd()` (`packages/opencode/src/cli/cmd/run.ts`), so every PortOS agent ran in the
 * PortOS folder while logs reported the app's workspace (#3193, follow-up to #3180). Upstream closed it won't-fix with exporting `PWD` as the workaround, so PortOS pins it at every spawn site; a `PWD` disagreeing with the real cwd is wrong for any reader.
 *
 * @param {NodeJS.ProcessEnv|object} env - env the child would otherwise receive
 * @param {string|undefined|null} cwd - the directory being passed to `spawn` as `cwd`
 * @returns {object} a copy of `env` with `PWD` set to `cwd` (unchanged copy when `cwd` is absent)
 */
export function withSpawnCwdEnv(env, cwd) {
  const next = { ...(env || {}) };
  // No cwd means the child inherits the parent's real cwd, so the inherited PWD is already truthful; stripping it would substitute a different lie.
  if (typeof cwd !== 'string' || !cwd) return next;
  for (const key of Object.keys(next)) if (PWD_KEY_RE.test(key)) delete next[key];
  next.PWD = cwd;
  return next;
}
