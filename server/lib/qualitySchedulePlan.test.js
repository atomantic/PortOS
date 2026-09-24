import { describe, it, expect } from 'vitest';
import { AUDIT_SUGGESTED_AFTER, AUDIT_TASK_TYPE_LIST, defaultFileIssuesFor } from './auditCatalog.js';
import { cronWeekdayHours } from './cronFields.js';
import {
  buildBusySlots,
  orderQualityChecks,
  planQualitySchedule,
  resolveQualityScheduleOptions,
} from './qualitySchedulePlan.js';

const busyFrom = (crons, padding = {}) =>
  buildBusySlots(crons.map(cronWeekdayHours), { padBeforeHours: 1, padAfterHours: 2, ...padding });

const planAll = (overrides = {}) => planQualitySchedule({ taskTypes: [...AUDIT_TASK_TYPE_LIST], ...overrides });

describe('buildBusySlots', () => {
  it('pads around the job and carries the padding across midnight', () => {
    const busy = busyFrom(['30 0 * * 1']);
    // Monday 00:00 ± (1 before, 2 after) reaches back into Sunday 23:00.
    expect(busy.has('1:0')).toBe(true);
    expect(busy.has('1:2')).toBe(true);
    expect(busy.has('0:23')).toBe(true);
    expect(busy.has('1:3')).toBe(false);
  });
});

describe('orderQualityChecks', () => {
  it('puts every selected check after the predecessors the catalog names', () => {
    const ordered = orderQualityChecks([...AUDIT_TASK_TYPE_LIST]);
    for (const [taskType, predecessors] of Object.entries(AUDIT_SUGGESTED_AFTER)) {
      for (const predecessor of predecessors) {
        expect(ordered.indexOf(predecessor)).toBeLessThan(ordered.indexOf(taskType));
      }
    }
  });

  it('ignores a predecessor the user did not select', () => {
    // `module-hygiene` follows `simplify`; with simplify deselected it is free
    // to run first rather than being held back or dropped.
    expect(orderQualityChecks(['module-hygiene'])).toEqual(['module-hygiene']);
  });
});

describe('resolveQualityScheduleOptions', () => {
  it('fills defaults, orders the window, and refuses an unknown claim task', () => {
    const resolved = resolveQualityScheduleOptions({ windowStartHour: 20, windowEndHour: 4, claimTaskType: 'rm-rf' });
    expect(resolved.windowEndHour).toBe(20);
    expect(resolved.claimTaskType).toBe('claim-work');
    expect(resolved.claimOffsetHours).toBe(3);
  });
});

