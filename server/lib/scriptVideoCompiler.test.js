import { describe, it, expect } from 'vitest';
import {
  BEAT_MAX_WORDS,
  MAX_CHAIN_LENGTH,
  DEFAULT_FPS,
  partitionLinesIntoBeats,
  snapFramesToGrid,
  formatDialogueLine,
  buildBeatPrompt,
  compileScriptToClips,
} from './scriptVideoCompiler.js';

const bible = {
  styleDescriptor: 'Gritty noir animation, high-contrast chiaroscuro lighting.',
  cast: {
    KESSA: { descriptor: 'KESSA: lean build, silver undercut, mid-30s, teal scarf.' },
    GIANT: { descriptor: 'GIANT: hulking build, shaved head, late-40s, red gauntlet.' },
  },
  locations: {
    VAULT: { descriptor: 'INT. VAULT — cavernous concrete chamber, blue emergency lighting.' },
  },
};

describe('partitionLinesIntoBeats', () => {
  it('keeps lines together under the word/speaker limits', () => {
    const lines = [
      { type: 'action', text: 'Kessa creeps along the wall.' },
      { type: 'dialogue', speaker: 'KESSA', text: 'Quiet.' },
    ];
    const beats = partitionLinesIntoBeats(lines);
    expect(beats).toHaveLength(1);
    expect(beats[0].lines).toHaveLength(2);
    expect(beats[0].speakers).toEqual(['KESSA']);
  });

  it('splits a beat when a third distinct speaker would join it', () => {
    const lines = [
      { type: 'dialogue', speaker: 'KESSA', text: 'Move.' },
      { type: 'dialogue', speaker: 'GIANT', text: 'Where?' },
      { type: 'dialogue', speaker: 'NARRATOR', text: 'They ran.' },
    ];
    const beats = partitionLinesIntoBeats(lines, { maxSpeakers: 2 });
    expect(beats).toHaveLength(2);
    expect(beats[0].speakers).toEqual(['KESSA', 'GIANT']);
    expect(beats[1].speakers).toEqual(['NARRATOR']);
  });

  it('splits a beat once the word count would exceed maxWords', () => {
    const lines = [
      { type: 'action', text: 'word '.repeat(20).trim() },
      { type: 'action', text: 'word '.repeat(20).trim() },
    ];
    const beats = partitionLinesIntoBeats(lines, { maxWords: BEAT_MAX_WORDS });
    expect(beats).toHaveLength(2);
  });

  it('never splits a single line, even one longer than maxWords', () => {
    const lines = [{ type: 'action', text: 'word '.repeat(50).trim() }];
    const beats = partitionLinesIntoBeats(lines, { maxWords: 35 });
    expect(beats).toHaveLength(1);
    expect(beats[0].lines).toHaveLength(1);
  });
});

describe('snapFramesToGrid', () => {
  it('ceilings to a whole frame under the uniform grid', () => {
    const { frames, fps } = snapFramesToGrid({ seconds: 2.01, fps: 24, grid: 'uniform' });
    expect(fps).toBe(24);
    expect(frames).toBe(Math.ceil(2.01 * 24));
  });

  it('defaults to DEFAULT_FPS when fps is omitted', () => {
    const { fps } = snapFramesToGrid({ seconds: 3 });
    expect(fps).toBe(DEFAULT_FPS);
  });

  it('snaps up to the nearest 17n+5 frame count', () => {
    // 107 = 17*6 + 5. A request for exactly 107 frames worth of seconds
    // should land there, not on the next rung.
    const { frames } = snapFramesToGrid({ seconds: 107 / 24, fps: 24, grid: '17n+5' });
    expect(frames).toBe(107);
    expect((frames - 5) % 17).toBe(0);
  });

  it('rounds a mid-grid request UP to the next 17n+5 rung, never down', () => {
    // 108 pixel frames sits strictly between 107 (17*6+5) and 124 (17*7+5).
    const { frames } = snapFramesToGrid({ seconds: 108 / 24, fps: 24, grid: '17n+5' });
    expect(frames).toBe(124);
  });
});

