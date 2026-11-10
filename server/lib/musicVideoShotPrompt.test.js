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
describe('sheet-built stills', () => {
  const sheetProject = { ...project, cameras: [{ id: 'snap', name: 'Snapshot camera', kind: 'in-world' }, { id: 'eye', name: 'Observer', kind: 'observer' }] };
  const built = { ...scene, prompt: 'they laugh', framePrompt: 'red raincoat', shotSheet: { promptFromSheet: true, cameraId: 'snap', holder: 'Ada', view: 'Arm\u2019s-length selfie', location: 'Corner curb', timeOfDay: 'Dusk', light: 'Flash', characters: ['Ada', 'K'], action: 'They bump heads', emotion: 'Playful' } };
  // Catches the sheet's columns not reaching the still, arriving unlabeled, or out of reading order.
  it('composes the general prompt and each detail as its own labeled part', () => {
    const input = musicVideoFrameModelInput(sheetProject, built);
    expect(input.prompt.startsWith('red raincoat\nCamera: Snapshot camera, held by Ada.\nView: Arm\u2019s-length selfie.\nPlace and time: Corner curb, Dusk, lit by Flash.\nWho: Ada and K.\nAction: They bump heads.\nEmotion: Playful.')).toBe(true);
    expect(ids(input).slice(0, 6)).toEqual(['shot-sheet-camera', 'shot-sheet-view', 'shot-sheet-place', 'shot-sheet-who', 'shot-sheet-action', 'shot-sheet-emotion']);
  });
  // Catches an unsplit shot sending its sheet columns, or a sheet-built one borrowing the motion prompt.
  it('leaves other shots\' sheet columns alone and never falls back to the motion prompt', () => {
    const plain = { ...built, shotSheet: { ...built.shotSheet, promptFromSheet: undefined } };
    const input = musicVideoFrameModelInput(sheetProject, plain);
    expect(input.prompt).not.toContain('held by Ada');
    expect(input.prompt).not.toContain('View:');
    expect(input.prompt).toContain('Camera: Snapshot camera, an in-world camera.');
    const noGeneral = musicVideoFrameModelInput(sheetProject, { ...built, framePrompt: '' });
    expect(noGeneral.prompt.startsWith('Camera:')).toBe(true);
    expect(noGeneral.prompt).not.toContain('they laugh');
  });
  // Catches the details not reaching the clip, or a detail-built clip borrowing the still's general prompt.
  it('adds the same details to the clip after its motion text', () => {
    const clip = musicVideoShotModelInput(sheetProject, built, { asTyped: true });
    expect(clip.prompt.startsWith('they laugh\nCamera: Snapshot camera, held by Ada.')).toBe(true);
    expect(ids(clip)).toContain('shot-sheet-emotion');
    expect(authoredShotPrompt({ ...built, prompt: '' })).toBe('');
    const plain = musicVideoShotModelInput(sheetProject, { ...built, shotSheet: { ...built.shotSheet, promptFromSheet: undefined } }, { asTyped: true });
    expect(plain.prompt).not.toContain('held by Ada');
    expect(plain.prompt).toContain('Camera: Snapshot camera, an in-world camera.');
  });
  // Catches an observer camera reading as held, and the sheet columns leaking into an end frame.
  it('names an observer camera as unheld and keeps sheet columns off the end frame', () => {
    const observed = musicVideoFrameModelInput(sheetProject, { ...built, shotSheet: { promptFromSheet: true, cameraId: 'eye' } });
    expect(observed.prompt).toContain('Camera: Observer, an unseen observer camera that nobody in the scene holds.');
    const end = musicVideoFrameModelInput(sheetProject, built, { slot: 'end' });
    expect(end.prompt).not.toContain('View:');
    expect(end.prompt).toContain('Camera: Snapshot camera, an in-world camera.');
    expect(ids(end)).toContain('camera-rule');
  });
});

