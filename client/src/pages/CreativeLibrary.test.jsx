import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.hoisted(() => vi.fn());
const { socketEvents } = vi.hoisted(() => ({ socketEvents: new Map() }));
vi.mock('../services/socket', () => ({ default: { on: (name, handler) => socketEvents.set(name, handler), off: name => socketEvents.delete(name) } }));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
  getCatalogIngredientCards: vi.fn(async () => []),
  setCatalogIngredientLock: vi.fn(),
  createCatalogIngredient: vi.fn(),
  getCatalogFacets: vi.fn(),
  getCatalogIngredientDetails: vi.fn(),
  attachCatalogIngredientGeneratedImage: vi.fn(),
  listCatalogStories: vi.fn(),
  joinCatalogStory: vi.fn(),
}));
vi.mock('../services/api', () => ({
  createCatalogIngredient: (...args) => createCatalogIngredient(...args),
  joinCatalogStory: (...args) => joinCatalogStory(...args),
  draftCatalogStoryMember: vi.fn(),
}));
vi.mock('../components/musicVideo/MusicVideoLlmPicker', () => ({ default: () => <p>Model picker</p> }));
vi.mock('../components/catalog/GenerateImageControl', () => ({
  default: ({ name, onComplete }) => <button type="button" onClick={() => onComplete('new-cover.png')}>Generate image for {name}</button>,
}));
vi.mock('../services/apiCatalogTypes', () => ({ listCatalogTypes: vi.fn() }));
vi.mock('../services/apiUniverseBuilder', () => ({ listUniverseNames: vi.fn(async () => [{ id: 'u-1', name: 'Example Universe' }]) }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/MediaImage', async () => {
  const { imageThumbnailSrc } = await import('../lib/imageThumbnailSrc');
  return {
    default: ({ src, thumbnail, alt, ...rest }) => <img src={(thumbnail && imageThumbnailSrc(src)) || src} alt={alt} {...rest} />,
  };
});

import CreativeLibrary from './CreativeLibrary';
import { listCatalogIngredients, createCatalogIngredient, getCatalogFacets, setCatalogIngredientLock, getCatalogIngredientCards, getCatalogIngredientDetails, attachCatalogIngredientGeneratedImage, listCatalogStories, joinCatalogStory } from '../services/apiCatalog';
import { draftCatalogStoryMember } from '../services/api';
import { listCatalogTypes } from '../services/apiCatalogTypes';

const renderLibrary = (libraryId, entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <CreativeLibrary libraryId={libraryId} />
  </MemoryRouter>,
);

