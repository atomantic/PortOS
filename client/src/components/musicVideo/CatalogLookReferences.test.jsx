import { useState } from 'react';
import socket from '../../services/socket.js';
import { getMusicVideoCastAndSets } from '../../services/apiMusicVideo.js';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CastSetsStage from './stages/CastSetsStage.jsx';
import { detachCatalogIngredientMedia, listCatalogIngredientMedia } from '../../services/apiCatalog.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoCastAndSets: vi.fn() }));
vi.mock('../../services/socket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../services/apiCatalog.js', () => ({ listCatalogIngredientMedia: vi.fn(), detachCatalogIngredientMedia: vi.fn() }));
vi.mock('./CastAndSetsCheckin.jsx', () => ({ default: () => <p>Approved sheet</p> }));
vi.mock('./DevArtifactsPanel.jsx', () => ({ default: () => null }));
vi.mock('./LookReferencesPanel.jsx', () => ({ default: () => null }));
vi.mock('./VisualSpecPanel.jsx', () => ({ default: () => null }));
vi.mock('./CameoRosterPanel.jsx', () => ({ default: () => null }));
vi.mock('./VideoCastLinks.jsx', () => ({ VideoCastLinksDisclosure: () => null }));
vi.mock('../../hooks/useMusicVideoCastingChanges.js', () => ({ default: () => ({}) }));

const makeProject = () => ({
  id: 'mv-test', concept: { universeId: 'universe-shared', subjects: [
    { id: 'bike', kind: 'object', name: 'Bike', ingredientId: 'cat-bike' },
    { id: 'camera', kind: 'object', name: 'Camera', ingredientId: 'cat-camera' },
    { id: 'unlinked', kind: 'object', name: 'Unlinked object' },
    { id: 'cast', kind: 'character', name: 'Cast', ingredientId: 'cat-cast' },
  ] }, visualSpec: { references: [{ id: 'original', imageId: 'shared.png', role: 'prop', condition: false }] },
  castAndSets: { status: 'approved', images: { character: { imageId: 'approved.png' } } },
});

function show(project = makeProject(), save = vi.fn(), extra = {}) {
  const board = { project, saveVisualSpec: save, locked: false, castSets: { busy: false }, kickoff: { running: false }, devArtifacts: { busy: false }, ...extra };
  const view = render(<MemoryRouter><CastSetsStage board={board} /></MemoryRouter>);
  return { ...view, save };
}

