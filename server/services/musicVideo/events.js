import { EventEmitter } from 'events';

// Event bus for Music Video async side effects that need to reach the client
// after the originating HTTP request has returned. Today it carries one event:
//
//   'scene-image' → { projectId, sceneId, referenceImageId }
//
// emitted by `musicVideoSceneImageHook` once an async (local/Codex) reference-
// frame render has been durably filed onto the project scene's
// `referenceImageId` (#1760 Phase 1b). socket.js bridges it to
// `music-video:scene-image` on Socket.IO so the director scene board updates
// reactively without a refetch — the durable, hook-driven counterpart to the
// synchronous external-SD-API lane (which returns the filename inline and lets
// the client PATCH `referenceImageId` directly).
export const musicVideoEvents = new EventEmitter();
