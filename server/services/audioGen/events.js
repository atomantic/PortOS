import { EventEmitter } from 'events';

// Mirrors imageGenEvents/videoGenEvents/trainingEvents — the mediaJobQueue
// emitter contract every gen module rides (`progress`/`activity`/`completed`/
// `failed`, keyed by `generationId`). See server/services/imageGenEvents.js for
// the maxListeners rationale; audio jobs are lower-volume (no Codex-style
// parallel lane) but the cap is cheap insurance against the same warning.
export const audioGenEvents = new EventEmitter();
audioGenEvents.setMaxListeners(200);
