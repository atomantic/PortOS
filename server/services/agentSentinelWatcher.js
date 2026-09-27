/**
 * Run-scoped completion-sentinel access for TUI agents.
 *
 * The producer contract is the canonical `.agent-done-<agentId>` path. A
 * terminal/model can occasionally lose the final character while copying that
 * path, though, leaving a completion file that the exact watcher will never
 * see. This module accepts only the one-character truncation that can occur for
 * generated agent ids, and only when the file is fresh for this run and no
 * active sibling owns the same prefix.
 */

import * as fs from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { watchForFile } from '../lib/fileUtils.js';
import { doneSentinelAgentId, doneSentinelCandidateNames, doneSentinelPath } from '../lib/agentSentinel.js';

function activeIds(getActiveAgentIds) {
  try {
    const source = getActiveAgentIds?.() ?? [];
    const iterable = source instanceof Map ? source.keys() : source;
    return [...iterable].filter((id) => typeof id === 'string');
  } catch {
    // A registry read must never turn a completion signal into a crash. The
    // fallback is fail-closed below, so an uncertain sibling set cannot steal
    // another run's sentinel.
    return null;
  }
}

function isFreshFile(filePath, startedAt) {
  try {
    const info = fs.statSync?.(filePath, { throwIfNoEntry: false });
    return !!info?.isFile?.() && Number.isFinite(info.mtimeMs) && info.mtimeMs >= startedAt;
  } catch {
    return false;
  }
}

/**
 * Build the sentinel access used by a live TUI run.
 *
 * The returned `path` is always the canonical path. `resolvedPath()` changes
 * to the accepted recovery path only after a watcher or presence check has
 * validated it. That lets the controller promote a recovered file back to the
 * canonical name before finalization reads structured payloads. A caller may
 * pass `sentinelPath` when the transport already supplied the canonical path;
 * custom paths deliberately disable truncation recovery.
 */
export function createAgentSentinelAccess({
  workspacePath,
  agentId,
  sentinelPath = null,
  startedAt = Date.now(),
  getActiveAgentIds = () => [],
} = {}) {
  const canonicalPath = sentinelPath || doneSentinelPath(workspacePath, agentId);
  const defaultCanonicalPath = doneSentinelPath(workspacePath, agentId);
  const candidatePaths = canonicalPath
    ? canonicalPath === defaultCanonicalPath
      ? doneSentinelCandidateNames(agentId).map((name) => join(workspacePath, name))
      : [canonicalPath]
    : [];
  const fallbackPaths = candidatePaths.slice(1);
  const rejectedFallbackIds = new Set();
  let detectedPath = null;
  let callbackDelivered = false;
  let activeWatcherCloser = null;
  let recoveryPromoted = false;

  const fallbackIsUnambiguous = (filePath) => {
    const candidateId = doneSentinelAgentId(basename(filePath));
    if (!candidateId) return false;
    if (rejectedFallbackIds.has(candidateId)) return false;
    const ids = activeIds(getActiveAgentIds);
    // Registry reads can fail transiently. Fail closed for this check, but do
    // not cache that answer: a sibling that is still active now may finish
    // before the next watcher poll, and then this recovery becomes safe.
    if (!ids) return false;
    if (ids.some((activeId) => activeId !== agentId && activeId.startsWith(candidateId))) {
      // Once a colliding run was observed, its sentinel name can no longer be
      // attributed safely for the rest of this run. Do not reopen the race
      // after that sibling exits and leaves its fresh file behind.
      rejectedFallbackIds.add(candidateId);
      return false;
    }
    return isFreshFile(filePath, startedAt);
  };

  const resolvePath = () => {
    if (!canonicalPath) return null;
    if (fs.existsSync(canonicalPath)) {
      detectedPath ??= canonicalPath;
      return canonicalPath;
    }
    const recoveredPath = fallbackPaths.find((filePath) =>
      fs.existsSync(filePath) && fallbackIsUnambiguous(filePath)
    );
    if (recoveredPath) {
      detectedPath ??= recoveredPath;
      return recoveredPath;
    }
    return null;
  };

  const notify = (watchedPath, onDetected) => {
    const resolved = resolvePath();
    if (!resolved || (watchedPath !== canonicalPath && resolved !== watchedPath)) return;
    detectedPath = resolved;
    if (callbackDelivered) return;
    callbackDelivered = true;
    return onDetected(resolved);
  };

  const watch = (onDetected, watchOptions = {}) => {
    if (!canonicalPath || typeof onDetected !== 'function') return null;
    activeWatcherCloser?.();
    // A failed read or promotion may re-arm the same access object. The prior
    // one-shot callback must not permanently suppress that retry.
    callbackDelivered = false;
    const rawCloser = candidatePaths.length === 1
      ? watchForFile(canonicalPath, onDetected, watchOptions)
      : (() => {
        const closers = candidatePaths.map((filePath) => watchForFile(
          filePath,
          () => notify(filePath, onDetected),
          {
            ...watchOptions,
            shouldDetect: () => filePath === canonicalPath || fallbackIsUnambiguous(filePath),
          },
        ));
        return () => closers.forEach((close) => close?.());
      })();
    let wrappedCloser;
    wrappedCloser = () => {
      if (activeWatcherCloser === wrappedCloser) activeWatcherCloser = null;
      rawCloser?.();
    };
    activeWatcherCloser = wrappedCloser;
    return wrappedCloser;
  };

  const resolvedPath = () => {
    if (detectedPath) {
      const stillPresent = detectedPath === canonicalPath
        ? fs.existsSync(detectedPath)
        : fs.existsSync(detectedPath) && fallbackIsUnambiguous(detectedPath);
      if (stillPresent) return detectedPath;
      detectedPath = null;
    }
    return resolvePath();
  };

  const read = async () => {
    const filePath = resolvedPath() || canonicalPath;
    if (!filePath) throw new Error('No workspace available for completion sentinel');
    return readFile(filePath, 'utf8');
  };

  const remove = async () => {
    activeWatcherCloser?.();
    const paths = new Set();
    if (canonicalPath) paths.add(canonicalPath);
    if (detectedPath && detectedPath !== canonicalPath) paths.add(detectedPath);
    await Promise.all([...paths].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
    detectedPath = null;
    callbackDelivered = false;
    recoveryPromoted = false;
  };

  const promote = async (contents) => {
    const sourcePath = resolvedPath();
    if (!sourcePath) return false;
    if (sourcePath === canonicalPath || fs.existsSync(canonicalPath)) {
      recoveryPromoted = true;
      return true;
    }
    try {
      await writeFile(canonicalPath, contents, { flag: 'wx' });
      recoveryPromoted = true;
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      recoveryPromoted = fs.existsSync(canonicalPath);
      return recoveryPromoted;
    }
  };

  // Shared cleanup removes the canonical path by design. Remove only the
  // recovery path this access object actually accepted; never glob or delete a
  // sibling's similarly-prefixed sentinel.
  const cleanup = async () => {
    activeWatcherCloser?.();
    if (!recoveryPromoted) return false;
    if (detectedPath && detectedPath !== canonicalPath) {
      await rm(detectedPath, { force: true }).catch(() => {});
    }
    detectedPath = null;
    recoveryPromoted = false;
    return true;
  };

  return {
    path: canonicalPath,
    candidatePaths,
    exists: () => !!resolvedPath(),
    resolvedPath,
    read,
    remove,
    promote,
    cleanup,
    watch,
  };
}
