import { EventEmitter } from 'events';

// Bridge for video gen progress — server/services/socket.js subscribes
// and forwards as Socket.IO events `video-gen:started|progress|completed|failed`.
export const videoGenEvents = new EventEmitter();
// Video runs serially (one MLX GPU job at a time) so the listener count is
// bounded, but raise the cap anyway so short job-churn windows don't trip
// the warning. See imageGenEvents.js for the longer rationale.
videoGenEvents.setMaxListeners(50);
