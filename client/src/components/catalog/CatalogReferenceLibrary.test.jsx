import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';

vi.mock('../../hooks/useMediaUsages', () => ({ useMediaUsages: () => ({}), refreshMediaUsages: () => Promise.resolve() }));
vi.mock('../../services/apiCatalog', () => ({
  updateCatalogIngredientMediaLibrary: vi.fn(async () => ({})),
  attachCatalogIngredientMediaFromMoodBoard: vi.fn(async () => ({ attached: [], skipped: [] })),
  refineCatalogMedia: vi.fn(async () => ({ jobId: 'refined-job' })),
}));
vi.mock('../../hooks/useModelInputPreview', () => ({
  useModelInputPreview: (_fn, _body, options) => options.enabled ? { preview: { sentPrompt: 'Exact sent prompt' }, error: null } : {},
}));
vi.mock('../../hooks/useMediaAnnotations', () => ({ useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn() }) }));
vi.mock('../../services/apiImageVideo', () => ({
  listImageVariants: vi.fn(async () => ({ items: [] })),
  getGalleryImages: vi.fn(async () => []),
  listMediaGalleryPage: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../media/AddToCollectionMenu', () => ({ default: () => null }));
vi.mock('../media/PinToMoodBoardMenu', () => ({ default: () => null }));
vi.mock('../media/PromptRefineModal', () => ({ default: () => null }));
vi.mock('../media/PromptFromMedia', () => ({ PromptFromMediaModal: () => null }));
vi.mock('../pipeline/MediaJobThumb', () => ({
  default: ({ jobId, onFilename, onStatus, label }) => (
    <div data-testid={`job-thumb-${jobId || 'thumb'}`}>
      <span>{label}</span>
      <button onClick={() => onFilename?.('refined.png')}>Complete refinement</button>
      <button onClick={() => onStatus?.('failed', 'Render error')}>Fail refinement</button>
    </div>
  ),
}));
const api = await import('../../services/apiCatalog');
const { default: CatalogReferenceLibrary } = await import('./CatalogReferenceLibrary.jsx');
const { CatalogImagePreviewProvider } = await import('./CatalogImagePreviewProvider.jsx');

const media = [
  { mediaKey: 'seven.png', kind: 'reference', library: { variant: { age: 7 }, guide: true, tags: ['vhs'] } },
  { mediaKey: 'seventeen.png', kind: 'reference', library: { variant: { age: 17 } } },
  { mediaKey: 'clip.mp4', kind: 'video', library: { variant: { age: 27 } } },
  { mediaKey: 'voice.m4a', kind: 'audio', library: {} },
];

describe('CatalogReferenceLibrary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selects a canonical image from the image set and marks the current choice', () => {
    const onSetPortrait = vi.fn();
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { mediaKey: 'current.png', kind: 'portrait' },
      { mediaKey: 'next.png', kind: 'reference' },
    ]} onSetPortrait={onSetPortrait} />);
    expect(screen.getByText('Canonical image')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set as canonical image' }));
    expect(onSetPortrait).toHaveBeenCalledWith('next.png');
  });

  it('lists image/video references, counts guides and filters by age and era', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={media} />);
    expect(screen.getAllByTestId('library-row')).toHaveLength(3);
    expect(screen.getByTestId('guide-count').textContent).toContain('1/4');
    fireEvent.change(screen.getByLabelText('Filter by age'), { target: { value: '17' } });
    expect(screen.getAllByTestId('library-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Filter by age'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter by era'), { target: { value: 'adult' } });
    expect(screen.getAllByTestId('library-row')).toHaveLength(1);
  });

  it('toggles a guide through the library API and refreshes', async () => {
    const onChanged = vi.fn();
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={media} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /make guide/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith('cat-chr-1', { mediaKey: 'seventeen.png', kind: 'reference', guide: true }, { silent: true });
  });

  it('puts a left-out collage back into likeness and refreshes', async () => {
    const onChanged = vi.fn();
    api.updateCatalogIngredientMediaLibrary.mockResolvedValueOnce({ mediaKey: 'board.png', kind: 'reference', library: {} });
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" onChanged={onChanged}
      media={[{ mediaKey: 'board.png', kind: 'reference', library: { likeness: false, guide: false } }]} />);
    expect(screen.getByRole('button', { name: 'Make guide' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Left out of likeness' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith('cat-chr-1',
      { mediaKey: 'board.png', kind: 'reference', likeness: true }, { silent: true });
  });

  it('disables new guides at the cap of four', () => {
    const full = [1, 2, 3, 4, 5].map((n) => ({ mediaKey: `${n}.png`, kind: 'reference', library: { guide: n <= 4 } }));
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={full} />);
    expect(screen.getByRole('button', { name: /make guide/i }).disabled).toBe(true);
  });

  it('imports mood board items with age inference', async () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[]} />);
    fireEvent.click(screen.getByText('Add from mood board', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('Mood board id'), { target: { value: 'mb-1' } });
    fireEvent.change(screen.getByLabelText('Mood board item ids'), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: /add from mood board/i }));
    await waitFor(() => expect(api.attachCatalogIngredientMediaFromMoodBoard)
      .toHaveBeenCalledWith('cat-chr-1', { boardId: 'mb-1', itemIds: ['a', 'b'], inferAge: true }, { silent: true }));
  });

  it('tags a reference with one of the saved ages/looks and filters by it', async () => {
    const forms = [{ id: 'form-kid', label: 'Age 7' }];
    const tagged = [
      { mediaKey: 'kid.png', kind: 'reference', library: { variant: { formId: 'form-kid' } } },
      { mediaKey: 'now.png', kind: 'reference', library: {} },
    ];
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={tagged} forms={forms} />);
    fireEvent.change(screen.getByLabelText('Filter by age or look'), { target: { value: 'canonical' } });
    expect(screen.getAllByTestId('library-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Age or look for now.png'), { target: { value: 'form-kid' } });
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary)
      .toHaveBeenCalledWith('cat-chr-1', { mediaKey: 'now.png', kind: 'reference', variant: { formId: 'form-kid' } }, { silent: true }));
  });

  it('keeps each preview with its metadata and filters the visuals with the cards', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={media} />);
    const cards = screen.getAllByTestId('library-row');
    expect(within(cards[0]).getByRole('img')).toHaveAttribute('src', '/data/image-thumbnails/seven.webp');
    expect(within(cards[0]).getByText(/Age 7/)).toHaveTextContent('Canonical · Age 7 · child · vhs');
    expect(cards[2].querySelector('video')).toHaveAttribute('src', '/data/videos/clip.mp4');
    fireEvent.click(screen.getByLabelText('Guides only'));
    expect(screen.getAllByTestId('library-row')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/data/image-thumbnails/seven.webp');
  });

  it('shows one control set for a visual attached as both primary and reference', async () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { kind: 'portrait', mediaKey: 'shared.png', library: { tags: ['portrait-tag'], review: { status: 'unreviewed', feedback: 'Too dark' } } },
      { kind: 'reference', mediaKey: 'shared.png', library: { variant: { age: 17, label: 'Age 17 portrait' }, tags: ['reference-tag'] } },
    ]} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    const details = screen.getByRole('group', { name: 'Details for shared.png' });
    expect(within(details).getByRole('heading', { name: 'Age 17 portrait' })).toBeInTheDocument();
    expect(within(details).getByText(/Age 17 · teen/)).toHaveTextContent('reference-tag');
    expect(within(details).getByText('portrait · reference')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Make guide' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Good' })).toHaveLength(1);
    // The guide goes on the reference only; one rating covers both attachments and keeps each one's feedback.
    fireEvent.click(within(details).getByRole('button', { name: 'Make guide' }));
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'shared.png', kind: 'reference', guide: true }, { silent: true }));
    fireEvent.click(within(details).getByRole('button', { name: 'Good' }));
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'shared.png', kind: 'portrait', review: { status: 'good', feedback: 'Too dark' } }, { silent: true }));
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'shared.png', kind: 'reference', review: { status: 'good' } }, { silent: true });
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledTimes(3);
  });

  it('clears a guide from every attachment of a visual', async () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { kind: 'portrait', mediaKey: 'shared.png', library: { guide: true } },
      { kind: 'reference', mediaKey: 'shared.png', library: { guide: true } },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledTimes(2));
    for (const kind of ['portrait', 'reference']) expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'shared.png', kind, guide: false }, { silent: true });
  });

  it('preserves per-attachment read-only provenance and counts guides outside this tab', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1"
      referenceMedia={media.slice(0, 2)}
      media={[{ ...media[0], readOnly: true }, ...media.slice(1), ...[1, 2, 3].map((n) => ({ kind: 'reference', mediaKey: `sheet-${n}.png`, library: { guide: true } }))]} />);
    expect(within(screen.getAllByTestId('library-row')[0]).queryByText('Edit reference details')).toBeNull();
    expect(screen.getByRole('button', { name: /make guide/i })).toBeDisabled();
    expect(screen.getByTestId('guide-count')).toHaveTextContent('4/4');
  });

  it('keeps an update failure visible beside the gallery', async () => {
    api.updateCatalogIngredientMediaLibrary.mockRejectedValueOnce(new Error('Reference update failed'));
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={media} />);
    fireEvent.click(screen.getByRole('button', { name: /make guide/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference update failed');
    expect(screen.getAllByTestId('library-row')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /make guide/i })).not.toBeDisabled();
  });

  it('hides editing controls when read-only', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={media} readOnly />);
    expect(screen.queryByRole('button', { name: /guide/i })).toBeNull();
  });

  it('saves exact review guidance before refining and keeps the original image while the new version runs', async () => {
    const feedback = '  Keep the face.\nShorten the adult hair.  ';
    const onChanged = vi.fn();
    let settleSave;
    api.updateCatalogIngredientMediaLibrary.mockImplementationOnce((_id, body) => new Promise(resolve => {
      settleSave = () => resolve({ mediaKey: body.mediaKey, kind: body.kind, library: { review: body.review, guide: false } });
    }));
    function Gallery() {
      const [rows, setRows] = useState([{ mediaKey: 'source.png', kind: 'reference', library: { guide: true } }]);
      return <CatalogReferenceLibrary ingredientId="cast" media={rows} onChanged={onChanged} onMediaUpdated={updated => setRows([updated])} />;
    }
    render(<Gallery />);
    // Rating an item bad drops it from the default view; refining needs it to stay visible.
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: '' } });
    fireEvent.click(screen.getByText(/Review & refine/));
    fireEvent.change(screen.getByLabelText('Reference rating'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByLabelText('Editing guidance'), { target: { value: feedback } });
    expect(screen.getByRole('button', { name: 'Refine as new version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    expect(screen.getByRole('button', { name: 'Refine as new version' })).toBeDisabled();
    await waitFor(() => expect(settleSave).toBeTypeOf('function'));
    settleSave();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refine as new version' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Make guide' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refine as new version' }));
    await waitFor(() => expect(api.refineCatalogMedia).toHaveBeenCalledWith('cast', {
      mediaKey: 'source.png', kind: 'reference', feedback,
    }, { silent: true }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/data/image-thumbnails/source.webp');
    fireEvent.click(await screen.findByRole('button', { name: 'Complete refinement' }));
    expect(onChanged).toHaveBeenCalled();
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith('cast', {
      mediaKey: 'source.png', kind: 'reference', review: { status: 'bad', feedback },
    }, { silent: true });
  });

  it('synchronizes the visible age after assigning a form without blurring the old age back to the server', async () => {
    api.updateCatalogIngredientMediaLibrary.mockImplementationOnce(async (_id, body) => ({
      mediaKey: body.mediaKey, kind: body.kind, library: { variant: body.variant },
    }));
    function Gallery() {
      const [rows, setRows] = useState([{ mediaKey: 'source.png', kind: 'reference', library: { variant: { age: 27, era: 'adult' } } }]);
      return <CatalogReferenceLibrary ingredientId="cast" media={rows} forms={[{ id: 'teen', label: 'Teen', age: '17' }]}
        onMediaUpdated={updated => setRows([updated])} />;
    }
    render(<Gallery />);
    fireEvent.change(screen.getByLabelText('Age or look for source.png'), { target: { value: 'teen' } });
    await waitFor(() => expect(screen.getByLabelText('Age for source.png')).toHaveValue(17));
    fireEvent.blur(screen.getByLabelText('Age for source.png'));
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledTimes(1);
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith('cast', {
      mediaKey: 'source.png', kind: 'reference', variant: { age: 17, era: undefined, formId: 'teen' },
    }, { silent: true });
  });

  it('renames a reference card from its details and clears back to the caption', async () => {
    api.updateCatalogIngredientMediaLibrary.mockImplementation(async (_id, body) => ({
      mediaKey: body.mediaKey, kind: body.kind, caption: 'Original caption', library: { variant: body.variant },
    }));
    function Gallery() {
      const [rows, setRows] = useState([{ mediaKey: 'source.png', kind: 'reference', caption: 'Original caption', library: { variant: { age: 27, label: 'Nora 37 old title' } } }]);
      return <CatalogReferenceLibrary ingredientId="cast" media={rows} onMediaUpdated={updated => setRows([updated])} />;
    }
    render(<Gallery />);
    const row = screen.getByTestId('library-row');
    expect(within(row).getByRole('heading', { name: 'Nora 37 old title' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title for source.png'), { target: { value: '  Nora 27 short bob ' } });
    fireEvent.blur(screen.getByLabelText('Title for source.png'));
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenLastCalledWith('cast', {
      mediaKey: 'source.png', kind: 'reference', variant: { age: 27, label: 'Nora 27 short bob' },
    }, { silent: true });
    await waitFor(() => expect(within(row).getByRole('heading', { name: 'Nora 27 short bob' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Title for source.png'), { target: { value: '' } });
    fireEvent.blur(screen.getByLabelText('Title for source.png'));
    await waitFor(() => expect(within(row).getByRole('heading', { name: 'Original caption' })).toBeInTheDocument());
    expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledTimes(2);
    api.updateCatalogIngredientMediaLibrary.mockImplementation(async () => ({}));
  });

  it('blocks refinement while the profile is unsaved while allowing review guidance to be saved', () => {
    render(<CatalogReferenceLibrary ingredientId="cast" media={[{ mediaKey: 'source.png', kind: 'reference',
      library: { review: { status: 'good', feedback: 'Preserve the face' } } }]} blockedReason="Save your profile edits first" />);
    fireEvent.change(screen.getByLabelText('Editing guidance'), { target: { value: 'Preserve the face and freckles' } });
    expect(screen.getByRole('button', { name: 'Save review' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refine as new version' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Save your profile edits first');
  });
  it('never shows a guide for a rejected duplicate portrait/reference image', () => {
    render(<CatalogReferenceLibrary ingredientId="cast" media={[
      { mediaKey: 'same.png', kind: 'portrait', library: { guide: true } },
      { mediaKey: 'same.png', kind: 'reference', library: { review: { status: 'rejected' } } },
    ]} />);
    expect(screen.getByTestId('guide-count')).toHaveTextContent('0/4');
    expect(screen.queryByRole('button', { name: 'Guide' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Make guide' }).every(button => button.disabled)).toBe(true);
    fireEvent.click(screen.getByLabelText('Guides only'));
    expect(screen.queryByTestId('library-row')).toBeNull();
  });

  it('opens references in the standard media viewer, steps with prev/next and rates then advances', async () => {
    function Gallery() {
      const [rows, setRows] = useState(['a.png', 'b.png', 'c.png'].map(mediaKey => ({ mediaKey, kind: 'reference' })));
      return <CatalogReferenceLibrary ingredientId="cat-chr-1" media={rows}
        onMediaUpdated={updated => setRows(prev => prev.map(r => r.mediaKey === updated.mediaKey ? updated : r))} />;
    }
    api.updateCatalogIngredientMediaLibrary.mockImplementation(async (_id, body) => ({ mediaKey: body.mediaKey, kind: body.kind, library: { review: body.review } }));
    // A link written before the standard viewer still opens.
    render(<MemoryRouter initialEntries={['/?preview=catalog-image%3Aimages%3Ab.png']}><CatalogImagePreviewProvider><Gallery /></CatalogImagePreviewProvider></MemoryRouter>);
    expect(await screen.findByRole('dialog', { name: 'Media viewer — b.png' })).toBeInTheDocument();
    await act(async () => {});
    fireEvent.click(screen.getAllByRole('button', { name: 'Previous media' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Media viewer — a.png' });
    await act(async () => {});
    // The page's own controls sit in the viewer beside the standard actions.
    expect(within(dialog).getByRole('button', { name: 'Film look' })).toBeInTheDocument();
    // Rating bad drops a.png from the default view and moves on to b.png.
    // The record's rating takes the viewer's standard good/bad slot.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bad' }));
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'a.png', kind: 'reference', review: { status: 'bad' } }, { silent: true }));
    expect(await screen.findByRole('dialog', { name: 'Media viewer — b.png' })).toBeInTheDocument();
    await act(async () => {});
  });

  it('removes a reference from the record (every attachment of the image) from the viewer with a second tap', async () => {
    const onDetach = vi.fn(async () => {});
    render(<MemoryRouter initialEntries={['/?preview=image%3Aa.png']}><CatalogImagePreviewProvider>
      <CatalogReferenceLibrary ingredientId="cat-chr-1" onDetach={onDetach} onSetPortrait={vi.fn()}
        media={[{ mediaKey: 'a.png', kind: 'portrait' }, { mediaKey: 'a.png', kind: 'reference' }, { mediaKey: 'b.png', kind: 'reference' }]} />
    </CatalogImagePreviewProvider></MemoryRouter>);
    const actions = within(await screen.findByTestId('page-actions'));
    await act(async () => {});
    expect(actions.getByText('Primary')).toBeInTheDocument();
    fireEvent.click(actions.getByRole('button', { name: 'Remove' }));
    expect(onDetach).not.toHaveBeenCalled();
    fireEvent.click(actions.getByRole('button', { name: 'Tap to remove' }));
    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(2));
    expect(onDetach).toHaveBeenCalledWith('a.png', 'portrait');
    expect(onDetach).toHaveBeenCalledWith('a.png', 'reference');
    await act(async () => {});
  });

  it('defaults to good and unreviewed references, hiding bad and rejected until the filter changes', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { mediaKey: 'a.png', kind: 'reference', library: { review: { status: 'good' } } },
      { mediaKey: 'b.png', kind: 'reference' },
      { mediaKey: 'c.png', kind: 'reference', library: { review: { status: 'bad' } } },
      { mediaKey: 'd.png', kind: 'reference', library: { review: { status: 'rejected' } } },
    ]} />);
    expect(screen.getAllByTestId('library-row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: '' } });
    expect(screen.getAllByTestId('library-row')).toHaveLength(4);
  });

  it('rates reference cards good or bad only, and shows a legacy rejected rating as bad', async () => {
    const onChanged = vi.fn();
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { mediaKey: 'sample.png', kind: 'reference', library: { review: { status: 'unreviewed' } } },
    ]} onChanged={onChanged} />);

    const ratingGroup = screen.getByRole('group', { name: 'Rating for sample.png' });
    const goodBtn = within(ratingGroup).getByRole('button', { name: /good/i });
    const badBtn = within(ratingGroup).getByRole('button', { name: /bad/i });
    expect(within(ratingGroup).queryByRole('button', { name: /rejected/i })).toBeNull();
    expect(screen.queryByRole('option', { name: 'rejected' })).toBeNull();

    expect(goodBtn).toHaveAttribute('aria-pressed', 'false');
    expect(badBtn).toHaveAttribute('aria-pressed', 'false');

    // Click Good
    fireEvent.click(goodBtn);
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1',
      { mediaKey: 'sample.png', kind: 'reference', review: { status: 'good' } },
      { silent: true },
    ));
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a legacy rejected reference out of the default view and lists it under bad', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { mediaKey: 'old.png', kind: 'reference', library: { review: { status: 'rejected' } } },
    ]} />);
    expect(screen.queryByTestId('library-row')).toBeNull();
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: 'bad' } });
    const ratingGroup = screen.getByRole('group', { name: 'Rating for old.png' });
    expect(within(ratingGroup).getByRole('button', { name: /bad/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reflects active rating on buttons, preserves feedback and allows toggling back to unreviewed', async () => {
    function Gallery() {
      const [rows, setRows] = useState([
        { mediaKey: 'sample.png', kind: 'reference', library: { review: { status: 'bad', feedback: 'Fix lighting' } } },
      ]);
      return <CatalogReferenceLibrary ingredientId="cat-chr-1" media={rows} onMediaUpdated={updated => setRows([updated])} />;
    }
    api.updateCatalogIngredientMediaLibrary.mockImplementationOnce(async (_id, body) => ({
      mediaKey: body.mediaKey, kind: body.kind, library: { review: body.review },
    }));

    render(<Gallery />);
    // Bad items are hidden by the default "Good & unreviewed" filter.
    expect(screen.queryByTestId('library-row')).toBeNull();
    fireEvent.change(screen.getByLabelText('Rating'), { target: { value: '' } });
    const ratingGroup = screen.getByRole('group', { name: 'Rating for sample.png' });
    const badBtn = within(ratingGroup).getByRole('button', { name: /bad/i });
    expect(badBtn).toHaveAttribute('aria-pressed', 'true');

    // Clicking bad again should toggle back to unreviewed while preserving feedback
    fireEvent.click(badBtn);
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1',
      { mediaKey: 'sample.png', kind: 'reference', review: { status: 'unreviewed', feedback: 'Fix lighting' } },
      { silent: true },
    ));
    await waitFor(() => expect(badBtn).toHaveAttribute('aria-pressed', 'false'));
  });

  it('shows static rating text and hides rating buttons in read-only mode', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { mediaKey: 'sample.png', kind: 'reference', library: { review: { status: 'good' } } },
    ]} readOnly />);

    expect(screen.queryByRole('group', { name: 'Rating for sample.png' })).toBeNull();
    expect(screen.getByText('Rating: good')).toBeInTheDocument();
  });

  it('renders pending render placeholder card in gallery and completes through onPendingRenderComplete', async () => {
    const onPendingRenderComplete = vi.fn();
    const onPendingRenderFailed = vi.fn();
    const pendingRenders = [
      { jobId: 'job-pending-1', instruction: 'make the jacket red', sourceFilename: 'orig.png' },
    ];

    const { rerender } = render(
      <CatalogReferenceLibrary
        ingredientId="cat-chr-1"
        media={[]}
        pendingRenders={pendingRenders}
        onPendingRenderComplete={onPendingRenderComplete}
        onPendingRenderFailed={onPendingRenderFailed}
      />
    );

    const pendingRow = screen.getByTestId('library-row-pending');
    expect(pendingRow).toBeInTheDocument();
    expect(within(pendingRow).getByRole('heading', { level: 4, name: 'Edit: make the jacket red' })).toBeInTheDocument();
    expect(within(pendingRow).getByText('Rendering')).toBeInTheDocument();
    expect(within(pendingRow).getByText('From orig.png')).toBeInTheDocument();
    expect(within(pendingRow).getByText('Live updating…')).toBeInTheDocument();

    // Clicking complete on the MediaJobThumb triggers onPendingRenderComplete
    fireEvent.click(within(pendingRow).getByRole('button', { name: 'Complete refinement' }));
    expect(onPendingRenderComplete).toHaveBeenCalledWith('job-pending-1', 'refined.png');

    // When the rendered image lands in media, the pending placeholder transitions out
    rerender(
      <CatalogReferenceLibrary
        ingredientId="cat-chr-1"
        media={[{ mediaKey: 'job-pending-1.png', kind: 'reference', library: { variant: { label: 'New reference' } } }]}
        pendingRenders={pendingRenders}
        onPendingRenderComplete={onPendingRenderComplete}
        onPendingRenderFailed={onPendingRenderFailed}
      />
    );

    expect(screen.queryByTestId('library-row-pending')).toBeNull();
    expect(screen.getByTestId('library-row')).toBeInTheDocument();
  });
});
