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
 * (legacy forced-stop reason or spawn failure). The analyzer prefers that
 * structural signal over a loose keyword match in the transcript — a
 * repaint-driven PTY transcript is a whole session's worth of text, and any
 * keyword in it (including ones the agent itself typed) would otherwise
 * classify the failure.
 *
 * @returns {Promise<object|null>} The error-analysis object, or null on success.
 */
export async function resolveErrorAnalysis({ finalSuccess, rawFile, fallbackText, task, model, immediateFallbackAnalysis, completionReason, completionError, promptProvenance }) {
  if (immediateFallbackAnalysis?.category === 'content-refusal') return immediateFallbackAnalysis;
  if (finalSuccess) return null;
  // Short-circuit BEFORE the tail read: a mid-stream fallback signal already is
  // the verdict, so reading ~16KB of spool only to discard it is pure waste.
  if (immediateFallbackAnalysis) return immediateFallbackAnalysis;
  const rawAnalysisText = await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
  // Raw spool rotation and the bounded tail read both retain a suffix, so the
  // byte count since submit still selects the same suffix without a second spool.
  const submittedBytes = promptProvenance?.bytesSinceSubmission;
  const analysisText = rawAnalysisText !== null && Number.isSafeInteger(submittedBytes) && submittedBytes >= 0
    ? (submittedBytes === 0 ? '' : Buffer.from(rawAnalysisText).subarray(-submittedBytes).toString('utf8'))
    : rawAnalysisText ?? fallbackText;
  return analyzeAgentFailure(analysisText, task, model, {
    completionReason, completionError,
    ...(promptProvenance ? { promptProvenance } : {}),
  });
}
