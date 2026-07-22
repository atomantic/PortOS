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
import { open, stat as fsStat, writeFile } from 'fs/promises';
import * as git from '../git.js';
import { analyzeAgentFailure } from '../agentErrorAnalysis.js';

// Tail-read window for raw.txt at failure analysis. analyzeAgentFailure only
// inspects the last ~200 lines, so reading the whole file (which has no upper
// bound for long-running agents) would reintroduce the OOM risk the disk
// spool was meant to avoid. 1MB easily contains the last 200 lines of any
// realistic PTY stream while keeping peak finalize memory bounded.
export const RAW_TAIL_ANALYSIS_BYTES = 1024 * 1024;

/**
 * Read at most `maxBytes` from the end of a file. Returns null when the file
 * doesn't exist or can't be opened; an empty string for a zero-byte file.
 * Used to bound the memory footprint of failure-analysis reads against the
 * uncapped raw PTY spool. Non-throwing — any failure surfaces as null so
 * the caller's failure-analysis path can fall back to outputBuffer instead
 * of aborting `finish()` before finalizeAgent runs.
 */
export async function readFileTail(path, maxBytes) {
  const st = await fsStat(path).catch(() => null);
  if (!st) return null;
  if (st.size === 0) return '';
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(length);
    // Honour bytesRead — the file can shrink between stat and read, or the
    // OS can return a short read; decoding the whole `buf` would otherwise
    // append NULs to the returned string. Read failures surface as null so
    // callers can distinguish "empty file" ('') from "read error" (null) —
    // a `bytesRead: 0` fallback would conflate the two.
    const readResult = await fh.read(buf, 0, length, start).catch(() => null);
    if (readResult === null) return null;
    return buf.toString('utf8', 0, readResult.bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

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
 * @returns {Promise<object|null>} The error-analysis object, or null on success.
 */
export async function resolveErrorAnalysis({ finalSuccess, rawFile, fallbackText, task, model, immediateFallbackAnalysis }) {
  if (finalSuccess) return null;
  const rawAnalysisText = await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
  return immediateFallbackAnalysis || analyzeAgentFailure(rawAnalysisText ?? fallbackText, task, model);
}
