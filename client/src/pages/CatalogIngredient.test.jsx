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
      // storyBible stats are { label, value } — the editor + durable shape
      // standardize on .label (the prior read-only renderer wrongly read .key).
      stats: [{ label: 'Logic', value: '9' }],
      aliases: ['The Countess'],
    },
    refs: [{ refKind: 'universe', refId: 'u-1', refName: 'My Cool Universe', role: 'canon-character' }],
    sources: [],
  },
}));

// The detail page now hydrates via the batched getCatalogIngredientDetails
// ({ ingredient, refs, sources, relations, revisions, media, missingMedia }).
const { detailsOf } = vi.hoisted(() => ({
  detailsOf: (ing) => ({
    ingredient: ing,
    refs: ing.refs || [],
    sources: ing.sources || [],
    relations: { outbound: [], inbound: [] },
    revisions: [],
    media: [],
    missingMedia: [],
  }),
}));

vi.mock('../services/apiCatalog', () => ({
  getCatalogIngredientDetails: vi.fn(async () => detailsOf(CHAR_FIXTURE)),
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
import { getCatalogIngredientDetails } from '../services/apiCatalog';

const renderPage = () => render(<MemoryRouter><CatalogIngredient /></MemoryRouter>);

beforeEach(() => {
  getCatalogIngredientDetails.mockImplementation(async () => detailsOf(CHAR_FIXTURE));
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

  it('renders EDITABLE array editors (color palette + stats + aliases) seeded from payload', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add color/i })).toBeTruthy());
    // Editors render their values as inputs now (editable), not static text.
    expect(screen.getByDisplayValue('Brass')).toBeTruthy();
    expect(screen.getByDisplayValue('Logic')).toBeTruthy();      // stat .label
    expect(screen.getByDisplayValue('9')).toBeTruthy();          // stat .value
    expect(screen.getByDisplayValue('The Countess')).toBeTruthy(); // alias
  });

  it('adds an alias chip, a palette swatch, and a stat row, then Save sends them in the payload', async () => {
    const { updateCatalogIngredient } = await import('../services/apiCatalog');
    updateCatalogIngredient.mockResolvedValue({ ...CHAR_FIXTURE, name: 'Ada Lovelace' });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add color/i })).toBeTruthy());

    // Add one of each list type.
    fireEvent.click(screen.getByRole('button', { name: /Add alias/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add color/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add stat/i }));

    // Fill the newly-added rows. The new alias input is the empty one (index 1).
    const aliasInputs = screen.getAllByLabelText(/^Aliases \d+$/);
    fireEvent.change(aliasInputs[aliasInputs.length - 1], { target: { value: 'Lady Byron' } });
    // New palette name input (empty) — last "Color Palette N name".
    const paletteNames = screen.getAllByLabelText(/Color Palette \d+ name/);
    fireEvent.change(paletteNames[paletteNames.length - 1], { target: { value: 'Cobalt' } });
    const paletteHexes = screen.getAllByLabelText(/Color Palette \d+ hex/);
    fireEvent.change(paletteHexes[paletteHexes.length - 1], { target: { value: '#0047ab' } });
    // New stat label/value inputs (the empty pair).
    const statLabels = screen.getAllByLabelText(/Stats \d+ label/);
    fireEvent.change(statLabels[statLabels.length - 1], { target: { value: 'Charisma' } });
    const statValues = screen.getAllByLabelText(/Stats \d+ value/);
    fireEvent.change(statValues[statValues.length - 1], { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
    const [, patch] = updateCatalogIngredient.mock.calls[0];
    // aliases array carries the original + the new one.
    expect(patch.payload.aliases).toEqual(['The Countess', 'Lady Byron']);
    // colorPalette carries the original + the new { name, hex } row.
    expect(patch.payload.colorPalette).toContainEqual({ name: 'Cobalt', hex: '#0047ab', role: '' });
    // stats carry the original + the new { label, value } row (NOT { key }).
    expect(patch.payload.stats).toContainEqual({ label: 'Charisma', value: '7' });
  });

  it('shows a render-reference-sheet deep-link when none exists and a universe ref is present', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Render in Universe Builder/i)).toBeTruthy());
    const link = screen.getByText(/Render in Universe Builder/i).closest('a');
    expect(link.getAttribute('href')).toContain('/universes/u-1');
  });

  it('shows an existing reference sheet image when payload carries one', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
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
