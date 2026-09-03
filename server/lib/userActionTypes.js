/**
 * Closed vocabulary for the operator-action ledger (#5594, epic #5593).
 *
 * `user_action_events` exists so a later phase can ask "what did the user
 * actually do?" without replaying every log PortOS keeps. That question is only
 * answerable if the type column is a small, stable, enumerable set — an
 * open-ended string would drift into a second, unqueryable `history.jsonl`.
 * `recordUserAction` therefore THROWS on a type absent from this list rather
 * than inventing one silently, so a typo fails a test instead of quietly
 * writing a row nothing will ever filter on.
 *
 * Adding a type is a deliberate act: append it here, hook the exact mutation
 * site that produces it, and give it a test. Phase 2/3 of the epic expand this
 * list (mind-queued tasks, creative generation, Brain captures); a value living
 * here does NOT imply anything writes it yet — `mind` is a reserved actor with
 * no phase-1 producer.
 */

/**
 * Who performed the action. `user` is a human acting through the UI/API;
 * `schedule` is a cron-style automation the user configured; `mind` is the
 * Persistent Mind acting on its own (reserved — phase 2); `system` is PortOS
 * itself (boot, restore, internal maintenance). The distinction is the whole
 * point of the ledger: a settings write from the settings page and one from a
 * backup restore must never read as the same event.
 */
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
  'media.image.enqueue',
  'media.video.enqueue',
  'brain.capture',
]);

const TYPES = new Set(USER_ACTION_TYPES);
const ACTORS = new Set(USER_ACTION_ACTORS);

export const isUserActionType = (value) => typeof value === 'string' && TYPES.has(value);
export const isUserActionActor = (value) => typeof value === 'string' && ACTORS.has(value);
