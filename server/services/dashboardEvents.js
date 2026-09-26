import { EventEmitter } from 'node:events';

// Resource invalidations only: no personal records or configuration on the wire.
// Writers emit after persistence; socket.js forwards to authenticated clients.
export const dashboardEvents = new EventEmitter();
