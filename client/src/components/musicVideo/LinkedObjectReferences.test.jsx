import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CastSetsStage from './stages/CastSetsStage.jsx';
import { listCatalogIngredientMedia } from '../../services/apiCatalog.js';

vi.mock('../../services/apiCatalog.js', () => ({ listCatalogIngredientMedia: vi.fn() }));
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

function show(project = makeProject(), save = vi.fn()) {
  const board = { project, saveVisualSpec: save, locked: false, castSets: { busy: false }, kickoff: { running: false }, devArtifacts: { busy: false } };
  const view = render(<MemoryRouter><CastSetsStage board={board} /></MemoryRouter>);
  return { ...view, save };
}

describe('linked object references on the Look step', () => {
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
    const region = within(screen.getByRole('region', { name: 'Linked object references' }));
    expect(region.getByRole('link', { name: 'Bike' })).toHaveAttribute('href', '/objects/cat-bike');
    expect(region.getByRole('link', { name: 'Camera' })).toHaveAttribute('href', '/objects/cat-camera');
    expect(region.getAllByAltText(/^Bike reference [0-9]+$/)).toHaveLength(2);
    expect(region.getByText('Already in look references')).toBeInTheDocument();
    expect(region.queryByAltText(/^Unlinked object reference/)).toBeNull();
    expect(listCatalogIngredientMedia.mock.calls.map(([id]) => id).sort()).toEqual(['cat-bike', 'cat-camera']);
    expect(save).not.toHaveBeenCalled();
    expect(project.castAndSets.images.character.imageId).toBe('approved.png');

    const red = region.getByText('Red cruiser').closest('li');
    fireEvent.load(within(red).getByRole('img'));
    await act(async () => fireEvent.click(within(red).getByRole('button', { name: /^Add Bike image [0-9]+ to look references$/ })));
    expect(save).toHaveBeenCalledWith({ references: [project.visualSpec.references[0], expect.objectContaining({
      id: expect.stringMatching(/^mvr-object-/), imageId: 'red.png', label: 'Bike', role: 'prop', condition: false,
    })] });
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
    expect(screen.getByText(/Only available in Objects/)).toBeInTheDocument();
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
    const first = (await screen.findByText('First')).closest('li');
    const second = screen.getByText('Second').closest('li');
    fireEvent.load(within(first).getByRole('img'));
    fireEvent.load(within(second).getByRole('img'));
    fireEvent.click(within(first).getByRole('button'));
    expect(within(second).getByRole('button')).toBeDisabled();
    const references = save.mock.calls[0][0].references;
    const updated = { ...project, visualSpec: { references } };
    const board = { project: updated, saveVisualSpec: save, locked: false, castSets: { busy: false }, kickoff: { running: false }, devArtifacts: { busy: false } };
    rerender(<MemoryRouter><CastSetsStage board={board} /></MemoryRouter>);
    expect(within(second).getByRole('button')).toBeDisabled();
    await act(async () => finishSave());
    await waitFor(() => expect(within(second).getByRole('button')).toBeEnabled());
    await act(async () => fireEvent.click(within(second).getByRole('button')));
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
