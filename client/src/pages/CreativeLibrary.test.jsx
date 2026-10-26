import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
  setCatalogIngredientPortrait: vi.fn(),
}));
vi.mock('../components/catalog/GenerateImageControl', () => ({
  default: ({ name, onComplete }) => <button type="button" onClick={() => onComplete('new-cover.png')}>Generate image for {name}</button>,
}));
vi.mock('../services/apiCatalogTypes', () => ({ listCatalogTypes: vi.fn() }));
vi.mock('../services/apiUniverseBuilder', () => ({ listUniverseNames: vi.fn(async () => [{ id: 'u-1', name: 'Example Universe' }]) }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/MediaImage', () => ({
  default: ({ src, alt, ...rest }) => <img src={src} alt={alt} {...rest} />,
}));

import CreativeLibrary from './CreativeLibrary';
import { listCatalogIngredients, createCatalogIngredient, getCatalogFacets, setCatalogIngredientLock, getCatalogIngredientCards, getCatalogIngredientDetails, setCatalogIngredientPortrait } from '../services/apiCatalog';
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
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', '/data/images/ada.png');
    expect(screen.getByRole('img', { name: 'Bo' })).toHaveAttribute('src', '/data/images/bo.png');
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
    expect(screen.getByRole('img', { name: 'Fresh name' })).toHaveAttribute('src', '/data/images/fresh.png');
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
    expect(screen.getByRole('img', { name: 'Example' })).toHaveAttribute('src', '/data/images/chosen.png');
    await act(async () => lock.resolve({ ...item, payload: { locked: true } }));
    expect(screen.getByRole('img', { name: 'Example' })).toHaveAttribute('src', '/data/images/chosen.png');
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

    fireEvent.click(await screen.findByRole('button', { name: 'Not in a universe' }));
    await waitFor(() => expect(listCatalogIngredients).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'place', unlinked: true }),
    ));
  });

  it.each([['environments', 'place'], ['casting', 'character']])('shows the confirmed generated portrait instead of the previous reference cover in %s', async (library, type) => {
    const item = { id: 'example-record', type, name: 'Example Record', thumbnailKey: 'previous-reference.png', payload: {} };
    listCatalogIngredients.mockResolvedValue({ items: [item] });
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: item, media: [{ kind: 'reference', mediaKey: 'previous-reference.png' }] });
    setCatalogIngredientPortrait.mockResolvedValue({ mediaKey: 'new-cover.png', kind: 'portrait' });
    renderLibrary(library, `/${library}`);
    expect(await screen.findByRole('img', { name: item.name })).toHaveAttribute('src', '/data/images/previous-reference.png');

    fireEvent.click(screen.getByRole('button', { name: `Generate image for ${item.name}` }));

    await waitFor(() => expect(screen.getByRole('img', { name: item.name })).toHaveAttribute('src', '/data/images/new-cover.png'));
    expect(setCatalogIngredientPortrait).toHaveBeenCalledWith(item.id, { mediaKey: 'new-cover.png' }, { silent: true });
  });

  it.each([['environments', 'place'], ['casting', 'character']])('yields a generated cover to a newer authoritative portrait in %s', async (library, type) => {
    const items = Array.from({ length: 48 }, (_, index) => ({ id: `example-${index}`, type, name: `Example ${index}`, payload: {}, thumbnailKey: 'previous-reference.png', updatedAt: '2026-10-20T00:00:00Z' }));
    listCatalogIngredients.mockResolvedValueOnce({ items }).mockResolvedValueOnce({ items: [{ ...items[0], thumbnailKey: 'chosen-portrait.png', updatedAt: '2026-10-21T00:00:00Z' }] });
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: items[0], media: [{ kind: 'reference', mediaKey: 'previous-reference.png' }] });
    setCatalogIngredientPortrait.mockResolvedValue({ mediaKey: 'new-cover.png', kind: 'portrait' });
    renderLibrary(library, `/${library}`);
    await screen.findByRole('img', { name: 'Example 0' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image for Example 0' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Example 0' })).toHaveAttribute('src', '/data/images/new-cover.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Example 0' })).toHaveAttribute('src', '/data/images/chosen-portrait.png'));
  });

  it('creates a record of its type and opens it', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    createCatalogIngredient.mockResolvedValue({ id: 'cat-obj-9', type: 'object', name: 'Reel can' });
    renderLibrary('objects', '/objects');

    fireEvent.click(await screen.findByRole('button', { name: /New/ }));
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
