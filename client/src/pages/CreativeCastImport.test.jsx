import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiCatalog', () => ({
  previewMusicVideoCastImport: vi.fn(),
  commitMusicVideoCastImport: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/IngredientPicker', () => ({
  default: ({ open, type, onSelect }) => (open ? (
    <div role="dialog" aria-label={`Pick ${type}`}>
      <button type="button" onClick={() => onSelect({ id: 'cat-plc-9', type: 'place', name: 'Corner cafe' })}>Corner cafe</button>
    </div>
  ) : null),
}));
vi.mock('../components/MediaImage', async () => {
  const { imageThumbnailSrc } = await import('../lib/imageThumbnailSrc');
  return {
    default: ({ src, thumbnail, alt, ...rest }) => <img src={(thumbnail && imageThumbnailSrc(src)) || src} alt={alt} {...rest} />,
  };
});

import CreativeCastImport from './CreativeCastImport';
import { previewMusicVideoCastImport, commitMusicVideoCastImport } from '../services/apiCatalog';
import toast from '../components/ui/Toast';

const PREVIEW = { projects: [{ projectId: 'mv-1', name: 'Example Video', items: [
  { subjectId: 'cs-protagonist', kind: 'character', name: 'Ada', imageId: 'ada.png', action: 'create', ingredientId: 'cat-chr-mv-1' },
  { subjectId: 'mvc-2', kind: 'character', name: 'Cal', imageId: null, action: 'link', ingredientId: 'cat-chr-cal', ingredientName: 'Cal' },
  { subjectId: 'cs-set-diner', kind: 'place', name: 'Night diner', imageId: 'diner.png', action: 'create', ingredientId: 'cat-plc-mv-2' },
] }] };

const renderPage = () => render(<MemoryRouter><CreativeCastImport /></MemoryRouter>);

describe('CreativeCastImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each video\'s proposals and imports the reviewed choices', async () => {
    previewMusicVideoCastImport.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ projects: [] });
    commitMusicVideoCastImport.mockResolvedValue({ projects: 1, created: 1, linked: 1, kept: 1 });
    renderPage();

    expect(await screen.findByRole('link', { name: 'Example Video' })).toHaveAttribute('href', '/music-video/mv-1');
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', '/data/images/ada.png');
    expect(screen.getByLabelText('What to do with Cal')).toHaveValue('link');
    fireEvent.change(screen.getByLabelText('What to do with Night diner'), { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));

    await waitFor(() => expect(commitMusicVideoCastImport).toHaveBeenCalledWith([
      { projectId: 'mv-1', subjectId: 'cs-protagonist', action: 'create' },
      { projectId: 'mv-1', subjectId: 'mvc-2', action: 'link', ingredientId: 'cat-chr-cal' },
      { projectId: 'mv-1', subjectId: 'cs-set-diner', action: 'local' },
    ], { silent: true }));
    expect(toast.success).toHaveBeenCalledWith('Imported: 1 new, 1 linked, 1 kept in their videos');
    expect(await screen.findByText(/already in the catalog/)).toBeInTheDocument();
  });

  it('imports a large library in parts and totals the results', async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ subjectId: `mvc-${i}`, kind: 'object', name: `Prop ${i}`, imageId: null, action: 'create', ingredientId: `cat-obj-${i}` }));
    previewMusicVideoCastImport.mockResolvedValueOnce({ projects: [{ projectId: 'mv-1', name: 'Example Video', items }] }).mockResolvedValueOnce({ projects: [] });
    commitMusicVideoCastImport.mockImplementation(async (rows) => ({ projects: 1, created: rows.length, linked: 0, kept: 0 }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Import 501' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported: 501 new, 0 linked, 0 kept in their videos'));
    expect(commitMusicVideoCastImport.mock.calls.map(([rows]) => rows.length)).toEqual([500, 1]);
  });

  it('links a row to a record the director picks', async () => {
    previewMusicVideoCastImport.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ projects: [] });
    commitMusicVideoCastImport.mockResolvedValue({ projects: 1, created: 1, linked: 2, kept: 0 });
    renderPage();

    fireEvent.change(await screen.findByLabelText('What to do with Night diner'), { target: { value: 'pick' } });
    fireEvent.click(screen.getByRole('button', { name: 'Corner cafe' }));
    expect(screen.getByLabelText('What to do with Night diner')).toHaveDisplayValue('Use Corner cafe');
    fireEvent.click(screen.getByRole('button', { name: 'Import 3' }));

    await waitFor(() => expect(commitMusicVideoCastImport).toHaveBeenCalledTimes(1));
    expect(commitMusicVideoCastImport.mock.calls[0][0][2]).toEqual({ projectId: 'mv-1', subjectId: 'cs-set-diner', action: 'link', ingredientId: 'cat-plc-9' });
  });

  it('marks a similar-name suggestion for checking and imports it with its age form', async () => {
    previewMusicVideoCastImport.mockResolvedValueOnce({ projects: [{ projectId: 'mv-1', name: 'Example Video', items: [
      { subjectId: 'mvc-1', kind: 'character', name: 'Ada (17)', imageId: null, action: 'link', ingredientId: 'cat-chr-ada', ingredientName: 'Ada', match: 'base', formId: 'f-young', formLabel: 'Young' },
      { subjectId: 'mvc-2', kind: 'character', name: 'Bo', imageId: null, action: 'link', ingredientId: 'cat-chr-bo', ingredientName: 'Bo', match: 'name' },
    ] }] }).mockResolvedValueOnce({ projects: [] });
    commitMusicVideoCastImport.mockResolvedValue({ projects: 1, created: 0, linked: 2, kept: 0 });
    renderPage();

    expect(await screen.findByLabelText('What to do with Ada (17)')).toHaveDisplayValue('Use Ada (Young)');
    expect(screen.getByText(/Similar name, check before importing/)).toBeInTheDocument();
    expect(screen.getByText(/Same name in the catalog/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));

    await waitFor(() => expect(commitMusicVideoCastImport).toHaveBeenCalledWith([
      { projectId: 'mv-1', subjectId: 'mvc-1', action: 'link', ingredientId: 'cat-chr-ada', formId: 'f-young' },
      { projectId: 'mv-1', subjectId: 'mvc-2', action: 'link', ingredientId: 'cat-chr-bo' },
    ], { silent: true }));
  });
});