// Uniquely catches a shot's camera rule staying out of the frame, end frame and clip (#15586).
describe('shot camera rule', () => {
  const ruled = {
    cameras: [
      { id: 'snap', name: 'Snapshot camera', kind: 'in-world', owner: 'Ada', rule: 'Held at arm\'s length, facing back.' },
      { id: 'eye', name: 'Observer', kind: 'observer', rule: 'Subjects do not look at it.' },
    ],
  };
  const shot = { sceneId: 's9', framePrompt: 'Ada on the curb', prompt: 'Ada laughs', endFramePrompt: 'the curb empties', shotSheet: { cameraId: 'snap', holder: 'Ada' } };
  const cameraText = (input) => input.promptAdditions.find((item) => item.id === 'camera-rule')?.text;

  it('adds the camera block to the frame, end frame and clip, and follows a camera change', () => {
    const frame = musicVideoFrameModelInput(ruled, shot);
    const block = 'Camera: Snapshot camera, an in-world camera. This camera is the one taking the picture, so it is not in the frame. Held at arm\'s length, facing back.';
    expect(cameraText(frame)).toBe(block);
    expect(frame.prompt).toContain(block);
    expect(frame.prompt).toContain('Ada on the curb');
    const end = musicVideoFrameModelInput(ruled, shot, { slot: 'end' });
    expect(cameraText(end)).toBe(block);
    expect(end.prompt).toContain(block);
    const clip = musicVideoShotModelInput(ruled, shot, { asTyped: true });
    expect(cameraText(clip)).toBe(block);
    expect(clip.prompt).toContain(block);
    const observed = musicVideoFrameModelInput(ruled, { ...shot, shotSheet: { cameraId: 'eye' } });
    expect(cameraText(observed)).toBe('Camera: Observer, an observer camera. Subjects do not look at it.');
    expect(observed.prompt).toContain('Ada on the curb');
    expect(ids(musicVideoFrameModelInput(ruled, { ...shot, shotSheet: {} }))).not.toContain('camera-rule');
    expect(ids(musicVideoShotModelInput(ruled, { ...shot, shotSheet: null }, { asTyped: true }))).not.toContain('camera-rule');
  });

  // Catches a sheet-built shot listing two Camera chips, which the preview cannot tell apart.
  it('folds the rule into the sheet Camera line so the preview has one Camera chip', () => {
    const built = { ...shot, shotSheet: { promptFromSheet: true, cameraId: 'snap', holder: 'Ada' } };
    const frame = musicVideoFrameModelInput(ruled, built);
    const line = 'Camera: Snapshot camera, held by Ada. This camera is the one taking the picture, so it is not in the frame. Held at arm\'s length, facing back.';
    expect(frame.promptAdditions.find((item) => item.id === 'shot-sheet-camera')?.text).toBe(line);
    expect(frame.prompt).toContain(line);
    expect(ids(frame)).not.toContain('camera-rule');
    const clip = musicVideoShotModelInput(ruled, built, { asTyped: true });
    expect(clip.promptAdditions.find((item) => item.id === 'shot-sheet-camera')?.text).toBe(line);
    expect(ids(clip)).not.toContain('camera-rule');
    const end = musicVideoFrameModelInput(ruled, built, { slot: 'end' });
    expect(cameraText(end)).toBe('Camera: Snapshot camera, an in-world camera. This camera is the one taking the picture, so it is not in the frame. Held at arm\'s length, facing back.');
  });
});

