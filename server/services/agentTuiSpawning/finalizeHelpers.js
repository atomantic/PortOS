/**
 * Agent TUI finalize helpers
 *
 * Failure-analysis + worktree-inspection support for spawnTuiAgent's finalize
 * path. All side-effect-narrow and non-throwing: a failure to read the raw
 * spool, inspect the worktree, or capture a diff must never abort finish()
 * before finalizeAgent runs. Extracted from spawnTuiAgent so the "read the
 * spool tail → analyze the failure" concern is self-contained and testable.
 */

import { join } from 'path';
import { writeFile } from 'fs/promises';
import * as git from '../git.js';
import { readFileTail } from '../../lib/fileUtils.js';
import { commitsSince } from '../../lib/gitCommitProbe.js';
import { analyzeAgentFailure } from '../agentErrorAnalysis.js';

// Re-exported so this module's existing importers (and its tests) keep their
// entry point after the implementation moved to lib/fileUtils.js (#3498) —
// `getAgent`'s transcript cap needed the same bounded tail read.
export { readFileTail };

// Same deal for the run-window commit probe: it moved to lib/gitCommitProbe.js
// (#3637) once finalize's success-criteria evaluation, run completion, and
// orphan recovery all needed the same answer, but this stays its historical
// entry point.
export { commitsSince };

// Tail-read window for raw.txt at failure analysis. analyzeAgentFailure narrows
// further (ANSI-stripped, last ~200 lines AND ≤16K chars), so reading the whole
// file (which has no upper bound for long-running agents) would reintroduce the
// OOM risk the disk spool was meant to avoid. 1MB comfortably covers the
// analyzer's window on any realistic PTY stream — including a repaint-heavy TUI
// transcript, where escape sequences dominate the byte count — while keeping
// peak finalize memory bounded.
export const RAW_TAIL_ANALYSIS_BYTES = 1024 * 1024;

/**
 * Check if a worktree has any uncommitted changes. Returns true when the
 * working tree is dirty (staged or unstaged changes exist). Used to gate
 * idle-complete success — an agent that idled out with zero file changes
 * should fail, not succeed.
 */
export async function worktreeHasChanges(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  const status = await git.getStatus(workspacePath).catch(() => null);
  return status && !status.clean;
}

/**
 * Did this agent leave any evidence of work behind? Dirty tree OR at least one
 * commit made during the run.
 *
 * The commit half is what makes this correct for jobs whose deliverable is a
 * COMMIT rather than a dirty tree — `/do:release` and `/do:pr` runs commit,
 * push, and open a PR, so by the time they idle the tree is clean *because they
 * succeeded*. Gating on `worktreeHasChanges` alone scored those as
 * `idle-no-changes` failures: two consecutive release runs on 2026-08-08 each
 * cut the release commit and opened/repaired the release PR, were reported as
 * failures, and the task retried — holding the release for two days.
 *
 * Accepted trade-off: a run that pulls in a merge commit another agent pushed
 * mid-run sees that commit stamped inside the window and counts it as work.
 * That false success is rarer, and far cheaper, than failing every
 * commit-and-push job.
 */
export async function worktreeHasWorkEvidence(workspacePath, sinceMs) {
  if (await worktreeHasChanges(workspacePath)) return true;
  return (await commitsSince(workspacePath, sinceMs)) > 0;
}

/**
 * Capture the git diff (staged + unstaged) from a worktree and save it to the
 * agent archive dir. Called before worktree cleanup so post-mortems can see
 * what changes existed even if the worktree is deleted. Non-throwing — a
 * failure to capture shouldn't block finalize.
 *
 * @returns {string|null} The captured diff, or null if none/error.
 */
export async function captureWorktreeDiff(workspacePath, agentDir) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  if (!agentDir || typeof agentDir !== 'string') return null;
  const [staged, unstaged] = await Promise.all([
    git.getDiff(workspacePath, true).catch(() => ''),
    git.getDiff(workspacePath, false).catch(() => ''),
  ]);
  const combined = [
    staged ? `### STAGED CHANGES ###\n${staged}` : '',
    unstaged ? `### UNSTAGED CHANGES ###\n${unstaged}` : '',
  ].filter(Boolean).join('\n\n');
  if (!combined.trim()) return null;
  const diffFile = join(agentDir, 'worktree-diff.txt');
  await writeFile(diffFile, combined).catch((err) => {
    console.error(`❌ Failed to capture worktree diff for agent: ${err.message}`);
  });
  return combined;
}

/**
 * Resolve the error-analysis payload for a finalizing agent. Successful runs
 * skip the raw-spool read entirely (that's what keeps the disk-spool's
 * bounded-memory guarantee for healthy long runs); failures read only the
 * tail of raw.txt and hand it to analyzeAgentFailure.
 *
 * `??` (not `||`) so an empty raw spool ('') stays distinguishable from a read
 * failure (null) — readFileTail's contract. A zero-byte raw.txt lets analysis
 * run against ''; both a missing file AND a read error return null and fall
 * back to `fallbackText` (the capped output buffer, which has the spawn-startup
 * notices). An immediate-fallback signal, if one was detected mid-stream,
 * short-circuits the analysis entirely.
 *
 * `completionReason` / `completionError` carry the finalize path's OWN verdict
 * (idle reaper, max runtime, spawn failure). The analyzer prefers that structural
 * signal over a loose keyword match in the transcript — a repaint-driven PTY
 * transcript is a whole session's worth of text, and any keyword in it (including
 * ones the agent itself typed) would otherwise classify the failure.
 *
 * @returns {Promise<object|null>} The error-analysis object, or null on success.
 */
export async function resolveErrorAnalysis({ finalSuccess, rawFile, fallbackText, task, model, immediateFallbackAnalysis, completionReason, completionError }) {
  if (finalSuccess) return null;
  // Short-circuit BEFORE the tail read: a mid-stream fallback signal already is
  // the verdict, so reading ~16KB of spool only to discard it is pure waste.
  if (immediateFallbackAnalysis) return immediateFallbackAnalysis;
  const rawAnalysisText = await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
  return analyzeAgentFailure(rawAnalysisText ?? fallbackText, task, model, { completionReason, completionError });
}
