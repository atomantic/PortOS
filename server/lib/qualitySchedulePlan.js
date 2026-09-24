/**
 * Lay the quality audits out across a week, around whatever else already runs.
 *
 * The problem this solves: an app has ~26 schedulable audit types
 * (`AUDIT_DEFINITIONS`), each of which would otherwise need a hand-picked cron
 * expression, in an order that respects `AUDIT_SUGGESTED_AFTER`, in hours that
 * do not land on top of a release job. Nobody picks 26 cron expressions by
 * hand, so this module picks them: it distributes the checks over all seven
 * days, and interleaves the issue-claim drain a few hours after each one so
 * the issues a filing audit just wrote get worked before the next audit runs.
 *
 * Pure: the caller supplies the applicable types and the occupied weekday/hour
 * cells (`busy`), and gets cron strings back. Nothing here reads a schedule,
 * a repository, or the clock.
 */

import { AUDIT_DEFINITIONS, AUDIT_SUGGESTED_AFTER, AUDIT_TASK_TYPE_LIST, defaultFileIssuesFor } from './auditCatalog.js';

/** The task types the claim drain can be run through, in preference order. */
export const CLAIM_DRAIN_TASK_TYPES = Object.freeze(['claim-work', 'claim-issue', 'plan-task']);

export const DEFAULT_QUALITY_SCHEDULE_OPTIONS = Object.freeze({
  /** Checks per day. `null` spreads the selected checks evenly over seven days. */
  checksPerDay: null,
  /** Earliest and latest hour (inclusive) an audit slot may be placed in. */
  windowStartHour: 0,
  windowEndHour: 23,
  /** Run the issue-claim drain between checks. */
  claimBetween: true,
  /** Hours after an audit slot the claim drain starts. */
  claimOffsetHours: 3,
  /** Which task type drives the claim drain. */
  claimTaskType: 'claim-work',
  /** Hours around an already-scheduled job treated as occupied. */
  padBeforeHours: 1,
  padAfterHours: 2,
  /**
   * Form-wide delivery mode. `null` means "ask the catalog per audit"
   * (`defaultFileIssuesFor`), which is the default because 11 audits ship
   * `defaultFileIssues: false` — a form-wide `true` here would silently flip
   * every one of them to issues-only on an untouched Apply.
   */
  fileIssues: null,
});

const clampHour = (value, fallback) => {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
};

/**
 * Order the selected checks so each one follows the audits the catalog says
 * should precede it (`AUDIT_SUGGESTED_AFTER`). A predecessor the user did not
 * select imposes no constraint, and a cycle — which the shipped table has none
 * of, but a future edit could introduce — degrades to catalog order for the
 * types it traps rather than dropping them.
 *
 * @param {string[]} taskTypes - Audit task types to order
 * @returns {string[]} The same types, earliest-first
 */
export function orderQualityChecks(taskTypes) {
  const selected = AUDIT_TASK_TYPE_LIST.filter(type => taskTypes.includes(type));
  const pending = new Set(selected);
  const ordered = [];
  while (pending.size) {
    const ready = selected.filter(type => pending.has(type)
      && (AUDIT_SUGGESTED_AFTER[type] || []).every(dep => !pending.has(dep)));
    // A cycle leaves nothing ready; emit the rest in catalog order and stop.
    const batch = ready.length ? ready : selected.filter(type => pending.has(type));
    for (const type of batch) {
      ordered.push(type);
      pending.delete(type);
    }
  }
  return ordered;
}

/**
 * The option bag with every default filled in and the hour window made
 * coherent (`windowEndHour` never before `windowStartHour`).
 *
 * ONE resolver, called by `planQualitySchedule` and by the service that also
 * hands the same bag to `buildBusySlots` — so "what does an omitted option
 * mean" has a single answer rather than one per caller.
 *
 * @param {object} [options] - Partial overrides of DEFAULT_QUALITY_SCHEDULE_OPTIONS
 * @returns {object} The resolved bag
 */
