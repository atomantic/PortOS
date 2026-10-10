import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CastSetsStage from './stages/CastSetsStage.jsx';
import useMusicVideoCastAndSets from '../../hooks/useMusicVideoCastAndSets';
import { castAndSetsPreviewItems } from './CastAndSetsReferenceProgress.jsx';

const { listeners, api, getMediaJob } = vi.hoisted(() => ({
  listeners: new Map(),
  api: { getMusicVideoProject: vi.fn(), startMusicVideoCastAndSets: vi.fn(), regenerateMusicVideoCastAndSets: vi.fn(), editMusicVideoCastAndSetsDirection: vi.fn(), resumeMusicVideoCastAndSets: vi.fn(), approveMusicVideoCastAndSets: vi.fn(), reconfirmMusicVideoCastAndSets: vi.fn(), revertMusicVideoProductionInput: vi.fn(), skipMusicVideoCastAndSets: vi.fn() },
  getMediaJob: vi.fn(),
}));
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
  character: { key: 'character', label: 'Keeper', prompt: 'Planned keeper portrait', deps: [], refKeys: [], moodRefs: true },
  set: { key: 'set', label: 'Lamp room', prompt: 'Planned lamp room', deps: ['character'], refKeys: ['character'] },
  looks: { key: 'looks', label: 'Wardrobe', prompt: 'Planned wardrobe', deps: ['character'], refKeys: ['character'] },
};
const project = (images = {}, extra = {}) => ({ id: 'example-project', castAndSets: { revision: 1, status: 'imaging', plan, images, moodImages: [{ kind: 'image-ref', filename: 'mood.png' }], ...extra } });
const done = (filename, prompt) => ({ status: 'done', jobId: `job-${filename}`, imageId: filename, submittedPrompt: prompt, submittedRevision: 1, submittedReferences: [{ kind: 'image-ref', filename: 'mood.png' }] });
let selectProject;
function Harness({ initial, locked = true, openPreview = vi.fn() }) {
  const [value, setValue] = useState(initial);
  selectProject = setValue;
  const actions = useMusicVideoCastAndSets({ project: value, replaceProject: setValue });
  return <CastSetsStage board={{ project: value, locked, castSets: actions, kickoff: { running: locked }, devArtifacts: { busy: false }, openArtifact: vi.fn(), openPreview, approveCastAndSets: actions.approve, skipCastAndSets: actions.skip, ...DRAFTS }} />;
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
