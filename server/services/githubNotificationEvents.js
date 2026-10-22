import { EventEmitter } from 'events';

/**
 * Leaf event bus for the GitHub notifications inbox (#12871), bridged to
 * Socket.IO as `github:notifications:changed`. Invalidation only: the payload
 * is `{ accountId }` and the browser refetches through the inbox routes.
 */
export const githubNotificationEvents = new EventEmitter();
