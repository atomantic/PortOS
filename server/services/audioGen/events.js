import { EventEmitter } from 'events';

// Mirrors imageGenEvents/videoGenEvents/trainingEvents — the mediaJobQueue
// emitter contract every gen module rides (`progress`/`activity`/`completed`/
// `failed`, keyed by `generationId`). See server/services/imageGenEvents.js for
// the maxListeners rationale. Federated audio jobs can share a bounded parallel
// lane, so retain the same generous listener cap as the other media adapters.
export const audioGenEvents = new EventEmitter();
audioGenEvents.setMaxListeners(200);
