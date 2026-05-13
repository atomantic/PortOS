import { EventEmitter } from 'events';

export const imageGenEvents = new EventEmitter();
// Each in-flight image job attaches ~6 listeners (progress/status/completed/
// failed + 2 watchdog activity tracers). With CODEX_PARALLEL_MAX = 10 codex
// renders in flight plus a concurrent local image render, that's 60+ live
// listeners — well past Node's default cap of 10. Setting it to 0 disables
// the leak warning entirely; the listener pairs are deterministically detached
// in runJob's terminate() + final detach() so a real leak would surface as
// memory growth in pm2 status, not as the warning. 200 leaves headroom for
// short overlap during job churn.
imageGenEvents.setMaxListeners(200);
