import { describe, expect, it } from 'vitest';
import { musicVideoFrameModelInput } from './musicVideoShotPrompt.js';

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

  it('sends nothing for a still with no text', () => {
    expect(musicVideoFrameModelInput(project, { sceneId: 's2' })).toEqual({ prompt: '', promptAdditions: [] });
  });
});