export function resolveQualityScheduleOptions(options = {}) {
  // Pick, never spread: the caller hands us the whole request body, and the
  // client seeds its form from the returned bag — so an echoed `taskTypes`
  // would come back as an option and override the user's live selection.
  const picked = Object.fromEntries(Object.keys(DEFAULT_QUALITY_SCHEDULE_OPTIONS)
    .filter(key => options[key] !== undefined)
    .map(key => [key, options[key]]));
  const settings = { ...DEFAULT_QUALITY_SCHEDULE_OPTIONS, ...picked };
  const windowStartHour = clampHour(settings.windowStartHour, DEFAULT_QUALITY_SCHEDULE_OPTIONS.windowStartHour);
  return {
    ...settings,
    windowStartHour,
    windowEndHour: Math.max(windowStartHour, clampHour(settings.windowEndHour, DEFAULT_QUALITY_SCHEDULE_OPTIONS.windowEndHour)),
    claimTaskType: CLAIM_DRAIN_TASK_TYPES.includes(settings.claimTaskType)
      ? settings.claimTaskType
      : DEFAULT_QUALITY_SCHEDULE_OPTIONS.claimTaskType,
  };
}

/**
 * Build the occupied-cell lookup the planner avoids.
 *
 * @param {Array<{ days: number[], hours: number[] }>} occupancies - Expanded cron occupancies
 * @param {{ padBeforeHours?: number, padAfterHours?: number }} [options]
 * @returns {Set<string>} `"<day>:<hour>"` keys, padding included
 */
export function buildBusySlots(occupancies = [], {
  padBeforeHours = DEFAULT_QUALITY_SCHEDULE_OPTIONS.padBeforeHours,
  padAfterHours = DEFAULT_QUALITY_SCHEDULE_OPTIONS.padAfterHours,
} = {}) {
  const busy = new Set();
  for (const { days = [], hours = [] } of occupancies) {
    for (const day of days) {
      for (const hour of hours) {
        for (let offset = -padBeforeHours; offset <= padAfterHours; offset += 1) {
          // A padded window crossing midnight lands on the neighbouring day.
          const shifted = hour + offset;
          const dayShift = Math.floor(shifted / 24);
          busy.add(`${(((day + dayShift) % 7) + 7) % 7}:${((shifted % 24) + 24) % 24}`);
        }
      }
    }
  }
  return busy;
}

/** Whether an hour is free on EVERY weekday — the test a daily drain needs. */
const freeAllWeek = (busy, hour) => ![0, 1, 2, 3, 4, 5, 6].some(day => busy.has(`${day}:${hour}`));

/**
 * First hour at or near `target` that is free all week and not already taken.
 * Scans outward (target, +1, -1, +2, …) so a slot lands as close to its even
 * spacing as the occupied hours allow, staying inside `[low, high]`.
 */
function findFreeHour(target, { busy, taken, low, high }) {
  const span = Math.max(target - low, high - target);
  for (let step = 0; step <= span; step += 1) {
    for (const hour of step === 0 ? [target] : [target + step, target - step]) {
      if (hour < low || hour > high) continue;
      if (taken.has(hour)) continue;
      if (freeAllWeek(busy, hour)) return hour;
    }
  }
  return null;
}

/**
 * First free hour at or AFTER `target`, wrapping past midnight.
 *
 * The claim drain works the issues the audit before it just filed, so it may
 * only ever move later. An outward search would happily place it an hour
 * BEFORE its audit when the intervening hours are occupied — which reads as a
 * drain "between" the checks while actually running against the previous
 * night's backlog.
 */
function findFreeHourForward(target, { busy, taken }) {
  // Bounded at 23, never wrapping: the drain runs on a DAILY cron, so an hour
  // "after" midnight is not later than the audit — it is 21 hours earlier the
  // same day, which is exactly the backlog-ordering bug the forward search
  // exists to prevent. No free hour left in the day drops the slot instead.
  for (let hour = target; hour <= 23; hour += 1) {
    if (!taken.has(hour) && freeAllWeek(busy, hour)) return hour;
  }
  return null;
}

