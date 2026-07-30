// Synthesized drum-kit voice recipes for the SongBook play-along (#3115).
//
// PortOS ships no drum samples (repo size + sample licensing), so the play-along
// kit is synthesized. The original recipe was a generic "noise burst + sine
// sweep" click-with-groove, and its kick read as weak: the pitch sweep ran across
// the WHOLE 0.22s amplitude decay, so the tone spent most of the note above
// 100 Hz and then vanished before any body developed. Two fixes carry this file:
//
// 1. THE PITCH ENVELOPE IS DECOUPLED FROM THE AMPLITUDE ENVELOPE (`pitchDecay`).
//    A drum-machine kick snaps from its attack pitch down to the fundamental in
//    ~30–60ms and then HOLDS there while the amplitude decays for half a second
//    or more. That separation is what the ear reads as "punch, then weight".
// 2. VOICES ARE SATURATED (`drive`). A 48 Hz sine is nearly inaudible on a phone
//    or laptop speaker — there is no driver for it. Running the tone through a
//    tanh shaper generates the harmonic series (96/144/192 Hz…) that small
//    speakers CAN reproduce, so the ear reconstructs the missing fundamental.
//    This is the same trick every drum machine and bass amp uses.
//
// A voice is a list of LAYERS mixed together, each an independent little synth:
//
//   { kind: 'tone',  wave, from, to?, pitchDecay?, decay, openDecay?, gain,
//                    drive?, filter? }
//   { kind: 'metal', partials, decay, openDecay?, gain, filter }
//   { kind: 'noise', filter, decay, openDecay?, gain }
//
// - `from`/`to` are the pitch envelope endpoints; omit `to` for a static pitch.
// - `pitchDecay` is how long the sweep takes — INDEPENDENT of `decay`, and
//   required whenever `to` is set (see the note at the top).
// - `openDecay` replaces `decay` for an `o` (open hi-hat) cell.
// - `filter` is `{ type, freq, q }` applied after the source(s).
// - `drive` (>0) is the tanh saturation amount, normalized so the layer keeps its
//   peak level and only gains harmonics.
// - a `metal` layer is one voice built from N square oscillators summed into a
//   single filter + envelope; `gain` is the level of the WHOLE cluster (the
//   realization divides it across the partials), so it is directly comparable to
//   a noise layer's `gain`.
//
// `drumPlayback.js` owns the Web Audio realization of these recipes; this module
// is pure data plus the small helpers that build repetitive layer sets, so a kit
// can be auditioned/tweaked without touching the scheduler.

// The 808's hi-hat/cymbal source is a cluster of square oscillators at
// deliberately inharmonic ratios, run through a high-pass — that inharmonicity is
// what makes it read as "metal" rather than "hiss". These are the classic six.
const METAL_PARTIALS = [205.3, 304.4, 369.6, 522.7, 540, 800];

// CALIBRATION WARNING for every `metal` layer below. A square's harmonics fall
// off 6 dB/octave, so almost nothing of a 205 Hz partial survives a hi-hat-height
// high-pass: measured against the 909's noise hat, this cluster at a 7.8 kHz
// cutoff and a noise-hat-like gain came out 19 dB quieter — inaudible under the
// kit. Metal cutoffs are therefore much LOWER, and their gains much HIGHER, than
// the noise voices they sit beside. They are not typos and must not be
// "harmonized" with the 909's numbers.
const metal = ({ freq, decay, openDecay, gain, partials = METAL_PARTIALS }) => ({
  kind: 'metal', partials, filter: { type: 'highpass', freq, q: 0.7 }, decay, openDecay, gain,
});

// A membrane (kick/tom) is a pitch-dropping sine; the arguments are the knobs
// that actually differ between one and the next.
const membrane = ({ from, to, pitchDecay, decay, gain, drive = 0 }) => ({
  kind: 'tone', wave: 'sine', from, to, pitchDecay, decay, gain, drive,
});

// The beater/stick transient that sits on top of a membrane hit — a very short
// high-passed noise tick. This is most of what makes a kick audible on a laptop
// speaker before the body arrives.
const transient = ({ freq, decay, gain }) => ({
  kind: 'noise', filter: { type: 'highpass', freq, q: 0.4 }, decay, gain,
});

