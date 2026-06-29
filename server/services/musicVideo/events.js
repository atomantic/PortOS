import { EventEmitter } from 'events';

// Event bus for Music Video async side effects that need to reach the client
// after the originating HTTP request has returned. It carries two events:
//
//   'scene-image' → { projectId, sceneId, referenceImageId }
//   'scene-video' → { projectId, sceneId, videoHistoryId }
//
// emitted by `musicVideoSceneImageHook` / `musicVideoSceneVideoHook` once an
// async (local/Codex) reference-frame render or i2v scene clip has been durably
// filed onto the project scene's `referenceImageId` / `videoHistoryId` (#1760
// Phase 1b / Phase 1). socket.js bridges them to `music-video:scene-image` /
// `music-video:scene-video` on Socket.IO so the director scene board updates
// reactively without a refetch — the durable, hook-driven counterpart to the
// synchronous external-SD-API lane (which returns the image filename inline and
// lets the client PATCH `referenceImageId` directly; video renders always ride
// the queue, so the clip attach is hook-only).
export const musicVideoEvents = new EventEmitter();