describe('stale and contradictory direction clauses', () => {
  const clause = 'focal subject: Red umbrella; framing: close-up; keep the lower third of the frame clean, low-detail negative space for a separately composited title; subject left third';

  it('sends no direction clause after a sheet and prompt rewrite marks it stale', () => {
    const rewritten = {
      ...scene,
      prompt: 'an empty wide of a fence',
      shotSheet: { characters: ['Fence'], view: 'Wide' },
      direction: { stale: true, frameClause: clause, motionClause: 'keep the lower third of the frame clear throughout the move' },
    };
    const frame = musicVideoFrameModelInput(project, rewritten);
    const clip = musicVideoShotModelInput(project, rewritten);
    expect(frame.prompt).not.toContain('Red umbrella');
    expect(frame.prompt).not.toContain('lower third');
    expect(frame.prompt).not.toContain('negative space');
    expect(ids(frame)).not.toContain('frame-direction');
    expect(clip.prompt).not.toContain('lower third');
    expect(ids(clip)).not.toContain('shot-direction');
  });

  it('drops a type region when lyric overlay is off, and a focal or framing segment the sheet contradicts', () => {
    const overlayOff = musicVideoFrameModelInput(
      { ...project, lyricOverlayEnabled: false },
      { ...scene, direction: { frameClause: clause } },
    );
    expect(overlayOff.prompt).not.toContain('lower third');
    expect(overlayOff.prompt).toContain('subject left third');
    expect(ids(overlayOff)).toContain('frame-direction');
    const contradicted = musicVideoFrameModelInput(project, {
      ...scene,
      shotSheet: { characters: ['Fence'], view: 'Wide' },
      direction: { frameClause: clause },
    });
    expect(contradicted.prompt).not.toContain('Red umbrella');
    expect(contradicted.prompt).not.toContain('framing: close-up');
    expect(contradicted.prompt).toContain('subject left third');
  });
});