/**
 * TR-909 — the punchy one, and the default.
 *
 * Chosen as the default because it is the most legible kit to practise against:
 * a short attack-forward kick, a bright snare crack, and tight hats all stay
 * distinct at speed, where the 808's long tails smear together under 16ths.
 */
const KIT_909 = {
  id: '909',
  label: 'TR-909',
  description: 'Punchy attack-forward kick, bright snare crack, tight hats.',
  voices: {
    kick: [
      membrane({ from: 200, to: 48, pitchDecay: 0.03, decay: 0.42, gain: 1.55, drive: 7 }),
      transient({ freq: 1800, decay: 0.014, gain: 0.5 }),
    ],
    snare: [
      { kind: 'noise', filter: { type: 'highpass', freq: 1400, q: 0.7 }, decay: 0.17, gain: 0.85 },
      { kind: 'tone', wave: 'triangle', from: 330, to: 300, pitchDecay: 0.05, decay: 0.085, gain: 0.4 },
      { kind: 'tone', wave: 'triangle', from: 185, to: 172, pitchDecay: 0.06, decay: 0.11, gain: 0.5, drive: 2.5 },
    ],
    tom1: [membrane({ from: 380, to: 165, pitchDecay: 0.07, decay: 0.38, gain: 0.95, drive: 3 })],
    tom2: [membrane({ from: 285, to: 122, pitchDecay: 0.08, decay: 0.45, gain: 0.95, drive: 3 })],
    floor: [membrane({ from: 195, to: 76, pitchDecay: 0.1, decay: 0.6, gain: 1, drive: 4 })],
    hihat: [
      { kind: 'noise', filter: { type: 'highpass', freq: 8200, q: 0.8 }, decay: 0.045, openDecay: 0.32, gain: 0.5 },
    ],
    hihatFoot: [
      { kind: 'noise', filter: { type: 'highpass', freq: 6500, q: 0.8 }, decay: 0.03, gain: 0.34 },
    ],
    ride: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 5600, q: 0.7 }, decay: 0.8, gain: 0.34 },
      // The bell "ping" on top of the wash — same square-harmonic rolloff caveat
      // as `metal`, hence the low cutoff for so modest a gain.
      { kind: 'tone', wave: 'square', from: 1180, filter: { type: 'highpass', freq: 2500, q: 0.7 }, decay: 0.5, gain: 0.2 },
    ],
    crash: [
      { kind: 'noise', filter: { type: 'highpass', freq: 3200, q: 0.4 }, decay: 1.3, gain: 0.5 },
    ],
  },
};

/**
 * TR-808 — the deep one. Long sub-heavy kick, thin snare, metallic square-cluster
 * hats. Sounds enormous on headphones and at slow practice tempos; the kick tail
 * deliberately outruns a 16th at speed, which is the point of the machine.
 */
const KIT_808 = {
  id: '808',
  label: 'TR-808',
  description: 'Deep sub kick with a long tail, thin snare, metallic hats.',
  voices: {
    kick: [
      membrane({ from: 110, to: 45, pitchDecay: 0.055, decay: 0.9, gain: 1.7, drive: 4 }),
      transient({ freq: 1200, decay: 0.01, gain: 0.28 }),
    ],
    snare: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 1750, q: 0.5 }, decay: 0.12, gain: 0.72 },
      { kind: 'tone', wave: 'triangle', from: 330, to: 315, pitchDecay: 0.04, decay: 0.075, gain: 0.34 },
      { kind: 'tone', wave: 'triangle', from: 178, to: 168, pitchDecay: 0.05, decay: 0.1, gain: 0.44 },
    ],
    tom1: [membrane({ from: 340, to: 150, pitchDecay: 0.09, decay: 0.55, gain: 0.9, drive: 2 })],
    tom2: [membrane({ from: 250, to: 110, pitchDecay: 0.1, decay: 0.65, gain: 0.9, drive: 2 })],
    floor: [membrane({ from: 165, to: 66, pitchDecay: 0.12, decay: 0.85, gain: 0.95, drive: 3 })],
    hihat: [metal({ freq: 4200, decay: 0.04, openDecay: 0.42, gain: 2.4 })],
    hihatFoot: [metal({ freq: 3800, decay: 0.028, gain: 1.7 })],
    ride: [
      metal({ freq: 3200, decay: 0.7, gain: 1.3 }),
      { kind: 'noise', filter: { type: 'bandpass', freq: 5200, q: 0.9 }, decay: 0.7, gain: 0.16 },
    ],
    crash: [
      metal({ freq: 2400, decay: 1.2, gain: 1.3 }),
      { kind: 'noise', filter: { type: 'highpass', freq: 3000, q: 0.4 }, decay: 1.4, gain: 0.34 },
    ],
  },
};