describe('planQualitySchedule', () => {
  it('gives every selected check exactly one weekly slot spread over the week', () => {
    const plan = planAll();
    expect(plan.slots).toHaveLength(AUDIT_TASK_TYPE_LIST.length);
    expect(new Set(plan.slots.map(slot => slot.taskType)).size).toBe(AUDIT_TASK_TYPE_LIST.length);
    expect(new Set(plan.slots.map(slot => slot.day)).size).toBe(7);
    // One check per weekday/hour cell — two audits in one cell would run the
    // same app's repository through two agents at once.
    const cells = plan.slots.map(slot => `${slot.day}:${slot.hour}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(plan.warnings).toEqual([]);
  });

  it('keeps every audit and the claim drain out of a nightly release window', () => {
    // The shape this feature exists for: a 03:30 release must not have an audit
    // or a claim job running against the same checkout.
    const busy = busyFrom(['30 3 * * *']);
    const plan = planAll({ busy });
    const blocked = [2, 3, 4, 5];
    for (const slot of plan.slots) expect(blocked).not.toContain(slot.hour);
    for (const hour of plan.claim.hours) expect(blocked).not.toContain(hour);
  });

  it('starts the claim drain after the check it follows, never before it', () => {
    // With the natural offset hours occupied, an outward or wrapping search
    // would place the drain EARLIER in the day — the claim cron is daily, so
    // "01:00" is not after a 22:00 audit, it is 21 hours before the next one.
    const plan = planAll({ busy: busyFrom(['30 3 * * *']), options: { checksPerDay: 4, claimOffsetHours: 3 } });
    const auditHours = [...new Set(plan.slots.map(slot => slot.hour))];
    expect(plan.claim.hours).toHaveLength(auditHours.length);
    // Every claim hour is strictly later in the SAME day than the audit it
    // follows, and by at least the requested offset.
    for (const claimHour of plan.claim.hours) {
      const follows = auditHours.filter(hour => hour < claimHour);
      expect(follows.length).toBeGreaterThan(0);
      expect(claimHour - Math.max(...follows)).toBeGreaterThanOrEqual(3);
    }
    expect(Math.min(...plan.claim.gapHours)).toBeGreaterThanOrEqual(3);
  });

  it('places the audits in clock order within a day, so the suggested order holds', () => {
    // Only three hours free all week, far enough apart that the outward search
    // in `findFreeHour` resolves slot 2 BELOW slot 1 — which used to assign
    // `performance` an hour before the `code-quality` it must follow.
    const free = new Set([0, 4, 10]);
    const busy = buildBusySlots(
      [{ days: [0, 1, 2, 3, 4, 5, 6], hours: Array.from({ length: 24 }, (_, hour) => hour).filter(hour => !free.has(hour)) }],
      { padBeforeHours: 0, padAfterHours: 0 },
    );
    const plan = planQualitySchedule({
      taskTypes: ['performance', 'code-quality', 'security'],
      busy,
      options: { checksPerDay: 3, claimBetween: false },
    });
    const monday = plan.slots.filter(slot => slot.day === 1);
    expect(monday.map(slot => slot.hour)).toEqual([0, 4, 10]);
    const hourOf = taskType => monday.find(slot => slot.taskType === taskType).hour;
    expect(hourOf('code-quality')).toBeLessThan(hourOf('performance'));
  });

  it('drops the claim slot rather than wrapping it past midnight', () => {
    // A 23:00 audit has no room left in the day for a +3h drain. Wrapping to
    // 02:00 on a DAILY cron would run it before every audit, not after.
    const plan = planQualitySchedule({
      taskTypes: ['security'],
      options: { windowStartHour: 23, windowEndHour: 23, claimOffsetHours: 3 },
    });
    expect(plan.slots[0].hour).toBe(23);
    expect(plan.claim).toBeNull();
    expect(plan.warnings.join(' ')).toMatch(/No free hour left in the day/);
  });

  it('defers to each audit catalog default rather than forcing one delivery mode', () => {
    // 11 audits ship `defaultFileIssues: false`. A form-wide `true` default
    // would flip every one of them to issues-only on an untouched Apply.
    const plan = planAll();
    for (const slot of plan.slots) expect(slot.fileIssues).toBe(defaultFileIssuesFor(slot.taskType));
    expect(plan.slots.some(slot => slot.fileIssues)).toBe(true);
    expect(plan.slots.some(slot => !slot.fileIssues)).toBe(true);
  });

  it('reports a checks-per-day below the floor instead of silently raising it', () => {
    const plan = planAll({ options: { checksPerDay: 1 } });
    expect(plan.checksPerDay).toBe(Math.ceil(AUDIT_TASK_TYPE_LIST.length / 7));
    expect(plan.warnings.join(' ')).toMatch(new RegExp(`1 a day was raised to ${Math.ceil(AUDIT_TASK_TYPE_LIST.length / 7)}`));
    // Raised to the floor, it spreads like the default rather than packing and
    // leaving a day empty.
    expect(new Set(plan.slots.map(slot => slot.day)).size).toBe(7);
  });

  it('packs each day full when asked for more checks a day than the week needs', () => {
    const perDay = Math.ceil(AUDIT_TASK_TYPE_LIST.length / 7) + 3;
    const plan = planAll({ options: { checksPerDay: perDay } });
    const days = new Set(plan.slots.map(slot => slot.day));
    expect(days.size).toBe(Math.ceil(AUDIT_TASK_TYPE_LIST.length / perDay));
    // Monday-first: the packed week starts on Monday and never reaches Sunday.
    expect(days.has(1)).toBe(true);
    expect(days.has(0)).toBe(false);
  });

  it('says so when an overnight window is collapsed rather than planning a window nobody chose', () => {
    const plan = planAll({ options: { windowStartHour: 22, windowEndHour: 6 } });
    expect(plan.warnings.join(' ')).toMatch(/cannot wrap past midnight/);
    for (const slot of plan.slots) expect(slot.hour).toBe(22);
  });

  it('keeps a request field from riding back as a planning option', () => {
    // The client seeds its form from `plan.options`; an echoed `taskTypes`
    // there would override the user's live selection on the next request.
    const plan = planQualitySchedule({ taskTypes: ['security'], options: { taskTypes: ['ux'], nonsense: 1 } });
    expect(plan.options.taskTypes).toBeUndefined();
    expect(plan.options.nonsense).toBeUndefined();
    expect(plan.slots.map(slot => slot.taskType)).toEqual(['security']);
  });

  it('emits one daily cron covering every slot, not one per day', () => {
    const plan = planAll();
    // The literal, not the production expression restated: a planner that
    // emitted one claim hour for four daily slots would pass that version.
    expect(plan.claim.cron).toBe('0 3,8,13,17,22 * * *');
    expect(plan.claim.hours).toHaveLength(plan.checksPerDay);
    expect(plan.claim.taskType).toBe('claim-work');
  });

  it('schedules no claim drain when nothing files issues', () => {
    const plan = planAll({ options: { fileIssues: false } });
    expect(plan.claim).toBeNull();
    expect(plan.slots.every(slot => slot.fileIssues === false)).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/implements its own fixes/);
  });

  it('honors a per-check delivery mode over the form default', () => {
    const plan = planQualitySchedule({
      taskTypes: ['security', 'ux'],
      fileIssuesByType: { security: false },
      options: { fileIssues: true },
    });
    expect(plan.slots.find(slot => slot.taskType === 'security').fileIssues).toBe(false);
    expect(plan.slots.find(slot => slot.taskType === 'ux').fileIssues).toBe(true);
  });

  it('confines slots to the chosen window and says so when they do not fit', () => {
    const plan = planAll({ options: { windowStartHour: 9, windowEndHour: 11 } });
    for (const slot of plan.slots) {
      expect(slot.hour).toBeGreaterThanOrEqual(9);
      expect(slot.hour).toBeLessThanOrEqual(11);
    }
    expect(plan.warnings.join(' ')).toMatch(/does not fit in a 3-hour window/);
  });

  it('reports rather than silently drops checks when the week runs out of free hours', () => {
    // Every hour but one occupied leaves 7 weekly cells for the whole catalog.
    const busy = buildBusySlots([{ days: [0, 1, 2, 3, 4, 5, 6], hours: Array.from({ length: 23 }, (_, h) => h + 1) }], { padBeforeHours: 0, padAfterHours: 0 });
    const plan = planAll({ busy });
    expect(plan.checksPerDay).toBe(1);
    expect(plan.slots).toHaveLength(AUDIT_TASK_TYPE_LIST.length);
    expect(plan.warnings.join(' ')).toMatch(/share a slot/);
  });

  it('returns an empty plan rather than a cron for nothing when no check is selected', () => {
    const plan = planQualitySchedule({ taskTypes: [] });
    expect(plan.slots).toEqual([]);
    expect(plan.claim).toBeNull();
  });

  it('emits crons the scheduler can read back', () => {
    for (const slot of planAll().slots) {
      expect(cronWeekdayHours(slot.cron)).toEqual({ days: [slot.day], hours: [slot.hour] });
    }
  });
});
