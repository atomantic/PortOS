import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CastSetsStage from './stages/CastSetsStage.jsx';
import useMusicVideoCastAndSets from '../../hooks/useMusicVideoCastAndSets';

const { listeners, api, getMediaJob } = vi.hoisted(() => ({
  listeners: new Map(),
  api: { getMusicVideoProject: vi.fn(), startMusicVideoCastAndSets: vi.fn(), regenerateMusicVideoCastAndSets: vi.fn(), editMusicVideoCastAndSetsDirection: vi.fn(), resumeMusicVideoCastAndSets: vi.fn(), approveMusicVideoCastAndSets: vi.fn(), skipMusicVideoCastAndSets: vi.fn() },
  getMediaJob: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: {
  on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
  off: (event, fn) => listeners.get(event)?.delete(fn),
} }));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../services/apiMediaJobs', () => ({ getMediaJob }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const emit = async (event, data) => act(async () => { for (const fn of listeners.get(event) || []) fn(data); });
const plan = {
  character: { key: 'character', label: 'Keeper', prompt: 'Planned keeper portrait', deps: [], refKeys: [], moodRefs: true },
  set: { key: 'set', label: 'Lamp room', prompt: 'Planned lamp room', deps: ['character'], refKeys: ['character'] },
  looks: { key: 'looks', label: 'Wardrobe', prompt: 'Planned wardrobe', deps: ['character'], refKeys: ['character'] },
};
const project = (images = {}, extra = {}) => ({ id: 'example-project', castAndSets: { revision: 1, status: 'imaging', plan, images, moodImages: [{ kind: 'image-ref', filename: 'mood.png' }], ...extra } });
const done = (filename, prompt) => ({ status: 'done', jobId: `job-${filename}`, imageId: filename, submittedPrompt: prompt, submittedRevision: 1, submittedReferences: [{ kind: 'image-ref', filename: 'mood.png' }] });
let selectProject;
function Harness({ initial, locked = true }) {
  const [value, setValue] = useState(initial);
  selectProject = setValue;
  const actions = useMusicVideoCastAndSets({ project: value, replaceProject: setValue });
  return <CastSetsStage board={{ project: value, locked, castSets: actions, kickoff: { running: locked }, devArtifacts: { busy: false }, openArtifact: vi.fn(), approveCastAndSets: actions.approve, skipCastAndSets: actions.skip }} />;
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
  api.getMusicVideoProject.mockReset();
});
afterEach(() => vi.restoreAllMocks());

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
    render(<Harness initial={reloaded} />);
    expect(card('Keeper').getByText('New submitted prompt')).toBeInTheDocument();
    expect(card('Keeper').getByRole('link', { name: 'Keeper — generated reference' })).toHaveAttribute('href', '/data/images/keeper-new.png');
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

  it('offers the editor only for a procedural direction waiting in review', () => {
    const view = render(<Harness initial={review(direction())} locked={false} />);
    expect(screen.queryByRole('button', { name: /Edit direction/ })).toBeNull();
    view.unmount();
    render(<Harness initial={review(direction('procedural'), { status: 'approved' })} locked={false} />);
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