describe('musicVideoFrameModelInput', () => {
  it('composes a start frame from the director\'s text with each look block listed', () => {
    const input = musicVideoFrameModelInput(project, scene);
    expect(input.prompt.startsWith('harbor at dawn, grainy 16mm, ')).toBe(true);
    expect(input.prompt).toContain('character (protagonist): Example singer — Silver coat');
    expect(input.prompt).toContain('Universe style: Ink silhouettes');
    expect(input.prompt).toContain('color palette #112233; camera: locked-off wides');
    expect(input.prompt).not.toContain('condensed sans');
    expect(ids(input)).toEqual(['project-style', 'creative-context', 'visual-direction', 'frame-direction']);
    expect(input.prompt).toContain('subject left third');
    for (const item of input.promptAdditions) expect(input.prompt).toContain(item.text);
  });

  // Uniquely catches an amateur snapshot look rendering people studio-lit and pasted in.
  it('lets people be badly lit when the look is amateur snapshots or home video, and only then', () => {
    const snapshots = { ...project, concept: { ...project.concept, style: 'Found 1979 snapshots and VHS-C home video' } };
    const input = musicVideoFrameModelInput(snapshots, scene);
    expect(ids(input)).toContain('people-light');
    expect(input.prompt).toContain('Authentic amateur snapshot lighting');
    expect(ids(musicVideoFrameModelInput(project, scene))).not.toContain('people-light');
  });

  // Uniquely catches a panel-linked still losing the storyboard's action, picks or sketch role (Here to Dance, cold-open shot 1).
  it('leads a panel-linked still with the panel\'s action, shot picks and sketch, and names only its subjects', () => {
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
    expect(input.prompt).not.toContain('Example rink');
    expect(ids(input).slice(0, 3)).toEqual(['storyboard-action', 'storyboard-shot', 'storyboard-sketch']);
    for (const item of input.promptAdditions) expect(input.prompt).toContain(item.text);

    const authored = musicVideoFrameModelInput(cast, { sceneId: 's2', framePrompt: 'her own words' }, { panel });
    expect(authored.prompt.startsWith('her own words\nFraming: wide establishing shot.')).toBe(true);
    expect(ids(authored).slice(0, 2)).toEqual(['storyboard-shot', 'project-style']);
    expect(ids(musicVideoFrameModelInput(cast, scene, { panel, fromFrame: true }))).not.toContain('storyboard-shot');
  });

  // Uniquely catches a still rendered with no size cue, so a figure towers over a 4 ft fence and a 7 ft sign alike.
  it('states the shot subjects\' real-world sizes as their own chip, only for subjects in frame', () => {
    const cast = { ...project, concept: { ...project.concept, subjects: [
      { id: 'a', kind: 'character', name: 'Example Ada', ingredientId: 'cat-a', castForm: { id: 'form-12345678', label: 'Age 12', age: 12 } },
      { id: 'b', kind: 'character', name: 'Example Frank', ingredientId: 'cat-b' },
      { id: 'f', kind: 'place', name: 'Example fence line', ingredientId: 'cat-f' },
    ] } };
    const sizes = { a: 'about 4 ft 11 in (150 cm)', b: '6 ft 1 in', f: 'chain-link fence 4 ft tall; No Outlet sign 7 ft to its top' };
    const references = ['a', 'b', 'f'].map((id) => ({ id: `mvr-linked-${id}`, imageId: `${id}.png`, role: 'character', label: id, subjectId: id }));
    const input = musicVideoFrameModelInput(cast, scene, { sizes, references });
    const chip = input.promptAdditions.find((item) => item.id === 'real-world-scale');
    expect(chip.label).toBe('Real-world scale');
    expect(chip.text).toBe('Real-world sizes: keep every person, object and set feature in the frame at these true sizes against each other: Example Ada (age 12): about 4 ft 11 in (150 cm) tall; Example Frank: 6 ft 1 in tall; Example fence line: chain-link fence 4 ft tall; No Outlet sign 7 ft to its top.');
    expect(input.prompt).toContain(chip.text);
    const panel = { action: 'Ada climbs through', castIds: ['cat-a'], environmentIds: ['cat-f'] };
    const panelled = musicVideoFrameModelInput(cast, { sceneId: 's2' }, { panel, sizes });
    expect(panelled.promptAdditions.find((item) => item.id === 'real-world-scale').text).not.toContain('Example Frank');
    expect(ids(musicVideoFrameModelInput(cast, scene, { sizes: {}, references }))).not.toContain('real-world-scale');
  });

  // Uniquely catches a still describing every place and object in the video when the shot attaches none of them (an interior set showing up in a street shot).
  it('describes only the subjects the shot\'s references show or it picks, keeping unlinkable authored subjects', () => {
    const cast = { ...project, concept: { ...project.concept, subjects: [
      { id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' },
      { id: 'a', kind: 'character', name: 'Example Ada', ingredientId: 'cat-a', description: 'Red jacket' },
      { id: 'b', kind: 'character', name: 'Example Cal', ingredientId: 'cat-b', description: 'Striped shirt' },
      { id: 'm', kind: 'place', name: 'Example mall', ingredientId: 'cat-m', description: 'A dim two-level mall' },
      { id: 's', kind: 'place', name: 'Example street', ingredientId: 'cat-s', description: 'A suburban street' },
      { id: 'o', kind: 'object', name: 'Example bike', ingredientId: 'cat-o', description: 'A blue BMX' },
    ] } };
    const references = [null,
      { id: 'mvr-catalog-1', imageId: 'ada.png', role: 'character', label: 'Example Ada', catalogSubjectId: 'a' },
      { id: 'mvr-guide-cal.png', imageId: 'cal.png', role: 'character', label: 'Example Cal', castGuide: true, ingredientId: 'cat-b' },
      { id: 'mvr-panel-p1', imageId: 'panel.png', role: 'mood', label: 'Storyboard panel', panelArt: true }];
    const input = musicVideoFrameModelInput(cast, { sceneId: 's3', framePrompt: 'two kids on a street', setReference: { subjectId: 's' } }, { references });
    const bible = input.promptAdditions.find((item) => item.id === 'creative-context').text;
    for (const name of ['Example singer', 'Example Ada', 'Example Cal', 'Example street']) expect(bible).toContain(name);
    for (const name of ['Example mall', 'Example bike']) expect(bible).not.toContain(name);
    // A peer-routed render, whose send positions are unknown, still names the shot's subjects.
    const peer = musicVideoFrameModelInput(cast, { sceneId: 's3' }, { references: [], subjectReferences: [references[1]] });
    expect(peer.prompt).toContain('Example Ada');
    expect(peer.prompt).not.toContain('Example Cal');
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

// Uniquely catches a local clip prompt overflowing LTX-2's 1024-token text encoder with the production bible.
describe('local clip prompts', () => {
  const shot = { sceneId: 's1', startSec: 0, endSec: 4, prompt: 'a lantern swings' };

  it('leaves the production bible out of a local render that hears the song, and keeps it elsewhere', () => {
    const ids = (input) => input.promptAdditions.map((item) => item.id);
    expect(ids(musicVideoShotModelInput(project, shot, { hears: true, backend: 'local' }))).not.toContain('creative-context');
    expect(ids(musicVideoShotModelInput(project, shot, { hears: true, backend: 'local' }))).toContain('project-style');
    expect(ids(musicVideoShotModelInput(project, shot, { hears: true, backend: 'fal' }))).toContain('creative-context');
  });
});

// #15639: exercise the actual frame/clip input and visible additions rather
// than just a classifier, including precedence and authored-text preservation.
describe('framing-aware production bible additions', () => {
  const cast = { concept: { subjects: [{ id: 'lead', kind: 'character', name: 'Example Lead',
    description: 'face: freckles and detailed irises; hair: black braid; wardrobe: yellow coat' }] } };
  const authored = 'face: keep my exact freckles; wardrobe: my own words';
  const bible = (input) => input.promptAdditions.find((item) => item.id === 'creative-context')?.text;

  it('uses the sheet before direction for stills, end frames and audio-conditioned clips', () => {
    const shot = { framePrompt: authored, endFramePrompt: authored, prompt: authored,
      shotSheet: { view: 'Establishing wide shot' }, direction: { framing: 'close-up' } };
    const inputs = [musicVideoFrameModelInput(cast, shot), musicVideoFrameModelInput(cast, shot, { slot: 'end' }),
      musicVideoShotModelInput(cast, shot, { hears: true, backend: 'fal' })];
    for (const input of inputs) {
      expect(bible(input)).not.toContain('freckles');
      expect(bible(input)).toContain('hair: black braid; wardrobe: yellow coat');
      expect(bible(input)).toContain('Wide framing:');
      expect(input.prompt).toContain(authored);
      expect(input.prompt).toContain(bible(input));
    }
    expect(bible(musicVideoShotModelInput(cast, shot, { asTyped: true, hears: true }))).toBeUndefined();
    expect(bible(musicVideoShotModelInput(cast, shot, { hears: false }))).toBeUndefined();
    expect(bible(musicVideoShotModelInput(cast, shot, { hears: true, backend: 'local' }))).toBeUndefined();
  });

  it('falls back through direction and live panel shot size while preserving close and unknown framing', () => {
    const shot = { framePrompt: authored, shotSheet: { view: 'from behind' } };
    expect(bible(musicVideoFrameModelInput(cast, { ...shot, direction: { framing: 'wide' } }))).not.toContain('freckles');
    expect(bible(musicVideoFrameModelInput(cast, shot, { panel: { shotSize: 'wide' } }))).not.toContain('freckles');
    for (const framing of ['close-up', 'medium', 'unspecified']) {
      const input = musicVideoFrameModelInput(cast, { ...shot, direction: { framing } }, { panel: { shotSize: 'medium' } });
      expect(bible(input)).toContain('face: freckles and detailed irises');
      expect(bible(input)).not.toContain('Wide framing:');
    }
    expect(bible(musicVideoFrameModelInput(cast, shot, { panel: { shotSize: 'wide' }, fromFrame: true }))).toContain('freckles');
    expect(bible(musicVideoFrameModelInput(cast, shot))).toContain('freckles');
  });
});

// Catches clip-only physical guards missing from the sent prompt or its visible additions.
describe('clip motion guards', () => {
  const guardIds = ['continuation-handoff', 'performer-individuality', 'mouth-lock'];
  const continued = { ...scene, prompt: 'Ada turns toward K.', referenceImageId: 'handoff-clip-1000.png', shotSheet: { characters: ['Ada', 'K'] } };

  it('labels continuation, independent timing and silent mouths without rewriting authored text', () => {
    const input = musicVideoShotModelInput(null, continued);
    expect(ids(input)).toEqual(expect.arrayContaining(guardIds));
    expect(input.prompt.startsWith(continued.prompt)).toBe(true);
    for (const item of input.promptAdditions.filter((item) => guardIds.includes(item.id))) expect(input.prompt).toContain(item.text);
    for (const input of [musicVideoShotModelInput(null, continued, { asTyped: true }), musicVideoFrameModelInput(null, continued)]) {
      expect(ids(input).filter((id) => guardIds.includes(id))).toEqual([]);
    }
  });

  it('preserves deliberately coordinated choreography within the individuality guard', () => {
    const shot = { ...continued, shotMode: 'performance', prompt: 'Ada and K dance in synchronized steps.' };
    const input = musicVideoShotModelInput(null, shot);
    expect(input.prompt.startsWith(shot.prompt)).toBe(true);
    expect(input.promptAdditions.find((item) => item.id === 'performer-individuality')?.text)
      .toContain('while preserving explicitly directed coordinated action');
  });

  it('recognizes only the selected handoff take, including a continued still', () => {
    const take = { kind: 'image', assetId: 'previous-still.png', prompt: 'The picture the previous shot ends on' };
    const shot = { ...scene, referenceImageId: take.assetId, takes: [take] };
    expect(ids(musicVideoShotModelInput(null, shot))).toContain('continuation-handoff');
    expect(ids(musicVideoShotModelInput(null, { ...shot, takes: [{ ...take, prompt: 'Out-frame of the previous shot at 2s of its clip' }] }))).toContain('continuation-handoff');
    for (const referenceImageId of ['ordinary.png', undefined]) {
      expect(ids(musicVideoShotModelInput(null, { ...shot, referenceImageId }))).not.toContain('continuation-handoff');
    }
  });

  it('counts conditioned characters while leaving unselected cast out', () => {
    const cast = { concept: { subjects: [
      { id: 'a', kind: 'character', name: 'Ada' },
      { id: 'b', kind: 'character', name: 'K' },
      { id: 'unused', kind: 'character', ingredientId: 'offscreen', name: 'Other' },
    ] } };
    expect(ids(musicVideoShotModelInput(cast, scene))).toContain('performer-individuality');
    expect(ids(musicVideoShotModelInput({ concept: { subjects: cast.concept.subjects.slice(1) } }, scene))).not.toContain('performer-individuality');
    expect(ids(musicVideoShotModelInput(null, scene))).not.toContain('mouth-lock');
  });

  it('preserves vocals and deliberate speech and avoids duplicating the audio-reactive guard', () => {
    for (const [shot, options] of [
      [{ ...continued, shotMode: 'performance' }, {}],
      [{ ...continued, direction: { actionContract: { activeSpeaker: ' Ada ' } } }, {}],
      [continued, { audioReactive: true }],
    ]) expect(ids(musicVideoShotModelInput(null, shot, options))).not.toContain('mouth-lock');
    const music = { ...continued, shotMode: 'performance', performanceStyle: 'music' };
    expect(ids(musicVideoShotModelInput(null, music))).toContain('mouth-lock');
    const reactive = musicVideoShotModelInput(null, music, { audioReactive: true });
    expect(ids(reactive)).toContain('audio-reactive-guard');
    expect(ids(reactive)).not.toContain('mouth-lock');
  });
});
