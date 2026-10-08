import { EventEmitter } from 'node:events';

// Voice fine-tuning job bus (#10400). Kept apart from `fineTuning.js` so the
// Socket.IO bridge in services/socket.js does not pull the training service's
// child-process and runtime imports into its closure.
//
//   'updated' → { profileId, job } — the client projection of one job after a
//     status change, a sealed checkpoint, or (throttled) training progress.
//
// socket.js bridges it to `voice:fine-tune:updated`.
export const fineTuningEvents = new EventEmitter();
