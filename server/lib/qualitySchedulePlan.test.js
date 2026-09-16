import { describe, it, expect } from 'vitest';
import { AUDIT_SUGGESTED_AFTER, AUDIT_TASK_TYPE_LIST } from './auditCatalog.js';
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
    // With the natural offset hours occupied, an outward search would place the
    // drain earlier in the day — working last night's backlog instead.
    const plan = planAll({ busy: busyFrom(['30 3 * * *']), options: { checksPerDay: 2, claimOffsetHours: 3 } });
    const auditHours = [...new Set(plan.slots.map(slot => slot.hour))].sort((a, b) => a - b);
    expect(plan.claim.hours).toHaveLength(auditHours.length);
    auditHours.forEach((auditHour, index) => {
      const gap = (plan.claim.hours.slice().sort((a, b) => a - b)[index] - auditHour + 24) % 24;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(24);
    });
  });

  it('emits one daily cron for the claim drain covering every slot', () => {
    const plan = planAll({ options: { checksPerDay: 2 } });
    expect(plan.claim.cron).toBe(`0 ${plan.claim.hours.join(',')} * * *`);
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
    // Every hour but one occupied leaves 7 weekly cells for 26 checks.
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
