import { describe, expect, it } from 'vitest';
import { MOTION_CONTINUITY_CLAUSE, silentMotionPrompt } from './musicVideoMotion.js';
import { musicVideoCreativeContext } from './musicVideoCreativeContext.js';

// Regression: a silent i2v model acted out song cues and look words, and stripping must never erase the action itself.
describe('silentMotionPrompt', () => {
  it.each([
    ['Her head drops onto the pillow on "Sleep", film grain, 35mm Kodak', 'Her head drops onto the pillow'],
    ['She spins on the downbeat and the camera pushes in at 1:42.', 'She spins and the camera pushes in.'],
    ['Shot on 35mm film. She turns toward the window and smiles.', 'She turns toward the window and smiles.'],
    ['She wipes the camera lens and steps back.', 'She wipes the camera lens and steps back.'],
    ['Wind ripples the grain field as she runs through it.', 'Wind ripples the grain field as she runs through it.'],
    ['He walks to the bridge and hangs his coat on a hook.', 'He walks to the bridge and hangs his coat on a hook.'],
    ["She turns to 'face' the crowd.", "She turns to 'face' the crowd."],
    ['Camera pushes in on the downbeat as she turns.', 'Camera pushes in as she turns.'],
    ['Shallow depth of field', 'Shallow depth of field'],
  ])('%s', (input, expected) => {
    expect(silentMotionPrompt(input)).toBe(expected);
  });

  it('drops song-timed intent lines and the project look but keeps the generated contract and camera lines', () => {
    const prompt = ['She runs, grainy 35mm look', 'Camera movement: Push in — slow push', 'Speed: Slow; land the move exactly on the downbeat.',
      'Action 0.000s–1.000s: Singer — Offers a hand', 'Word 0.500s–1.500s: Stay', 'Musical onsets: 0.750s'].join('\n');
    expect(silentMotionPrompt(prompt, { styleParts: ['grainy 35mm look'] })).toBe(
      'She runs\nCamera movement: Push in — slow push\nSpeed: Slow.\nAction 0.000s–1.000s: Singer — Offers a hand');
  });

  // Regression: a board holding an older copy of the project sent its whole bible to Hailuo-02, which refused the 2,000+ character prompt.
  it('cuts a creative-context block the verbatim strip cannot match, up to the motion clause', () => {
    const subjects = (description) => [{ kind: 'character', role: 'lead', name: 'Example Lead', description },
      { kind: 'location', name: 'Example Diner', description: 'a chrome diner at night, neon in the window' }];
    const stale = musicVideoCreativeContext({ universeStyle: 'Example universe look', subjects: subjects('red jacket, short hair') }, { moodBoard: false });
    const current = musicVideoCreativeContext({ universeStyle: 'Example universe look', subjects: subjects('black sweater, short hair') }, { moodBoard: false });
    const prompt = [`She shakes her head, ${stale}; warm practical light, one slow beat, ${MOTION_CONTINUITY_CLAUSE}`, 'Camera: static'].join('\n');
    expect(silentMotionPrompt(prompt, { styleParts: [current], keep: ['one slow beat'] }))
      .toBe(`She shakes her head, one slow beat, ${MOTION_CONTINUITY_CLAUSE}\nCamera: static`);
  });
});
