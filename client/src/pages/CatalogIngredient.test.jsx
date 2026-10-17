/**
 * Render tests for the CatalogIngredient character-sheet editor.
 *
 * Locks the enriched-sheet behavior: grouped sections expose the canon scalar
 * fields, read-only canon arrays (color palette, stats) render, and the
 * reference-sheet panel shows an existing sheet / a render deep-link.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

// Stable navigate mock — returning a fresh vi.fn() per call would change the
// load effect's dependency identity every render and re-fire the fetch, which
// races the second test in this file into a stuck "loading" state.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: () => {} }));
vi.mock('react-router', async (io) => {
  const actual = await io();
  return { ...actual, useNavigate: () => navigateMock };
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
  linkCatalogIngredientRelation: vi.fn(),
  unlinkCatalogIngredientRelation: vi.fn(),
  listCatalogIngredientRevisions: vi.fn(async () => ({ items: [] })),
  restoreCatalogIngredientRevision: vi.fn(),
  uploadCatalogIngredientMediaFile: vi.fn(),
  listCatalogIngredientMedia: vi.fn(async () => []),
  listCatalogIngredientMissingMedia: vi.fn(async () => ({ missing: [] })),
  attachCatalogIngredientMedia: vi.fn(),
  setCatalogIngredientPortrait: vi.fn(),
  detachCatalogIngredientMedia: vi.fn(),
  listCatalogSheetVariants: vi.fn(async () => ({ variants: [] })),
  previewCatalogSheet: vi.fn(async () => ({ preview: null })),
  renderCatalogSheet: vi.fn(),
}));
// Universe-delegated sheet renders announce completion on this broadcast.
const { socketHandlers } = vi.hoisted(() => ({ socketHandlers: new Map() }));
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => socketHandlers.set(event, fn),
    off: (event) => socketHandlers.delete(event),
  },
}));

vi.mock('../services/apiSystem', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn(async () => ({ types: [] })),
}));
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
vi.mock('../services/apiImageVideo', () => ({
  listImageGalleryPage: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 60 })),
  // Echo the request as the "sent" prompt, with its declared additions as chips.
  previewImagePrompt: vi.fn(async (body) => ({
    sentPrompt: body.prompt,
    ...(body.negativePrompt ? { sentNegativePrompt: body.negativePrompt } : {}),
    promptAdditions: body.promptAdditions || [],
  })),
}));
vi.mock('../components/IngredientPicker', () => ({ default: () => null }));
vi.mock('../components/MediaImage', () => ({ default: ({ src, alt, fallbackSrc }) => <img src={src} alt={alt} data-fallback-src={fallbackSrc} /> }));
vi.mock('../components/loraTraining/CharacterLoraChip', () => ({ default: () => null }));
vi.mock('../components/TagPicker', () => ({
  default: ({ value = [], onChange }) => (
    <button
      type="button"
      onClick={() => onChange(value.includes('example-tag')
        ? value.filter((tag) => tag !== 'example-tag')
        : [...value, 'example-tag'])}
    >
      Change tag
    </button>
  ),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CatalogIngredient, { buildGenerationPromptSeed } from './CatalogIngredient';
import { getCatalogIngredientDetails, unlinkCatalogIngredientRelation, updateCatalogIngredient, detachCatalogIngredientMedia, restoreCatalogIngredientRevision, uploadCatalogIngredientMediaFile } from '../services/apiCatalog';
import toast from '../components/ui/Toast';

const renderPage = async (path = '/catalog/character/cat-chr-1') => {
  const router = createMemoryRouter([
    { path: '/catalog', element: <div>Catalog index</div> },
    { path: '/catalog/:type/:id', element: <CatalogIngredient /> },
    { path: '/casting', element: <div>Casting index</div> },
    { path: '/casting/:id/:tab?', element: <CatalogIngredient /> },
    { path: '/objects/:id/:tab?', element: <CatalogIngredient /> },
    { path: '/environments/:id/:tab?', element: <CatalogIngredient /> },
  ], { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  await act(async () => {});
  return { ...result, router };
};

beforeEach(() => {
  getCatalogIngredientDetails.mockImplementation(async () => detailsOf(CHAR_FIXTURE));
  updateCatalogIngredient.mockReset();
  unlinkCatalogIngredientRelation.mockReset();
  detachCatalogIngredientMedia.mockReset();
  restoreCatalogIngredientRevision.mockReset();
  uploadCatalogIngredientMediaFile.mockReset();
});

describe('CatalogIngredient — character sheet', () => {
  it('reports a rejected file read and re-enables the upload control', async () => {
    await renderPage();
    const fileInput = document.querySelector('input[type="file"][accept="image/*,audio/*,video/*"]');
    const unreadable = { name: 'example.png', type: 'image/png', arrayBuffer: vi.fn().mockRejectedValue(new Error('File unavailable')) };

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [unreadable] } });
      await Promise.resolve();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('File unavailable'));
    await waitFor(() => expect(fileInput).toBeEnabled());
    expect(uploadCatalogIngredientMediaFile).not.toHaveBeenCalled();
  });

  it('keeps revision restore confirmation open when restore fails', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      revisions: [
        { id: 'rev-latest', source: 'save', name: 'Current', createdAt: '2026-10-17T00:00:00Z' },
        { id: 'rev-old', source: 'save', name: 'Earlier', createdAt: '2026-10-16T00:00:00Z' },
      ],
    }));
    restoreCatalogIngredientRevision.mockRejectedValue(new Error('Restore failed'));
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    const confirmation = screen.getByRole('group', { name: 'Confirm restore of Earlier' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Restore failed'));
    expect(confirmation).toBeInTheDocument();
    expect(confirmation.querySelector('button')).toHaveTextContent('Restore');
  });

  // The h1 is the ONLY place the ingredient's name appears on this route, and
  // clipped text is neither selectable nor expandable — the tooltip is the sole
  // access path to the rest of a long name on a phone (#5694).
  it('exposes the full record name through the heading title attribute', async () => {
    const longName = 'Augusta Ada King, Countess of Lovelace, Analytical Engine Programmer and Mathematician';
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({ ...CHAR_FIXTURE, name: longName }));
    await renderPage();

    const heading = await screen.findByRole('heading', { name: longName });
    expect(heading.getAttribute('title')).toBe(longName);
  });

  it('requires confirmation before detaching media', async () => {
    detachCatalogIngredientMedia.mockResolvedValue({});
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      media: [{ mediaKey: 'portrait.png', kind: 'portrait' }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Detach' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    expect(detachCatalogIngredientMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Detach', exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detach', exact: true }));
    await waitFor(() => expect(detachCatalogIngredientMedia).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'portrait.png', kind: 'portrait' }, { silent: true },
    ));
  });

  it('requires confirmation before removing an outbound relation', async () => {
    unlinkCatalogIngredientRelation.mockResolvedValue({});
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(CHAR_FIXTURE),
      relations: {
        outbound: [{
          fromId: CHAR_FIXTURE.id,
          toId: 'cat-place-1',
          kind: 'lives-at',
          other: { id: 'cat-place-1', name: 'Example Place', type: 'place' },
        }],
        inbound: [],
      },
    }));
    await renderPage();

    const removeButton = await screen.findByRole('button', { name: 'Remove relation to Example Place' });
    fireEvent.click(removeButton);
    expect(unlinkCatalogIngredientRelation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(unlinkCatalogIngredientRelation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove relation to Example Place' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation to Example Place' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(unlinkCatalogIngredientRelation).toHaveBeenCalledWith(
      CHAR_FIXTURE.id,
      { toId: 'cat-place-1', kind: 'lives-at' },
      { silent: true },
    ));
    await waitFor(() => expect(screen.queryByText('Example Place')).toBeNull());
  });

  describe('unsaved changes', () => {
    it('tracks name, tags, and payload edits in the unsaved indicator', async () => {
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      const tagButton = screen.getByRole('button', { name: 'Change tag' });

      expect(screen.queryByText('Unsaved changes')).toBeNull();

      fireEvent.change(nameInput, { target: { value: 'Edited ingredient' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      fireEvent.change(nameInput, { target: { value: CHAR_FIXTURE.name } });
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());

      fireEvent.click(tagButton);
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      fireEvent.click(tagButton);
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());

      fireEvent.change(descriptionInput, { target: { value: 'Edited description' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('confirms before the Back link discards dirty edits', async () => {
      const { router } = await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Edited ingredient' } });

      fireEvent.click(screen.getByRole('link', { name: /Back/ }));
      expect(await screen.findByText('Discard your unsaved changes to this ingredient?')).toBeTruthy();
      expect(screen.queryByText('Catalog index')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByText('Discard your unsaved changes to this ingredient?')).toBeNull());
      expect(router.state.location.pathname).toBe('/catalog/character/cat-chr-1');

      fireEvent.click(screen.getByRole('link', { name: /Back/ }));
      expect(await screen.findByText('Discard your unsaved changes to this ingredient?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(await screen.findByText('Catalog index')).toBeTruthy();
    });

    it('clears the unsaved indicator after a successful save', async () => {
      updateCatalogIngredient.mockResolvedValue({ ...CHAR_FIXTURE, name: 'Saved ingredient' });
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Saved ingredient' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    it('keeps edits typed during a save and submits them on the next save', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      const tagButton = screen.getByRole('button', { name: 'Change tag' });

      fireEvent.change(nameInput, { target: { value: 'First draft' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      fireEvent.change(nameInput, { target: { value: 'Newer draft' } });
      fireEvent.change(descriptionInput, { target: { value: 'Newer description' } });
      fireEvent.click(tagButton);

      await act(async () => finishSave({ ...CHAR_FIXTURE, name: 'First draft' }));
      expect(nameInput.value).toBe('Newer draft');
      expect(descriptionInput.value).toBe('Newer description');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      updateCatalogIngredient.mockResolvedValueOnce({
        ...CHAR_FIXTURE, name: 'Newer draft', tags: [...CHAR_FIXTURE.tags, 'example-tag'],
        payload: { ...CHAR_FIXTURE.payload, physicalDescription: 'Newer description' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(2));
      expect(updateCatalogIngredient.mock.calls[1][1]).toMatchObject({
        name: 'Newer draft', tags: [...CHAR_FIXTURE.tags, 'example-tag'],
        payload: { physicalDescription: 'Newer description' },
      });
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    it('applies server normalization only to fields unchanged since submission', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      const descriptionInput = screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.');
      fireEvent.change(nameInput, { target: { value: '  Normalized name  ' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      fireEvent.change(descriptionInput, { target: { value: 'Unsaved description' } });

      await act(async () => finishSave({
        ...CHAR_FIXTURE, name: 'Normalized name', tags: ['Mentor'],
      }));
      expect(nameInput.value).toBe('Normalized name');
      expect(descriptionInput.value).toBe('Unsaved description');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      updateCatalogIngredient.mockResolvedValueOnce({
        ...CHAR_FIXTURE, name: 'Normalized name', tags: ['Mentor'],
        payload: { ...CHAR_FIXTURE.payload, physicalDescription: 'Unsaved description' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(2));
      expect(updateCatalogIngredient.mock.calls[1][1].tags).toEqual(['Mentor']);
    });

    it('keeps the draft dirty after a failed save', async () => {
      let failSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
      await renderPage();
      const nameInput = await screen.findByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'Unsaved draft' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      await act(async () => failSave(new Error('Save failed')));
      expect(nameInput.value).toBe('Unsaved draft');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('ignores a save response after switching records and returning', async () => {
      let finishSave;
      updateCatalogIngredient.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
      getCatalogIngredientDetails.mockImplementation(async (id) => detailsOf({
        ...CHAR_FIXTURE, id, name: id === 'cat-chr-1' ? 'First ingredient' : 'Second ingredient',
      }));
      const { router } = await renderPage();
      await screen.findByDisplayValue('First ingredient');
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      await act(async () => router.navigate('/catalog/character/cat-chr-2'));
      await screen.findByDisplayValue('Second ingredient');
      await act(async () => router.navigate('/catalog/character/cat-chr-1'));
      await screen.findByDisplayValue('First ingredient');

      await act(async () => finishSave({ ...CHAR_FIXTURE, name: 'Stale response' }));
      expect(screen.getByLabelText('Name').value).toBe('First ingredient');
      expect(screen.queryByText('Stale response')).toBeNull();
    });
  });

  it('renders grouped sheet sections with the enriched canon scalar fields', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());
    expect(screen.getByText('Identity')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('Goals & Drives')).toBeTruthy();
    expect(screen.getByDisplayValue('she/her')).toBeTruthy();
    expect(screen.getByDisplayValue('Decode the machine.')).toBeTruthy();
    expect(screen.getByDisplayValue('Being underestimated.')).toBeTruthy();
  });

  it('shows additional stored canon read-only on a locked character and preserves it on an unrelated save', async () => {
    const character = {
      ...CHAR_FIXTURE, name: 'Example courier',
      payload: {
        ...CHAR_FIXTURE.payload, locked: true,
        ghost: 'Lost the first dispatch.', want: 'Deliver the final letter.', arcType: 'positive',
        secrets: ['Keeps a duplicate map.'], sliders: { proactivity: 0, competence: null },
        psychology: { assessment: 'unknown', assessmentNote: 'The narrator cannot read this mind.',
          drives: { connection: { desire: 'A place at the table.' } } },
        props: [{ name: 'Compass', purpose: 'Find the route.', materials: 'Brass', notes: 'One dent.' }],
        expressions: [{ name: 'Alert', description: 'Eyes follow every doorway.' }],
        handGestures: [{ name: 'Wait', description: 'Palm held forward.' }],
        relationshipLinks: [{ targetCharacterId: 'chr-example-guide', type: 'ally', description: 'Shared a crossing.' }],
        voiceCanon: { description: 'Low and steady.', approved: false, pronunciations: [{ term: 'Example', pronunciation: 'ig-ZAM-pul' }] },
        firstAppearance: 'Opening chapter', missingFromProse: ['The compass origin.'],
        futureCanon: { retained: true },
      },
    };
    getCatalogIngredientDetails.mockResolvedValue(detailsOf(character));
    updateCatalogIngredient.mockImplementation(async (_id, patch) => ({ ...character, ...patch }));
    await renderPage('/casting/cat-chr-1/profile');
    const panel = screen.getByRole('region', { name: 'Additional character canon' });
    const canon = within(panel);
    for (const value of ['Lost the first dispatch.', 'Deliver the final letter.', 'Keeps a duplicate map.', '0',
      'unknown', 'The narrator cannot read this mind.', 'A place at the table.', 'Compass',
      'Eyes follow every doorway.', 'Palm held forward.', 'chr-example-guide', 'Low and steady.',
      'Candidate', 'ig-ZAM-pul', 'Opening chapter', 'The compass origin.']) {
      expect(canon.getByText(value)).toBeInTheDocument();
    }
    expect(canon.getByText(/Materials: Brass/)).toBeInTheDocument();
    expect(canon.queryByRole('textbox')).not.toBeInTheDocument();
    expect(canon.queryByText('Competence')).not.toBeInTheDocument();
    expect(canon.queryByText(/futureCanon|retained/)).not.toBeInTheDocument();
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example route keeper' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledWith(character.id,
      expect.objectContaining({ name: 'Example route keeper', payload: character.payload }), expect.anything()));
  });

  it('preserves an explicit not-applicable assessment and safely skips malformed optional canon', async () => {
    getCatalogIngredientDetails.mockResolvedValue(detailsOf({
      ...CHAR_FIXTURE,
      payload: { ...CHAR_FIXTURE.payload, ghost: { invalid: true }, secrets: [null, {}],
        props: [null, {}, { name: { invalid: true } }], expressions: 'invalid', handGestures: [false],
        relationshipLinks: [null], voiceCanon: [], sliders: { competence: false },
        psychology: { assessment: 'not-applicable', drives: { survival: null } } },
    }));
    await renderPage();
    const canon = within(screen.getByRole('region', { name: 'Additional character canon' }));
    expect(canon.getByText('not-applicable')).toBeInTheDocument();
    expect(canon.queryByRole('button', { name: 'Props' })).not.toBeInTheDocument();
    expect(canon.queryByText(/\[object Object\]|false|invalid/)).not.toBeInTheDocument();
  });

  it('does not invent additional canon for an unfilled legacy character', async () => {
    await renderPage();
    expect(screen.queryByRole('region', { name: 'Additional character canon' })).not.toBeInTheDocument();
  });

  it('shows a stored generation prompt for a legacy character with no other canon details', async () => {
    getCatalogIngredientDetails.mockResolvedValue(detailsOf({
      ...CHAR_FIXTURE, payload: { prompt: 'An example courier in a blue coat, standing beside a milestone.' },
    }));
    await renderPage();
    const canon = within(screen.getByRole('region', { name: 'Additional character canon' }));
    expect(canon.getByText('Generation prompt')).toBeInTheDocument();
    expect(canon.getByText('An example courier in a blue coat, standing beside a milestone.')).toBeInTheDocument();
    expect(canon.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it.each([
    ['nested canon', { psychology: { strategy: 'Takes the long route.' } }, 'Psychology'],
    ['array fields', { aliases: ['Example alias'] }, 'Aliases'],
    ['previously absent fields', { notes: '' }, 'Notes'],
  ])('reports revision changes to %s even when editable scalar text matches', async (_label, changed, fieldLabel) => {
    getCatalogIngredientDetails.mockResolvedValue({
      ...detailsOf(CHAR_FIXTURE),
      revisions: [{ ...CHAR_FIXTURE, id: 'rev-1', source: 'user', payload: { ...CHAR_FIXTURE.payload, ...changed } }],
    });
    await renderPage();
    const history = within(screen.getByRole('heading', { name: /Revision history/ }).closest('section'));
    fireEvent.click(history.getByRole('button'));
    expect(history.queryByText('Identical to the current saved state.')).not.toBeInTheDocument();
    expect(history.getByText('Additional fields changed')).toBeInTheDocument();
    expect(history.getByText(fieldLabel)).toBeInTheDocument();
  });

  it('recognizes an identical complete revision despite object key order', async () => {
    const payload = { ...CHAR_FIXTURE.payload, psychology: { strategy: 'Waits.', assessment: 'unknown' } };
    const revisionPayload = { ...payload, psychology: { assessment: 'unknown', strategy: 'Waits.' } };
    getCatalogIngredientDetails.mockResolvedValue({
      ...detailsOf({ ...CHAR_FIXTURE, payload }),
      revisions: [{ ...CHAR_FIXTURE, id: 'rev-1', source: 'user', payload: revisionPayload }],
    });
    await renderPage();
    const history = within(screen.getByRole('heading', { name: /Revision history/ }).closest('section'));
    fireEvent.click(history.getByRole('button'));
    expect(history.getByText('Identical to the current saved state.')).toBeInTheDocument();
  });

  it('shows the source scrap by TITLE (not the bare id) and links to it, with siblings from the same source (#7617)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      sources: [{
        scrapId: 'cat-scrap-abc123',
        scrapTitle: 'Notebook Page Three',
        extractedAt: '2026-01-01T00:00:00.000Z',
        siblings: [{ id: 'cat-plc-1', name: 'Sibling Place', type: 'place' }],
      }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Notebook Page Three')).toBeTruthy());
    // Never the raw id — that's the bug this issue fixes.
    expect(screen.queryByText('cat-scrap-abc123')).toBeNull();
    const scrapLink = screen.getByText('Notebook Page Three').closest('a');
    expect(scrapLink.getAttribute('href')).toBe('/catalog?scrap=cat-scrap-abc123');
    // The sibling extraction from the same source scrap is listed and links to
    // its own detail page.
    expect(screen.getByText('From the same source')).toBeTruthy();
    const siblingLink = screen.getByText('Sibling Place').closest('a');
    expect(siblingLink.getAttribute('href')).toBe('/environments/cat-plc-1');
  });

  it('renders no "From the same source" stub for a solo extraction or a manually-created ingredient (#7617)', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      sources: [{ scrapId: 'cat-scrap-solo', scrapTitle: 'Lone Page', extractedAt: null, siblings: [] }],
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Lone Page')).toBeTruthy());
    expect(screen.queryByText('From the same source')).toBeNull();

    // No source scrap at all (created manually) — the existing message, no stub.
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({ ...CHAR_FIXTURE, sources: [] }));
    await renderPage();
    await waitFor(() => expect(screen.getByText('Created manually — no source scrap.')).toBeTruthy());
    expect(screen.queryByText('From the same source')).toBeNull();
  });

  it('renders EDITABLE array editors (color palette + stats + aliases) seeded from payload', async () => {
    await renderPage();
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
    await renderPage();
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
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Render in Universe Builder/i)).toBeTruthy());
    const link = screen.getByText(/Render in Universe Builder/i).closest('a');
    expect(link.getAttribute('href')).toContain('/universes/u-1');
  });

  it('shows an existing reference sheet image when payload carries one', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf({
      ...CHAR_FIXTURE,
      payload: { ...CHAR_FIXTURE.payload, referenceSheetImageRef: 'sheet-123.png' },
    }));
    await renderPage();
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
    await renderPage();
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
    await renderPage();
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
    await renderPage();
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
    await renderPage();
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
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('she/her')).toBeTruthy());
    fireEvent.click(screen.getByText('Identity'));
    await waitFor(() => expect(screen.queryByDisplayValue('she/her')).toBeNull());
  });

  // #11317: the box holds only the record's own words. The linked universe's
  // style rides beside it as a labeled addition, the preview shows the exact
  // composed text, and the render sends that same composed request.
  it('keeps the universe style out of the prompt box and sends it as a labeled addition', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    const { generateImage } = await import('../services/apiSystem');
    getUniverse.mockResolvedValue({
      influences: { embrace: ['neon noir', 'rain-slick streets'], avoid: ['cartoon', 'flat colors'] },
    });
    // No clearMocks config — clear prior tests' calls so calls[0] is this render's.
    generateImage.mockClear();
    generateImage.mockResolvedValue({ jobId: 'job-uni' });
    await renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Sharp eyes, ink-stained cuffs.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    // Fetched by the ingredient's universe refId, silently (no error toast).
    expect(getUniverse).toHaveBeenCalledWith('u-1', { silent: true });
    // The preview names the universe style as a chip once the universe loads.
    fireEvent.click(await screen.findByRole('button', { name: '+ Universe style' }));
    expect(screen.getByText(/neon noir, rain-slick streets/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Style negatives' })).toBeTruthy();
    // The editable prompt is only the record's own seed — no preset tokens.
    expect(promptBox.value).toBe('Ada Lovelace: Sharp eyes, ink-stained cuffs.. mentor, My Cool Universe');
    expect(screen.getByLabelText(/Negative prompt/).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /^Render$/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [payload] = generateImage.mock.calls[0];
    expect(payload.prompt).toMatch(/^neon noir, rain-slick streets\. Ada Lovelace: Sharp eyes/);
    expect(payload.negativePrompt).toMatch(/cartoon/);
    expect(payload.promptAdditions.map((addition) => addition.label)).toEqual(['Universe style', 'Style negatives']);
    getUniverse.mockResolvedValue(null); // restore default for any later test
  });

  // Regression: the textarea is editable during the awaited universe fetch, so a
  // user typing before it resolves must NOT have their input clobbered by the
  // async prefill (codex review). Deferred getUniverse controls the race window.
  it('does not overwrite a prompt the user typed during the universe prefill', async () => {
    const { getUniverse } = await import('../services/apiUniverseBuilder');
    let resolveUniverse;
    getUniverse.mockImplementation(() => new Promise((res) => { resolveUniverse = res; }));
    await renderPage();
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

  it('attributes relation evidence only to the matching outbound kind and target', async () => {
    const fixtureWithRelations = {
      ...CHAR_FIXTURE,
      payload: {
        ...CHAR_FIXTURE.payload,
        evidence: [
          'owned-by → Pocket Watch: Ada carries this golden pocket watch everywhere',
          'used-by → Pocket Watch: Ada times experiments with the watch',
          'used-by → Analytical Engine: Ada programmed the engine with punch cards',
        ],
      },
    };
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf(fixtureWithRelations),
      relations: {
        outbound: [
          {
            toId: 'cat-obj-1',
            kind: 'owned-by',
            other: { id: 'cat-obj-1', name: 'Pocket Watch', type: 'object' },
          },
          {
            toId: 'cat-obj-1',
            kind: 'used-by',
            other: { id: 'cat-obj-1', name: 'Pocket Watch', type: 'object' },
          },
        ],
        inbound: [
          {
            fromId: 'cat-obj-2',
            kind: 'used-by',
            other: { id: 'cat-obj-2', name: 'Analytical Engine', type: 'object' },
          },
        ],
      },
    }));

    await renderPage();

    // Outbound uses getRelationKind('owned-by').label -> "Owned by" (appears in select option + relation list)
    const ownedByElements = await screen.findAllByText('Owned by');
    expect(ownedByElements.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Pocket Watch')).toHaveLength(2);
    expect(screen.getAllByText(/Ada carries this golden pocket watch everywhere/)).toHaveLength(2);
    expect(screen.getAllByText(/Ada times experiments with the watch/)).toHaveLength(2);

    // Inbound uses getRelationKind('used-by').inverseLabel -> "Uses"
    expect(screen.getByText('Uses')).toBeTruthy();
    expect(screen.getByText('Analytical Engine')).toBeTruthy();
    // This ingredient's evidence cannot ground a relation owned by another ingredient.
    expect(screen.getAllByText(/Ada programmed the engine with punch cards/)).toHaveLength(1);

    // SourcesPanel grounded evidence
    expect(screen.getByText('Grounded evidence')).toBeTruthy();
  });
});

describe('CatalogIngredient — tabbed library record pages', () => {
  const HERO = {
    id: 'cat-chr-hero',
    type: 'character',
    name: 'Example Hero',
    tags: [],
    payload: {
      physicalDescription: 'Tall, green cloak.',
      referenceSheetImageRef: 'hero-standard.png',
      referenceSheets: { expressions: 'hero-expressions.png' },
      wardrobes: [{ id: 'wardrobe-1', name: 'Red scarf', description: 'Long red wool scarf.', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    },
    refs: [{ refKind: 'universe', refId: 'u-example', refName: 'Example Universe' }],
    sources: [],
  };
  const MEDIA = [
    { mediaKey: 'portrait.png', kind: 'portrait', role: null },
    { mediaKey: 'mood.png', kind: 'reference', role: null },
    { mediaKey: 'sheet-1.png', kind: 'reference', role: 'sheet:standard' },
    { mediaKey: 'plate-1.png', kind: 'reference', role: 'plate' },
    { mediaKey: 'look-1.png', kind: 'reference', role: 'look:wardrobe-1' },
  ];
  const SHEET_VARIANTS = [
    { id: 'standard', label: 'Standard turnaround', description: 'Front, side and back views.' },
    { id: 'expressions', label: 'Expression sheet', description: 'Six expressions.' },
  ];

  beforeEach(async () => {
    const api = await import('../services/apiCatalog');
    getCatalogIngredientDetails.mockImplementation(async () => ({ ...detailsOf(HERO), media: MEDIA }));
    api.listCatalogSheetVariants.mockImplementation(async () => ({ variants: SHEET_VARIANTS }));
    api.previewCatalogSheet.mockImplementation(async (_id, body) => ({
      preview: {
        sentPrompt: `Example style. ${body.variant} sheet of Example Hero`,
        promptAdditions: [{ id: 'universe-style', label: 'Universe style', text: 'Example style.' }],
      },
    }));
    api.renderCatalogSheet.mockReset();
    api.attachCatalogIngredientMedia.mockReset();
    socketHandlers.clear();
  });

  it('shows universe pointer sheets and sheet media on /casting/:id/sheets', async () => {
    await renderPage('/casting/cat-chr-hero/sheets');
    expect(await screen.findByRole('tab', { name: /Sheets/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByAltText('standard reference sheet').getAttribute('src')).toBe('/data/image-refs/hero-standard.png');
    expect(screen.getByAltText('expressions reference sheet').getAttribute('src')).toBe('/data/image-refs/hero-expressions.png');
    await waitFor(() => expect(screen.getByAltText('Standard turnaround').getAttribute('src')).toBe('/data/images/sheet-1.png'));
    // Sheets don't carry the profile form or the general media panel.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByAltText('mood.png')).toBeNull();
  });

  it('shows existing canon images on References even when no catalog media is attached', async () => {
    getCatalogIngredientDetails.mockResolvedValue(detailsOf({
      ...HERO, payload: { ...HERO.payload, locked: true,
        imageRefs: ['existing.png', 'existing.png', null, {}], primaryImageRef: 'existing.png' },
    }));
    await renderPage('/casting/cat-chr-hero/references');
    expect(screen.getAllByAltText('Example Hero canon reference')).toHaveLength(1);
    expect(screen.getByAltText('Example Hero canon reference')).toHaveAttribute('src', '/data/images/existing.png');
    expect(screen.getByAltText('Example Hero canon reference')).toHaveAttribute('data-fallback-src', '/data/image-refs/existing.png');
    expect(screen.getByText('Primary canon reference')).toBeInTheDocument();
    expect(screen.queryByText(/No media yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Detach', exact: true })).not.toBeInTheDocument();
    const api = await import('../services/apiCatalog');
    expect(api.attachCatalogIngredientMedia).not.toHaveBeenCalled();
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
  });

  it('does not repeat canon images already attached in a media role', async () => {
    getCatalogIngredientDetails.mockResolvedValue({
      ...detailsOf({ ...HERO, payload: { ...HERO.payload, imageRefs: ['mood.png', 'sheet-1.png', 'canon-only.png'] } }),
      media: MEDIA,
    });
    await renderPage('/casting/cat-chr-hero/references');
    const images = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(images.filter((src) => src === '/data/images/mood.png')).toHaveLength(1);
    expect(images.filter((src) => src === '/data/images/canon-only.png')).toHaveLength(1);
    expect(images).not.toContain('/data/images/sheet-1.png');
  });

  it('previews the chosen variant and posts it on Generate, then attaches the finished sheet', async () => {
    const api = await import('../services/apiCatalog');
    api.renderCatalogSheet.mockResolvedValue({ jobId: 'sheet-job', variant: 'expressions', role: 'sheet:expressions', delegatedTo: null });
    api.attachCatalogIngredientMedia.mockResolvedValue({});
    await renderPage('/casting/cat-chr-hero/sheets');

    fireEvent.change(await screen.findByLabelText('Sheet kind'), { target: { value: 'expressions' } });
    expect(screen.getByText('Six expressions.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '+ Universe style' })).toBeTruthy();
    await waitFor(() => expect(api.previewCatalogSheet).toHaveBeenLastCalledWith(
      'cat-chr-hero', { variant: 'expressions' }, { silent: true },
    ));

    fireEvent.click(screen.getByRole('button', { name: /Generate sheet/ }));
    await waitFor(() => expect(api.renderCatalogSheet).toHaveBeenCalledWith(
      'cat-chr-hero', { variant: 'expressions' }, { silent: true },
    ));
    expect(toast.success).toHaveBeenCalledWith('Rendering Expression sheet…');
    // The MediaJobThumb stub completes the job; the sheet attaches under its role.
    await waitFor(() => expect(api.attachCatalogIngredientMedia).toHaveBeenCalledWith(
      'cat-chr-hero', { mediaKey: 'sheet-job.png', kind: 'reference', role: 'sheet:expressions' }, { silent: true },
    ));
  });

  it('refreshes canon pointers when a universe-delegated sheet is announced ready', async () => {
    const api = await import('../services/apiCatalog');
    api.renderCatalogSheet.mockResolvedValue({ jobId: 'canon-job', variant: 'standard', delegatedTo: 'universe' });
    await renderPage('/casting/cat-chr-hero/sheets');
    fireEvent.click(await screen.findByRole('button', { name: /Generate sheet/ }));
    await waitFor(() => expect(socketHandlers.has('reference-sheet:changed')).toBe(true));
    expect(api.attachCatalogIngredientMedia).not.toHaveBeenCalled();

    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf({ ...HERO, payload: { ...HERO.payload, referenceSheetImageRef: 'hero-standard-v2.png' } }),
      media: MEDIA,
    }));
    await act(async () => {
      socketHandlers.get('reference-sheet:changed')({ jobId: 'canon-job', status: 'ready' });
    });
    await waitFor(() => expect(screen.getByAltText('standard reference sheet').getAttribute('src'))
      .toBe('/data/image-refs/hero-standard-v2.png'));
  });

  it('keeps an unsaved name edit across tab switches without a discard prompt', async () => {
    const { router } = await renderPage('/casting/cat-chr-hero');
    const nameInput = await screen.findByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Example Hero Renamed' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    await act(async () => { await router.navigate('/casting/cat-chr-hero/sheets'); });
    expect(router.state.location.pathname).toBe('/casting/cat-chr-hero/sheets');
    expect(screen.queryByText(/Discard your unsaved changes/)).toBeNull();
    // A dirty profile gates the render, which reads the saved record.
    expect(await screen.findByRole('button', { name: /Generate sheet/ })).toBeDisabled();

    await act(async () => { await router.navigate('/casting/cat-chr-hero'); });
    expect(screen.getByLabelText('Name').value).toBe('Example Hero Renamed');

    // Leaving the record is still guarded.
    await act(async () => { await router.navigate('/casting'); });
    expect(router.state.location.pathname).toBe('/casting/cat-chr-hero');
  });

  it('falls back to Profile for an unknown tab', async () => {
    await renderPage('/casting/cat-chr-hero/nonsense');
    expect(await screen.findByRole('tab', { name: /Profile/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Name').value).toBe('Example Hero');
  });

  it('lists only reference media on References (no sheets, plates, or looks)', async () => {
    await renderPage('/casting/cat-chr-hero/references');
    await waitFor(() => expect(screen.getByAltText('portrait')).toBeTruthy());
    const srcs = screen.getAllByRole('img').map((img) => img.getAttribute('src'));
    expect(srcs).toContain('/data/images/mood.png');
    expect(srcs).not.toContain('/data/images/sheet-1.png');
    expect(srcs).not.toContain('/data/images/plate-1.png');
    expect(srcs).not.toContain('/data/images/look-1.png');
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  describe('Looks tab', () => {
    // Catches the look render losing its wardrobe id or attaching under a role
    // the Looks tab does not read back.
    it('lists looks with their images, previews a look and renders it under its look role', async () => {
      const api = await import('../services/apiCatalog');
      api.renderCatalogSheet.mockResolvedValue({ jobId: 'look-job', variant: 'look', role: 'look:wardrobe-1', delegatedTo: null });
      api.attachCatalogIngredientMedia.mockResolvedValue({});
      await renderPage('/casting/cat-chr-hero/looks');
      expect(await screen.findByRole('tab', { name: /Looks/ })).toHaveAttribute('aria-selected', 'true');
      const card = screen.getByRole('article', { name: 'Look: Red scarf' });
      expect(card.textContent).toContain('Long red wool scarf.');
      await waitFor(() => expect(screen.getByAltText('Red scarf').getAttribute('src')).toBe('/data/images/look-1.png'));

      fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
      expect(await screen.findByRole('button', { name: '+ Universe style' })).toBeTruthy();
      expect(api.previewCatalogSheet).toHaveBeenLastCalledWith(
        'cat-chr-hero', { variant: 'look', wardrobeId: 'wardrobe-1' }, { silent: true },
      );
      fireEvent.click(screen.getByRole('button', { name: /Render look/ }));
      await waitFor(() => expect(api.renderCatalogSheet).toHaveBeenCalledWith(
        'cat-chr-hero', { variant: 'look', wardrobeId: 'wardrobe-1' }, { silent: true },
      ));
      await waitFor(() => expect(api.attachCatalogIngredientMedia).toHaveBeenCalledWith(
        'cat-chr-hero', { mediaKey: 'look-job.png', kind: 'reference', role: 'look:wardrobe-1' }, { silent: true },
      ));
    });

    // Catches a look save dropping the rest of the saved payload, reusing or
    // omitting ids, or failing to show the new look.
    it('adds a look by saving payload.wardrobes with a stamped wd- id and the rest of the payload intact', async () => {
      const added = { id: 'wd-new', name: 'Travel coat', description: 'Grey wool coat.' };
      updateCatalogIngredient.mockImplementation(async (_id, patch) => ({
        ...HERO, payload: { ...patch.payload, wardrobes: [HERO.payload.wardrobes[0], added] },
      }));
      await renderPage('/casting/cat-chr-hero/looks');
      fireEvent.click(await screen.findByRole('button', { name: /Add look/ }));
      fireEvent.change(screen.getByLabelText('Look name'), { target: { value: 'Travel coat' } });
      fireEvent.change(screen.getByLabelText('Outfit description'), { target: { value: 'Grey wool coat.' } });
      fireEvent.click(screen.getByRole('button', { name: /Save look/ }));

      await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
      const [id, patch] = updateCatalogIngredient.mock.calls[0];
      expect(id).toBe('cat-chr-hero');
      expect(patch.payload.physicalDescription).toBe('Tall, green cloak.');
      expect(patch.payload.wardrobes[0]).toEqual(HERO.payload.wardrobes[0]);
      expect(patch.payload.wardrobes[1]).toMatchObject({ name: 'Travel coat', description: 'Grey wool coat.' });
      expect(patch.payload.wardrobes[1].id).toMatch(/^wd-[0-9a-f-]{36}$/);
      expect(await screen.findByRole('article', { name: 'Look: Travel coat' })).toBeTruthy();
      expect(screen.queryByText('Unsaved changes')).toBeNull();
    });

    // Catches a deleted look stranding its images under a role no tab shows.
    it('deletes a look and leaves its images on References', async () => {
      updateCatalogIngredient.mockImplementation(async (_id, patch) => ({ ...HERO, payload: patch.payload }));
      const { router } = await renderPage('/casting/cat-chr-hero/looks');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Red scarf' }));
      expect(screen.getByText(/Its images move to References/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Delete look' }));
      await waitFor(() => expect(updateCatalogIngredient.mock.calls[0]?.[1].payload.wardrobes).toEqual([]));
      await waitFor(() => expect(screen.queryByRole('article', { name: 'Look: Red scarf' })).toBeNull());

      await act(async () => { await router.navigate('/casting/cat-chr-hero/references'); });
      await waitFor(() => expect(screen.getAllByRole('img').map((img) => img.getAttribute('src')))
        .toContain('/data/images/look-1.png'));
    });
  });

  it('marks a reference image as a plate on the environment Plates tab', async () => {
    const api = await import('../services/apiCatalog');
    api.attachCatalogIngredientMedia.mockResolvedValue({ mediaKey: 'mood.png', kind: 'reference', role: 'plate' });
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf({ ...HERO, id: 'cat-plc-1', type: 'place', name: 'Example Harbor', payload: {}, refs: [] }),
      media: MEDIA.filter((m) => m.mediaKey !== 'look-1.png'),
    }));
    await renderPage('/environments/cat-plc-1/plates');
    expect(await screen.findByRole('button', { name: 'Unmark plate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as plate' }));
    await waitFor(() => expect(api.attachCatalogIngredientMedia).toHaveBeenCalledWith(
      'cat-plc-1', { mediaKey: 'mood.png', kind: 'reference', role: 'plate', caption: null }, { silent: true },
    ));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Unmark plate' })).toHaveLength(2));
  });

  it('keeps /catalog/:type/:id untabbed with every panel on one page', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({
      ...detailsOf({ id: 'cat-idea-1', type: 'idea', name: 'Example Idea', tags: [], payload: {}, refs: [], sources: [] }),
      media: MEDIA,
    }));
    await renderPage('/catalog/idea/cat-idea-1');
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { name: /Media/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Relations' })).toBeTruthy();
  });

  it('prefills the image prompt with only the record\'s own words', async () => {
    getCatalogIngredientDetails.mockImplementation(async () => ({ ...detailsOf({ ...HERO, refs: [] }), media: [] }));
    await renderPage('/casting/cat-chr-hero/references');
    fireEvent.click(await screen.findByRole('button', { name: /^Generate$/i }));
    const promptBox = await screen.findByPlaceholderText(/Describe the image to render/i);
    expect(promptBox.value).toBe('Example Hero: Tall, green cloak.');
    expect(screen.getByLabelText(/Negative prompt/).value).toBe('');
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


describe('contextual unlock in Create libraries', () => {
  it.each([['objects', 'object'], ['environments', 'place'], ['casting', 'character']])(
    'preserves draft edits and sheet selection in %s and renders only on request', async (library, type) => {
      const api = await import('../services/apiCatalog');
      const locked = { id: 'example-locked', type, name: 'Example locked record', tags: [], payload: { locked: true, description: 'Saved description' }, refs: [] };
      let persisted = locked;
      getCatalogIngredientDetails.mockImplementation(async () => detailsOf(persisted));
      updateCatalogIngredient.mockImplementation(async (_id, patch) => {
        persisted = { ...persisted, ...patch, updatedAt: '2026-01-01T00:00:01Z' };
        return persisted;
      });
      api.listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'standard', label: 'Standard' }, { id: 'alternate', label: 'Alternate' }] });
      api.renderCatalogSheet.mockReset().mockResolvedValue({ jobId: 'example-sheet-job', variant: 'alternate' });
      api.attachCatalogIngredientMedia.mockResolvedValue({});
      const { router } = await renderPage(`/${library}/example-locked/profile`);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved draft name' } });
      await act(async () => router.navigate(`/${library}/example-locked/sheets`));
      const picker = await screen.findByLabelText('Sheet kind');
      fireEvent.change(picker, { target: { value: 'alternate' } });
      expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
      await screen.findByText(/Unlocked. Choose Generate/);
      expect(picker).toHaveValue('alternate');
      expect(api.renderCatalogSheet).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeDisabled();
      expect(updateCatalogIngredient).toHaveBeenCalledWith('example-locked', { payload: { ...locked.payload, locked: false } }, { silent: true });
      await act(async () => router.navigate(`/${library}/example-locked/profile`));
      expect(screen.getByLabelText('Name')).toHaveValue('Unsaved draft name');
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(persisted.name).toBe('Unsaved draft name'));
      await act(async () => router.navigate(`/${library}/example-locked/sheets`));
      await waitFor(() => expect(screen.getByRole('button', { name: /Generate sheet/ })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: /Generate sheet/ }));
      await waitFor(() => expect(api.renderCatalogSheet).toHaveBeenCalledTimes(1));
    },
  );
});