/**
 * The cron shape this planner emits for a claim drain: minute zero, an explicit
 * hour list, every day. `applyQualitySchedulePlan` uses it to recognize a drain
 * a previous plan wrote, so switching the drain type — or turning it off — can
 * retire the old one without touching a claim cadence a human set by hand.
 */
export const PLANNED_CLAIM_CRON = /^0 \d{1,2}(?:,\d{1,2})* \* \* \*$/;
export const isPlannedClaimCron = (interval) => typeof interval === 'string' && PLANNED_CLAIM_CRON.test(interval.trim());

/**
 * Which (weekday, daily-slot) cell each ordered check takes, day-major so a
 * check never runs earlier in the week than one ordered before it.
 *
 * With no explicit checks-per-day the checks are spread as evenly as the week
 * allows — 30 checks at 5 slots a day run 5,5,4,4,4,4,4, not 5×6 with an empty
 * Sunday. An explicit per-day count packs each day full first, which is what
 * asking for "N a day" means. More checks than cells wrap onto earlier cells
 * (the planner warns about that).
 */
function weeklyCells(count, perDay, pack) {
  if (pack || count > perDay * 7) {
    return Array.from({ length: count }, (_, index) => ({ dayIndex: Math.floor(index / perDay) % 7, hourIndex: index % perDay }));
  }
  const cells = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const today = Math.floor(count / 7) + (dayIndex < count % 7 ? 1 : 0);
    for (let hourIndex = 0; hourIndex < today; hourIndex += 1) cells.push({ dayIndex, hourIndex });
  }
  return cells;
}

/**
 * Plan the week.
 *
 * Audits are laid out as a fixed grid: the same `checksPerDay` hours on every
 * weekday, with each selected check taking one cell. That shape is what lets
 * the claim drain be ONE cron expression (`0 8,16 * * *`) instead of one per
 * day — and it is what a human can hold in their head when they later look at
 * the schedule page and ask why a task ran at 08:00.
 *
 * @param {object} input
 * @param {string[]} input.taskTypes - Audit types to schedule
 * @param {Record<string, boolean>} [input.fileIssuesByType] - Per-check delivery mode
 * @param {Set<string>} [input.busy] - Occupied `"<day>:<hour>"` cells
 * @param {object} [input.options] - Overrides of DEFAULT_QUALITY_SCHEDULE_OPTIONS
 * @returns {{ checksPerDay: number, slots: object[], claim: object|null, warnings: string[], options: object }}
 */
