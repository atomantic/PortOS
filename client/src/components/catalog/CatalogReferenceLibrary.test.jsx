import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../services/apiCatalog', () => ({
  updateCatalogIngredientMediaLibrary: vi.fn(async () => ({})),
  attachCatalogIngredientMediaFromMoodBoard: vi.fn(async () => ({ attached: [], skipped: [] })),
}));
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

  it('preserves per-attachment read-only provenance and counts guides outside this tab', () => {
    render(<CatalogReferenceLibrary ingredientId="cat-chr-1"
      media={[{ ...media[0], readOnly: true }, media[1]]}
      guideMedia={[...media, ...[1, 2, 3].map((n) => ({ kind: 'reference', mediaKey: `sheet-${n}.png`, library: { guide: true } }))]} />);
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
});
