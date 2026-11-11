import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import CatalogLooksPanel from './CatalogLooksPanel';
import CatalogSheetsPanel from './CatalogSheetsPanel';
import { listCatalogSheetVariants, previewCatalogSheet, renderCatalogSheet } from '../../services/apiCatalog';

// The real ModelInputPreview renders here, so this pins what the user sees
// before Generate: which image the look render edits, or why it does not.
vi.mock('../../services/apiCatalog', () => ({
  previewCatalogSheet: vi.fn(),
  renderCatalogSheet: vi.fn(),
  listCatalogSheetVariants: vi.fn(),
  listCatalogSheetJobs: vi.fn(async () => ({ jobs: [], hasMore: false })),
}));

vi.mock('../pipeline/MediaJobThumb', () => ({ default: () => <span>Rendering sheet</span> }));

vi.mock('../../hooks/useMediaAnnotations', () => ({ useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn() }) }));

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

  it('shows a framing refusal and prevents a look render', async () => {
    previewCatalogSheet.mockRejectedValue(new Error('Add another compatible reference image or choose another image model.'));
    openGenerate();
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Add another compatible reference image');
    expect(screen.getByRole('button', { name: 'Render look' })).toBeDisabled();
  });

  it('prevents sheet generation when its preview refuses the requested framing', async () => {
    listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'standard', label: 'Standard' }] });
    previewCatalogSheet.mockRejectedValue(new Error('Add another compatible reference image or choose another image model.'));
    render(<CatalogSheetsPanel ingredientId="cat-chr-1" payload={{}} sheetMedia={[]} />);
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Add another compatible reference image');
    expect(screen.getByRole('button', { name: 'Generate sheet' })).toBeDisabled();
  });
  it('shows a sheet rendering defect and regenerates its own variant and age', async () => {
    listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'blocked', label: 'Unavailable sheet' }, { id: 'product', label: 'Product sheet' }] });
    previewCatalogSheet.mockImplementation(async (_id, body) => {
      if (body.variant === 'blocked') throw new Error('The current selection has no compatible reference.');
      return { preview: { sentPrompt: 'Four views of a clock', promptAdditions: [], referenceImages: [] } };
    });
    renderCatalogSheet.mockResolvedValue({ jobId: 'replacement-job', variant: 'product' });
    render(<CatalogSheetsPanel ingredientId="cat-obj-example" payload={{ forms: [{ id: 'old', label: 'Old clock', age: '40' }] }}
      sheetMedia={[{ mediaKey: 'defect.png', kind: 'reference', role: 'sheet:product@old', library: { review: { status: 'bad', feedback: 'Rendering defect: The clock hands are fused.' } } }]} />);
    expect(await screen.findByText('Rendering defect: The clock hands are fused.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('The current selection has no compatible reference.');
    expect(screen.getByRole('button', { name: 'Regenerate sheet' })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Regenerate sheet' })); });
    expect(renderCatalogSheet).toHaveBeenCalledWith('cat-obj-example', { variant: 'product', formId: 'old' }, { silent: true });
  });

  // A comparison sheet regenerates with the pair it was made with, even though no partner is picked now.
  it('regenerates a comparison sheet with its own partner', async () => {
    listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'comparison', label: 'Comparison (two characters)' }] });
    renderCatalogSheet.mockResolvedValue({ jobId: 'pair-again', variant: 'comparison', role: 'sheet:comparison' });
    render(<CatalogSheetsPanel ingredientId="cat-chr-1" payload={{}}
      sheetMedia={[{ mediaKey: 'pair.png', kind: 'reference', role: 'sheet:comparison', library: { comparedWith: 'cat-chr-2', review: { status: 'bad', feedback: 'Rendering defect: Heights are swapped.' } } }]} />);
    expect(await screen.findByText('Rendering defect: Heights are swapped.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate sheet' })).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Regenerate sheet' })); });
    expect(renderCatalogSheet).toHaveBeenCalledWith('cat-chr-1', { variant: 'comparison', partnerId: 'cat-chr-2' }, { silent: true });
  });

  // The partner's copy would render with the sides swapped, so it offers no Regenerate.
  it('offers no regenerate on the partner copy of a comparison sheet', async () => {
    listCatalogSheetVariants.mockResolvedValue({ variants: [{ id: 'comparison', label: 'Comparison (two characters)' }] });
    render(<CatalogSheetsPanel ingredientId="cat-chr-2" payload={{}}
      sheetMedia={[{ mediaKey: 'pair.png', kind: 'reference', role: 'sheet:comparison', library: { review: { status: 'bad', feedback: 'Rendering defect: Heights are swapped.' } } }]} />);
    expect(await screen.findByText('Rendering defect: Heights are swapped.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate sheet' })).not.toBeInTheDocument();
  });

});
