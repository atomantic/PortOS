import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CatalogLooksPanel from './CatalogLooksPanel';

vi.mock('../../services/apiCatalog', () => ({
  previewCatalogSheet: vi.fn(),
  renderCatalogSheet: vi.fn(),
}));

vi.mock('../media/UniverseMoodBoardPicker', () => ({
  default: () => <div>UniverseMoodBoardPicker</div>,
  useStyleSourceLists: () => ({ universes: [], boards: [] }),
  BOARD_FOLLOW_UNIVERSE: 'follow',
  BOARD_NONE: 'none',
}));

vi.mock('../media/ModelInputPreview', () => ({
  default: () => <div>ModelInputPreview</div>,
}));

vi.mock('./CatalogMediaTile', () => ({
  default: ({ m, extraActions }) => (
    <div data-testid={`media-tile-${m.mediaKey}`}>
      <span>{m.mediaKey}</span>
      {extraActions}
    </div>
  ),
}));

describe('CatalogLooksPanel', () => {
  const wardrobes = [
    { id: 'w1', name: 'Standard Outfit', description: 'Blue suit', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters attach menu to only show candidate images marked "good"', () => {
    const candidates = [
      { mediaKey: 'good-1.png', kind: 'reference', library: { review: { status: 'good' } } },
      { mediaKey: 'good-2.png', kind: 'reference', review: { status: 'good' } },
      { mediaKey: 'bad-1.png', kind: 'reference', library: { review: { status: 'bad' } } },
      { mediaKey: 'rejected-1.png', kind: 'reference', library: { review: { status: 'rejected' } } },
      { mediaKey: 'unreviewed-1.png', kind: 'reference', library: { review: { status: 'unreviewed' } } },
      { mediaKey: 'no-review.png', kind: 'reference' },
    ];

    render(
      <CatalogLooksPanel
        ingredientId="cat-chr-1"
        wardrobes={wardrobes}
        lookMedia={[]}
        candidates={candidates}
        onSaveWardrobes={vi.fn()}
      />,
    );

    // Open the attach image menu
    fireEvent.click(screen.getByRole('button', { name: /Attach image/ }));

    // Good candidates should be visible
    expect(screen.getByTestId('media-tile-good-1.png')).toBeInTheDocument();
    expect(screen.getByTestId('media-tile-good-2.png')).toBeInTheDocument();

    // Non-good candidates should not be displayed
    expect(screen.queryByTestId('media-tile-bad-1.png')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-tile-rejected-1.png')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-tile-unreviewed-1.png')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-tile-no-review.png')).not.toBeInTheDocument();
  });

  it('shows message advising to mark reference images as good when references exist but none are marked good', () => {
    const candidates = [
      { mediaKey: 'unreviewed-1.png', kind: 'reference', library: { review: { status: 'unreviewed' } } },
      { mediaKey: 'bad-1.png', kind: 'reference', library: { review: { status: 'bad' } } },
    ];

    render(
      <CatalogLooksPanel
        ingredientId="cat-chr-1"
        wardrobes={wardrobes}
        lookMedia={[]}
        candidates={candidates}
        onSaveWardrobes={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Attach image/ }));

    expect(screen.getByText('No reference images marked "good" to use. Mark some as good on the References tab.')).toBeInTheDocument();
  });

  it('shows empty message when no reference candidates exist at all', () => {
    render(
      <CatalogLooksPanel
        ingredientId="cat-chr-1"
        wardrobes={wardrobes}
        lookMedia={[]}
        candidates={[]}
        onSaveWardrobes={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Attach image/ }));

    expect(screen.getByText('No reference images to use. Attach or generate some on the References tab.')).toBeInTheDocument();
  });

  it('attaches a good reference candidate when the user clicks its Pin button', async () => {
    const onSetRole = vi.fn().mockResolvedValue(true);
    const goodCandidate = { mediaKey: 'good-1.png', kind: 'reference', library: { review: { status: 'good' } } };

    render(
      <CatalogLooksPanel
        ingredientId="cat-chr-1"
        wardrobes={wardrobes}
        lookMedia={[]}
        candidates={[goodCandidate]}
        onSetRole={onSetRole}
        onSaveWardrobes={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Attach image/ }));

    const pinButton = screen.getByRole('button', { name: 'Use for Standard Outfit' });
    fireEvent.click(pinButton);

    await waitFor(() => {
      expect(onSetRole).toHaveBeenCalledWith(goodCandidate, 'look:w1', 'Added to Standard Outfit');
    });
  });
});
