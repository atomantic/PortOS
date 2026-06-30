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

vi.mock('../services/apiSystem', () => ({ generateImage: vi.fn() }));
// The editable-prompt panel lazily fetches the linked universe to layer its
// style preset onto the composed prompt; default to "no universe" so the seed
// renders bare unless a test overrides it.
vi.mock('../services/apiUniverseBuilder', () => ({ getUniverse: vi.fn(async () => null) }));
// Stand-in for the live image-gen thumb: fire onFilename as soon as a jobId is
// handed in, simulating a completed render without the socket/job machinery.
vi.mock('../components/pipeline/MediaJobThumb', async () => {
  const { useEffect } = await import('react');
  // A jobId of 'fail-job' simulates a failed render (drives onStatus); any other
  // id simulates a completed render (drives onFilename).
  function MockMediaJobThumb({ jobId, onFilename, onStatus }) {
    useEffect(() => {
      if (!jobId) return;
      if (jobId === 'fail-job') onStatus?.('failed');
      else onFilename?.(`${jobId}.png`);
    }, [jobId, onFilename, onStatus]);
    return null;
  }
  return { default: MockMediaJobThumb };
});
vi.mock('../services/apiImageVideo', () => ({ listImageGallery: vi.fn(async () => []) }));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
vi.mock('../components/MediaImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));
vi.mock('../components/TagPicker', () => ({ default: () => <div data-testid="tag-picker" /> }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CatalogIngredient, { buildGenerationPromptSeed } from './CatalogIngredient';
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

  it('composes the prompt from name + visual fields + tags, then renders and sets the portrait', async () => {
    const { generateImage } = await import('../services/apiSystem');
    const { setCatalogIngredientPortrait } = await import('../services/apiCatalog');
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    setCatalogIngredientPortrait.mockResolvedValue({});
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    // Step 1: open the editor — the prompt prefills with the composed seed.
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the image to render/i)).toBeTruthy());
    const promptBox = screen.getByPlaceholderText(/Describe the image to render/i);
    await waitFor(() => expect(promptBox.value).toMatch(/Ada Lovelace/));
    // Composed from the name + the type's visual fields + the ingredient's tags.
    expect(promptBox.value).toMatch(/Sharp eyes/);
    expect(promptBox.value).toMatch(/mentor/);

    // Step 2: render the (possibly-edited) prompt.
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [genPayload] = generateImage.mock.calls[0];
    expect(genPayload.prompt).toMatch(/Ada Lovelace/);
    expect(genPayload.prompt).toMatch(/Sharp eyes/);
    expect(genPayload.catalogIngredientId).toBe('cat-chr-1');
    // The MediaJobThumb stub fires onFilename → with no existing portrait the
    // render is attached as THE portrait.
    await waitFor(() => expect(setCatalogIngredientPortrait).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'job-1.png' }, { silent: true },
    ));
  });

  it('attaches a synchronously-returned image (external mode, no jobId)', async () => {
    const { generateImage } = await import('../services/apiSystem');
    const { setCatalogIngredientPortrait } = await import('../services/apiCatalog');
    generateImage.mockResolvedValue({ filename: 'ext.png' }); // external SD-API: no jobId
    setCatalogIngredientPortrait.mockResolvedValue({});
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toBeTruthy());
    // Wait for the async prefill so Render is enabled before clicking.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));

    await waitFor(() => expect(setCatalogIngredientPortrait).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'ext.png' }, { silent: true },
    ));
  });

  it('re-enables Generate after a failed render (does not get stuck)', async () => {
    const { generateImage } = await import('../services/apiSystem');
    generateImage.mockResolvedValue({ jobId: 'fail-job' });
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));
    // The MediaJobThumb stub drives onStatus('failed') for 'fail-job'; the
    // control must clear the job, close the editor, and re-enable Generate
    // rather than hang on "Generating…".
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^Generate$/i });
      expect(btn).toHaveProperty('disabled', false);
    });
  });

  it('disables Render until a prompt is present (no description → name-only prefill still renders)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      tags: [],
      payload: { role: 'Mentor' }, // no physicalDescription/description/summary
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/i })).toBeTruthy());
    // Generate is always enabled now — it opens the editor so the user can
    // compose a prompt even when no visual seed exists.
    expect(screen.getByRole('button', { name: /^Generate$/i })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    // The name still seeds the prompt, so Render becomes enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    const promptBox = screen.getByPlaceholderText(/Describe the image to render/i);
    expect(promptBox.value).toMatch(/Ada Lovelace/);

    // Clearing the prompt disables Render.
    fireEvent.change(promptBox, { target: { value: '   ' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', true));
  });

  it('collapses a sheet section when its header is clicked', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('she/her')).toBeTruthy());
    fireEvent.click(screen.getByText('Identity'));
    await waitFor(() => expect(screen.queryByDisplayValue('she/her')).toBeNull());
  });

  // The universe style-preset layering is the headline "stays on-model" feature
  // — pin that the linked universe is fetched by its refId and its embrace/avoid
  // tokens reach the composed prompt + negative, not just the null path.
  it('layers the linked universe style preset onto the composed prompt and negative', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    const { generateImage } = await import('../services/apiSystem');
    getUniverse.mockResolvedValue({
      influences: { embrace: ['neon noir', 'rain-slick streets'], avoid: ['cartoon', 'flat colors'] },
    });
    // No clearMocks config — clear prior tests' calls so calls[0] is this render's.
    generateImage.mockClear();
    generateImage.mockResolvedValue({ jobId: 'job-uni' });
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    // Preset embrace tokens prepend the subject prompt (diffusion weights earliest
    // tokens heaviest) — see composeStyledPrompt.
    await waitFor(() => expect(promptBox.value).toMatch(/neon noir/));
    expect(promptBox.value).toMatch(/Ada Lovelace/);
    // Fetched by the ingredient's universe refId, silently (no error toast).
    expect(getUniverse).toHaveBeenCalledWith('u-1', { silent: true });

    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [payload] = generateImage.mock.calls[0];
    expect(payload.prompt).toMatch(/neon noir/);
    // Universe avoid tokens become the render's negative prompt.
    expect(payload.negativePrompt).toMatch(/cartoon/);
    getUniverse.mockResolvedValue(null); // restore default for any later test
  });

  // Regression: the textarea is editable during the awaited universe fetch, so a
  // user typing before it resolves must NOT have their input clobbered by the
  // async prefill (codex review). Deferred getUniverse controls the race window.
  it('does not overwrite a prompt the user typed during the universe prefill', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    let resolveUniverse;
    getUniverse.mockImplementation(() => new Promise((res) => { resolveUniverse = res; }));
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    // User types before the universe fetch resolves.
    fireEvent.change(promptBox, { target: { value: 'my hand-written prompt' } });
    // Now the fetch resolves with a universe whose preset would otherwise overwrite.
    resolveUniverse({ influences: { embrace: ['neon noir'], avoid: [] } });
    // The user's text survives — the prefill is skipped because the field is dirty.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render$/i })).toHaveProperty('disabled', false));
    expect(promptBox.value).toBe('my hand-written prompt');
    expect(promptBox.value).not.toMatch(/neon noir/);
    getUniverse.mockResolvedValue(null); // restore default
  });
});

