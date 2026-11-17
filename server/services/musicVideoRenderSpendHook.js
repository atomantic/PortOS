/**
 * Music Video render spend hook: every paid image or clip a media job completes for a music
 * video (tagged `musicVideoProjectId` or `musicVideo.projectId`) lands in that project's spend
 * ledger, whether a shot card, the generic Video Gen / Image Gen routes, an agent test or a
 * plate rendered it, and whether or not it ever becomes a take (#16506).
 *
 * Best-effort bookkeeping: a failure is logged, never thrown. Mounted once at server boot; it
 * only listens.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { isMeteredProjectRender, recordCompletedRender } from './musicVideo/renderSpend.js';

const inFlight = new Set();
let completedHandler = null;

export function initMusicVideoRenderSpendHook() {
  if (completedHandler) return;
  completedHandler = (job) => {
    if (!isMeteredProjectRender(job)) return;
    const handled = recordCompletedRender(job)
      .catch((err) => console.error(`❌ music-video spend hook failed for job ${String(job.id).slice(0, 8)}: ${err?.message || err}`));
    inFlight.add(handled);
    handled.finally(() => inFlight.delete(handled));
  };
  mediaJobEvents.on('completed', completedHandler);
  console.log('💵 Music Video render spend hook initialized');
}

export const __testing = {
  reset() {
    if (completedHandler) mediaJobEvents.off('completed', completedHandler);
    completedHandler = null;
  },
  async drain() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  },
};