describe('CreativeLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCatalogIngredientCards.mockReset().mockResolvedValue([]);
    setCatalogIngredientLock.mockReset();
    listCatalogTypes.mockResolvedValue([]);
    listCatalogStories.mockResolvedValue({ stories: [] });
    getCatalogFacets.mockResolvedValue({
      types: [{ type: 'character', count: 2 }],
      universes: [{ refId: 'u-1', name: 'Example Universe', count: 3 }],
    });
  });

  it('lists only its type, links tiles to the library detail route, and shows canon images and usage', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [
      { id: 'cat-chr-1', type: 'character', name: 'Ada', payload: { primaryImageRef: 'ada.png' }, thumbnailKey: null, usage: { universe: 1, 'music-video': 2 } },
      { id: 'cat-chr-2', type: 'character', name: 'Bo', payload: {}, thumbnailKey: 'bo.png', usage: {} },
    ] });
    renderLibrary('casting', '/casting');

    const ada = await screen.findByRole('link', { name: /Ada/ });
    expect(ada).toHaveAttribute('href', '/casting/cat-chr-1?returnTo=%2Fcasting');
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', '/data/image-thumbnails/ada.webp');
    expect(screen.getByRole('img', { name: 'Bo' })).toHaveAttribute('src', '/data/image-thumbnails/bo.webp');
    expect(screen.getByText('1 universe · 2 videos')).toBeInTheDocument();
    expect(screen.getByText('No linked containers')).toBeInTheDocument();
    expect(listCatalogIngredients).toHaveBeenCalledWith(expect.objectContaining({ type: 'character', offset: 0 }));
  });

  it('keeps confirmed card locks when another page appends older copies of the loaded records', async () => {
    const items = Array.from({ length: 48 }, (_, index) => ({ id: `example-${index}`, type: 'character', name: `Example ${index}`, payload: { locked: false } }));
    listCatalogIngredients.mockResolvedValueOnce({ items }).mockResolvedValueOnce({ items: [{ id: 'last', type: 'character', name: 'Last', payload: {} }] });
    setCatalogIngredientLock.mockResolvedValue({ ...items[0], payload: { locked: true } });
    renderLibrary('casting', '/casting?scope=example-world');
    fireEvent.click(await screen.findByRole('button', { name: 'Lock Example 0' }));
    await screen.findByRole('button', { name: 'Unlock Example 0' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Open Last' });
    expect(screen.getByRole('button', { name: 'Unlock Example 0' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Example 0' })).toHaveAttribute('href', '/casting/example-0?returnTo=%2Fcasting%3Fscope%3Dexample-world');
  });

  it('accepts newer overlapping page rows when the visible character IDs stay the same', async () => {
    const items = Array.from({ length: 48 }, (_, index) => ({ id: `example-${index}`, type: 'character', name: `Example ${index}`, payload: {}, updatedAt: '2026-10-20T00:00:00Z' }));
    listCatalogIngredients.mockResolvedValueOnce({ items }).mockResolvedValueOnce({ items: [{ ...items[0], name: 'Fresh name', thumbnailKey: 'fresh.png', owningUniverse: { name: 'Fresh universe' }, updatedAt: '2026-10-21T00:00:00Z' }] });
    renderLibrary('casting', '/casting');
    await screen.findByRole('link', { name: 'Open Example 0' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Open Fresh name' });
    expect(screen.getByRole('img', { name: 'Fresh name' })).toHaveAttribute('src', '/data/image-thumbnails/fresh.webp');
    expect(screen.getByText('Universe: Fresh universe')).toBeInTheDocument();
    expect(getCatalogIngredientCards).not.toHaveBeenCalled();
  });

  it('keeps a concurrently selected cover when an older lock closure confirms, then refreshes bounded card context', async () => {
    const item = { id: 'example', type: 'character', name: 'Example', payload: { locked: false }, thumbnailKey: 'old.png' };
    listCatalogIngredients.mockResolvedValue({ items: [item] });
    const lock = Promise.withResolvers();
    const after = Promise.withResolvers();
    setCatalogIngredientLock.mockImplementation(() => lock.promise);
    getCatalogIngredientCards.mockResolvedValueOnce([{ ...item, thumbnailKey: 'chosen.png' }]).mockImplementationOnce(() => after.promise);
    renderLibrary('casting', '/casting');
    fireEvent.click(await screen.findByRole('button', { name: 'Lock Example' }));
    await act(async () => socketEvents.get('catalog:primitive-changed')({ ingredientId: item.id }));
    expect(screen.getByRole('img', { name: 'Example' })).toHaveAttribute('src', '/data/image-thumbnails/chosen.webp');
    await act(async () => lock.resolve({ ...item, payload: { locked: true } }));
    expect(screen.getByRole('img', { name: 'Example' })).toHaveAttribute('src', '/data/image-thumbnails/chosen.webp');
    expect(screen.getByRole('button', { name: 'Unlock Example' })).toBeInTheDocument();
    await act(async () => after.resolve([{ ...item, payload: { locked: true }, thumbnailKey: 'chosen.png' }]));
    expect(getCatalogIngredientCards).toHaveBeenCalledWith([item.id], { silent: true });
  });

  it('scopes to a universe or to unlinked records from the URL', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    renderLibrary('environments', '/environments?scope=u-1');
    await waitFor(() => expect(listCatalogIngredients).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'place', refKind: 'universe', refId: 'u-1' }),
    ));
    expect(await screen.findByText('No environments match this filter.')).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Not in a universe' }))[0]);
    await waitFor(() => expect(listCatalogIngredients).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'place', unlinked: true }),
    ));
  });

  it.each([['environments', 'place'], ['casting', 'character']])('shows the confirmed generated portrait instead of the previous reference cover in %s', async (library, type) => {
    const item = { id: 'example-record', type, name: 'Example Record', thumbnailKey: 'previous-reference.png', payload: {} };
    listCatalogIngredients.mockResolvedValue({ items: [item] });
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: item, media: [{ kind: 'reference', mediaKey: 'previous-reference.png' }] });
    attachCatalogIngredientGeneratedImage.mockResolvedValue({ media: { mediaKey: 'new-cover.png', kind: 'portrait' }, kind: 'portrait', attached: true });
    renderLibrary(library, `/${library}`);
    expect(await screen.findByRole('img', { name: item.name })).toHaveAttribute('src', '/data/image-thumbnails/previous-reference.webp');

    fireEvent.click(screen.getByRole('button', { name: `Generate image for ${item.name}` }));

    await waitFor(() => expect(screen.getByRole('img', { name: item.name })).toHaveAttribute('src', '/data/image-thumbnails/new-cover.webp'));
    expect(attachCatalogIngredientGeneratedImage).toHaveBeenCalledWith(item.id, { mediaKey: 'new-cover.png' }, { silent: true });
  });

  // Uniquely catches a render the server filed as a reference (another writer
  // set the portrait meanwhile) being shown as the card cover.
  it('keeps the current cover when the server files the render as a reference', async () => {
    const item = { id: 'example-record', type: 'place', name: 'Example Record', thumbnailKey: 'previous-reference.png', payload: {} };
    listCatalogIngredients.mockResolvedValue({ items: [item] });
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: item, media: [{ kind: 'reference', mediaKey: 'previous-reference.png' }] });
    attachCatalogIngredientGeneratedImage.mockResolvedValue({ media: { mediaKey: 'new-cover.png', kind: 'reference' }, kind: 'reference', attached: true });
    renderLibrary('environments', '/environments');
    expect(await screen.findByRole('img', { name: item.name })).toHaveAttribute('src', '/data/image-thumbnails/previous-reference.webp');

    fireEvent.click(screen.getByRole('button', { name: `Generate image for ${item.name}` }));

    await waitFor(() => expect(attachCatalogIngredientGeneratedImage).toHaveBeenCalledWith(item.id, { mediaKey: 'new-cover.png' }, { silent: true }));
    expect(screen.getByRole('img', { name: item.name })).toHaveAttribute('src', '/data/image-thumbnails/previous-reference.webp');
  });

  it.each([['environments', 'place'], ['casting', 'character']])('yields a generated cover to a newer authoritative portrait in %s', async (library, type) => {
    const items = Array.from({ length: 48 }, (_, index) => ({ id: `example-${index}`, type, name: `Example ${index}`, payload: {}, thumbnailKey: 'previous-reference.png', updatedAt: '2026-10-20T00:00:00Z' }));
    listCatalogIngredients.mockResolvedValueOnce({ items }).mockResolvedValueOnce({ items: [{ ...items[0], thumbnailKey: 'chosen-portrait.png', updatedAt: '2026-10-21T00:00:00Z' }] });
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: items[0], media: [{ kind: 'reference', mediaKey: 'previous-reference.png' }] });
    attachCatalogIngredientGeneratedImage.mockResolvedValue({ media: { mediaKey: 'new-cover.png', kind: 'portrait' }, kind: 'portrait', attached: true });
    renderLibrary(library, `/${library}`);
    await screen.findByRole('img', { name: 'Example 0' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image for Example 0' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Example 0' })).toHaveAttribute('src', '/data/image-thumbnails/new-cover.webp'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Example 0' })).toHaveAttribute('src', '/data/image-thumbnails/chosen-portrait.webp'));
  });

  it('creates a record of its type and opens it', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    createCatalogIngredient.mockResolvedValue({ id: 'cat-obj-9', type: 'object', name: 'Reel can' });
    renderLibrary('objects', '/objects');

    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    await screen.findByRole('option', { name: 'Example Universe' });
    fireEvent.change(screen.getByLabelText(/Owning universe/), { target: { value: 'u-1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reel can' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Dented tin.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/objects/cat-obj-9'));
    expect(createCatalogIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'object', name: 'Reel can', payload: { description: 'Dented tin.' } }),
      { silent: true },
    );
  });

  it('creates cast with picked family relationships', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    createCatalogIngredient.mockResolvedValue({ id: 'cat-chr-9', type: 'character', name: 'Example Mother' });
    renderLibrary('casting', '/casting');

    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    await screen.findByRole('option', { name: 'Example Universe' });
    fireEvent.change(screen.getByLabelText(/Owning universe/), { target: { value: 'u-1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example Mother' } });
    fireEvent.change(screen.getByLabelText('Example Mother is the'), { target: { value: 'mother-of' } });
    listCatalogIngredients.mockResolvedValue({ items: [{ id: 'cat-chr-nora', type: 'character', name: 'Nora', payload: {} }] });
    fireEvent.click(screen.getByRole('button', { name: 'Pick cast' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByText('Nora'));
    expect(await screen.findByRole('button', { name: 'Remove Mother of Nora' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/casting/cat-chr-9'));
    expect(createCatalogIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'character', name: 'Example Mother', relations: [{ kind: 'mother-of', toId: 'cat-chr-nora' }] }),
      { silent: true },
    );
  });

  // The story filter lists a storyboard's members (its refs and panel cast)
  // and offers creating cast that joins it.
  it('narrows to a story in the universe and drafts new cast that joins it', async () => {
    const story = { kind: 'storyboard', id: 'sb-1', name: 'Example Story', universeIds: ['u-1'], count: 1, joinable: true };
    listCatalogStories.mockResolvedValue({ stories: [story, { kind: 'music-video', id: 'mv-2', name: 'Other Video', universeIds: ['u-9'], count: 0, joinable: false }] });
    listCatalogIngredients.mockResolvedValue({ items: [] });
    draftCatalogStoryMember.mockResolvedValue({ draft: { name: 'Example Rival', content: 'Green cap.' }, sentPrompt: 'full prompt', promptAdditions: [], providerId: 'example', model: 'example-model' });
    createCatalogIngredient.mockResolvedValue({ id: 'cat-chr-9', type: 'character', name: 'Example Rival' });
    joinCatalogStory.mockResolvedValue({ role: 'cast' });
    renderLibrary('casting', '/casting?scope=u-1&story=storyboard:sb-1');

    expect(await screen.findByRole('heading', { name: 'Example Story' })).toBeInTheDocument();
    await waitFor(() => expect(listCatalogIngredients).toHaveBeenCalledWith(expect.objectContaining({ type: 'character', refKind: 'storyboard', refId: 'sb-1' })));
    expect(screen.queryByRole('button', { name: /Other Video/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'New from prompt' })[1]);
    fireEvent.change(await screen.findByLabelText('Describe the cast member'), { target: { value: 'A rival skater.' } });
    expect(screen.getByLabelText('Joins story')).toHaveValue('storyboard:sb-1');
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Example Rival'));
    expect(draftCatalogStoryMember).toHaveBeenCalledWith(expect.objectContaining({ type: 'character', universeId: 'u-1', storyKind: 'storyboard', storyId: 'sb-1', prompt: 'A rival skater.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to Example Story' }));

    await waitFor(() => expect(joinCatalogStory).toHaveBeenCalledWith('storyboard', 'sb-1', 'cat-chr-9', { silent: true }));
    expect(createCatalogIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'character', name: 'Example Rival', universeId: 'u-1', payload: { physicalDescription: 'Green cap.' } }), { silent: true });
  });

  it('renders section navigation tabs with the current library active', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    renderLibrary('casting', '/casting');
    await act(async () => {});
    expect(screen.getByRole('tab', { name: 'Casting' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Environments' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Objects' })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }));
    expect(navigateMock).toHaveBeenCalledWith('/objects');
  });
});
