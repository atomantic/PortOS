import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CastSetsStage from './stages/CastSetsStage.jsx';
import useMusicVideoCastAndSets from '../../hooks/useMusicVideoCastAndSets';
import { castAndSetsPreviewItems } from './CastAndSetsReferenceProgress.jsx';

const { listeners, api, getMediaJob, greyboxData } = vi.hoisted(() => ({
  listeners: new Map(),
  api: { getMusicVideoProject: vi.fn(), getMusicVideoCastAndSets: vi.fn(), startMusicVideoCastAndSets: vi.fn(), regenerateMusicVideoCastAndSets: vi.fn(), editMusicVideoCastAndSetsDirection: vi.fn(), resumeMusicVideoCastAndSets: vi.fn(), approveMusicVideoCastAndSets: vi.fn(), reconfirmMusicVideoCastAndSets: vi.fn(), revertMusicVideoProductionInput: vi.fn(), skipMusicVideoCastAndSets: vi.fn(), applyMusicVideoCastAndSetsFeedback: vi.fn(), removeMusicVideoCastAndSetsFeedback: vi.fn(), discardMusicVideoCastAndSets: vi.fn(), getMusicVideoCastAndSetsCastingChanges: vi.fn() },
  getMediaJob: vi.fn(),
  greyboxData: { places: {} },
}));
vi.mock('../../hooks/useMusicVideoGreyboxPlaces.js', () => ({ default: () => greyboxData.places }));
vi.mock('../../services/socket', () => ({ default: {
  on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
  off: (event, fn) => listeners.get(event)?.delete(fn),
} }));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({
  ...await importOriginal(),
  ...api,
}));
vi.mock('../../services/apiMediaJobs', () => ({ getMediaJob }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
// The Look step also holds the creative direction; it is covered by its own panels' tests.
vi.mock('./CreativeSetupPanel.jsx', () => ({ default: () => null }));
vi.mock('./LookReferencesPanel.jsx', () => ({ default: () => null }));
vi.mock('./VisualSpecPanel.jsx', () => ({ default: () => null }));
const DRAFTS = { conceptDraft: { value: '', onChange: () => {}, onBlur: () => {} }, styleDraft: { value: '', onChange: () => {}, onBlur: () => {} } };

const emit = async (event, data) => act(async () => { for (const fn of listeners.get(event) || []) fn(data); });
const plan = {
  character: { key: 'character', label: 'Keeper', prompt: 'Planned keeper portrait', deps: [], refKeys: [] },
  set: { key: 'set', label: 'Lamp room', prompt: 'Planned lamp room', deps: ['character'], refKeys: ['character'] },
  looks: { key: 'looks', label: 'Wardrobe', prompt: 'Planned wardrobe', deps: ['character'], refKeys: ['character'] },
};
const project = (images = {}, extra = {}) => ({ id: 'example-project', castAndSets: { revision: 1, status: 'imaging', plan, images, ...extra } });
const done = (filename, prompt) => ({ status: 'done', jobId: `job-${filename}`, imageId: filename, submittedPrompt: prompt, submittedRevision: 1, submittedReferences: [{ kind: 'image-ref', filename: 'mood.png' }] });
let selectProject;
function Harness({ initial, locked = true, openPreview = vi.fn() }) {
  const [value, setValue] = useState(initial);
  selectProject = setValue;
  const actions = useMusicVideoCastAndSets({ project: value, replaceProject: setValue });
  return <MemoryRouter initialEntries={['/music-video/example-project/cast-sets']}>
    <CastSetsStage board={{ project: value, locked, castSets: actions, kickoff: { running: locked }, devArtifacts: { busy: false }, openArtifact: vi.fn(), openPreview, approveCastAndSets: actions.approve, skipCastAndSets: actions.skip, ...DRAFTS }} />
  </MemoryRouter>;
}
const stage = (next) => emit('music-video:cast-and-sets', { projectId: next.id, project: next });
const card = (name) => within(screen.getByRole('article', { name }));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  getMediaJob.mockResolvedValue({ status: 'queued' });
  greyboxData.places = {};
  api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: null });
  api.getMusicVideoProject.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('optional greybox references on Look', () => {
  const sets = [{ id: 'lab', name: 'Lamp room' }, { id: 'harbor', name: 'Harbor' }];
  const review = (concept, extra = {}) => ({ id: 'example-project', concept, castAndSets: {
    revision: 1, status: 'review', direction: { sets }, plan: {}, images: {}, ...extra,
  } });

  it('leaves approval available and shows no empty set headings when nothing is linked', async () => {
    render(<Harness initial={review({ subjects: [] })} locked={false} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
    expect(screen.queryByText(/Set plate ·/)).toBeNull();
    expect(screen.queryByText(/Greybox references/)).toBeNull();
  });

  it('keeps mixed environments optional and gates approval only after choosing a camera', async () => {
    const subjects = [
      { id: 'lab-place', kind: 'place', ingredientId: 'cat-lab', name: 'Lamp room' },
      { id: 'harbor-place', kind: 'place', ingredientId: 'cat-harbor', name: 'Harbor' },
    ];
    greyboxData.places = {
      'cat-lab': { ingredient: { type: 'place', payload: { greybox: { shots: [{ id: 'wide', label: 'Wide' }] } } }, media: [{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }] },
      'cat-harbor': { ingredient: { type: 'place', payload: {} }, media: [] },
    };
    let value = review({ subjects }, { direction: { sets: [{ ...sets[0], setReference: { subjectId: 'harbor-place' } }, sets[1]] }, greyboxPending: true });
    api.editMusicVideoCastAndSetsDirection.mockImplementation(async (_id, { sets: updates }) => {
      const direction = { ...value.castAndSets.direction, sets: value.castAndSets.direction.sets.map((set) => set.id === updates[0].id ? { ...set, setReference: updates[0].setReference } : set) };
      const greyboxPending = direction.sets.some((set) => set.setReference?.greyboxShotId);
      value = { ...value, castAndSets: { ...value.castAndSets, direction, greyboxPending } };
      return { project: value, stage: value.castAndSets };
    });
    render(<Harness initial={value} locked={false} />);
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
    expect(screen.queryByText(/Regenerate to render the set plates/)).toBeNull();
    const disclosure = screen.getByText('Greybox references (optional)').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Greybox references (optional)'));
    const lab = within(screen.getByText('Set plate · Lamp room').parentElement);
    await act(async () => { fireEvent.change(lab.getByRole('combobox', { name: 'Set' }), { target: { value: 'lab-place' } }); });
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
    await act(async () => { fireEvent.change(lab.getByRole('combobox', { name: 'Camera shot' }), { target: { value: 'wide' } }); });
    expect(screen.getByRole('button', { name: 'Approve & continue' })).toBeDisabled();
    expect(screen.getByText(/Regenerate to render the set plates/)).toBeInTheDocument();
    await act(async () => { fireEvent.change(lab.getByRole('combobox', { name: 'Set' }), { target: { value: '' } }); });
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
  });

  it('resolves an older mixed-environment flag using the camera actually sent to the plate', async () => {
    const subjects = [{ id: 'lab-place', kind: 'place', ingredientId: 'cat-lab', name: 'Lamp room' }];
    const setReference = { subjectId: 'lab-place', greyboxShotId: 'wide' };
    const entry = { ingredient: { type: 'place', payload: { greybox: { shots: [{ id: 'wide', label: 'Wide' }] } } }, media: [{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }] };
    greyboxData.places = { 'cat-lab': entry };
    const initial = review({ subjects }, { direction: { sets: [{ ...sets[0], setReference }, { ...sets[1], setReference: { subjectId: 'other-place' } }] },
      plan: { 'set:lab': { key: 'set:lab', prompt: 'Empty lamp room', setReference, refImages: ['layout.png'] } }, greyboxPending: true,
      images: { 'set:lab': { status: 'done', imageId: 'lamp-room.png', submittedRevision: 1, inspection: { verdict: 'pass', inputs: {
        key: 'set:lab', imageId: 'lamp-room.png', imageRevision: 1, jobId: null, planPrompt: 'Empty lamp room', submittedPrompt: null,
      } } } } });
    render(<Harness initial={initial} locked={false} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
    greyboxData.places = { 'cat-lab': { ...entry, media: [{ ...entry.media[0], mediaKey: 'new-layout.png' }] } };
    await act(async () => selectProject({ ...initial }));
    expect(screen.getByRole('button', { name: 'Approve & continue' })).toBeDisabled();
    greyboxData.places = {};
    const afterEdit = { ...initial, castAndSets: { ...initial.castAndSets, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: ['lab'] } };
    await act(async () => selectProject(afterEdit));
    expect(screen.getByRole('button', { name: 'Approve & continue' })).toBeDisabled();
    greyboxData.places = { 'cat-lab': entry };
    await act(async () => selectProject({ ...afterEdit }));
    expect(screen.getByRole('button', { name: 'Approve & continue' })).not.toBeDisabled();
  });
});

describe('Cast & Sets incremental references', () => {
  it('shows plan, completion, failure and regeneration from sockets while prompts and images remain inspectable', async () => {
    const view = render(<Harness initial={project()} />);
    expect(card('Keeper').getByText('Planned prompt')).not.toBeDisabled();
    expect(screen.getByRole('article', { name: 'Keeper' }).closest('fieldset[disabled]')).toBeNull();
    expect(card('Keeper').getByText('Planned keeper portrait')).toBeInTheDocument();
    expect(card('Lamp room').getByText('Waiting for Keeper')).toBeInTheDocument();

    const character = done('keeper.png', 'Submitted keeper portrait with silver grain');
    const partial = project({ character, set: { status: 'queued', jobId: 'set-job' }, looks: { status: 'pending' } });
    await stage(partial);
    expect(card('Keeper').getByRole('img', { name: 'Keeper — generated reference' })).toHaveAttribute('src', '/data/images/keeper.png');
    expect(card('Keeper').getByText(character.submittedPrompt)).toBeInTheDocument();
    expect(card('Keeper').getByRole('img', { name: 'Keeper input: mood.png' })).toHaveAttribute('src', '/data/image-refs/mood.png');
    expect(getMediaJob).toHaveBeenCalledWith('set-job');
    expect(getMediaJob).not.toHaveBeenCalledWith(character.jobId);
    const progressImage = 'data:image/png;base64,ZXhhbXBsZQ==';
    await emit('image-gen:progress', { generationId: 'set-job', progress: 0.5, message: 'Drawing room', currentImage: progressImage });
    expect(card('Lamp room').getByText('Rendering')).toBeInTheDocument();
    expect(card('Lamp room').getByRole('progressbar')).toHaveAttribute('value', '0.5');
    expect(card('Lamp room').getByRole('img', { name: 'Lamp room — in-progress render' })).toHaveAttribute('src', progressImage);

    const room = done('room.png', 'Submitted room prompt');
    await stage(project({ character, set: room, looks: { status: 'queued', jobId: 'looks-job' } }));
    expect(card('Lamp room').getByRole('img', { name: 'Lamp room — generated reference' })).toHaveAttribute('src', '/data/images/room.png');
    await emit('image-gen:failed', { generationId: 'looks-job', error: 'Example render failure' });
    expect(card('Wardrobe').getByText('Failed')).toBeInTheDocument();
    expect(card('Wardrobe').getByText('Example render failure')).toBeInTheDocument();

    await stage(project({ character: { status: 'queued', jobId: 'new-character', imageId: 'keeper.png' }, set: room, looks: { status: 'pending' } }, { revision: 2 }));
    expect(card('Keeper').getByRole('img', { name: 'Keeper — previous revision' })).toHaveAttribute('src', '/data/images/keeper.png');
    expect(card('Keeper').getByText('Previous revision — replacement pending')).toBeInTheDocument();
    expect(card('Lamp room').getByText('Retained from revision 1')).toBeInTheDocument();
    await emit('image-gen:completed', { generationId: 'set-job', filename: 'obsolete.png' });
    expect(card('Keeper').queryByRole('img', { name: 'Keeper — generated reference' })).not.toBeInTheDocument();
    await emit('image-gen:completed', { generationId: 'new-character' });
    expect(card('Keeper').getByRole('img', { name: 'Keeper — previous revision' })).toHaveAttribute('src', '/data/images/keeper.png');
    const reloaded = project({ character: { ...done('keeper-new.png', 'New submitted prompt'), submittedRevision: 2 }, set: room }, { revision: 2, interrupted: true });
    await stage(reloaded);
    view.unmount();
    getMediaJob.mockClear();
    const openPreview = vi.fn();
    render(<Harness initial={reloaded} openPreview={openPreview} />);
    expect(card('Keeper').getByText('New submitted prompt')).toBeInTheDocument();
    // Taps open the page lightbox, never the raw file (a Home Screen app has no back from that).
    expect(card('Keeper').queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(card('Keeper').getByRole('button', { name: 'Preview Keeper' }));
    fireEvent.click(card('Keeper').getByRole('button', { name: 'Keeper input: mood.png' }));
    expect(openPreview.mock.calls).toEqual([['image:keeper-new.png'], ['image-ref:mood.png']]);
    const items = castAndSetsPreviewItems(reloaded.castAndSets);
    expect(items.find((i) => i.key === 'image:keeper-new.png')).toMatchObject({ previewUrl: '/data/images/keeper-new.png', prompt: 'New submitted prompt' });
    expect(items.find((i) => i.key === 'image-ref:mood.png')).toMatchObject({ previewUrl: '/data/image-refs/mood.png' });
    expect(card('Wardrobe').getByText('Interrupted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(getMediaJob).not.toHaveBeenCalled();
  });

  it('refreshes once on reconnect or tab return and ignores reads superseded by sockets or a project switch', async () => {
    const first = deferred();
    api.getMusicVideoProject.mockReturnValueOnce(first.promise);
    const view = render(<Harness initial={project()} />);
    await emit('connect');
    await emit('connect');
    expect(api.getMusicVideoProject).toHaveBeenCalledTimes(1);
    await stage(project({ character: done('latest.png', 'Newest prompt') }));
    await act(async () => first.resolve(project()));
    expect(card('Keeper').getByText('Newest prompt')).toBeInTheDocument();

    const second = deferred();
    api.getMusicVideoProject.mockReturnValueOnce(second.promise);
    let visibility = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    fireEvent(document, new Event('visibilitychange'));
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(document, new Event('visibilitychange'));
    expect(api.getMusicVideoProject).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(project({ looks: { status: 'failed', error: 'Missed failure' } }, { status: 'failed' })));
    expect(card('Wardrobe').getByText('Missed failure')).toBeInTheDocument();

    const stale = deferred();
    api.getMusicVideoProject.mockReturnValueOnce(stale.promise);
    await emit('connect');
    await act(async () => selectProject({ id: 'another-project', castAndSets: { revision: 1, status: 'imaging', plan: { other: { key: 'other', label: 'Other cast', prompt: 'Other plan' } }, images: {} } }));
    await act(async () => stale.resolve(project({ character: done('stale.png', 'Stale prompt') })));
    expect(screen.queryByText('Stale prompt')).not.toBeInTheDocument();
    expect(card('Other cast').getByText('Other plan')).toBeInTheDocument();
    view.unmount();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe('Cast & Sets direction editing', () => {
  const direction = (medium) => ({
    ...(medium ? { medium } : {}),
    protagonist: { name: 'Boat', description: 'a paper boat', construction: 'three folds', palette: '#f5f0e6', movement: 'bobs', expressions: ['proud: bow lifts'] },
    world: { layout: 'a river', camera: 'slow dolly' },
    sets: [{ id: 'river', name: 'River', description: 'a neon river', imageRole: 'background' }, { id: 'quay', name: 'Quay', description: 'wet stone', imageRole: 'texture' }],
  });
  const review = (dir, extra = {}) => ({ id: 'example-project', castAndSets: { revision: 1, status: 'review', plan: {}, images: {}, direction: dir, ...extra } });

  it('offers the editor only for a procedural direction waiting in review', async () => {
    const view = render(<Harness initial={review(direction())} locked={false} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Edit direction/ })).toBeNull();
    view.unmount();
    render(<Harness initial={review(direction('procedural'), { status: 'approved' })} locked={false} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Edit direction/ })).toBeNull();
  });

  it('sends only the changed fields, applies the saved project, and keeps the edit across the revision', async () => {
    api.editMusicVideoCastAndSetsDirection.mockImplementation(async (_id, body) => ({ project: review({
      ...direction('procedural'),
      protagonist: { ...direction().protagonist, palette: body.protagonist.palette },
      sets: direction().sets.map((s) => ({ ...s, imageRole: body.sets?.find((x) => x.id === s.id)?.imageRole || s.imageRole })),
    }, { revision: 2, status: 'imaging' }) }));
    render(<Harness initial={review(direction('procedural'))} locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit direction/ }));
    const save = screen.getByRole('button', { name: /Save direction/ });
    expect(save).toBeDisabled();
    expect(screen.getByLabelText('Construction').value).toBe('three folds');
    expect(screen.getByLabelText('Expressions (one per line)').value).toBe('proud: bow lifts');

    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: '#112233, #ddeeff' } });
    fireEvent.change(screen.getByLabelText('Image role · Quay'), { target: { value: 'cutout' } });
    expect(save).not.toBeDisabled();
    await act(async () => { fireEvent.click(save); });

    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenCalledWith('example-project', {
      protagonist: { palette: '#112233, #ddeeff' },
      sets: [{ id: 'quay', imageRole: 'cutout' }],
    }, { silent: true });
    // The saved revision replaces the sheet's state; the editor closes and the stage shows the new revision.
    expect(screen.getByText('revision 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save direction/ })).toBeNull();
  });

  it('keeps the draft open when the save fails', async () => {
    api.editMusicVideoCastAndSetsDirection.mockRejectedValue(new Error('Nothing changed'));
    render(<Harness initial={review(direction('procedural'))} locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit direction/ }));
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'locked off' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save direction/ })); });
    expect(screen.getByLabelText('Camera').value).toBe('locked off');
  });
});

