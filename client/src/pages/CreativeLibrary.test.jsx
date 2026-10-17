import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
  createCatalogIngredient: vi.fn(),
  getCatalogFacets: vi.fn(),
}));
vi.mock('../services/apiCatalogTypes', () => ({ listCatalogTypes: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/MediaImage', () => ({
  default: ({ src, alt, ...rest }) => <img src={src} alt={alt} {...rest} />,
}));

import CreativeLibrary from './CreativeLibrary';
import { listCatalogIngredients, createCatalogIngredient, getCatalogFacets } from '../services/apiCatalog';
import { listCatalogTypes } from '../services/apiCatalogTypes';

const renderLibrary = (libraryId, entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <CreativeLibrary libraryId={libraryId} />
  </MemoryRouter>,
);

describe('CreativeLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(ada).toHaveAttribute('href', '/casting/cat-chr-1');
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', '/data/images/ada.png');
    expect(screen.getByRole('img', { name: 'Bo' })).toHaveAttribute('src', '/data/images/bo.png');
    expect(screen.getByText('1 universe · 2 videos')).toBeInTheDocument();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(listCatalogIngredients).toHaveBeenCalledWith(expect.objectContaining({ type: 'character', offset: 0 }));
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

  it('creates a record of its type and opens it', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [] });
    createCatalogIngredient.mockResolvedValue({ id: 'cat-obj-9', type: 'object', name: 'Reel can' });
    renderLibrary('objects', '/objects');

    fireEvent.click(await screen.findByRole('button', { name: /New/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reel can' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Dented tin.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/objects/cat-obj-9'));
    expect(createCatalogIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'object', name: 'Reel can', payload: { description: 'Dented tin.' } }),
      { silent: true },
    );
  });
});
