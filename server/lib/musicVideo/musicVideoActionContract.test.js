import { describe, expect, it } from 'vitest';
import { musicVideoFrameModelInput, musicVideoShotModelInput } from './musicVideoShotPrompt.js';

const project = { lyricCues: [{ startSec: 9, endSec: 13, text: 'Burn my fire voice', words: [
  { w: 'Burn', startSec: 9.5, endSec: 10.5 },
  { w: 'my', startSec: 10.5, endSec: 10.95 },
  { w: 'fire', startSec: 11, endSec: 11.4 },
  { w: 'voice', startSec: 11.4, endSec: 12 },
] }] };
const scene = { startSec: 10, endSec: 12, shotMode: 'performance', performanceStyle: 'lip-sync', prompt: 'Keep my words: P/B/M!',
  direction: { actionContract: { version: 1, purpose: 'A singer performs', activeSpeaker: 'Singer' } },
  shotSheet: { characters: ['Singer'] } };
const vocalGuidance = /Lip-seal closures|Teeth-on-lip contacts|Sustained vowel holds|Mouth Visibility Guard|Single-Mouth Exclusivity Lock/;

// Catches provider text/chip drift and full-song timing leaking into a padded vocal take.
describe('vocal performance model input', () => {
  it('adds articulation and mouth visibility to the visible action chip, retaining authored text and clip offsets', () => {
    const input = musicVideoShotModelInput(project, scene, { hears: true, asTyped: true, offsetSec: 0.75 });
    expect(input.prompt.startsWith(scene.prompt)).toBe(true);
    const actions = input.promptAdditions.find((item) => item.id === 'shot-actions').text;
    expect(input.prompt).toContain(actions);
    expect(actions).toContain('Sing in sync with the audio track.\nLip-seal closures');
    expect(actions).toContain('on: "Burn", "my".');
    expect(actions).toContain('on: "fire", "voice".');
    expect(actions).toContain('Sustained vowel holds (within each timed word, preserve consonant closures');
    expect(actions).toContain('on: "Burn", "my", "voice".');
    expect(actions).toContain('Word 1.250s–1.700s: my');
    expect(actions).toContain('Word 0.750s–1.250s: Burn');
    expect(actions).toContain('Mouth Visibility Guard:');
    expect(actions).toContain('microphone head');
    expect(actions).toContain('strobe or hard flash soft');
    expect(actions).not.toContain('Single-Mouth Exclusivity Lock');
  });

  // Catches listeners mouthing along when identified by either sheet cast or timed intent.
  it('locks listeners from sheet cast or other action subjects and works without optional dramatic intent', () => {
    for (const shared of [
      { ...scene, shotSheet: { characters: ['Singer', 'Listener'] } },
      { ...scene, direction: { actionContract: { ...scene.direction.actionContract,
        reactions: [{ startSec: 0, endSec: 1, subject: 'Listener', description: 'Nods' }] } } },
      { ...scene, direction: undefined, shotSheet: { characters: ['Singer', 'Listener'] } },
    ]) {
      const input = musicVideoShotModelInput(project, shared, { hears: true });
      expect(input.prompt).toContain('Single-Mouth Exclusivity Lock: Only the active singer forms words');
      expect(input.prompt).toContain('never mouthing along or shadowing syllables');
      expect(input.prompt).not.toContain('undefined');
    }
  });

  // Catches still/silent/non-vocal prompts inheriting the new audible vocal instructions.
  it('excludes vocal guidance from stills, silent takes, music, cutaways, and empty lyric windows', () => {
    const inputs = [
      musicVideoFrameModelInput(project, scene),
      musicVideoShotModelInput(project, scene, { hears: false }),
      musicVideoShotModelInput(project, { ...scene, performanceStyle: 'music' }, { hears: true }),
      musicVideoShotModelInput(project, { ...scene, shotMode: 'cutaway' }, { hears: true }),
      musicVideoShotModelInput({ lyricCues: [{ text: 'untimed words' }] }, scene, { hears: true }),
      musicVideoShotModelInput({ lyricCues: [{ startSec: 12, endSec: 13, text: 'Next' }] }, scene, { hears: true }),
    ];
    for (const input of inputs) expect(input.prompt).not.toMatch(vocalGuidance);
    expect(inputs[1].prompt).not.toContain('Word ');
  });
});
