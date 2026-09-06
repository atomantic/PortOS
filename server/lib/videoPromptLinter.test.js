import { describe, it, expect } from 'vitest';
import { lintClipPrompt, lintClips, MAX_CLIP_PROMPT_LENGTH } from './videoPromptLinter.js';

const bible = {
  cast: { hero: { descriptor: 'A weathered pilot in a scuffed orange flight suit.' } },
  locations: { hangar: { descriptor: 'A cavernous steel hangar lit by hanging sodium lamps.' } },
};

const passingContinueClip = {
  cutType: 'continue',
  framing: 'a low tracking shot',
  previousFraming: 'a wide establishing shot',
  prompt: 'Hard cut to a low tracking shot: A weathered pilot in a scuffed orange flight suit. A cavernous steel hangar lit by hanging sodium lamps. She strides toward the ship.',
  references: [{ kind: 'cast', id: 'hero' }, { kind: 'locations', id: 'hangar' }],
};

describe('lintClipPrompt', () => {
  it('passes a clip that satisfies every rule', () => {
    expect(lintClipPrompt(passingContinueClip, { bible })).toEqual({ pass: true, reasons: [] });
  });

  it('passes a fresh-cut clip with no hard-cut opener requirement', () => {
    const clip = {
      cutType: 'fresh',
      framing: 'a wide establishing shot',
      prompt: `${bible.cast.hero.descriptor} She stands in the hangar doorway.`,
      references: [{ kind: 'cast', id: 'hero' }],
    };
    expect(lintClipPrompt(clip, { bible })).toEqual({ pass: true, reasons: [] });
  });

  it('flags a continuing clip missing the hard-cut opener', () => {
    const clip = { ...passingContinueClip, prompt: passingContinueClip.prompt.replace('Hard cut to a low tracking shot: ', '') };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('hard-cut opener'))).toBe(true);
  });

  it('flags a continuing clip whose opener framing does not match clip.framing', () => {
    const clip = { ...passingContinueClip, prompt: passingContinueClip.prompt.replace('a low tracking shot', 'a close-up') };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('hard-cut opener'))).toBe(true);
  });

  it('flags a continuing clip whose framing repeats the preceding clip', () => {
    const clip = { ...passingContinueClip, framing: 'a wide establishing shot', prompt: passingContinueClip.prompt.replace('a low tracking shot', 'a wide establishing shot') };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('repeats the preceding clip'))).toBe(true);
  });

  it('flags a missing bible descriptor entry', () => {
    const clip = { ...passingContinueClip, references: [{ kind: 'cast', id: 'nobody' }] };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('no bible descriptor found'))).toBe(true);
  });

  it('flags a prompt that paraphrases the bible descriptor instead of quoting it verbatim', () => {
    const clip = { ...passingContinueClip, prompt: passingContinueClip.prompt.replace('A weathered pilot in a scuffed orange flight suit.', 'A weary pilot in an orange flight suit.') };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('verbatim bible descriptor'))).toBe(true);
  });

  it.each(['same', 'still', 'again', 'continues', 'as before'])('flags the banned cross-clip referent "%s"', (term) => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} It looks ${term} as it did.` };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes(`banned cross-clip referent "${term}"`))).toBe(true);
  });

  it('does not flag a substring false-positive for a banned referent', () => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} She is against the wall, staged in the design.` };
    expect(lintClipPrompt(clip, { bible }).pass).toBe(true);
  });

  it.each(['no', 'without', 'never'])('flags the banned negative construction "%s"', (term) => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} There is ${term} sound here.` };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes(`banned negative construction "${term}"`))).toBe(true);
  });

  it('does not flag a substring false-positive for a banned negative', () => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} A canoe glides into the hangar.` };
    expect(lintClipPrompt(clip, { bible }).pass).toBe(true);
  });

  it.each(['text', 'caption', 'overlay'])('flags the banned UI overlay term "%s"', (term) => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} A ${term} appears on screen.` };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes(`banned UI overlay language "${term}"`))).toBe(true);
  });

  it('does not flag a substring false-positive for a banned overlay term', () => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} The context of the scene is tense.` };
    expect(lintClipPrompt(clip, { bible }).pass).toBe(true);
  });

  it('flags a prompt over the character length bound', () => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} ${'x'.repeat(MAX_CLIP_PROMPT_LENGTH)}` };
    const { pass, reasons } = lintClipPrompt(clip, { bible });
    expect(pass).toBe(false);
    expect(reasons.some((r) => r.includes('over the'))).toBe(true);
  });

  it('honors a custom maxLength', () => {
    const clip = { ...passingContinueClip };
    expect(lintClipPrompt(clip, { bible, maxLength: 10 }).pass).toBe(false);
  });

  it('never throws on malformed clip fields — returns a failing result instead', () => {
    expect(() => lintClipPrompt({ prompt: null, cutType: 'continue', framing: 42, references: 'not-an-array' }, { bible })).not.toThrow();
    const { pass } = lintClipPrompt({ prompt: null, cutType: 'continue', framing: 42, references: 'not-an-array' }, { bible });
    expect(pass).toBe(false);
    expect(() => lintClipPrompt(null, { bible })).not.toThrow();
    expect(() => lintClipPrompt(undefined, { bible })).not.toThrow();
  });

  it('does not flag a banned term abutting an underscore as a standalone word', () => {
    const clip = { ...passingContinueClip, prompt: `${passingContinueClip.prompt} same_frame_id logged.` };
    expect(lintClipPrompt(clip, { bible }).pass).toBe(true);
  });
});

describe('lintClips', () => {
  it('passes an array of chained clips and derives previousFraming from the preceding clip', () => {
    const fresh = {
      cutType: 'fresh',
      framing: 'a wide establishing shot',
      prompt: `${bible.cast.hero.descriptor} She stands in the hangar doorway.`,
      references: [{ kind: 'cast', id: 'hero' }],
    };
    const continued = { ...passingContinueClip };
    delete continued.previousFraming;
    const { pass, results } = lintClips([fresh, continued], { bible });
    expect(pass).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0].index).toBe(0);
    expect(results[1].index).toBe(1);
  });

  it('reports a failing clip among passing ones', () => {
    const bad = { ...passingContinueClip, prompt: passingContinueClip.prompt.replace('Hard cut to a low tracking shot: ', '') };
    const { pass, results } = lintClips([passingContinueClip, bad], { bible });
    expect(pass).toBe(false);
    expect(results[0].pass).toBe(true);
    expect(results[1].pass).toBe(false);
  });

  it('never throws on a non-array clips argument', () => {
    expect(() => lintClips(null, { bible })).not.toThrow();
    expect(() => lintClips(undefined, { bible })).not.toThrow();
    expect(() => lintClips('not-an-array', { bible })).not.toThrow();
    expect(() => lintClips(42, { bible })).not.toThrow();
    expect(lintClips(null, { bible })).toEqual({ pass: true, results: [] });
    expect(lintClips('not-an-array', { bible })).toEqual({ pass: true, results: [] });
  });
});
