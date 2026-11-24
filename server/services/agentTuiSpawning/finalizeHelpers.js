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
import * as git from '../git/status.js';
import { readFileTail } from '../../lib/fileUtils.js';
import { commitsSince } from '../../lib/gitCommitProbe.js';
import { analyzeAgentFailure } from '../agent/agentErrorAnalysis.js';

// Re-exported entry points for importers and tests (implementations live in
// lib/fileUtils.js and lib/gitCommitProbe.js).
export { readFileTail };
export { commitsSince };

// Tail-read window for raw.txt at failure analysis. analyzeAgentFailure narrows
// further (last ~200 lines AND ≤16K chars); reading the whole unbounded file
// would reintroduce the OOM risk the disk spool avoids. 1MB covers that window
// even on a repaint-heavy TUI transcript.
export const RAW_TAIL_ANALYSIS_BYTES = 1024 * 1024;

/**
 * Capture the git diff (staged + unstaged) from a worktree and save it to the
 * agent archive dir, before worktree cleanup, for post-mortems. Non-throwing.
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
 * skip the raw-spool read (bounded memory for long healthy runs); failures read
 * only the tail of raw.txt and hand it to analyzeAgentFailure.
 *
 * `??` (not `||`) keeps an empty raw spool ('') distinct from a read failure
 * (null, also a missing file), which falls back to `fallbackText` (the capped
 * output buffer, which has the spawn-startup notices). An immediate-fallback
 * signal detected mid-stream short-circuits the analysis.
 *
 * `completionReason` / `completionError` carry the finalize path's OWN verdict;
 * the analyzer prefers it over keyword matching in a whole-session transcript,
 * where even text the agent typed would classify the failure.
 *
 * @returns {Promise<object|null>} The error-analysis object, or null on success.
 */
export async function resolveErrorAnalysis({ finalSuccess, rawFile, fallbackText, task, model, immediateFallbackAnalysis, completionReason, completionError, promptProvenance }) {
  if (immediateFallbackAnalysis?.category === 'content-refusal') return immediateFallbackAnalysis;
  if (finalSuccess) return null;
  if (immediateFallbackAnalysis) return immediateFallbackAnalysis;
  const rawAnalysisText = await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
  // Rotation and the bounded tail both retain a suffix, so the byte count since
  // submit still selects the same suffix.
  const submittedBytes = promptProvenance?.bytesSinceSubmission;
  const analysisText = rawAnalysisText !== null && Number.isSafeInteger(submittedBytes) && submittedBytes >= 0
    ? (submittedBytes === 0 ? '' : Buffer.from(rawAnalysisText).subarray(-submittedBytes).toString('utf8'))
    : rawAnalysisText ?? fallbackText;
  return analyzeAgentFailure(analysisText, task, model, {
    completionReason, completionError,
    ...(promptProvenance ? { promptProvenance } : {}),
  });
}