export function planQualitySchedule({ taskTypes = [], fileIssuesByType = {}, busy = new Set(), options = {} } = {}) {
  const settings = resolveQualityScheduleOptions(options);
  const { windowStartHour, windowEndHour } = settings;
  const windowHours = windowEndHour - windowStartHour + 1;
  const warnings = [];
  const ordered = orderQualityChecks(taskTypes);

  // An overnight window (22:00 → 06:00) is the natural way to ask for one, and
  // the resolver collapses it to a single hour. Say so rather than reporting a
  // "1-hour window" the user never chose.
  if (Number.isInteger(options.windowEndHour) && options.windowEndHour < windowStartHour) {
    warnings.push(`Latest hour ${String(options.windowEndHour).padStart(2, '0')}:00 is before the earliest hour, and a window cannot wrap past midnight — planning in ${String(windowStartHour).padStart(2, '0')}:00 only.`);
  }

  if (!ordered.length) {
    return { checksPerDay: 0, slots: [], claim: null, warnings: ['No quality checks selected.'], options: settings };
  }

  // Enough slots to give every check its own cell, unless the user asked for
  // more. A window too narrow to hold that many is reported rather than
  // silently doubling checks onto one hour.
  const requested = Number(settings.checksPerDay);
  const minimumPerDay = Math.ceil(ordered.length / 7);
  let checksPerDay = Math.max(minimumPerDay, Number.isInteger(requested) && requested > 0 ? requested : 0);
  if (Number.isInteger(requested) && requested > 0 && requested < minimumPerDay) {
    warnings.push(`${ordered.length} checks need at least ${minimumPerDay} a day to each get their own slot in a week, so ${requested} a day was raised to ${minimumPerDay}.`);
  }
  if (checksPerDay > windowHours) {
    warnings.push(`${ordered.length} checks need ${checksPerDay} slots a day, which does not fit in a ${windowHours}-hour window — widen the window or deselect checks.`);
    checksPerDay = windowHours;
  }

  // One audit hour per daily slot, plus the claim hour that follows it.
  const taken = new Set();
  const placements = [];
  for (let slot = 0; slot < checksPerDay; slot += 1) {
    const target = windowStartHour + Math.round((slot * windowHours) / checksPerDay);
    const auditHour = findFreeHour(Math.min(target, windowEndHour), { busy, taken, low: windowStartHour, high: windowEndHour });
    if (auditHour === null) {
      warnings.push('Not enough unoccupied hours in the chosen window for every daily slot; reduce checks per day or widen the window.');
      break;
    }
    taken.add(auditHour);
    const placement = { auditHour, claimHour: null };
    placements.push(placement);

    if (!settings.claimBetween) continue;
    // The claim drain may sit outside the audit window — it is the follow-up
    // work, not an audit — but never past midnight (see findFreeHourForward).
    const claimTarget = auditHour + Math.max(1, Number(settings.claimOffsetHours) || 1);
    const claimHour = claimTarget > 23 ? null : findFreeHourForward(claimTarget, { busy, taken });
    if (claimHour === null) {
      warnings.push('No free hour left in the day for the claim drain after every check; it will run on fewer slots.');
      continue;
    }
    taken.add(claimHour);
    placement.claimHour = claimHour;
  }

  // Audits run in clock order within a day: `findFreeHour` searches OUTWARD from
  // each target, so slot 2 can resolve to an earlier hour than slot 1 — and
  // assigning the ordered checks to unsorted hours would run an audit before the
  // predecessor `orderQualityChecks` just placed ahead of it.
  const auditHours = placements.map(placement => placement.auditHour).sort((a, b) => a - b);

  if (!auditHours.length) {
    return { checksPerDay: 0, slots: [], claim: null, warnings, options: settings };
  }

  const cells = weeklyCells(ordered.length, auditHours.length, Number.isInteger(requested) && requested > 0);
  const slots = ordered.map((taskType, index) => {
    // Monday-first so the head of the suggested order (security, data safety)
    // opens the working week rather than landing on a Sunday.
    const day = (1 + cells[index].dayIndex) % 7;
    const hour = auditHours[cells[index].hourIndex];
    const fileIssues = typeof fileIssuesByType[taskType] === 'boolean'
      ? fileIssuesByType[taskType]
      : (typeof settings.fileIssues === 'boolean' ? settings.fileIssues : defaultFileIssuesFor(taskType));
    return {
      taskType,
      label: AUDIT_DEFINITIONS[taskType]?.label || taskType,
      day,
      hour,
      fileIssues,
      cron: `0 ${hour} * * ${day}`,
    };
  });

  if (ordered.length > auditHours.length * 7) {
    warnings.push(`Only ${auditHours.length * 7} free weekly slots were available for ${ordered.length} checks; the extras share a slot with an earlier check.`);
  }

  const filingSlots = slots.filter(slot => slot.fileIssues);
  const claimPlacements = placements.filter(placement => placement.claimHour !== null);
  let claim = null;
  if (settings.claimBetween && claimPlacements.length && filingSlots.length) {
    const hours = [...new Set(claimPlacements.map(placement => placement.claimHour))].sort((a, b) => a - b);
    // The REALIZED gaps, not the requested offset: an occupied target hour
    // pushes the drain later, and the preview has to say what it will do.
    const gapHours = [...new Set(claimPlacements.map(placement => placement.claimHour - placement.auditHour))].sort((a, b) => a - b);
    claim = {
      taskType: settings.claimTaskType,
      hours,
      gapHours,
      cron: `0 ${hours.join(',')} * * *`,
    };
  } else if (settings.claimBetween && !filingSlots.length) {
    warnings.push('Every check implements its own fixes, so no issue-claim drain was scheduled.');
  }

  return { checksPerDay: auditHours.length, slots, claim, warnings, options: settings };
}
