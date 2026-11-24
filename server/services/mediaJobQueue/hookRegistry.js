/** Register the terminal listeners a queued or restored media job needs before its outcome becomes durable. */
import { requireMediaJobTerminalHooks } from '../bootHookRegistry.js';

// The same first-load promise covers overlapping jobs. A rejected registration
// must leave its transition staged, so repairing the module and flushing the
// queue can publish the original event without re-running a paid generator.
// Production hook pairs are registered in bootHooks.js (#18217) so this leaf
// holds zero literal import edges into domain hook subtrees.
export function createMediaJobHookLoader(registrations) {
  const active = registrations ?? requireMediaJobTerminalHooks();
  const pending = new Map();
  return job => Promise.all(active.filter(([matches]) => matches(job)).map(([, load]) => {
    if (!pending.has(load)) {
      pending.set(load, Promise.resolve().then(load).catch(error => {
        pending.delete(load);
        throw Object.assign(new Error(`Media job terminal hook could not load: ${error.message}`, { cause: error }), {
          code: 'MEDIA_JOB_HOOK_LOAD_FAILED',
        });
      }));
    }
    return pending.get(load);
  }));
}
