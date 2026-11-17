/**
 * Closed vocabulary for the operator-action ledger (#5594, epic #5593).
 *
 * `user_action_events` lets a later phase ask "what did the user actually do?" without replaying every log, answerable only if the type column is a small, stable, enumerable set (an open string would drift into a second, unqueryable `history.jsonl`), so `recordUserAction` THROWS on a type absent from this list (a typo fails a test instead of writing a row nothing filters on). Adding a type is deliberate: append it here, hook the exact mutation site, add a test. Phase 2/3 expand the list (mind-queued tasks, creative generation, Brain captures); a value here does NOT imply anything writes it yet (`mind` is a reserved actor with no phase-1 producer).
 */

/** Who performed the action: `user` (a human via UI/API), `schedule` (a user-configured cron-style automation), `mind` (the Persistent Mind on its own; reserved, phase 2), `system` (PortOS itself: boot, restore, maintenance). The distinction is the ledger's point: a settings write from the page and one from a backup restore must never read as one event. */
export const USER_ACTION_ACTORS = Object.freeze(['user', 'mind', 'schedule', 'system']);

/** Phase-1 operator actions (issue #5594) plus phase-3 growth (#5596). */
export const USER_ACTION_TYPES = Object.freeze([
  'cos.task.create',
  'cos.task.update',
  'cos.task.delete',
  'cos.task.approve',
  'cos.task.spawn',
  'cos.agent.feedback',
  'cos.schedule.trigger',
  'cos.schedule.update',
  'settings.update',
  'instance-feature.toggle',
  'instance-feature-group.toggle',
  'media.image.enqueue',
  'media.video.enqueue',
  'brain.capture',
]);

const TYPES = new Set(USER_ACTION_TYPES);
const ACTORS = new Set(USER_ACTION_ACTORS);

export const isUserActionType = (value) => typeof value === 'string' && TYPES.has(value);
export const isUserActionActor = (value) => typeof value === 'string' && ACTORS.has(value);
