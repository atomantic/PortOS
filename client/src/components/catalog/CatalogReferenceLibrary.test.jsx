import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

vi.mock('../../services/apiCatalog', () => ({
  updateCatalogIngredientMediaLibrary: vi.fn(async () => ({})),
  attachCatalogIngredientMediaFromMoodBoard: vi.fn(async () => ({ attached: [], skipped: [] })),
  refineCatalogMedia: vi.fn(async () => ({ jobId: 'refined-job' })),
}));
vi.mock('../../hooks/useModelInputPreview', () => ({
  useModelInputPreview: (_fn, _body, options) => options.enabled ? { preview: { sentPrompt: 'Exact sent prompt' }, error: null } : {},
}));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: ({ onFilename }) => <button onClick={() => onFilename('refined.png')}>Complete refinement</button> }));
const api = await import('../../services/apiCatalog');
const { default: CatalogReferenceLibrary } = await import('./CatalogReferenceLibrary.jsx');

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

  it('shows one visual while retaining independently stored portrait and reference metadata', async () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1" media={[
      { kind: 'portrait', mediaKey: 'shared.png', library: { tags: ['portrait-tag'] } },
      { kind: 'reference', mediaKey: 'shared.png', library: { guide: true, variant: { age: 17 }, tags: ['reference-tag'] } },
    ]} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    const reference = screen.getByRole('group', { name: 'reference details for shared.png' });
    expect(within(reference).getByText(/Age 17/)).toHaveTextContent('reference-tag');
    expect(screen.getByRole('group', { name: 'portrait details for shared.png' })).toHaveTextContent('portrait-tag');
    fireEvent.click(within(reference).getByRole('button', { name: 'Guide' }));
    await waitFor(() => expect(api.updateCatalogIngredientMediaLibrary).toHaveBeenCalledWith(
      'cat-chr-1', { mediaKey: 'shared.png', kind: 'reference', guide: false }, { silent: true }));
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
});
