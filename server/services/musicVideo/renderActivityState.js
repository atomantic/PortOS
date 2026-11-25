/**
 * Which projects hold a final-render slot on this instance. A leaf so the shot
 * segment cache and render cleanup can ask without importing render.js (#17578).
 */
import { trackedRenderMap } from '../renderActivity.js';
import { musicVideoEvents } from './events.js';

// Keyed by projectId so two projects can render in parallel; the value is the
// live jobId, or finalRenderJob.js's pending marker while preparation owns the slot.
export const projectRenders = trackedRenderMap('music-video-final', { noun: 'music video render', link: (key) => `/music-video/${encodeURIComponent(key)}` });

export function releaseProjectRender(projectId) {
  if (projectRenders.delete(projectId)) musicVideoEvents.emit('render-cleanup-idle', { projectId });
}

// Preparation also owns the slot before a public job ID exists.
export const isProjectRenderActive = (projectId) => projectRenders.has(projectId);
