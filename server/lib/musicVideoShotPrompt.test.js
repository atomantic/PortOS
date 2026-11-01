import { describe, expect, it } from 'vitest';
import { authoredShotPrompt, musicVideoFrameModelInput, musicVideoShotModelInput } from './musicVideoShotPrompt.js';

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

  // Uniquely catches a panel-linked still losing the storyboard's action, picks or sketch role (Here to Dance, cold-open shot 1).
  it('leads a panel-linked still with the panel\'s action, shot picks and sketch, and names only its cast', () => {
    const cast = { ...project, concept: { ...project.concept, subjects: [
      { id: 'a', kind: 'character', name: 'Example Nora', ingredientId: 'cat-a' },
      { id: 'b', kind: 'character', name: 'Example Frank', ingredientId: 'cat-b' },
      { id: 'p', kind: 'place', name: 'Example rink', ingredientId: 'cat-p' },
    ] } };
    const panel = { action: 'Nora laces her skates alone', framing: 'wide', facing: 'front', camera: 'a loose wide shot', castIds: ['cat-a'], environmentIds: ['cat-other'] };
    const input = musicVideoFrameModelInput(cast, { sceneId: 's2' }, { panel, panelReference: 3 });
    expect(input.prompt.startsWith('Nora laces her skates alone\nFraming: wide establishing shot.\nSubject: front view')).toBe(true);
    expect(input.prompt).toContain('\nReference image 3 is the storyboard sketch for this shot: copy its camera angle, framing and where each person is');
    expect(input.prompt).not.toContain('a loose wide shot');
    expect(input.prompt).toContain('Example Nora');
    expect(input.prompt).not.toContain('Example Frank');
    expect(input.prompt).toContain('Example rink');
    expect(ids(input).slice(0, 3)).toEqual(['storyboard-action', 'storyboard-shot', 'storyboard-sketch']);
    for (const item of input.promptAdditions) expect(input.prompt).toContain(item.text);

    const authored = musicVideoFrameModelInput(cast, { sceneId: 's2', framePrompt: 'her own words' }, { panel });
    expect(authored.prompt.startsWith('her own words\nFraming: wide establishing shot.')).toBe(true);
    expect(ids(authored).slice(0, 2)).toEqual(['storyboard-shot', 'project-style']);
    expect(ids(musicVideoFrameModelInput(cast, scene, { panel, fromFrame: true }))).not.toContain('storyboard-shot');
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

// Uniquely catches the server's clip dispatch refusing a panel-linked shot with no typed prompt, or a planner's
// intent on an unlinked shot standing in for the director's text.
describe('authoredShotPrompt', () => {
  it('takes the shot\'s own prompt, then its storyboard panel\'s direction, then its frame prompt', () => {
    const linked = { panelId: 'p1', visualIntent: 'She laces her skates', framePrompt: 'rental booth' };
    expect(authoredShotPrompt({ ...linked, prompt: 'She stands up' })).toBe('She stands up');
    expect(authoredShotPrompt(linked)).toBe('She laces her skates');
    expect(authoredShotPrompt({ visualIntent: 'planner intent', framePrompt: 'rental booth' })).toBe('rental booth');
  });
});

// A composed still must identify each sent image without changing the director's notes
// or assuming the supplied references contain everyone in the shot.
describe('reference map', () => {
  const references = [
    { id: 'mvr-cs-character', imageId: 'lead.png', role: 'character', label: 'Example lead', note: 'short hair; blue coat' },
    null,
    { id: 'mvr-cs-cast-other', imageId: 'other.png', role: 'character', label: 'Example guest', note: 'long hair' },
    { id: 'mvr-cs-set-street', imageId: 'street.png', role: 'set', label: 'Example street' },
    { id: 'mvr-cs-props', imageId: 'props.png', role: 'prop', label: 'Props' },
  ];

  it('names each reference image by its send position, with the face text in full', () => {
    const input = musicVideoFrameModelInput(project, scene, { references });
    const text = input.promptAdditions.find((item) => item.id === 'reference-map').text;
    expect(text).toContain('Reference image 1 is Example lead: this exact person. Match their face, hair, skin, build and age exactly (short hair; blue coat)');
    expect(text).toContain('Reference image 3 is Example guest: this exact person.');
    expect(text).toContain('Reference image 4 is the set reference "Example street"');
    expect(text).toContain('Reference image 5 is the prop sheet');
    expect(text).not.toContain('Reference image 2');
    expect(text).not.toContain('add nobody else');
    expect(input.prompt).toContain(text);
    expect(ids(musicVideoFrameModelInput(project, scene, { references: [null, { role: 'mood', imageId: 'x.png' }] }))).not.toContain('reference-map');
  });

  it('preserves a long, multiline reference note in the listed and sent prompt', () => {
    const note = `${'An invented detail. '.repeat(35)}\nKeep  the spacing.`;
    const input = musicVideoFrameModelInput(project, scene, { references: [{ ...references[0], note }] });
    expect(ids(input)[0]).toBe('reference-map');
    const text = input.promptAdditions[0].text;
    expect(text).toContain(note);
    expect(input.prompt).toContain(text);
    expect(ids(musicVideoFrameModelInput(project, scene))).not.toContain('reference-map');
  });
});
