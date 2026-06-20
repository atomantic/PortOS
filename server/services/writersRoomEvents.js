import { EventEmitter } from 'events';

// Event bus for Writers-Room async side effects that need to reach the client
// after the originating HTTP request has returned. Today it carries one event:
//
//   'scene-image' → { workId, analysisId, sceneId, image }
//
// emitted by `writersRoomSceneImageHook` once an async (local/Codex) storyboard
// render has been durably filed onto the analysis snapshot. socket.js bridges
// it to `writers-room:scene-image` on Socket.IO so the storyboard boards update
// reactively without a refetch — the durable, hook-driven replacement for the
// client's old generate-then-attach round-trip (#1363).
export const writersRoomEvents = new EventEmitter();
