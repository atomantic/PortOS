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
//
// #8988 adds two more:
//   'excerpt-render' → { projectId, excerptId, status } — a draft excerpt
//     render reached a terminal state and its record write landed; an opt-in
//     auto-review run waiting on that draft continues from it (server-only).
//   'auto-review'    → { projectId, runId, run, action, project } — an
//     auto-review run advanced; socket.js bridges it to
//     `music-video:auto-review` so an open board can submit the sections the
//     run hands out for generation and show the run's progress.
export const musicVideoEvents = new EventEmitter();