describe('Cast & Sets per-image actions', () => {
  const photoPlan = {
    character: { key: 'character', kind: 'character', label: 'June', prompt: 'June portrait', deps: [], refKeys: [] },
    expressions: { key: 'expressions', kind: 'expressions', label: 'June · moods', prompt: 'moods', deps: ['character'], refKeys: ['character'] },
    'cast:dad': { key: 'cast:dad', kind: 'cast', castId: 'dad', label: 'Dad', prompt: 'Dad portrait', deps: [], refKeys: [] },
  };
  const direction = { protagonist: { name: 'June', description: 'a girl', expressions: ['eyes closed, looking down'], forms: [] },
    cast: [{ id: 'dad', name: 'Dad', role: 'father', description: 'tall' }], sets: [], tests: [] };
  const sheet = (status, extra = {}) => ({ id: 'example-project', castAndSets: { revision: 1, status, plan: photoPlan, images: {}, direction, ...extra } });

  it('edits moods, removes a cast member and re-renders one image from its card', async () => {
    api.regenerateMusicVideoCastAndSets.mockResolvedValue({ project: sheet('imaging', { revision: 2 }) });
    api.editMusicVideoCastAndSetsDirection.mockResolvedValue({ project: sheet('review', { revision: 2 }) });
    render(<Harness initial={sheet('review')} locked={false} />);
    fireEvent.click(card('June · moods').getByRole('button', { name: 'Edit June · moods' }));
    const moods = card('June · moods').getByLabelText(/One mood per line/);
    expect(moods.value).toBe('eyes closed, looking down');
    fireEvent.change(moods, { target: { value: 'eyes closed, looking down\ncarefree, eyes closed' } });
    await act(async () => { fireEvent.click(card('June · moods').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project',
      { protagonist: { expressions: ['eyes closed, looking down', 'carefree, eyes closed'] } }, { silent: true });

    fireEvent.click(card('Dad').getByRole('button', { name: 'Remove Dad' }));
    await act(async () => { fireEvent.click(card('Dad').getByRole('button', { name: 'Remove Dad from the sheet' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project', { cast: [{ id: 'dad', remove: true }] }, { silent: true });

    await act(async () => { fireEvent.click(card('Dad').getByRole('button', { name: 'Regenerate Dad' })); });
    expect(api.regenerateMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { keys: ['cast:dad'] }, { silent: true });
  });

  it('edits structured wardrobe sections and exposes automatic test controls', async () => {
    const photoDirection = { ...direction, looks: [{ name: 'Rain', description: 'coat', chapters: 'chorus' }] };
    const plan = { ...photoPlan,
      looks: { key: 'looks', kind: 'looks', label: 'Wardrobe', prompt: 'looks', deps: [], refKeys: [] },
      'test:1': { key: 'test:1', kind: 'test', testIndex: 0, label: 'Automatic frame', test: { action: 'walk', caption: 'bridge' }, prompt: 'test', deps: [], refKeys: [] },
    };
    api.editMusicVideoCastAndSetsDirection.mockResolvedValue({ project: sheet('review', { revision: 2, direction: photoDirection, plan }) });
    render(<Harness initial={sheet('review', { direction: photoDirection, plan })} locked={false} />);
    fireEvent.click(card('Wardrobe').getByRole('button', { name: 'Edit Wardrobe' }));
    fireEvent.change(card('Wardrobe').getByLabelText('Song sections'), { target: { value: 'chorus, bridge' } });
    await act(async () => { fireEvent.click(card('Wardrobe').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project', { looks: [{ name: 'Rain', description: 'coat', chapters: 'chorus, bridge', originalName: 'Rain' }] }, { silent: true });
    fireEvent.click(card('Automatic frame').getByRole('button', { name: 'Edit Automatic frame' }));
    expect(card('Automatic frame').getByLabelText('What happens in the frame').value).toBe('walk');
    fireEvent.change(card('Automatic frame').getByLabelText('Caption'), { target: { value: 'outro' } });
    await act(async () => { fireEvent.click(card('Automatic frame').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project', { tests: [{ index: 1, caption: 'outro' }] }, { silent: true });
    expect(card('Automatic frame').getByRole('button', { name: 'Remove Automatic frame' })).toBeInTheDocument();
  });

  it('binds an age to a catalog-linked character and a test to that age', async () => {
    const age = { id: 'age-7', label: 'Age 7', age: '7', description: 'small', height: '', hair: '', wardrobe: '', era: '', look: '' };
    const agedDirection = { ...direction, protagonist: { ...direction.protagonist, forms: [age] } };
    const plan = { ...photoPlan,
      'form:age-7': { key: 'form:age-7', kind: 'form', formId: 'age-7', label: 'June · Age 7', prompt: 'young', deps: ['character'], refKeys: ['character'], subjectId: 'gone', bindingMissing: 'subject' },
      'test:1': { key: 'test:1', kind: 'test', testIndex: 0, label: 'Memory', test: { action: 'skip stones', caption: 'memory' }, prompt: 'test', deps: [], refKeys: [] },
    };
    const linked = { ...sheet('review', { direction: agedDirection, plan }), concept: { subjects: [
      { id: 'mvc-child', kind: 'character', name: 'June (Age 7)', ingredientId: 'cat-1', castForm: { id: 'age-7', label: 'Age 7' } },
      { id: 'mvc-local', kind: 'character', name: 'Stranger' },
      { id: 'cs-protagonist', kind: 'character', name: 'June', ingredientId: 'cat-2' },
    ] } };
    api.editMusicVideoCastAndSetsDirection.mockResolvedValue({ project: linked });
    render(<Harness initial={linked} locked={false} />);
    expect(card('June · Age 7').getByText(/no longer cast in this video/)).toBeInTheDocument();
    expect(card('June · Age 7').queryByRole('link', { name: 'Revise look' })).toBeNull();
    fireEvent.click(card('June · Age 7').getByRole('button', { name: 'Edit June · Age 7' }));
    const subject = card('June · Age 7').getByLabelText('Catalog reference for this age');
    expect([...subject.options].map((o) => o.value)).toEqual(['', 'mvc-child']);
    fireEvent.change(subject, { target: { value: 'mvc-child' } });
    await act(async () => { fireEvent.click(card('June · Age 7').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project',
      { protagonist: { forms: [{ ...age, id: 'age-7', subjectId: 'mvc-child' }] } }, { silent: true });
    fireEvent.click(card('Memory').getByRole('button', { name: 'Edit Memory' }));
    fireEvent.change(card('Memory').getByLabelText('Age shown'), { target: { value: 'age-7' } });
    await act(async () => { fireEvent.click(card('Memory').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project', { tests: [{ index: 1, formId: 'age-7' }] }, { silent: true });
  });

  it('loads a matching legacy test before editing and can clear its caption', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const withTest = sheet('review', { plan: { 'test:1': legacy } });
    api.getMusicVideoCastAndSets.mockResolvedValue({ stage: { revision: 1, plan: { 'test:1': { ...legacy, test: { action: 'walking the quay', caption: 'the opener' } } } } });
    api.editMusicVideoCastAndSetsDirection.mockResolvedValue({ project: withTest });
    render(<Harness initial={withTest} locked={false} />);
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(api.getMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { silent: true });
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('walking the quay');
    expect(card('Harbor').getByLabelText('Caption').value).toBe('the opener');
    fireEvent.change(card('Harbor').getByLabelText('Caption'), { target: { value: '' } });
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenLastCalledWith('example-project', { tests: [{ index: 1, caption: '' }] }, { silent: true });
  });

  it('does not open a legacy test editor when the saved plan cannot be verified', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    api.getMusicVideoCastAndSets.mockResolvedValue({ stage: { revision: 1, plan: { 'test:1': legacy } } });
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(card('Harbor').queryByLabelText('What happens in the frame')).not.toBeInTheDocument();
    expect(card('Harbor').getByText(/Rebuild the check-in before editing/)).toBeInTheDocument();
  });

  it('refreshes a missed stage update before retrying a stale legacy card', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const newer = { ...legacy, prompt: 'new prompt', test: { action: 'new action', caption: 'new caption' } };
    const updated = sheet('review', { revision: 2, plan: { 'test:1': newer } });
    api.getMusicVideoCastAndSets.mockResolvedValueOnce({ stage: updated.castAndSets });
    api.getMusicVideoProject.mockResolvedValueOnce(updated);
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(api.getMusicVideoProject).toHaveBeenCalledWith('example-project', { silent: true });
    expect(card('Harbor').getByText('new prompt')).toBeInTheDocument();
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('new action');
  });

  it('keeps a newer socket stage when a stale card refresh finishes later', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const makeStage = (revision) => sheet('review', { revision, plan: { 'test:1': { ...legacy, prompt: `prompt ${revision}`, test: { action: `action ${revision}` } } } });
    const pending = deferred();
    api.getMusicVideoCastAndSets.mockResolvedValueOnce({ stage: makeStage(2).castAndSets });
    api.getMusicVideoProject.mockReturnValueOnce(pending.promise);
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(api.getMusicVideoProject).toHaveBeenCalledTimes(1);
    await stage(makeStage(3));
    await act(async () => { pending.resolve(makeStage(2)); });
    expect(card('Harbor').getByText('prompt 3')).toBeInTheDocument();
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('action 3');
  });

  it('starts a fresh project read after finding a newer card and ignores an earlier read at the same revision', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const initial = sheet('review', { revision: 2, plan: { 'test:1': legacy } });
    const updated = sheet('review', { revision: 2, plan: { 'test:1': { ...legacy, prompt: 'new prompt', test: { action: 'new action' } } } });
    const pending = deferred();
    api.getMusicVideoProject.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(updated);
    api.getMusicVideoCastAndSets.mockResolvedValue({ stage: updated.castAndSets });
    render(<Harness initial={initial} locked={false} />);
    await emit('connect');
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(api.getMusicVideoProject).toHaveBeenCalledTimes(2);
    expect(card('Harbor').getByText('new prompt')).toBeInTheDocument();
    await act(async () => { pending.resolve(initial); });
    expect(card('Harbor').getByText('new prompt')).toBeInTheDocument();
  });

  it('explains when a stale card cannot refresh automatically', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    api.getMusicVideoCastAndSets.mockResolvedValueOnce({ stage: { revision: 2, plan: { 'test:1': legacy } } });
    api.getMusicVideoProject.mockRejectedValueOnce(new Error('offline'));
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    await act(async () => { fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' })); });
    expect(card('Harbor').getByText(/Refresh the project and try editing/)).toBeInTheDocument();
    expect(card('Harbor').getByRole('button', { name: 'Edit Harbor' })).toBeEnabled();
  });

  it('ignores a legacy test read superseded by a newer stage', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const pending = deferred();
    api.getMusicVideoCastAndSets.mockReturnValue(pending.promise);
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    await stage(sheet('review', { revision: 2, plan: { 'test:1': { ...legacy, prompt: 'new prompt', test: { action: 'new action', caption: 'new caption' } } } }));
    expect(card('Harbor').getByRole('button', { name: 'Edit Harbor' })).toBeEnabled();
    expect(card('Harbor').getByRole('button', { name: 'Regenerate Harbor' })).toBeEnabled();
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('new action');
    await act(async () => { pending.resolve({ stage: { revision: 1, plan: { 'test:1': { ...legacy, test: { action: 'old action' } } } } }); });
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('new action');
    expect(card('Harbor').queryByText(/This test changed/)).not.toBeInTheDocument();
  });

  it('does not let an old legacy read clear a newer pending read', async () => {
    const legacy = { key: 'test:1', kind: 'test', testIndex: 0, setId: 'harbor', label: 'Harbor', prompt: 'saved prompt', deps: [], refKeys: [] };
    const first = deferred();
    const second = deferred();
    api.getMusicVideoCastAndSets.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness initial={sheet('review', { plan: { 'test:1': legacy } })} locked={false} />);
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    const newer = { ...legacy, prompt: 'new prompt' };
    await stage(sheet('review', { revision: 2, plan: { 'test:1': newer } }));
    fireEvent.click(card('Harbor').getByRole('button', { name: 'Edit Harbor' }));
    await act(async () => { first.resolve({ stage: { revision: 1, plan: { 'test:1': { ...legacy, test: { action: 'old action' } } } } }); });
    expect(card('Harbor').getByRole('button', { name: 'Edit Harbor' })).toBeDisabled();
    expect(card('Harbor').queryByLabelText('What happens in the frame')).not.toBeInTheDocument();
    await act(async () => { second.resolve({ stage: { revision: 2, plan: { 'test:1': { ...newer, test: { action: 'new action' } } } } }); });
    expect(card('Harbor').getByLabelText('What happens in the frame').value).toBe('new action');
  });

  it('adds another age to the protagonist', async () => {
    api.editMusicVideoCastAndSetsDirection.mockResolvedValue({ project: sheet('review', { revision: 2 }) });
    render(<Harness initial={sheet('failed')} locked={false} />);
    fireEvent.click(card('June').getByRole('button', { name: 'Add another age' }));
    fireEvent.change(card('June').getByLabelText('Label'), { target: { value: 'Teen' } });
    fireEvent.change(card('June').getByLabelText('Age'), { target: { value: '17' } });
    fireEvent.change(card('June').getByLabelText('How they look at that age'), { target: { value: 'lanky, braces' } });
    fireEvent.change(card('June').getByLabelText('Height at that age'), { target: { value: '5 ft 4 in' } });
    await act(async () => { fireEvent.click(card('June').getByRole('button', { name: 'Save and re-render' })); });
    expect(api.editMusicVideoCastAndSetsDirection).toHaveBeenCalledWith('example-project',
      { protagonist: { forms: [{ label: 'Teen', age: '17', description: 'lanky, braces', height: '5 ft 4 in', hair: '', wardrobe: '', era: '', look: '' }] } }, { silent: true });
  });

  it('says a sheet in review predates the story and rebuilds it from the story in one tap', async () => {
    api.discardMusicVideoCastAndSets.mockResolvedValue({ project: { id: 'example-project' } });
    api.startMusicVideoCastAndSets.mockResolvedValue({ project: sheet('directing', { revision: 2 }) });
    const Page = () => {
      const [value, setValue] = useState(sheet('review'));
      const actions = useMusicVideoCastAndSets({ project: value, replaceProject: setValue });
      return <CastSetsStage board={{ project: value, locked: false, castSets: actions, kickoff: { running: false }, devArtifacts: { busy: false }, openArtifact: vi.fn(),
        productionReadiness: { castAndSets: { approved: false, stale: null, storyStale: { changedFields: ['story', 'cast guide'] } } }, approveCastAndSets: actions.approve, skipCastAndSets: actions.skip, ...DRAFTS }} />;
    };
    render(<Page />);
    expect(screen.getByText(/Built before your latest story, cast guide/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Rebuild from story/ })); });
    expect(api.discardMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { silent: true });
    expect(api.startMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', {}, { silent: true });
    // While the new direction is written, the banner gives way to progress.
    expect(screen.queryByRole('button', { name: /Rebuild from story/ })).toBeNull();
  });

  // A face revised in Casting mid-production: each linked card links back to
  // that record's Design tab (returning here) and names the cards it outdated.
  it('links linked cards to Casting Design and marks the ones built from an older look', async () => {
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: { images: [{ key: 'character', label: 'June' }], cast: [] } });
    const linked = { ...sheet('approved'), concept: { subjects: [
      { id: 'mvc-june', kind: 'character', name: 'June', role: 'protagonist', ingredientId: 'cat-june' },
      { id: 'mvc-dad', kind: 'character', name: 'Dad', ingredientId: 'cat-dad' },
    ] } };
    render(<Harness initial={linked} locked={false} />);
    expect(await card('June').findByText(/Older look/)).toBeInTheDocument();
    expect(card('Dad').queryByText(/Older look/)).toBeNull();
    const back = new URLSearchParams({ returnTo: '/music-video/example-project/cast-sets' });
    expect(card('June').getByRole('link', { name: 'Revise look' })).toHaveAttribute('href', `/casting/cat-june/design?${back}`);
    expect(card('Dad').getByRole('link', { name: 'Revise look' })).toHaveAttribute('href', `/casting/cat-dad/design?${back}`);
    expect(card('June · moods').queryByRole('link', { name: 'Revise look' })).toBeNull();
  });

  it('offers to update the images whose Casting references changed (with their dependents), then to add a newly linked character', async () => {
    api.regenerateMusicVideoCastAndSets.mockResolvedValue({ project: sheet('imaging', { revision: 2 }) });
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: { images: [{ key: 'character', label: 'June' }], cast: [] } });
    const Page = ({ initial }) => {
      const [value, setValue] = useState(initial);
      selectProject = setValue;
      const actions = useMusicVideoCastAndSets({ project: value, replaceProject: setValue });
      return <CastSetsStage board={{ project: value, locked: false, castSets: actions, kickoff: { running: false }, devArtifacts: { busy: false }, openArtifact: vi.fn(),
        productionReadiness: { castAndSets: { approved: true, stale: null, storyStale: null } }, approveCastAndSets: actions.approve, skipCastAndSets: actions.skip, ...DRAFTS }} />;
    };
    render(<Page initial={sheet('approved')} />);
    expect(await screen.findByText(/New Casting images for June\./)).toBeInTheDocument();
    expect(api.getMusicVideoCastAndSetsCastingChanges).toHaveBeenCalledWith('example-project', { silent: true });
    // The expression sheet is built on the character sheet, so it re-renders too.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Update 2 images/ })); });
    expect(api.regenerateMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { keys: ['character'] }, { silent: true });
    // While those re-render the notice gives way to progress.
    expect(screen.queryByText(/Casting changed since this sheet was built/)).toBeNull();

    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: { images: [], cast: ['Zora'] } });
    await act(async () => { selectProject(sheet('review', { revision: 2 })); });
    expect(await screen.findByText(/Zora is linked in Casting but has no sheet yet\./)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Add Zora to the sheet/ })); });
    // A direction note, not a discard: a production run's check-in and standing feedback carry over.
    expect(api.regenerateMusicVideoCastAndSets).toHaveBeenLastCalledWith('example-project',
      { notes: [{ text: 'Add Zora to the cast from Casting, each with a cast sheet.' }] }, { silent: true });
    expect(api.discardMusicVideoCastAndSets).not.toHaveBeenCalled();
  });

  // A failed Casting re-read must not read as "nothing changed": the last good notice stays, Retry re-reads.
  it('keeps the Casting notice through a failed re-read, and Retry loads the next answer', async () => {
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: { images: [{ key: 'character', label: 'June' }], cast: [] } });
    render(<Harness initial={sheet('approved')} locked={false} />);
    expect(await screen.findByText(/New Casting images for June\./)).toBeInTheDocument();
    api.getMusicVideoCastAndSetsCastingChanges.mockRejectedValue(new Error('network down'));
    await act(async () => { selectProject(sheet('review', { revision: 2 })); });
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.getByText(/New Casting images for June\./)).toBeInTheDocument();
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: null });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry/ })); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull());
    expect(screen.queryByText(/Casting changed since this sheet was built/)).toBeNull();
  });

  it('shows Retry and no changes notice when the first Casting read fails', async () => {
    api.getMusicVideoCastAndSetsCastingChanges.mockRejectedValueOnce(new Error('network down'));
    render(<Harness initial={sheet('approved')} locked={false} />);
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByText(/Casting changed since this sheet was built/)).toBeNull();
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValueOnce({ changes: { images: [{ key: 'character', label: 'June' }], cast: [] } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry/ })); });
    expect(await screen.findByText(/New Casting images for June\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  // Switching projects must not carry the previous project's notice or failure into the new one.
  it('drops the previous project\'s Casting notice while the next project reads, and does not reuse its changes after a failure', async () => {
    api.getMusicVideoCastAndSetsCastingChanges.mockResolvedValue({ changes: { images: [{ key: 'character', label: 'June' }], cast: [] } });
    render(<Harness initial={sheet('approved')} locked={false} />);
    expect(await screen.findByText(/New Casting images for June\./)).toBeInTheDocument();
    let fail;
    api.getMusicVideoCastAndSetsCastingChanges.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    await act(async () => { selectProject({ ...sheet('approved'), id: 'other-project' }); });
    expect(api.getMusicVideoCastAndSetsCastingChanges).toHaveBeenLastCalledWith('other-project', { silent: true });
    expect(screen.queryByText(/Casting changed since this sheet was built/)).toBeNull();
    await act(async () => { fail(new Error('network down')); });
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByText(/Casting changed since this sheet was built/)).toBeNull();
  });

  it('hides card actions while working and starts over only after confirming', async () => {
    const view = render(<Harness initial={sheet('imaging')} locked={false} />);
    expect(screen.queryByRole('button', { name: 'Regenerate Dad' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Start over/ })).toBeNull();
    view.unmount();
    api.discardMusicVideoCastAndSets.mockResolvedValue({ project: { id: 'example-project' } });
    render(<Harness initial={sheet('failed')} locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Start over/ }));
    expect(api.discardMusicVideoCastAndSets).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Cast & Sets over' })); });
    expect(api.discardMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { silent: true });
    expect(screen.queryByText('Cast & Sets check-in')).toBeNull();
  });
});

