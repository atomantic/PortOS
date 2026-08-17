import { describe, it, expect } from 'vitest';
import { KIT_PIECES } from './drumNotation.js';
import {
  CLICK_VOICE,
  DEFAULT_DRUM_KIT,
  DRUM_KITS,
  DRUM_KIT_IDS,
  DRUM_KIT_LIST,
  kitVoiceLayers,
  resolveDrumKit,
} from './drumKits.js';

// The kits are pure data with no runtime validation — a typo'd envelope number
// or a piece a kit forgot to voice would only show up as a drum that plays
// silence (or a click) somewhere in a chart. These are PROPERTY tests over every
// kit × every layer rather than a spot-check of one recipe, so a fourth kit or a
// tenth kit piece is covered the moment it's added.

const ALL_LAYERS = Object.values(DRUM_KITS).flatMap((kit) => Object
  .entries(kit.voices)
  .flatMap(([sound, layers]) => layers.map((layer, i) => ({ kit: kit.id, sound, i, layer }))));

describe('drumKits', () => {
  it('derives every lookup from the one ordered kit list', () => {
    expect(DRUM_KIT_LIST.length).toBeGreaterThan(1);
    expect(DRUM_KIT_IDS).toEqual(DRUM_KIT_LIST.map((k) => k.id));
    expect(DEFAULT_DRUM_KIT).toBe(DRUM_KIT_LIST[0].id);
    for (const id of DRUM_KIT_IDS) expect(DRUM_KITS[id]?.id).toBe(id);
    // The picker renders label + tooltip straight off the list.
    expect(DRUM_KIT_LIST.every((k) => k.label && k.description)).toBe(true);
  });

  it('voices every kit piece the notation can name, in every kit', () => {
    // A missing voice would fall back to the snare — the hit lands at the right
    // time but on the wrong drum, which reads as a chart bug, not a kit gap.
    const sounds = [...new Set(KIT_PIECES.map((p) => p.sound))];
    for (const id of DRUM_KIT_IDS) {
      for (const sound of sounds) {
        expect(DRUM_KITS[id].voices[sound]?.length, `${id}/${sound}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every layer a sounding envelope', () => {
    for (const { kit, sound, i, layer } of ALL_LAYERS) {
      const where = `${kit}/${sound}[${i}]`;
      expect(['tone', 'noise', 'metal'], where).toContain(layer.kind);
      if (layer.kind === 'metal') {
        expect(layer.partials.length, where).toBeGreaterThan(1);
        expect(layer.partials.every((hz) => hz > 0), where).toBe(true);
        expect(layer.filter, where).toBeTruthy();
      }
      expect(layer.decay, where).toBeGreaterThan(0);
      expect(layer.gain, where).toBeGreaterThan(0);
      // Web Audio's exponential ramps cannot touch zero, so no envelope endpoint
      // or filter frequency may be 0 — that throws at schedule time.
      if (layer.filter) expect(layer.filter.freq, where).toBeGreaterThan(0);
      if (layer.openDecay != null) expect(layer.openDecay, where).toBeGreaterThan(layer.decay);
    }
  });

  it('sweeps every pitched layer downward, and faster than its amplitude tail', () => {
    // The punch rule from the module header: a membrane snaps to its fundamental
    // and HOLDS while the amplitude decays. A layer whose pitchDecay equals its
    // amp decay is the weak-kick recipe this replaced.
    for (const { kit, sound, i, layer } of ALL_LAYERS) {
      if (layer.kind !== 'tone' || !(layer.to > 0)) continue;
      const where = `${kit}/${sound}[${i}]`;
      expect(layer.from, where).toBeGreaterThan(layer.to);
      expect(layer.pitchDecay, where).toBeGreaterThan(0);
      expect(layer.pitchDecay, where).toBeLessThan(layer.decay);
    }
  });

  it('drives the kick of every kit so it reads on a small speaker', () => {
    for (const id of DRUM_KIT_IDS) {
      const kick = DRUM_KITS[id].voices.kick;
      const body = kick.find((l) => l.kind === 'tone');
      expect(body?.drive, id).toBeGreaterThan(0);
      // Deep enough to be a kick, and its tail long enough to have weight — the
      // original 0.22s sweep-the-whole-decay recipe had neither.
      expect(body.to, id).toBeLessThan(60);
      expect(body.decay, id).toBeGreaterThan(0.35);
    }
  });

  it('keeps every high-passed square layer within reach of its own harmonics', () => {
    // A square's harmonic amplitudes fall off as 1/h, so a high-pass far above
    // the fundamental leaves almost nothing: the 808's metal hat first landed at
    // a 7.8 kHz cutoff over a 205 Hz partial (a ratio of 38) and measured 19 dB
    // below the 909's noise hat — audibly missing. 25 is comfortably past every
    // calibrated value here and comfortably short of that bug.
    for (const { kit, sound, i, layer } of ALL_LAYERS) {
      if (layer.filter?.type !== 'highpass') continue;
      const squares = layer.kind === 'metal' ? layer.partials
        : (layer.wave === 'square' ? [layer.from] : []);
      for (const hz of squares) {
        expect(layer.filter.freq / hz, `${kit}/${sound}[${i}] @${hz}Hz`).toBeLessThan(25);
      }
    }
  });

  it('resolveDrumKit falls back to the default for a missing or unknown id', () => {
    expect(resolveDrumKit(DEFAULT_DRUM_KIT).id).toBe(DEFAULT_DRUM_KIT);
    expect(resolveDrumKit('808').id).toBe('808');
    expect(resolveDrumKit(undefined).id).toBe(DEFAULT_DRUM_KIT);
    expect(resolveDrumKit('a-kit-that-was-renamed').id).toBe(DEFAULT_DRUM_KIT);
  });

  it('kitVoiceLayers falls back to the snare rather than to silence', () => {
    const kit = resolveDrumKit('909');
    expect(kitVoiceLayers(kit, 'kick')).toBe(kit.voices.kick);
    expect(kitVoiceLayers(kit, 'tambourine')).toBe(kit.voices.snare);
    expect(kitVoiceLayers(null, 'kick')).toEqual([]);
  });

  it('keeps the metronome click out of the kits so it sounds the same in all three', () => {
    expect(CLICK_VOICE.length).toBeGreaterThan(0);
    for (const id of DRUM_KIT_IDS) expect(DRUM_KITS[id].voices.click).toBeUndefined();
  });
});
// @vitest-environment node