/**
 * Acoustic — the closest of the three to a real kit, for charts that read as
 * band parts rather than machine patterns. Same envelope discipline as the
 * others (this is NOT the old weak recipe), just tuned rounder and less driven.
 */
const KIT_ACOUSTIC = {
  id: 'acoustic',
  label: 'Acoustic',
  description: 'Rounder, less saturated — a studio kit rather than a machine.',
  voices: {
    kick: [
      membrane({ from: 165, to: 52, pitchDecay: 0.045, decay: 0.4, gain: 1.35, drive: 3 }),
      transient({ freq: 2400, decay: 0.02, gain: 0.4 }),
    ],
    snare: [
      { kind: 'noise', filter: { type: 'highpass', freq: 1100, q: 0.6 }, decay: 0.2, gain: 0.8 },
      { kind: 'tone', wave: 'triangle', from: 340, to: 300, pitchDecay: 0.05, decay: 0.1, gain: 0.3 },
      { kind: 'tone', wave: 'sine', from: 200, to: 178, pitchDecay: 0.06, decay: 0.13, gain: 0.42 },
    ],
    tom1: [membrane({ from: 300, to: 160, pitchDecay: 0.09, decay: 0.42, gain: 0.9 })],
    tom2: [membrane({ from: 235, to: 120, pitchDecay: 0.1, decay: 0.5, gain: 0.9 })],
    floor: [membrane({ from: 160, to: 82, pitchDecay: 0.12, decay: 0.68, gain: 0.95, drive: 2 })],
    hihat: [
      { kind: 'noise', filter: { type: 'highpass', freq: 7200, q: 0.9 }, decay: 0.05, openDecay: 0.3, gain: 0.46 },
    ],
    hihatFoot: [
      { kind: 'noise', filter: { type: 'highpass', freq: 5800, q: 0.9 }, decay: 0.035, gain: 0.32 },
    ],
    ride: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 6000, q: 0.8 }, decay: 0.75, gain: 0.32 },
    ],
    crash: [
      { kind: 'noise', filter: { type: 'highpass', freq: 2800, q: 0.4 }, decay: 1.4, gain: 0.46 },
    ],
  },
};

// One ordered source of truth — the picker renders this order, and the FIRST kit
// is the default. Everything else below is derived, so adding a kit is one edit.
export const DRUM_KIT_LIST = [KIT_909, KIT_808, KIT_ACOUSTIC];
export const DRUM_KITS = Object.fromEntries(DRUM_KIT_LIST.map((kit) => [kit.id, kit]));
export const DRUM_KIT_IDS = DRUM_KIT_LIST.map((kit) => kit.id);
export const DEFAULT_DRUM_KIT = DRUM_KIT_LIST[0].id;

/**
 * A kit id → its recipe, falling back to the default. An unknown id (a stale
 * localStorage value from a kit that has since been renamed) must degrade to a
 * kit that sounds, never to silence.
 */
export const resolveDrumKit = (id) => DRUM_KITS[id] || DRUM_KITS[DEFAULT_DRUM_KIT];

/**
 * The layer list for one kit piece — `sound` is the `KIT_PIECES` synth name
 * (`kick`, `snare`, `hihat`, …). Falls back to the kit's snare so an unmapped
 * piece is still audible at the right time rather than dropping out.
 */
export const kitVoiceLayers = (kit, sound) => kit?.voices?.[sound] || kit?.voices?.snare || [];

// The metronome click is NOT part of the kit: it's a reference pulse layered over
// whatever kit is selected, so it must stay identical (and cut through) across
// all three. A short, bright, barely-moving blip.
export const CLICK_VOICE = [
  { kind: 'tone', wave: 'square', from: 1600, to: 1560, pitchDecay: 0.02, decay: 0.045, gain: 0.6 },
];
