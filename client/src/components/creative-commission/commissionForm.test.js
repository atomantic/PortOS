import { describe, it, expect } from 'vitest';
import {
  toForm, toPayload, blankForm, patchFormState, validateForm,
  describeSchedule, describeAssignment,
} from './commissionForm.js';

describe('commissionForm helpers', () => {
  describe('toForm', () => {
    it('fills gaps so every input stays controlled from an empty record', () => {
      const f = toForm({});
      expect(f.name).toBe('');
      expect(f.enabled).toBe(true);
      expect(f.targetAbility).toBe('video');
      expect(f.brief).toEqual({ intent: '', genre: '', styleSpec: '' });
      expect(f.schedule.kind).toBe('DAILY');
      expect(f.schedule.atLocalTime).toBe('02:00');
      expect(f.generation).toEqual({ quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10 });
      expect(f.assignment).toEqual({ providerId: '', model: '' });
      expect(f.feedbackWindow).toBe(5);
    });

    it('projects a stored record, treating enabled:false and feedbackWindow:0 as intentional', () => {
      const f = toForm({ name: 'Nightly', enabled: false, feedbackWindow: 0, brief: { intent: 'surreal' } });
      expect(f.name).toBe('Nightly');
      expect(f.enabled).toBe(false);
      expect(f.feedbackWindow).toBe(0);
      expect(f.brief.intent).toBe('surreal');
    });
  });

  describe('toPayload', () => {
    it('drops schedule fields the cadence does not use (DAILY)', () => {
      const p = toPayload(toForm({ schedule: { kind: 'DAILY', atLocalTime: '03:00', weekdaysOnly: true } }));
      expect(p.schedule).toEqual({ kind: 'DAILY', atLocalTime: '03:00', weekdaysOnly: true });
      expect(p.schedule.cron).toBeUndefined();
      expect(p.schedule.weekday).toBeUndefined();
    });

    it('sends only cron for CUSTOM cadence', () => {
      const form = toForm({ schedule: { kind: 'CUSTOM', cron: '0 2 * * *' } });
      const p = toPayload(form);
      expect(p.schedule).toEqual({ kind: 'CUSTOM', cron: '0 2 * * *' });
    });

    it('nulls a provider-less model so a stored pin never dangles', () => {
      const form = { ...blankForm(), assignment: { providerId: '', model: 'gpt-x' } };
      expect(toPayload(form).assignment).toEqual({ providerId: null, model: null });
    });

    it('keeps the model when a provider is pinned', () => {
      const form = { ...blankForm(), assignment: { providerId: 'claude', model: 'opus' } };
      expect(toPayload(form).assignment).toEqual({ providerId: 'claude', model: 'opus' });
    });

    it('coerces a blank genre to null', () => {
      const form = { ...blankForm(), brief: { intent: 'x', genre: '  ', styleSpec: '' } };
      expect(toPayload(form).brief.genre).toBeNull();
    });
  });

  describe('validateForm', () => {
    const base = () => ({ ...blankForm(), name: 'A', brief: { intent: 'i', genre: '', styleSpec: '' } });
    it('passes a complete form', () => {
      expect(validateForm(base())).toBeNull();
    });
    it('requires a name', () => {
      expect(validateForm({ ...base(), name: '  ' })).toMatch(/name/i);
    });
    it('requires a brief intent', () => {
      expect(validateForm({ ...base(), brief: { intent: '', genre: '', styleSpec: '' } })).toMatch(/intent/i);
    });
    it('rejects a blank feedback window (would silently disable conditioning)', () => {
      expect(validateForm({ ...base(), feedbackWindow: '' })).toMatch(/feedback window/i);
    });
    it('accepts feedbackWindow 0 (explicit disable)', () => {
      expect(validateForm({ ...base(), feedbackWindow: 0 })).toBeNull();
    });
    it('rejects an out-of-range feedback window', () => {
      expect(validateForm({ ...base(), feedbackWindow: 99 })).toMatch(/feedback window/i);
    });
  });

  describe('patchFormState', () => {
    it('patches a one-level path immutably', () => {
      const prev = blankForm();
      const next = patchFormState(prev, ['name'], 'X');
      expect(next.name).toBe('X');
      expect(prev.name).toBe('');
      expect(next).not.toBe(prev);
    });
    it('patches a nested path without dropping siblings', () => {
      const prev = toForm({ brief: { intent: 'keep', genre: 'g' } });
      const next = patchFormState(prev, ['brief', 'genre'], 'new');
      expect(next.brief.genre).toBe('new');
      expect(next.brief.intent).toBe('keep');
      expect(prev.brief.genre).toBe('g');
    });
  });

  describe('describeSchedule', () => {
    it('summarizes each cadence kind', () => {
      expect(describeSchedule({ kind: 'DAILY', atLocalTime: '02:00' })).toBe('Daily at 02:00');
      expect(describeSchedule({ kind: 'DAILY', atLocalTime: '02:00', weekdaysOnly: true })).toBe('Daily (weekdays) at 02:00');
      expect(describeSchedule({ kind: 'WEEKLY', weekday: 1, atLocalTime: '09:00' })).toBe('Weekly · Monday at 09:00');
      expect(describeSchedule({ kind: 'CUSTOM', cron: '0 2 * * *' })).toBe('Custom · 0 2 * * *');
      expect(describeSchedule(null)).toBe('No schedule');
    });
  });

  describe('describeAssignment', () => {
    it('names the install default when unpinned', () => {
      expect(describeAssignment({})).toBe('Install default AI');
      expect(describeAssignment(null)).toBe('Install default AI');
    });
    it('names the provider and model when pinned', () => {
      expect(describeAssignment({ providerId: 'claude' })).toBe('claude');
      expect(describeAssignment({ providerId: 'claude', model: 'opus' })).toBe('claude · opus');
    });
  });
});