describe('buildGenerationPromptSeed', () => {
  const charType = { primaryContentKey: 'physicalDescription' };

  it('folds every populated visual field together in order', () => {
    const seed = buildGenerationPromptSeed({
      physicalDescription: 'Sharp eyes',
      visualNotes: 'ink-stained cuffs',
      visualIdentity: 'brass goggles',
    }, charType);
    expect(seed).toBe('Sharp eyes. ink-stained cuffs. brass goggles');
  });

  it('dedupes the primaryContentKey against the visual keys (no double-render)', () => {
    // physicalDescription is BOTH the primary key and a visual key — it must
    // only appear once.
    const seed = buildGenerationPromptSeed({ physicalDescription: 'Once only' }, charType);
    expect(seed).toBe('Once only');
  });

  it('appends string tags as comma-joined prompt tokens after the seed', () => {
    const seed = buildGenerationPromptSeed(
      { physicalDescription: 'Sharp eyes' }, charType, ['mentor', 'My Cool Universe'],
    );
    expect(seed).toBe('Sharp eyes. mentor, My Cool Universe');
  });

  it('falls back to tags alone when no visual field is present', () => {
    expect(buildGenerationPromptSeed({ role: 'Mentor' }, charType, ['villain'])).toBe('villain');
  });

  it('falls back to description / summary when the primary visual key is absent', () => {
    expect(buildGenerationPromptSeed({ description: 'A quiet place' }, { primaryContentKey: 'name' }))
      .toBe('A quiet place');
    expect(buildGenerationPromptSeed({ summary: 'In brief' }, null)).toBe('In brief');
  });

  it('ignores non-string and blank tags', () => {
    const seed = buildGenerationPromptSeed(
      { physicalDescription: 'Sharp eyes' }, charType, ['  ', 42, null, 'real'],
    );
    expect(seed).toBe('Sharp eyes. real');
  });

  it('tolerates a non-array tags argument', () => {
    expect(buildGenerationPromptSeed({ physicalDescription: 'Sharp eyes' }, charType, 'nope'))
      .toBe('Sharp eyes');
  });

  it('returns an empty string when nothing usable is present', () => {
    expect(buildGenerationPromptSeed({ role: 'Mentor' }, charType, [])).toBe('');
    expect(buildGenerationPromptSeed(null, null, [])).toBe('');
  });

  it('caps an overly long seed with an ellipsis (≤ 700 chars)', () => {
    const seed = buildGenerationPromptSeed({ physicalDescription: 'x'.repeat(900) }, charType);
    expect(seed.length).toBeLessThanOrEqual(700);
    expect(seed.endsWith('…')).toBe(true);
  });
});
