/**
 * Agent TUI finalize helpers
 *
 * Failure-analysis support for spawnTuiAgent's finalize path. Non-throwing: a
 * failure to read the raw spool must never abort finish() before finalizeAgent
 * runs. Extracted from spawnTuiAgent so the "read the spool tail → analyze the
 * failure" concern is self-contained and testable.
 */

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
