import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CatalogLooksPanel from './CatalogLooksPanel';
import { previewCatalogSheet } from '../../services/apiCatalog';

// The real ModelInputPreview renders here, so this pins what the user sees
// before Generate: which image the look render edits, or why it does not.
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

const wardrobes = [{ id: 'wd-gala', name: 'Gala', description: 'Emerald gown' }];
const basePreview = {
  sentPrompt: 'LOOK REFERENCE — Ada in one full-body figure',
  promptAdditions: [{ id: 'portrait-edit-base', label: 'Edit from the canonical portrait', text: 'Edit the FIRST attached image' }],
  visualDirection: { ready: true, missing: [] },
};

const openGenerate = () => {
  render(<CatalogLooksPanel ingredientId="cat-chr-1" wardrobes={wardrobes} lookMedia={[]} candidates={[]} onSaveWardrobes={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
};

describe('CatalogLooksPanel Generate preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the portrait as the edit base and lists the edit addition', async () => {
    previewCatalogSheet.mockResolvedValue({ preview: { ...basePreview,
      editBase: { filename: 'portrait.png', source: 'Portrait', status: 'included', url: '/data/images/portrait.png' },
      referenceImages: [
        { filename: 'portrait.png', source: 'Portrait', status: 'included', role: 'edit-base', url: '/data/images/portrait.png' },
        { filename: 'side.png', source: 'Reference library', status: 'included', url: '/data/images/side.png' },
      ] } });
    openGenerate();
    expect(await screen.findByText('Edit base — the render starts from this image', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getAllByText('Edit base — the render starts from this image')).toHaveLength(1);
    expect(screen.getByText('The render edits the portrait; the other images guide likeness.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit from the canonical portrait/ })).toBeInTheDocument();
    expect(previewCatalogSheet).toHaveBeenCalledWith('cat-chr-1', expect.objectContaining({ variant: 'look', wardrobeId: 'wd-gala' }), { silent: true });
  });

  it('says why the portrait is not edited on a backend that cannot edit', async () => {
    previewCatalogSheet.mockResolvedValue({ preview: { ...basePreview, promptAdditions: [],
      editBase: { filename: 'portrait.png', source: 'Portrait', status: 'fallback', reason: 'Choose a cloud image backend to edit from the portrait.' },
      referenceImages: [{ filename: 'portrait.png', source: 'Portrait', status: 'included' }] } });
    openGenerate();
    expect(await screen.findByText(/Not editing from the portrait: Choose a cloud image backend/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText('Edit base — the render starts from this image')).not.toBeInTheDocument();
  });
});
