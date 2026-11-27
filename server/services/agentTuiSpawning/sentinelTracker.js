/** Read, recover and watch the completion sentinel for one TUI run. */
import { parseSentinelPayload } from '../../lib/agent/agentSentinel.js';
import { SENTINEL_COMPLETION_MARKER } from '../../lib/agent/agentOutputMarkers.js';

const SENTINEL_RECOVERY_RETRY_MS = 250;

export function createSentinelTracker({ sentinel, appendLine, isTerminal, hasRefusal, onDone }) {
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `sessionPhase`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  // A recovered sentinel is not completion until its contents have been read
  // and promoted to the canonical path. If either step races the filesystem,
  // keep the run alive and let the watcher retry instead of finalizing from a
  // partial/ambiguous signal.
  let sentinelRecoveryPending = false;
  let doneSentinelWatcher = null;
  let sentinelRecoveryRetryTimer = null;

  // Has the agent written its completion sentinel? One predicate for the 2s
  // watcher and ingestDoneSentinel so "the run finished" can't mean subtly
  // different things in two places.
  const sentinelPresent = () => sentinel.exists();

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistCompletionSummary, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  //
  // Returns the sentinel's `summary` text (or null on a second call / no
  // sentinel / an empty summary) — the merge-gate contract check below reads
  // this same return value rather than re-reading the file a second time.
  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return null;
    if (!sentinelPresent()) return null;
    sentinelIngested = true;
    const sentinelSourcePath = sentinel.resolvedPath?.();
    let sentinelReadSucceeded = true;
    let contents = await sentinel.read().catch(err => {
      sentinelReadSucceeded = false;
      console.error(`❌ ingestDoneSentinel readFile failed: ${err.message}`);
      return '';
    });
    // A terminal-copy recovery name is accepted only by the run-scoped
    // sentinel access. Promote its contents to the canonical name before the
    // shared finalization/output-hook path reads the sentinel again, so a
    // structured completion has the same behavior as an exact write.
    let sentinelValidated = sentinelReadSucceeded;
    if (sentinelReadSucceeded && sentinelSourcePath && sentinelSourcePath !== sentinel.path) {
      if (typeof sentinel.promote !== 'function') {
        sentinelValidated = false;
      } else {
        sentinelValidated = await sentinel.promote(contents).catch(err => {
          console.error(`❌ ingestDoneSentinel canonical promotion failed: ${err.message}`);
          return false;
        });
        if (sentinelValidated) {
          let canonicalReadSucceeded = true;
          const canonicalContents = await sentinel.read().catch(err => {
            canonicalReadSucceeded = false;
            console.error(`❌ ingestDoneSentinel canonical read failed: ${err.message}`);
            return '';
          });
          sentinelValidated = canonicalReadSucceeded;
          if (sentinelValidated) contents = canonicalContents;
        }
      }
    }
    if (!sentinelValidated) {
      sentinelIngested = false;
      sentinelRecoveryPending = true;
      return null;
    }
    // A programmatic-I/O task type writes a JSON `{ summary, payload }` sentinel;
    // append only the human `summary` to the agent output (the structured
    // `payload` is consumed separately by the task type's processTaskOutput hook,
    // read mode-agnostically in finalizeAgent). A legacy plain-markdown sentinel
    // parses back as its own text, so this is a no-op change for existing types.
    const { summary } = parseSentinelPayload(contents);
    if (!summary) return null;
    // Shared constant, not a literal: `extractAgentSummary` anchors the PR-body
    // extraction on this exact line to tell the agent's summary apart from the
    // lifecycle telemetry above it. Reword it here only, and the noise returns.
    appendLine(SENTINEL_COMPLETION_MARKER);
    const truncated = summary.length > 4096 ? `${summary.slice(0, 4096)}\n…[truncated]` : summary;
    for (const line of truncated.split('\n')) appendLine(line);
    return summary;
  };

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr and then
  // stop (it does NOT `/quit` — that is a UI command it can't invoke). This
  // watcher is the PRIMARY finalize path: it fires finish() shortly after the
  // sentinel appears, and finish()'s own cleanup kills the still-running TUI
  // session. The actual sentinel READ happens in finish() (via
  // ingestDoneSentinel) so the resolution is captured no matter which path
  // finalizes. A normal shell exit or explicit provider failure handles
  // agents that do not write the sentinel.
  //
  // `sentinel.watch` is one-shot (it detects, closes itself, then calls back) —
  // so a run whose merge-gate check re-prompts and deletes the sentinel to
  // await a SECOND completion needs a brand-new watcher, not a re-trigger of
  // this one. Factored out so both call sites build the exact same watcher.
  const watch = () => {
    doneSentinelWatcher = sentinel.watch(async () => {
      if (!isTerminal()) await onDone();
    });
  };

  const retryRecoveryIfPending = () => {
    if (!sentinelRecoveryPending) return false;
    sentinelRecoveryPending = false;
    if (!sentinelRecoveryRetryTimer && !isTerminal()) {
      sentinelRecoveryRetryTimer = setTimeout(() => {
        sentinelRecoveryRetryTimer = null;
        if (isTerminal() || hasRefusal()) return;
        doneSentinelWatcher?.();
        watch();
      }, SENTINEL_RECOVERY_RETRY_MS);
    }
    return true;
  };

  return {
    sentinelPresent,
    ingestDoneSentinel,
    watch,
    retryRecoveryIfPending,
    reopen() {
      sentinelIngested = false;
      watch();
    },
    stop() {
      if (sentinelRecoveryRetryTimer) { clearTimeout(sentinelRecoveryRetryTimer); sentinelRecoveryRetryTimer = null; }
      doneSentinelWatcher?.();
      doneSentinelWatcher = null;
    },
  };
}