describe('live catalog references on the Look step', () => {
  it('shows the video’s linked object images automatically, while excluding unusable and unrelated media', async () => {
    listCatalogIngredientMedia.mockImplementation(async (id) => id === 'cat-bike' ? [
      { kind: 'portrait', mediaKey: 'shared.png' },
      { kind: 'reference', mediaKey: 'shared.png', library: { review: { status: 'good' } } },
      { kind: 'reference', mediaKey: 'red.png', caption: 'Red cruiser' },
      { kind: 'reference', mediaKey: 'bad.png', library: { review: { status: 'bad' } } },
      { kind: 'reference', mediaKey: 'other-look.png', library: { variant: { formId: 'other' } } },
      { kind: 'video', mediaKey: 'clip.mp4' },
    ] : [{ kind: 'reference', mediaKey: 'camera.png' }]);
    const project = makeProject();
    const { save } = show(project);
    await screen.findByText('Red cruiser');
    const region = within(screen.getByRole('region', { name: 'Catalog-linked look' }));
    expect(region.getByRole('link', { name: 'Bike' })).toHaveAttribute('href', '/objects/cat-bike');
    expect(region.getByRole('link', { name: 'Camera' })).toHaveAttribute('href', '/objects/cat-camera');
    expect(region.getAllByAltText(/^Bike reference [0-9]+$/)).toHaveLength(2);
    expect(region.getByText('Pinned for shots')).toBeInTheDocument();
    expect(region.queryByAltText(/^Unlinked object reference/)).toBeNull();
    expect(listCatalogIngredientMedia.mock.calls.map(([id]) => id).sort()).toEqual(['cat-bike', 'cat-camera', 'cat-cast']);
    expect(save).not.toHaveBeenCalled();
    expect(project.castAndSets.images.character.imageId).toBe('approved.png');

    const red = region.getByText('Red cruiser').closest('[role=listitem]');
    fireEvent.load(within(red).getByRole('img'));
    await act(async () => fireEvent.click(within(red).getByRole('button', { name: /^Add Bike image [0-9]+ to look references$/ })));
    expect(save).toHaveBeenCalledWith({ references: [project.visualSpec.references[0], expect.objectContaining({
      id: expect.stringMatching(/^mvr-object-/), imageId: 'red.png', label: 'Bike', role: 'prop', condition: false,
    })] });
  });

  it('reads cast and environments from the catalog with the selected form and refreshes changes without saving copies', async () => {
    const project = makeProject();
    project.concept.subjects = [
      { id: 'lead', kind: 'character', name: 'Lead', ingredientId: 'cat-lead', castForm: { id: 'young' } },
      { id: 'set', kind: 'place', name: 'Street', ingredientId: 'cat-street' },
    ];
    let changed = false;
    listCatalogIngredientMedia.mockImplementation(async (id) => id === 'cat-lead' ? [
      { kind: 'portrait', mediaKey: 'adult.png' },
      { kind: 'reference', mediaKey: changed ? 'new.png' : 'young.png', library: { variant: { formId: 'young' } } },
    ] : [{ kind: 'reference', mediaKey: 'street.png' }]);
    const { save, unmount } = show(project);
    expect(await screen.findByAltText('Lead reference 1')).toHaveAttribute('src', '/data/images/young.png');
    expect(screen.getByRole('link', { name: 'Lead' })).toHaveAttribute('href', '/casting/cat-lead');
    expect(screen.getByRole('link', { name: 'Street' })).toHaveAttribute('href', '/environments/cat-street');
    expect(within(screen.getByRole('region', { name: 'Cast' })).getAllByRole('img')).toHaveLength(1);
    changed = true;
    const handler = socket.on.mock.calls.findLast(([name]) => name === 'catalog:assets-changed')[1];
    await act(async () => handler({ ingredientId: 'cat-lead' }));
    await waitFor(() => expect(screen.getByAltText('Lead reference 1')).toHaveAttribute('src', '/data/images/new.png'), { timeout: 2500 });
    expect(save).not.toHaveBeenCalled();
    expect(project.castAndSets.images.character.imageId).toBe('approved.png');
    unmount();
    expect(socket.off).toHaveBeenCalledWith('catalog:assets-changed', handler);
  });

  it('checks in only resolved catalog images and leaves prior generated sheets in closed history', async () => {
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[3]];
    project.castAndSets = { source: 'catalog', status: 'review', images: { character: { imageId: 'old-generated.png' } }, plan: { character: { key: 'character', label: 'Old generated sheet' } } };
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'reference', mediaKey: 'current.png' }, { kind: 'reference', mediaKey: 'not-selected.png' }]);
    getMusicVideoCastAndSets.mockResolvedValue({ catalogCheckin: { items: [{ subjectId: 'cast', ingredientId: 'cat-cast', name: 'Cast', images: ['current.png'] }], problems: [], approved: false, basis: 'seen-basis' } });
    const approve = vi.fn();
    const applyCatalogCheckin = vi.fn();
    const { save } = show(project, vi.fn(), { approveCastAndSets: approve, applyCatalogCheckin });
    expect(await screen.findByAltText('Cast reference 1')).toHaveAttribute('src', '/data/images/current.png');
    expect(screen.queryByAltText('Cast reference 2')).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage image in catalog' })).toHaveAttribute('href', '/casting/cat-cast');
    expect(screen.queryByRole('button', { name: /Unlink Cast image/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve catalog Cast & Sets' }));
    expect(approve).toHaveBeenCalledWith('seen-basis');
    expect(applyCatalogCheckin).toHaveBeenCalledWith(expect.objectContaining({ basis: 'seen-basis' }));
    const old = screen.getByAltText('Old generated sheet — previous revision');
    expect(old.closest('details')).not.toHaveAttribute('open');
    expect(within(screen.getByRole('region', { name: 'Catalog-linked look' })).queryByRole('img', { name: /Old generated sheet/ })).toBeNull();
    expect(screen.queryByText('Approved sheet')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows canonical payload images even without a media association and routes correction to the catalog', async () => {
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[3]];
    project.castAndSets.source = 'catalog';
    listCatalogIngredientMedia.mockResolvedValue([]);
    getMusicVideoCastAndSets.mockResolvedValue({ catalogCheckin: { items: [{ subjectId: 'cast', ingredientId: 'cat-cast', name: 'Cast', images: ['canonical.png'] }], problems: [], approved: true, basis: 'seen' } });
    show(project);
    expect(await screen.findByAltText('Cast reference 1')).toHaveAttribute('src', '/data/images/canonical.png');
    expect(screen.getByRole('link', { name: 'Manage image in catalog' })).toHaveAttribute('href', '/casting/cat-cast');
    expect(screen.queryByRole('button', { name: /Unlink Cast image/ })).toBeNull();
    expect(screen.queryByText('No usable images for this look.')).toBeNull();
  });

  it('blocks catalog approval on missing links or a failed read instead of falling back to old images', async () => {
    const project = makeProject();
    project.castAndSets.source = 'catalog';
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'portrait', mediaKey: 'old.png' }]);
    getMusicVideoCastAndSets.mockRejectedValueOnce(new Error('Catalog unavailable')).mockResolvedValueOnce({ catalogCheckin: { items: [], problems: [{ subjectId: 'bike', code: 'missing', message: 'Link Bike to a catalog record.' }], approved: false } });
    show(project);
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog unavailable');
    expect(screen.getByRole('button', { name: 'Approve catalog Cast & Sets' })).toBeDisabled();
    expect(screen.queryByAltText('Bike reference 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry catalog check-in' }));
    expect(await screen.findByText('Link Bike to a catalog record.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve catalog Cast & Sets' })).toBeDisabled();
  });

  it('does not add a reference that only exists outside the gallery', async () => {
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'reference', mediaKey: 'asset.png' }]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    const { save } = show(project);
    const image = await screen.findByAltText('Bike reference 1');
    const button = screen.getByRole('button', { name: /^Add Bike image [0-9]+ to look references$/ });
    expect(button).toBeDisabled();
    fireEvent.load(image);
    expect(button).toBeEnabled();
    fireEvent.error(image);
    expect(image.src).toContain('/data/image-refs/asset.png');
    fireEvent.load(image);
    expect(button).toBeDisabled();
    expect(screen.getByText(/Only available in the catalog/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('waits for a new look reference to save before adding another so neither edit is lost', async () => {
    listCatalogIngredientMedia.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'one.png', caption: 'First' },
      { kind: 'reference', mediaKey: 'two.png', caption: 'Second' },
    ]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    let finishSave;
    const save = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const { rerender } = show(project, save);
    const first = (await screen.findByText('First')).closest('[role=listitem]');
    const second = screen.getByText('Second').closest('[role=listitem]');
    fireEvent.load(within(first).getByRole('img'));
    fireEvent.load(within(second).getByRole('img'));
    fireEvent.click(within(first).getByRole('button', { name: /Add Bike/ }));
    expect(within(second).getByRole('button', { name: /Add Bike/ })).toBeDisabled();
    const references = save.mock.calls[0][0].references;
    const updated = { ...project, visualSpec: { references } };
    const board = { project: updated, saveVisualSpec: save, locked: false, castSets: { busy: false }, kickoff: { running: false }, devArtifacts: { busy: false } };
    rerender(<MemoryRouter><CastSetsStage board={board} /></MemoryRouter>);
    expect(within(second).getByRole('button', { name: /Add Bike/ })).toBeDisabled();
    await act(async () => finishSave());
    await waitFor(() => expect(within(second).getByRole('button', { name: /Add Bike/ })).toBeEnabled());
    await act(async () => fireEvent.click(within(second).getByRole('button', { name: /Add Bike/ })));
    expect(save.mock.calls[1][0].references.map((ref) => ref.imageId)).toEqual(['shared.png', 'one.png', 'two.png']);
  });

  it('keeps all existing look references when their list is full', async () => {
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'reference', mediaKey: 'bike.png' }]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    project.visualSpec.references = Array.from({ length: 24 }, (_, i) => ({ id: `ref-${i}`, imageId: `image-${i}.png` }));
    const { save } = show(project);
    fireEvent.load(await screen.findByAltText('Bike reference 1'));
    expect(screen.getByRole('button', { name: /^Add Bike image [0-9]+ to look references$/ })).toBeDisabled();
    expect(screen.getByText(/look reference list is full/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not add images to a code-only project', async () => {
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'portrait', mediaKey: 'bike.png' }]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    project.mediaMode = 'code-only';
    project.visualSpec.references = [];
    const { save } = show(project);
    fireEvent.load(await screen.findByAltText('Bike reference 1'));
    expect(screen.getByRole('button', { name: 'Add Bike image 1 to look references' })).toBeDisabled();
    expect(screen.getByText(/Code-only projects do not allow image references/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a failed object lookup and lets it be retried', async () => {
    listCatalogIngredientMedia.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ kind: 'portrait', mediaKey: 'bike.png' }]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    show(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByAltText('Bike reference 1')).toBeInTheDocument();
  });

  it('persists Look removal through the board save and supports adding the retained catalog image again', async () => {
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'portrait', mediaKey: 'shared.png' }]);
    let saved = makeProject();
    saved.concept.subjects = [saved.concept.subjects[0]];
    saved.visualSpec.references.push({ id: 'keep', imageId: 'keep.png' });
    saved.scenes = [{ sceneId: 'scene', frameReferenceIds: ['original'] }];
    function Board() {
      const [project, setProject] = useState(saved);
      const saveVisualSpec = async (patch) => {
        saved = { ...project, visualSpec: { ...project.visualSpec, ...patch } };
        setProject(saved);
        return saved;
      };
      return <CastSetsStage board={{ project, saveVisualSpec, locked: false, castSets: {}, kickoff: {}, devArtifacts: {} }} />;
    }
    const view = render(<MemoryRouter><Board /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Remove Bike/ }));
    await screen.findByRole('button', { name: /Add Bike/ });
    expect(saved.visualSpec.references.map(ref => ref.imageId)).toEqual(['keep.png']);
    expect(saved.scenes[0].frameReferenceIds).toEqual(['original']);
    view.unmount();
    render(<MemoryRouter><Board /></MemoryRouter>);
    const add = await screen.findByRole('button', { name: /Add Bike/ });
    fireEvent.load(screen.getByAltText('Bike reference 1'));
    fireEvent.click(add);
    await screen.findByRole('button', { name: /Remove Bike/ });
    expect(saved.visualSpec.references.map(ref => ref.imageId)).toEqual(['keep.png', 'shared.png']);
  });

  it('removes only the selected look reference, guards repeated clicks, and restores controls after failure', async () => {
    listCatalogIngredientMedia.mockResolvedValue([{ kind: 'portrait', mediaKey: 'shared.png' }]);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    project.visualSpec.references.push({ id: 'keep', imageId: 'keep.png' });
    let rejectSave;
    const save = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; })).mockResolvedValue(undefined);
    show(project, save);
    const remove = await screen.findByRole('button', { name: /Remove Bike/ });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ references: [project.visualSpec.references[1]] });
    await act(async () => rejectSave(new Error('Save failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    expect(remove).toBeEnabled();
    expect(project.visualSpec.references).toHaveLength(2);
    await act(async () => fireEvent.click(remove));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('confirms unlinking all image associations, preserves look references, and keeps the detach after remount', async () => {
    let rows = [
      { kind: 'portrait', mediaKey: 'shared.png' },
      { kind: 'reference', mediaKey: 'shared.png' },
      { kind: 'reference', mediaKey: 'keep.png' },
    ];
    listCatalogIngredientMedia.mockImplementation(async () => rows);
    let finish;
    detachCatalogIngredientMedia.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { rows = rows.filter(row => row.kind !== 'portrait'); resolve(); }; }))
      .mockImplementationOnce(async (_, { kind, mediaKey }) => { rows = rows.filter(row => row.kind !== kind || row.mediaKey !== mediaKey); });
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    const { save, unmount } = show(project);
    fireEvent.click(await screen.findByRole('button', { name: /Unlink Bike image 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(detachCatalogIngredientMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Unlink Bike image 1/ }));
    expect(screen.getByText(/catalog record and image file are kept/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));
    await waitFor(() => expect(detachCatalogIngredientMedia).toHaveBeenCalledTimes(1));
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText('Pinned for shots')).toBeNull());
    expect(detachCatalogIngredientMedia.mock.calls).toEqual([
      ['cat-bike', { mediaKey: 'shared.png', kind: 'portrait' }, { silent: true }],
      ['cat-bike', { mediaKey: 'shared.png', kind: 'reference' }, { silent: true }],
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(project.visualSpec.references[0].imageId).toBe('shared.png');
    unmount();
    show(project);
    expect(await screen.findByAltText('Bike reference 1')).toHaveAttribute('src', '/data/images/keep.png');
  });

  it('retains failed associations and retries without repeating successful detaches', async () => {
    listCatalogIngredientMedia.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'shared.png' }, { kind: 'reference', mediaKey: 'shared.png' },
    ]);
    detachCatalogIngredientMedia.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Cannot unlink')).mockResolvedValueOnce(undefined);
    const project = makeProject();
    project.concept.subjects = [project.concept.subjects[0]];
    show(project);
    fireEvent.click(await screen.findByRole('button', { name: /Unlink Bike image 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot unlink');
    expect(screen.getByAltText('Bike reference 1')).toBeInTheDocument();
    const list = screen.getByRole('list');
    screen.getByRole('button', { name: 'Confirm unlink' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));
    await screen.findByText('No usable images for this look.');
    expect(screen.getByRole('list')).toBe(list);
    expect(list).toHaveFocus();
    expect(detachCatalogIngredientMedia.mock.calls.map(([, body]) => body.kind)).toEqual(['portrait', 'reference', 'reference']);
  });

  it('does not show a prior project’s images when a late request completes', async () => {
    let finish;
    listCatalogIngredientMedia.mockImplementation((id) => id === 'cat-bike'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve([{ kind: 'portrait', mediaKey: 'camera.png' }]));
    const first = makeProject();
    first.concept.subjects = [first.concept.subjects[0]];
    const { rerender } = show(first);
    const next = makeProject();
    next.id = 'mv-next';
    next.concept.subjects = [next.concept.subjects[1]];
    const board = { project: next, saveVisualSpec: vi.fn(), locked: false, castSets: { busy: false }, kickoff: { running: false }, devArtifacts: { busy: false } };
    rerender(<MemoryRouter><CastSetsStage board={board} /></MemoryRouter>);
    await screen.findByAltText('Camera reference 1');
    await act(async () => finish([{ kind: 'portrait', mediaKey: 'old.png' }]));
    await waitFor(() => expect(screen.queryByAltText(/^Bike reference/)).toBeNull());
  });
});
