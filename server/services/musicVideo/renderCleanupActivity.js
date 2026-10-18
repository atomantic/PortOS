/** Synchronous admission shared by derived-render cleanup and its consumers. */
import { musicVideoEvents } from './events.js';
import { ServerError } from '../../lib/errorHandler.js';

const cleaning = new Set();
export function assertRenderCleanupIdle(projectId) {
  if (cleaning.has(projectId)) throw new ServerError('Render cleanup is in progress. Try again when it finishes.', { status: 409, code: 'RENDER_CLEANUP_ACTIVE' });
}

export async function withRenderCleanupReservation(projectId, work, { notify = true } = {}) {
  assertRenderCleanupIdle(projectId);
  cleaning.add(projectId);
  try { return await work(); } finally { cleaning.delete(projectId); if (notify) musicVideoEvents.emit('render-cleanup-idle', { projectId }); }
}

