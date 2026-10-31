import { describe, expect, it } from 'vitest';
import { musicVideoFrameModelInput, musicVideoShotModelInput } from './musicVideoShotPrompt.js';

const project = {
  concept: {
    style: 'grainy 16mm', universeStyle: 'Ink silhouettes', moodBoardStyle: 'Watercolor',
    subjects: [{ id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' }],
  },
  visualSpec: { palette: ['#112233'], cameraRules: 'locked-off wides', typography: 'condensed sans' },
};
const scene = { sceneId: 's1', startSec: 0, endSec: 4, framePrompt: 'harbor at dawn', endFramePrompt: 'the same frame as a pencil sketch', direction: { frameClause: 'subject left third' } };
const ids = (input) => input.promptAdditions.map((item) => item.id);

// Uniquely catches a still's prompt drifting from the chips it lists, or a block
// reaching a frame kind that should not carry it (#11317).
describe('musicVideoFrameModelInput', () => {
  it('composes a start frame from the director\'s text with each look block listed', () => {
    const input = musicVideoFrameModelInput(project, scene);
    expect(input.prompt.startsWith('harbor at dawn, grainy 16mm, ')).toBe(true);
    expect(input.prompt).toContain('character (protagonist): Example singer — Silver coat');
    expect(input.prompt).toContain('Universe style: Ink silhouettes');
    expect(input.prompt).toContain('color palette #112233; camera: locked-off wides');
    expect(input.prompt).not.toContain('condensed sans');
    expect(ids(input)).toEqual(['project-style', 'creative-context', 'visual-direction', 'frame-direction']);
    for (const item of input.promptAdditions) expect(input.prompt).toContain(item.text);
  });

  it('adds the rework line for a picked frame and the run\'s repair notes', () => {
    const input = musicVideoFrameModelInput(project, scene, { fromFrame: true, repairs: ['hand: six fingers', 'hand: six fingers'], fixes: 'too dark' });
    expect(input.prompt).toContain('\nStart from the first reference image and rework it to match this prompt.');
    expect(input.prompt.match(/six fingers/g)).toHaveLength(1);
    expect(ids(input).slice(-3)).toEqual(['rework-frame', 'plate-repairs', 'repair-notes']);
  });

  it('keeps an end frame rendered from the start frame to its own text plus the keep-the-shot line', () => {
    const fromStart = musicVideoFrameModelInput(project, scene, { slot: 'end', fromFrame: true });
    expect(fromStart.prompt).toBe('the same frame as a pencil sketch. Keep the reference image\'s composition, subject and framing; change only what this prompt describes.');
    expect(ids(fromStart)).toEqual(['keep-reference']);
    const fresh = musicVideoFrameModelInput(project, scene, { slot: 'end' });
    expect(fresh.prompt.startsWith('the same frame as a pencil sketch, grainy 16mm, ')).toBe(true);
    expect(ids(fresh)).toEqual(['project-style', 'creative-context', 'visual-direction']);
  });

  it('wraps a refine instruction and sends nothing else', () => {
    const input = musicVideoFrameModelInput(project, scene, { authored: 'remove the hand', refine: true });
    expect(input.prompt).toMatch(/^Edit the reference image: remove the hand\. Keep everything else exactly as it is/);
    expect(input.promptAdditions).toEqual([expect.objectContaining({ id: 'edit-instructions', text: expect.stringContaining('[instruction]') })]);
  });

  // Uniquely catches a refine or end frame that sends character references without saying what they are for.
  it('names the first image as the one to edit, and says what the shot\'s other references are for', () => {
    const refine = musicVideoFrameModelInput(project, scene, { authored: 'match his vest', refine: true, otherReferences: 2 });
    expect(refine.prompt).toMatch(/^Edit the first reference image: match his vest\./);
    expect(refine.prompt).toContain('The other reference images show the characters and places in this shot');
    expect(ids(refine)).toEqual(['edit-instructions', 'other-references']);
    const end = musicVideoFrameModelInput(project, scene, { slot: 'end', fromFrame: true, otherReferences: 1 });
    expect(ids(end)).toEqual(['keep-reference', 'other-references']);
    for (const input of [refine, end]) for (const item of input.promptAdditions.filter((a) => a.id === 'other-references')) expect(input.prompt).toContain(item.text);
  });

  it('still composes a planned start frame with no seeded text, and sends nothing for an empty end frame or refine', () => {
    expect(musicVideoFrameModelInput(project, { sceneId: 's2' }).prompt.startsWith('grainy 16mm, ')).toBe(true);
    expect(musicVideoFrameModelInput(project, { sceneId: 's2' }, { slot: 'end' })).toEqual({ prompt: '', promptAdditions: [] });
    expect(musicVideoFrameModelInput(project, scene, { authored: ' ', refine: true })).toEqual({ prompt: '', promptAdditions: [] });
    expect(musicVideoFrameModelInput(null, { sceneId: 's2' })).toEqual({ prompt: '', promptAdditions: [] });
  });
});

// Uniquely catches the medium's ban reaching a shot or frame as text the card does not list,
// or leaking into a project with no medium or a typed-as-is render (#14244).
describe('production medium chip', () => {
  const stepped = { ...project, productionMedium: 'stepped' };
  const graphic = { ...project, productionMedium: 'beat-graphic' };
  const shot = { sceneId: 's1', startSec: 0, endSec: 4, prompt: 'a lantern swings' };

  it('lists one production-medium chip on a clip and on a frame, and sends its text', () => {
    const clip = musicVideoShotModelInput(stepped, shot, { hears: false });
    const chip = clip.promptAdditions.find((item) => item.id === 'production-medium');
    expect(chip.text).toContain('no motion blur');
    expect(clip.prompt).toContain(chip.text);
    const frame = musicVideoFrameModelInput(graphic, scene);
    const lettering = frame.promptAdditions.find((item) => item.id === 'production-medium');
    expect(lettering.text).toContain('compositor');
    expect(frame.prompt).toContain(lettering.text);
  });

  it('adds nothing without a medium and nothing to a prompt sent as typed', () => {
    expect(musicVideoShotModelInput(project, shot).promptAdditions.map((item) => item.id)).not.toContain('production-medium');
    expect(musicVideoFrameModelInput(project, scene).promptAdditions.map((item) => item.id)).not.toContain('production-medium');
    expect(musicVideoShotModelInput(stepped, shot, { asTyped: true }).promptAdditions.map((item) => item.id)).not.toContain('production-medium');
  });
});