describe('Cast & Sets sheet feedback', () => {
  const direction = { protagonist: { name: 'Keeper' }, sets: [{ id: 'harbor', name: 'Harbor', description: 'a wet quay' }] };
  const sheet = (extra = {}) => ({ id: 'example-project', castAndSets: {
    revision: 1, status: 'review', direction, images: {},
    plan: { 'set:harbor': { key: 'set:harbor', label: 'Harbor', prompt: 'Empty set plate', deps: [], refKeys: [] } },
    ...extra,
  } });

  it('sends whole-sheet feedback, clears the box, and shows what the revision changed', async () => {
    const note = 'Fewer light sources, eighties analog film';
    api.applyMusicVideoCastAndSetsFeedback.mockResolvedValue({ project: sheet({ revision: 2, status: 'directing', feedback: [{ id: 'fb-1', text: note }] }) });
    const view = render(<Harness initial={sheet()} locked={false} />);
    const apply = screen.getByRole('button', { name: 'Apply feedback' });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: note } });
    await act(async () => { fireEvent.click(apply); });
    expect(api.applyMusicVideoCastAndSetsFeedback).toHaveBeenCalledWith('example-project', { text: note }, { silent: true });
    // Working again: the box waits for the new sheet.
    expect(screen.queryByLabelText('What should change?')).toBeNull();

    await stage(sheet({ revision: 2, feedback: [{ id: 'fb-1', text: note }], changeSummary: { revision: 2, changes: ['Look rewritten for every image', 'Lighting: Harbor'], rerendered: 1 } }));
    expect(screen.getByLabelText('What should change?').value).toBe('');
    expect(screen.getByText(/Revision 2: Look rewritten for every image · Lighting: Harbor · 1 image re-rendered/)).toBeInTheDocument();
    expect(screen.getByText('Standing feedback (1)')).toBeInTheDocument();

    api.removeMusicVideoCastAndSetsFeedback.mockResolvedValue({ project: sheet({ revision: 2, feedback: [] }) });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Stop applying: ${note}` })); });
    expect(api.removeMusicVideoCastAndSetsFeedback).toHaveBeenCalledWith('example-project', 'fb-1', { silent: true });
    expect(screen.queryByText(/Standing feedback/)).toBeNull();
    view.unmount();
  });

  it('aims feedback at one image and keeps the text when the request fails', async () => {
    api.applyMusicVideoCastAndSetsFeedback.mockRejectedValue(new Error('No provider'));
    render(<Harness initial={sheet()} locked={false} />);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'One lamp only' } });
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: 'set:harbor' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply feedback' })); });
    expect(api.applyMusicVideoCastAndSetsFeedback).toHaveBeenCalledWith('example-project', { text: 'One lamp only', target: 'set:harbor' }, { silent: true });
    expect(screen.getByLabelText('What should change?').value).toBe('One lamp only');
  });
});

describe('Cast & Sets tab: undo, regenerate and guide import', () => {
  const sheet = { id: 'sheet-1', title: 'Check-in sheet', kind: 'cast-sets', version: 1, status: 'approved', mimeType: 'text/html', updatedAt: '2026-01-01T00:00:00Z' };
  const imported = { id: 'guide-1', title: 'My guide', kind: 'other', version: 1, status: 'pending', mimeType: 'image/png', updatedAt: '2026-01-02T00:00:00Z' };
  const movie = { id: 'clip-1', title: 'A clip', kind: 'animatic', version: 1, status: 'pending', mimeType: 'video/mp4', updatedAt: '2026-01-03T00:00:00Z' };
  const withStatus = (status, extra = {}) => ({ id: 'example-project', devArtifacts: [sheet, imported, movie], castAndSets: { revision: 1, status, plan: {}, images: {}, artifactId: 'sheet-1', ...extra } });
  const open = (value, board = {}) => {
    const Page = () => {
      const [current, setCurrent] = useState(value);
      const actions = useMusicVideoCastAndSets({ project: current, replaceProject: setCurrent });
      return <CastSetsStage board={{ project: current, locked: false, castSets: actions, kickoff: { running: false }, devArtifacts: { busy: false }, openArtifact: vi.fn(), approveCastAndSets: actions.approve, skipCastAndSets: actions.skip, ...DRAFTS, ...board }} />;
    };
    return render(<Page />);
  };

  it.each(['approved', 'skipped'])('restarts a %s check-in from the tab with Rebuild', async (status) => {
    api.startMusicVideoCastAndSets.mockResolvedValue({ project: withStatus('directing', { revision: 2 }) });
    open(withStatus(status));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rebuild' })); });
    expect(api.startMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', {}, { silent: true });
    expect(screen.getByText('revision 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
  });

  it('offers Regenerate without a note and no Rebuild while the sheet awaits review', async () => {
    api.regenerateMusicVideoCastAndSets.mockResolvedValue({ project: withStatus('imaging', { revision: 2 }) });
    open(withStatus('review'));
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
    const regenerate = screen.getByRole('button', { name: /Regenerate/ });
    expect(regenerate).not.toBeDisabled();
    await act(async () => { fireEvent.click(regenerate); });
    expect(api.regenerateMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', {}, { silent: true });
  });

  it('imports a guide here and chooses it as the visual guide, only for usable files', () => {
    const useAsGuide = vi.fn();
    open(withStatus('approved'), { onUploadArtifact: vi.fn(), useAsGuide });
    expect(screen.getByLabelText('Import development file')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use My guide as visual guide' }));
    expect(useAsGuide).toHaveBeenCalledWith('guide-1');
    expect(screen.queryByRole('button', { name: 'Use A clip as visual guide' })).toBeNull();
  });

  it('names what changed since an approved sheet and keeps it approved on request (#10141)', async () => {
    const stale = { approvedAt: '2026-01-01T00:00:00.000Z', changedFields: ['concept', 'style'] };
    api.reconfirmMusicVideoCastAndSets.mockResolvedValue({ project: withStatus('approved') });
    open(withStatus('approved'), { productionReadiness: { castAndSets: { approved: true, stale } } });
    expect(screen.getByText('approved · stale')).toBeInTheDocument();
    expect(screen.getByText(/^Approved earlier — changed since: concept, style\./)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep approved' })); });
    expect(api.reconfirmMusicVideoCastAndSets).toHaveBeenCalledWith('example-project', { silent: true });
  });

  it('offers Revert only for changed inputs whose approved value was kept (#10241)', () => {
    const onRevertApproval = vi.fn();
    const stale = { approvedAt: '2026-01-01T00:00:00.000Z', changedFields: ['concept', 'song'], revertible: ['concept'] };
    open(withStatus('approved'), { productionReadiness: { castAndSets: { approved: true, stale } }, onRevertApproval });
    // Keep approved sits in the same row as Revert, right under the stale note.
    expect(screen.getByRole('button', { name: 'Keep approved' }).parentElement).toBe(screen.getByRole('button', { name: 'Revert concept' }).parentElement);
    fireEvent.click(screen.getByRole('button', { name: 'Revert concept' }));
    expect(onRevertApproval).toHaveBeenCalledWith('castAndSets', 'concept');
    expect(screen.queryByRole('button', { name: 'Revert song' })).toBeNull();
  });

  it('shows no stale note or Keep approved for a current approval', () => {
    open(withStatus('approved'), { productionReadiness: { castAndSets: { approved: true, stale: null } } });
    expect(screen.queryByRole('button', { name: 'Keep approved' })).toBeNull();
    expect(screen.queryByText(/changed since/)).toBeNull();
  });

  it('marks the chosen guide instead of offering it again', () => {
    const value = { ...withStatus('approved'), productionReview: { draft: { guideArtifactId: 'sheet-1' } } };
    open(value, { useAsGuide: vi.fn() });
    expect(screen.getByText(/Visual guide$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use Check-in sheet as visual guide' })).toBeNull();
  });
});

describe('Cast & Sets stage before any check-in exists', () => {
  it('leaves Build to the checklist and keeps only Skip, wired to the skip action', async () => {
    const start = vi.fn();
    const skip = vi.fn();
    render(<CastSetsStage board={{ project: { id: 'example-project', audioAnalysis: { sections: [{}] } }, locked: false, castSets: { busy: false, start, skip }, kickoff: { running: false }, devArtifacts: { busy: false }, openArtifact: vi.fn(), ...DRAFTS }} />);
    // The step's checklist and header already offer Build; a second copy here only repeated it.
    expect(screen.queryByRole('button', { name: 'Build cast & sets' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Skip cast & sets' }));
    expect(skip).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('says which style is empty and counts references and style images apart', () => {
    const project = { id: 'example-project', audioAnalysis: { sections: [{}] }, concept: { prompt: 'p', style: '', songStyle: 'synthwave' },
      visualSpec: { references: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, styleReferences: Array.from({ length: 15 }, (_, i) => ({ id: `s${i}` })) };
    render(<CastSetsStage board={{ project, locked: false, castSets: { busy: false, start: vi.fn(), skip: vi.fn() }, kickoff: { running: false }, devArtifacts: { busy: false }, openArtifact: vi.fn(), ...DRAFTS }} />);
    expect(screen.getByText(/No visual style yet · Song style set · 3 references · 15 style images/)).toBeInTheDocument();
  });
});
