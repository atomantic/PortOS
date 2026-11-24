import { musicVideoEvents } from './events.js';

// Recovery can emit these before a route loads the review orchestrator.
function forwardCompletion(event, handle) {
  import('./autoReviewService.js')
    .then(handle)
    .catch(err => console.error(`❌ Music Video auto-review could not handle ${event}: ${err.message}`));
}

let registered = false;
export function registerAutoReviewCompletionListeners() {
  if (registered) return;
  registered = true;
  musicVideoEvents.on('excerpt-render', (payload) => {
    if (payload?.projectId && payload.excerptId) {
      forwardCompletion('excerpt-render', service => service.onAutoReviewExcerptSettled(payload));
    }
  });
  for (const event of ['scene-image', 'scene-video']) {
    musicVideoEvents.on(event, (payload) => {
      if (payload?.projectId && payload.sceneId) {
        forwardCompletion(event, service => service.onAutoReviewSceneTake(payload));
      }
    });
  }
}
