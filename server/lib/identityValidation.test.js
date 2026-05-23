import { describe, it, expect } from 'vitest';
import {
  sectionStatusEnum,
  chronotypeEnum,
  chronotypeBehavioralInputSchema,
  birthDateInputSchema,
  goalHorizonEnum,
  goalCategoryEnum,
  goalStatusEnum,
  goalTypeEnum,
  createGoalInputSchema,
  updateGoalInputSchema,
  addMilestoneInputSchema,
  aiProviderInputSchema,
  acceptPhasesInputSchema,
  addProgressEntrySchema,
  addTodoInputSchema,
  updateTodoInputSchema,
  updateProgressSchema,
  linkActivityInputSchema,
  linkCalendarInputSchema,
  applyOrganizationInputSchema
} from './identityValidation.js';

describe('identityValidation', () => {
  describe('enums', () => {
    it('sectionStatusEnum admits the documented states', () => {
      for (const v of ['active', 'pending', 'unavailable']) {
        expect(sectionStatusEnum.safeParse(v).success).toBe(true);
      }
      expect(sectionStatusEnum.safeParse('archived').success).toBe(false);
    });

    it('chronotypeEnum admits the three classic chronotypes', () => {
      for (const v of ['morning', 'intermediate', 'evening']) {
        expect(chronotypeEnum.safeParse(v).success).toBe(true);
      }
      expect(chronotypeEnum.safeParse('night-owl').success).toBe(false);
    });

    it('goalHorizonEnum covers 1y through lifetime', () => {
      for (const v of ['1-year', '3-year', '5-year', '10-year', '20-year', 'lifetime']) {
        expect(goalHorizonEnum.safeParse(v).success).toBe(true);
      }
      expect(goalHorizonEnum.safeParse('30-year').success).toBe(false);
    });

    it('goalStatusEnum / goalTypeEnum / goalCategoryEnum reject unknown values', () => {
      expect(goalStatusEnum.safeParse('paused').success).toBe(false);
      expect(goalTypeEnum.safeParse('mega').success).toBe(false);
      expect(goalCategoryEnum.safeParse('not-a-cat').success).toBe(false);
    });
  });

  describe('chronotypeBehavioralInputSchema', () => {
    it('accepts well-formed HH:MM values', () => {
      const r = chronotypeBehavioralInputSchema.safeParse({
        preferredWakeTime: '06:30',
        preferredSleepTime: '22:45',
        peakFocusStart: '09:00',
        peakFocusEnd: '11:30',
        caffeineLastIntake: '14:00'
      });
      expect(r.success).toBe(true);
    });

    it('accepts edge HH:MM values (00:00 and 23:59)', () => {
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '00:00' }).success).toBe(true);
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '23:59' }).success).toBe(true);
    });

    it('rejects out-of-range times', () => {
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '24:00' }).success).toBe(false);
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '12:60' }).success).toBe(false);
    });

    it('rejects bad formats', () => {
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '6:30' }).success).toBe(false);
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '06-30' }).success).toBe(false);
      expect(chronotypeBehavioralInputSchema.safeParse({ preferredWakeTime: '0630' }).success).toBe(false);
    });

    it('accepts an empty object (all fields optional)', () => {
      expect(chronotypeBehavioralInputSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('birthDateInputSchema', () => {
    it('accepts a past calendar date', () => {
      expect(birthDateInputSchema.safeParse({ birthDate: '1990-05-15' }).success).toBe(true);
    });

    it('rejects future dates', () => {
      const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5)
        .toISOString().slice(0, 10);
      const r = birthDateInputSchema.safeParse({ birthDate: future });
      expect(r.success).toBe(false);
    });

    it('rejects non-calendar dates like Feb 30', () => {
      expect(birthDateInputSchema.safeParse({ birthDate: '2020-02-30' }).success).toBe(false);
    });

    it('rejects bad formats', () => {
      expect(birthDateInputSchema.safeParse({ birthDate: '1990/05/15' }).success).toBe(false);
      expect(birthDateInputSchema.safeParse({ birthDate: '90-05-15' }).success).toBe(false);
    });
  });

  describe('createGoalInputSchema', () => {
    it('accepts a minimal goal and fills defaults', () => {
      const r = createGoalInputSchema.safeParse({ title: 'Learn jazz piano' });
      expect(r.success).toBe(true);
      expect(r.data.horizon).toBe('5-year');
      expect(r.data.category).toBe('mastery');
      expect(r.data.goalType).toBe('standard');
      expect(r.data.parentId).toBeNull();
      expect(r.data.tags).toEqual([]);
    });

    it('rejects an empty title', () => {
      expect(createGoalInputSchema.safeParse({ title: '' }).success).toBe(false);
    });

    it('rejects a title longer than 200 chars', () => {
      expect(createGoalInputSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
    });

    it('caps tag count at 20', () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
      expect(createGoalInputSchema.safeParse({ title: 'x', tags }).success).toBe(false);
    });

    it('accepts a fully-specified timeBlockConfig', () => {
      const r = createGoalInputSchema.safeParse({
        title: 'Practice',
        timeBlockConfig: {
          preferredDays: ['mon', 'wed', 'fri'],
          timeSlot: 'morning',
          sessionDurationMinutes: 60
        }
      });
      expect(r.success).toBe(true);
    });

    it('accepts HH:MM as timeSlot in timeBlockConfig', () => {
      const r = createGoalInputSchema.safeParse({
        title: 'Practice',
        timeBlockConfig: {
          preferredDays: ['mon'],
          timeSlot: '07:30',
          sessionDurationMinutes: 30
        }
      });
      expect(r.success).toBe(true);
    });

    it('rejects timeBlockConfig with bad sessionDuration', () => {
      const r = createGoalInputSchema.safeParse({
        title: 'Practice',
        timeBlockConfig: {
          preferredDays: ['mon'],
          timeSlot: 'morning',
          sessionDurationMinutes: 10
        }
      });
      expect(r.success).toBe(false);
    });
  });

  describe('updateGoalInputSchema', () => {
    it('accepts an empty patch', () => {
      expect(updateGoalInputSchema.safeParse({}).success).toBe(true);
    });

    it('accepts targetDate=null to clear', () => {
      expect(updateGoalInputSchema.safeParse({ targetDate: null }).success).toBe(true);
    });

    it('rejects bad status value', () => {
      expect(updateGoalInputSchema.safeParse({ status: 'paused' }).success).toBe(false);
    });
  });

  describe('addMilestoneInputSchema', () => {
    it('accepts title only', () => {
      expect(addMilestoneInputSchema.safeParse({ title: 'First demo' }).success).toBe(true);
    });

    it('rejects bad targetDate', () => {
      expect(addMilestoneInputSchema.safeParse({ title: 'x', targetDate: '2020-02-30' }).success).toBe(false);
    });
  });

  describe('aiProviderInputSchema', () => {
    it('accepts empty body', () => {
      expect(aiProviderInputSchema.safeParse({}).success).toBe(true);
    });

    it('rejects empty providerId / model strings', () => {
      expect(aiProviderInputSchema.safeParse({ providerId: '' }).success).toBe(false);
      expect(aiProviderInputSchema.safeParse({ model: '' }).success).toBe(false);
    });
  });

  describe('acceptPhasesInputSchema', () => {
    it('accepts a single well-formed phase', () => {
      const r = acceptPhasesInputSchema.safeParse({
        phases: [{ title: 'P1', description: 'desc', targetDate: '2030-01-01', order: 0 }]
      });
      expect(r.success).toBe(true);
    });

    it('defaults description to empty string', () => {
      const r = acceptPhasesInputSchema.safeParse({
        phases: [{ title: 'P1', targetDate: '2030-01-01', order: 0 }]
      });
      expect(r.success).toBe(true);
      expect(r.data.phases[0].description).toBe('');
    });

    it('rejects empty phases array', () => {
      expect(acceptPhasesInputSchema.safeParse({ phases: [] }).success).toBe(false);
    });

    it('caps phases at 20', () => {
      const phases = Array.from({ length: 21 }, (_, i) => ({
        title: `P${i}`, targetDate: '2030-01-01', order: i
      }));
      expect(acceptPhasesInputSchema.safeParse({ phases }).success).toBe(false);
    });
  });

  describe('addProgressEntrySchema', () => {
    it('accepts a minimal entry', () => {
      const r = addProgressEntrySchema.safeParse({ date: '2025-01-15', note: 'practiced scales' });
      expect(r.success).toBe(true);
    });

    it('rejects an empty note', () => {
      expect(addProgressEntrySchema.safeParse({ date: '2025-01-15', note: '' }).success).toBe(false);
    });

    it('caps duration at 1440 minutes', () => {
      expect(addProgressEntrySchema.safeParse({
        date: '2025-01-15', note: 'x', durationMinutes: 1441
      }).success).toBe(false);
    });
  });

  describe('addTodoInputSchema / updateTodoInputSchema', () => {
    it('addTodoInputSchema defaults priority to medium', () => {
      const r = addTodoInputSchema.safeParse({ title: 'Send email' });
      expect(r.success).toBe(true);
      expect(r.data.priority).toBe('medium');
    });

    it('rejects bad priority', () => {
      expect(addTodoInputSchema.safeParse({ title: 'x', priority: 'urgent' }).success).toBe(false);
    });

    it('updateTodoInputSchema accepts estimateMinutes=null to clear', () => {
      expect(updateTodoInputSchema.safeParse({ estimateMinutes: null }).success).toBe(true);
    });

    it('updateTodoInputSchema rejects bad status', () => {
      expect(updateTodoInputSchema.safeParse({ status: 'archived' }).success).toBe(false);
    });
  });

  describe('updateProgressSchema', () => {
    it('validates progress is within 0..100', () => {
      expect(updateProgressSchema.safeParse({ value: 0 }).success).toBe(true);
      expect(updateProgressSchema.safeParse({ value: 100 }).success).toBe(true);
      expect(updateProgressSchema.safeParse({ value: -1 }).success).toBe(false);
      expect(updateProgressSchema.safeParse({ value: 101 }).success).toBe(false);
    });
  });

  describe('linkActivityInputSchema / linkCalendarInputSchema', () => {
    it('linkActivity defaults note to empty', () => {
      const r = linkActivityInputSchema.safeParse({ activityName: 'jogging' });
      expect(r.success).toBe(true);
      expect(r.data.note).toBe('');
    });

    it('linkActivity rejects non-positive frequency', () => {
      expect(linkActivityInputSchema.safeParse({
        activityName: 'x', requiredFrequency: 0
      }).success).toBe(false);
    });

    it('linkCalendar defaults matchPattern to empty', () => {
      const r = linkCalendarInputSchema.safeParse({
        subcalendarId: 'cal1', subcalendarName: 'Health'
      });
      expect(r.success).toBe(true);
      expect(r.data.matchPattern).toBe('');
    });
  });

  describe('applyOrganizationInputSchema', () => {
    it('accepts a minimal organization patch', () => {
      const r = applyOrganizationInputSchema.safeParse({
        organization: [{ id: 'g1' }]
      });
      expect(r.success).toBe(true);
    });

    it('accepts null suggestedParentId to detach', () => {
      const r = applyOrganizationInputSchema.safeParse({
        organization: [{ id: 'g1', suggestedParentId: null }]
      });
      expect(r.success).toBe(true);
    });

    it('rejects an empty organization array', () => {
      expect(applyOrganizationInputSchema.safeParse({ organization: [] }).success).toBe(false);
    });
  });
});
