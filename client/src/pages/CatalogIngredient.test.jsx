/**
 * Render tests for the CatalogIngredient character-sheet editor.
 *
 * Locks the enriched-sheet behavior: grouped sections expose the canon scalar
 * fields, read-only canon arrays (color palette, stats) render, and the
 * reference-sheet panel shows an existing sheet / a render deep-link.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable navigate mock — returning a fresh vi.fn() per call would change the
// load effect's dependency identity every render and re-fire the fetch, which
// races the second test in this file into a stuck "loading" state.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: () => {} }));
vi.mock('react-router-dom', async (io) => {
  const actual = await io();
  return { ...actual, useParams: () => ({ id: 'cat-chr-1', type: 'character' }), useNavigate: () => navigateMock };
});

const { CHAR_FIXTURE } = vi.hoisted(() => ({
  CHAR_FIXTURE: {
    id: 'cat-chr-1',
    type: 'character',
    name: 'Ada Lovelace',
    tags: ['mentor', 'My Cool Universe'],
    payload: {
      role: 'Mentor',
      pronouns: 'she/her',
      physicalDescription: 'Sharp eyes, ink-stained cuffs.',
      motivations: 'Decode the machine.',
      dislikes: 'Being underestimated.',
      colorPalette: [{ name: 'Brass', hex: '#b08d57' }],
      stats: [{ key: 'Logic', value: '9' }],
      aliases: ['The Countess'],
    },
    refs: [{ refKind: 'universe', refId: 'u-1', refName: 'My Cool Universe', role: 'canon-character' }],
    sources: [],
  },
}));

vi.mock('../services/apiCatalog', () => ({
  getCatalogIngredient: vi.fn(async () => CHAR_FIXTURE),
  updateCatalogIngredient: vi.fn(),
  deleteCatalogIngredient: vi.fn(),
  listCatalogIngredientRelations: vi.fn(async () => ({ outbound: [], inbound: [] })),
  linkCatalogIngredientRelation: vi.fn(),
  unlinkCatalogIngredientRelation: vi.fn(),
  listCatalogIngredientRevisions: vi.fn(async () => ({ items: [] })),
  restoreCatalogIngredientRevision: vi.fn(),
  listCatalogIngredientMedia: vi.fn(async () => []),
  listCatalogIngredientMissingMedia: vi.fn(async () => ({ missing: [] })),
  attachCatalogIngredientMedia: vi.fn(),
  setCatalogIngredientPortrait: vi.fn(),
  detachCatalogIngredientMedia: vi.fn(),
}));

vi.mock('../services/apiImageVideo', () => ({ listImageGallery: vi.fn(async () => []) }));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
vi.mock('../components/MediaImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));
vi.mock('../components/TagPicker', () => ({ default: () => <div data-testid="tag-picker" /> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CatalogIngredient from './CatalogIngredient';
import { getCatalogIngredient } from '../services/apiCatalog';

const renderPage = () => render(<MemoryRouter><CatalogIngredient /></MemoryRouter>);

beforeEach(() => {
  getCatalogIngredient.mockImplementation(async () => CHAR_FIXTURE);
});

describe('CatalogIngredient — character sheet', () => {
  it('renders grouped sheet sections with the enriched canon scalar fields', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());
    expect(screen.getByText('Identity')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('Goals & Drives')).toBeTruthy();
    expect(screen.getByDisplayValue('she/her')).toBeTruthy();
    expect(screen.getByDisplayValue('Decode the machine.')).toBeTruthy();
    expect(screen.getByDisplayValue('Being underestimated.')).toBeTruthy();
  });

  it('renders read-only canon arrays (color palette + stats)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Color Palette')).toBeTruthy());
    expect(screen.getByText('Brass')).toBeTruthy();
    expect(screen.getByText('Logic')).toBeTruthy();
    expect(screen.getByText('The Countess')).toBeTruthy();
  });

  it('shows a render-reference-sheet deep-link when none exists and a universe ref is present', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Render in Universe Builder/i)).toBeTruthy());
    const link = screen.getByText(/Render in Universe Builder/i).closest('a');
    expect(link.getAttribute('href')).toContain('/universes/u-1');
  });

  it('shows an existing reference sheet image when payload carries one', async () => {
    getCatalogIngredient.mockImplementation(async () => ({
      ...CHAR_FIXTURE,
      payload: { ...CHAR_FIXTURE.payload, referenceSheetImageRef: 'sheet-123.png' },
    }));
    renderPage();
    await waitFor(() => {
      const img = screen.getByAltText('standard reference sheet');
      expect(img.getAttribute('src')).toBe('/data/image-refs/sheet-123.png');
    });
    expect(screen.getByText(/Re-render in Universe Builder/i)).toBeTruthy();
  });

  it('collapses a sheet section when its header is clicked', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('she/her')).toBeTruthy());
    fireEvent.click(screen.getByText('Identity'));
    await waitFor(() => expect(screen.queryByDisplayValue('she/her')).toBeNull());
  });
});
