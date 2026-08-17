import { describe, it, expect } from 'vitest';
import {
  toForm, toPayload, blankForm, patchFormState, validateForm,
  describeSchedule, describeAssignment,
  ABILITY_OPTIONS, GENERATION_FIELDS_BY_ABILITY, GENERATION_DEFAULTS_BY_ABILITY,
  generationToForm, mergeGenerationForAbility, generationToPayload,
  backendFieldsForAbility, RENDER_BACKEND_AUTO,
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
      expect(f.generation).toEqual({
        quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10,
        videoMode: 'auto', videoModelId: null,
      });
      expect(f.assignment).toEqual({ providerId: '', model: '' });
      expect(f.musicTaste).toEqual({
        enabled: false, source: 'digital-twin', window: 'month', anchorCount: 3,
        explorationPercent: 20, musicEngineId: '', musicModelId: '',
      });
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

    it('round-trips taste controls only for an opted-in music commission', () => {
      const form = toForm({
        name: 'Taste study', targetAbility: 'music', brief: {
          intent: 'original ambient track',
          musicTaste: {
            source: 'digital-twin', window: 'week', anchorCount: 4, explorationPercent: 35,
            musicEngineId: 'acestep', musicModelId: 'example-model',
          },
        },
      });
      expect(form.musicTaste).toMatchObject({ enabled: true, anchorCount: 4, explorationPercent: 35 });
      expect(toPayload(form).brief.musicTaste).toEqual({
        source: 'digital-twin', window: 'week', anchorCount: 4, explorationPercent: 35,
        musicEngineId: 'acestep', musicModelId: 'example-model',
      });
      form.musicTaste.enabled = false;
      expect(toPayload(form).brief.musicTaste).toBeNull();
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
    it('validates bounded taste controls when enabled', () => {
      const form = toForm({ name: 'Taste', targetAbility: 'music', brief: { intent: 'x', musicTaste: { source: 'digital-twin' } } });
      form.musicTaste.anchorCount = 0;
      expect(validateForm(form)).toMatch(/anchor count/i);
      form.musicTaste.anchorCount = 3;
      form.musicTaste.explorationPercent = 101;
      expect(validateForm(form)).toMatch(/exploration/i);
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
      expect(generationToForm('image', {})).toEqual({
        quality: 'standard', aspectRatio: '16:9', imageCount: 1, imageMode: 'auto', imageModelId: null,
      });
      // A stored video key is ignored when projecting as image.
      expect(generationToForm('image', { imageCount: 4, targetDurationSeconds: 30 })).toEqual({
        quality: 'standard', aspectRatio: '16:9', imageCount: 4, imageMode: 'auto', imageModelId: null,
      });
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
        .toEqual({ quality: 'high', aspectRatio: '9:16', imageCount: 1, imageMode: 'auto', imageModelId: null });
      // image → music keeps nothing overlapping, just the music default.
      expect(mergeGenerationForAbility('music', { imageCount: 4 })).toEqual({ lengthSeconds: 30 });
    });

    it('generationToPayload emits only the ability keys and coerces numbers', () => {
      // number inputs arrive as strings from the DOM.
      expect(generationToPayload('image', { quality: 'standard', aspectRatio: '1:1', imageCount: '3' }))
        .toEqual({ quality: 'standard', aspectRatio: '1:1', imageCount: 3, imageMode: 'auto', imageModelId: null });
      expect(generationToPayload('music', { lengthSeconds: '45' })).toEqual({ lengthSeconds: 45 });
    });

    it('toPayload round-trips a non-video commission', () => {
      const form = toForm({ name: 'Daily Stills', targetAbility: 'image', brief: { intent: 'x' }, generation: { imageCount: 2 } });
      const payload = toPayload(form);
      expect(payload.targetAbility).toBe('image');
      expect(payload.generation).toEqual({
        quality: 'standard', aspectRatio: '16:9', imageCount: 2, imageMode: 'auto', imageModelId: null,
      });
    });

    it('validateForm ignores the non-numeric backend fields', () => {
      // A backend descriptor has no min/max — the numeric guard must skip it or
      // every image commission would fail validation on `imageMode`.
      const form = { ...blankForm(), name: 'x', brief: { intent: 'y' }, targetAbility: 'image', generation: generationToForm('image', {}) };
      expect(validateForm(form)).toBeNull();
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

  describe('render-backend pin (#3135)', () => {
    it('declares backend fields only for the abilities that enqueue that render kind', () => {
      expect(backendFieldsForAbility('image').map((f) => f.key)).toEqual(['imageMode']);
      expect(backendFieldsForAbility('video').map((f) => f.key)).toEqual(['videoMode']);
      // A music video renders both a video and (potentially) stills for it.
      expect(backendFieldsForAbility('music-video').map((f) => f.key)).toEqual(['videoMode', 'imageMode']);
      expect(backendFieldsForAbility('music')).toEqual([]);
      expect(backendFieldsForAbility('series')).toEqual([]);
    });

    it('defaults to auto with no model id — the pre-#3135 behavior', () => {
      const f = toForm({ targetAbility: 'image', brief: { intent: 'x' } });
      expect(f.generation.imageMode).toBe(RENDER_BACKEND_AUTO);
      expect(f.generation.imageModelId).toBeNull();
      expect(toPayload(f).generation.imageMode).toBe('auto');
      expect(toPayload(f).generation.imageModelId).toBeNull();
    });

    it('projects a stored pin (mode + model) back onto the form', () => {
      const f = toForm({
        targetAbility: 'image', brief: { intent: 'x' },
        generation: { imageMode: 'local', imageModelId: 'example-model' },
      });
      expect(f.generation.imageMode).toBe('local');
      expect(f.generation.imageModelId).toBe('example-model');
    });

    it('sends the model id for a model-bearing backend', () => {
      const payload = generationToPayload('image', {
        quality: 'standard', aspectRatio: '16:9', imageCount: 1, imageMode: 'local', imageModelId: 'example-model',
      });
      expect(payload.imageMode).toBe('local');
      expect(payload.imageModelId).toBe('example-model');
    });

    it('nulls a stale model id when the pinned backend has no model knob', () => {
      // Cloud CLIs pick their own model — a leftover local model id must not ride
      // along, and must be sent as null (not omitted) so the server merge clears it.
      const payload = generationToPayload('image', {
        quality: 'standard', aspectRatio: '16:9', imageCount: 1, imageMode: 'grok', imageModelId: 'example-model',
      });
      expect(payload.imageMode).toBe('grok');
      expect(payload.imageModelId).toBeNull();
      expect('imageModelId' in payload).toBe(true);
    });

    it('emits both video and image pins for a music-video commission', () => {
      const payload = generationToPayload('music-video', {
        quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10,
        videoMode: 'grok', videoModelId: null, imageMode: 'local', imageModelId: 'example-model',
      });
      expect(payload.videoMode).toBe('grok');
      expect(payload.imageMode).toBe('local');
      expect(payload.imageModelId).toBe('example-model');
    });

    it('never emits a backend key for an ability that has none', () => {
      const payload = generationToPayload('music', { lengthSeconds: 30, imageMode: 'grok' });
      expect(payload).toEqual({ lengthSeconds: 30 });
    });
  });
});
// @vitest-environment node