describe('formatDialogueLine', () => {
  it('formats a speaker clause with a voice tag', () => {
    expect(formatDialogueLine({ index: 1, speaker: 'KESSA', voice: 'whispered', text: 'Quiet.' }))
      .toBe('S1 (KESSA, whispered): "Quiet."');
  });

  it('omits the voice tag when absent', () => {
    expect(formatDialogueLine({ index: 2, speaker: 'GIANT', text: 'Where?' }))
      .toBe('S2 (GIANT): "Where?"');
  });
});

describe('buildBeatPrompt', () => {
  it('injects the SAME bible descriptor string across two different beats', () => {
    const beatA = { lines: [{ type: 'dialogue', speaker: 'KESSA', text: 'Move.' }], speakers: ['KESSA'] };
    const beatB = { lines: [{ type: 'dialogue', speaker: 'KESSA', text: 'Now.' }], speakers: ['KESSA'] };
    const promptA = buildBeatPrompt({ beat: beatA, bible, locationId: 'VAULT' });
    const promptB = buildBeatPrompt({ beat: beatB, bible, locationId: 'VAULT' });
    expect(promptA).toContain(bible.cast.KESSA.descriptor);
    expect(promptB).toContain(bible.cast.KESSA.descriptor);
    // Byte-identical descriptor substring, not just semantically similar.
    const descInA = promptA.slice(promptA.indexOf('KESSA:'), promptA.indexOf('KESSA:') + bible.cast.KESSA.descriptor.length);
    const descInB = promptB.slice(promptB.indexOf('KESSA:'), promptB.indexOf('KESSA:') + bible.cast.KESSA.descriptor.length);
    expect(descInA).toBe(descInB);
  });

  it('formats action text and dialogue clauses into the prompt body', () => {
    const beat = {
      lines: [
        { type: 'action', text: 'Kessa freezes.' },
        { type: 'dialogue', speaker: 'KESSA', text: 'Did you hear that?' },
      ],
      speakers: ['KESSA'],
    };
    const prompt = buildBeatPrompt({ beat, bible, locationId: 'VAULT' });
    expect(prompt).toContain('Kessa freezes.');
    expect(prompt).toContain('S1 (KESSA): "Did you hear that?"');
  });
});

describe('compileScriptToClips', () => {
  it('marks the first beat of a scene fresh, then continues within it', () => {
    const scenes = [{
      sceneId: 'S1',
      location: 'VAULT',
      lines: [
        { type: 'dialogue', speaker: 'KESSA', text: 'Move.' },
        { type: 'dialogue', speaker: 'GIANT', text: 'Where?' },
        { type: 'dialogue', speaker: 'KESSA', text: 'There.' },
      ],
    }];
    const clips = compileScriptToClips({ scenes, bible, maxWords: 2, maxSpeakers: 1 });
    expect(clips.length).toBeGreaterThan(1);
    expect(clips[0].cutType).toBe('fresh');
    expect(clips.slice(1).every((c) => c.cutType === 'continue')).toBe(true);
  });

  it('forces a fresh re-establish after maxChainLength continue clips', () => {
    const lines = Array.from({ length: 10 }, (_, i) => (
      { type: 'dialogue', speaker: 'KESSA', text: `Line ${i}.` }
    ));
    const scenes = [{ sceneId: 'S1', location: 'VAULT', lines }];
    const clips = compileScriptToClips({ scenes, bible, maxWords: 2, maxSpeakers: 1, maxChainLength: 3 });
    // Beats: 0=fresh,1=continue,2=continue,3=fresh(chain hit 3),4=continue,...
    const cutTypes = clips.map((c) => c.cutType);
    expect(cutTypes[0]).toBe('fresh');
    expect(cutTypes[3]).toBe('fresh');
    expect(cutTypes.filter((t) => t === 'fresh').length).toBeGreaterThan(1);
  });

  it('always starts a new scene with a fresh cut, even after a continue chain', () => {
    const scenes = [
      { sceneId: 'S1', location: 'VAULT', lines: [{ type: 'action', text: 'Opening beat.' }] },
      { sceneId: 'S2', location: 'VAULT', lines: [{ type: 'action', text: 'Second scene beat.' }] },
    ];
    const clips = compileScriptToClips({ scenes, bible });
    expect(clips).toHaveLength(2);
    expect(clips.every((c) => c.cutType === 'fresh')).toBe(true);
  });

  it('respects the configured maxChainLength constant as a default', () => {
    expect(MAX_CHAIN_LENGTH).toBe(6);
  });
});
