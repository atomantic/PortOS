import { EventEmitter } from 'events';

// Stage-progress bus for the importer's analyze phase. `analyzeImport` runs
// several heavy-tier AI passes (canon + arc in parallel, then issue split)
// over a single blocking HTTP request, so the client has no way to see which
// pass is in flight without a side channel. The orchestrator emits `progress`
// frames here; `socket.js` bridges them to `importer:progress` on Socket.IO,
// and the Importer page renders a live stage checklist while it waits.
//
// Single-user trust model: at most one analyze runs at a time, but each frame
// carries a `runId` so the client can ignore stragglers from a prior run.
export const importerEvents = new EventEmitter();

// Live snapshot of the in-flight run so a client that (re)connects mid-analyze
// can rebuild the checklist. The original design gated every `stage` frame on
// a runId the client only learned from the `start` frame — so a socket that
// reconnected after `start` (or mounted late) dropped every subsequent frame
// and the checklist stayed stuck on "Starting…" until the blocking analyze
// resolved. `socket.js` replays these frames to each newly-connected socket so
// a late joiner is brought fully up to date, labels and per-stage statuses
// included (a client-only lazy-seed couldn't recover either — `stage` frames
// carry no label and pre-reconnect completions would be lost).
let currentRun = null; // { runId, stages: [{id,label}], statusById: Map<id,status> }

// Record a frame into the live snapshot. Called by `recordAndEmit` below for
// every frame the orchestrator emits. A terminal frame clears the snapshot so
// a finished run isn't replayed to tabs that open later.
export function recordImporterFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'start') {
    currentRun = {
      runId: frame.runId,
      stages: Array.isArray(frame.stages) ? frame.stages : [],
      statusById: new Map(),
    };
    return;
  }
  // Stale frame from a run other than the one currently tracked — ignore so a
  // late straggler can't mutate a newer run's snapshot.
  if (!currentRun || frame.runId !== currentRun.runId) return;
  if (frame.type === 'stage') {
    currentRun.statusById.set(frame.id, frame.status);
    return;
  }
  if (frame.type === 'done') {
    currentRun = null;
  }
}

// Replayable frames that reconstruct the in-flight run for a fresh subscriber:
// the original `start` (so labels + ordering are restored) followed by one
// `stage` frame per status update already seen. Empty when no run is active.
export function getImporterProgressFrames() {
  if (!currentRun) return [];
  const frames = [{ type: 'start', runId: currentRun.runId, stages: currentRun.stages }];
  for (const [id, status] of currentRun.statusById) {
    frames.push({ type: 'stage', runId: currentRun.runId, id, status });
  }
  return frames;
}

// Single entry point the orchestrator uses: update the snapshot AND broadcast.
// Keeping both behind one call means a frame can never be emitted without also
// being recorded (which would desync late joiners from live subscribers).
export function emitImporterProgress(frame) {
  recordImporterFrame(frame);
  importerEvents.emit('progress', frame);
}
