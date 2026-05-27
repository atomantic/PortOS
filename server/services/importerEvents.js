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
