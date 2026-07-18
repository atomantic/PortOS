import { describe, it, expect } from 'vitest';
import {
  toForm, toPayload, blankForm, patchFormState, validateForm,
  describeSchedule, describeAssignment,
  ABILITY_OPTIONS, GENERATION_FIELDS_BY_ABILITY, GENERATION_DEFAULTS_BY_ABILITY,
  generationToForm, mergeGenerationForAbility, generationToPayload,
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

  describe('output-type generation params (#2769)', () => {
    it('exposes every ability with a field list and defaults', () => {
      for (const { id } of ABILITY_OPTIONS) {
        expect(Array.isArray(GENERATION_FIELDS_BY_ABILITY[id])).toBe(true);
        expect(GENERATION_DEFAULTS_BY_ABILITY[id]).toBeTruthy();
        // Every declared field has a matching default key.
        for (const field of GENERATION_FIELDS_BY_ABILITY[id]) {
          expect(GENERATION_DEFAULTS_BY_ABILITY[id]).toHaveProperty(field.key);
        }
      }
    });

    it('generationToForm fills the ability defaults and keeps only that ability keys', () => {
      expect(generationToForm('image', {})).toEqual({ quality: 'standard', aspectRatio: '16:9', imageCount: 1 });
      // A stored video key is ignored when projecting as image.
      expect(generationToForm('image', { imageCount: 4, targetDurationSeconds: 30 })).toEqual({ quality: 'standard', aspectRatio: '16:9', imageCount: 4 });
      expect(generationToForm('music', { lengthSeconds: 60 })).toEqual({ lengthSeconds: 60 });
    });

    it('toForm projects a stored non-video record onto its ability fields', () => {
      const f = toForm({ targetAbility: 'series', brief: { intent: 'noir' }, generation: { episodeCount: 3 } });
      expect(f.targetAbility).toBe('series');
      expect(f.generation).toEqual({ episodeCount: 3 });
    });

    it('mergeGenerationForAbility carries overlapping keys across a type switch', () => {
      // video → image keeps quality/aspectRatio, seeds imageCount default, drops duration.
      expect(mergeGenerationForAbility('image', { quality: 'high', aspectRatio: '9:16', targetDurationSeconds: 20 }))
        .toEqual({ quality: 'high', aspectRatio: '9:16', imageCount: 1 });
      // image → music keeps nothing overlapping, just the music default.
      expect(mergeGenerationForAbility('music', { imageCount: 4 })).toEqual({ lengthSeconds: 30 });
    });

    it('generationToPayload emits only the ability keys and coerces numbers', () => {
      // number inputs arrive as strings from the DOM.
      expect(generationToPayload('image', { quality: 'standard', aspectRatio: '1:1', imageCount: '3' }))
        .toEqual({ quality: 'standard', aspectRatio: '1:1', imageCount: 3 });
      expect(generationToPayload('music', { lengthSeconds: '45' })).toEqual({ lengthSeconds: 45 });
    });

    it('toPayload round-trips a non-video commission', () => {
      const form = toForm({ name: 'Daily Stills', targetAbility: 'image', brief: { intent: 'x' }, generation: { imageCount: 2 } });
      const payload = toPayload(form);
      expect(payload.targetAbility).toBe('image');
      expect(payload.generation).toEqual({ quality: 'standard', aspectRatio: '16:9', imageCount: 2 });
    });

    it('validateForm rejects an out-of-range per-ability number', () => {
      const base = { name: 'x', brief: { intent: 'y' }, feedbackWindow: 5 };
      const okImage = { ...base, targetAbility: 'image', generation: { quality: 'standard', aspectRatio: '16:9', imageCount: 3 } };
      expect(validateForm(okImage)).toBeNull();
      const badImage = { ...base, targetAbility: 'image', generation: { quality: 'standard', aspectRatio: '16:9', imageCount: 99 } };
      expect(validateForm(badImage)).toMatch(/Image count/);
      const clearedMusic = { ...base, targetAbility: 'music', generation: { lengthSeconds: '' } };
      expect(validateForm(clearedMusic)).toMatch(/Length/);
    });
  });
});
