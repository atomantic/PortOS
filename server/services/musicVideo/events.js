import { EventEmitter } from 'events';

// Event bus for Music Video async side effects that need to reach the client
// after the originating HTTP request has returned. It carries:
//
//   'scene-image' → { projectId, sceneId, referenceImageId, takes, takeId }
//   'scene-video' → { projectId, sceneId, videoHistoryId, takes, takeId }
//
// emitted by `musicVideoSceneImageHook` / `musicVideoSceneVideoHook` once an
// async (local/Codex) reference-frame render or i2v scene clip has been durably
// appended to the project scene's takes (#8965). `referenceImageId` /
// `videoHistoryId` carry the scene's CURRENT selection (a new take only fills
// an empty slot), `takes` the full candidate list. socket.js bridges them to `music-video:scene-image` /
// `music-video:scene-video` on Socket.IO so the director scene board updates
// reactively without a refetch — the durable, hook-driven counterpart to the
// synchronous external-SD-API lane (which returns the image filename inline and
// lets the client add it as a take through the takes route; video renders
// always ride the queue, so the clip attach is hook-only).
//   'scene-failure' → { projectId, sceneId, lastFailure: { lane, error, at } | null }
//
// `scene-image` / `scene-video` also carry the scene's `lastFailure` (null once a
// take lands for that lane). 'scene-failure' is emitted by the same hooks when a
// render FAILS (#10154) after the failure is persisted on the scene, bridged to
// `music-video:scene-failure`, so the board's "Frame failed: <reason> · Retry"
// chip appears without a refetch and survives a reload.
//
// #8988 adds two more:
//   'excerpt-render' → { projectId, excerptId, status } — a draft excerpt
//     render reached a terminal state and its record write landed; an opt-in
//     auto-review run waiting on that draft continues from it (server-only).
//   'auto-review'    → { projectId, runId, run, action, project } — an
//     auto-review run advanced; socket.js bridges it to
//     `music-video:auto-review` so an open board can submit the sections the
//     run hands out for generation and show the run's progress. A run a
//     production owns (`run.productionRunId`) is dispatched server-side instead.
//
// #9066 adds:
//   'production' → { projectId, runId, run, action, project } — a server-owned
//     production run advanced (steps, route choices, spend, halts); socket.js
//     bridges it to `music-video:production`.
//
// A fully-autonomous run (autonomousService.js) adds:
//   'autonomous' → { projectId, runId, run } — the run changed stage or status
//     (a stage settled, a checkpoint is waiting, it needs the director, it
//     finished); bridged to `music-video:autonomous`.
//
// A final render adds:
//   'render' → { projectId, jobId, status: 'completed'|'failed'|'canceled', error }
//     — a final music-video render job settled and its project write landed
//     (server-only; an autonomous run waiting on its final render finishes or
//     fails from it).
//
// The Cast & Sets check-in adds:
//   'cast-and-sets' → { projectId, stage, project } — the check-in stage
//     advanced (direction, an image landed, the sheet is ready, approved);
//     bridged to `music-video:cast-and-sets`. productionService.js listens so
//     a production run waiting on the check-in continues once it settles.
//   'dev-artifact'  → { projectId, artifactId, project } — a development
//     artifact was added, versioned, noted, reviewed or deleted; bridged to
//     `music-video:dev-artifact`.
//   'publish-draft' → { projectId, draftId, target, state } — a publish draft's
//     tab was filled ('open'), closed by hand ('closed') or discarded; bridged
//     to `music-video:publish-draft`.
export const musicVideoEvents = new EventEmitter();
