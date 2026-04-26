import { EventEmitter } from 'events';

// Bridge for video gen progress — server/services/socket.js subscribes
// and forwards as Socket.IO events `video-gen:started|progress|completed|failed`.
export const videoGenEvents = new EventEmitter();
