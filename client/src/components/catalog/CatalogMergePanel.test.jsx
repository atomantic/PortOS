import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import CatalogMergePanel from './CatalogMergePanel';
import { getSelfInstance } from '../../services/apiSystem';
import { getCatalogIngredientDetails, listCatalogIngredients, previewCatalogMerge, applyCatalogMerge, listCatalogMergeHistory, getCatalogMergeReceipt, recoverCatalogMerge } from '../../services/apiCatalog';

vi.mock('../../services/apiSystem', () => ({ getSelfInstance: vi.fn() }));
vi.mock('../../services/apiCatalog', () => ({
  getCatalogIngredientDetails: vi.fn(), listCatalogIngredients: vi.fn(), previewCatalogMerge: vi.fn(),
  applyCatalogMerge: vi.fn(), listCatalogMergeHistory: vi.fn(), getCatalogMergeReceipt: vi.fn(), recoverCatalogMerge: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));

const survivor = { id: 'example-survivor', name: 'Example subject', type: 'character', originInstanceId: 'example-local', payload: { locked: false, role: 'Guide' }, updatedAt: '2026-01-01' };
const source = { ...survivor, id: 'example-source', name: 'Example alias', payload: { locked: false, description: 'A thoughtful guide' } };
const proposed = { name: survivor.name, payload: { ...source.payload, ...survivor.payload }, tags: [] };
const onChanged = vi.fn();

async function show({ record = survivor, route = '/casting/example-survivor/profile', disabledReason } = {}) {
  const router = createMemoryRouter([{ path: '/casting/:id/profile', element: <CatalogMergePanel record={record} onChanged={onChanged} disabledReason={disabledReason} /> }], { initialEntries: [route] });
  render(<RouterProvider router={router} />);
  if (!route.includes('mergeSource') && !route.includes('mergeReceipt')) fireEvent.click(screen.getByRole('button', { name: 'Local consolidation' }));
  await act(async () => {});
  return router;
}

beforeEach(() => {
  vi.resetAllMocks();
  getSelfInstance.mockResolvedValue({ instanceId: 'example-local' });
  listCatalogMergeHistory.mockResolvedValue({ items: [], nextOffset: null });
  listCatalogIngredients.mockResolvedValue({ items: [source] });
  getCatalogIngredientDetails.mockResolvedValue({ ingredient: source });
  previewCatalogMerge.mockResolvedValue({ sourceId: source.id, survivorId: survivor.id, proposed, conflicts: [], previewToken: 'fresh-token', counts: { media: 3, revisions: 4 } });
  applyCatalogMerge.mockResolvedValue({ merged: true, scope: 'local' });
});

describe('catalog local consolidation management', () => {
  it('shows candidate canonical thumbnails with original fallback and preserves selection', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [{ ...source, thumbnailKey: 'canonical.png', payload: { ...source.payload, primaryImageRef: 'older.png' } }] });
    const router = await show();
    const image = screen.getByRole('img', { name: 'Example alias canonical image' });
    expect(image).toHaveAttribute('src', '/data/image-thumbnails/canonical.webp');
    expect(image).toHaveAttribute('loading', 'lazy');
    fireEvent.error(image);
    expect(image).toHaveAttribute('src', '/data/images/canonical.png');
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(new URLSearchParams(router.state.location.search).get('mergeSource')).toBe(source.id);
    expect(await screen.findByRole('button', { name: 'Preview consolidation' })).toBeEnabled();
    expect(applyCatalogMerge).not.toHaveBeenCalled();
  });

  it('uses the canonical payload image and keeps candidates without images selectable', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [source, { ...source, id: 'illustrated', name: 'Illustrated alias', payload: { ...source.payload, primaryImageRef: 'portrait.png' } }] });
    await show();
    expect(screen.getByRole('img', { name: 'Illustrated alias canonical image' })).toHaveAttribute('src', '/data/image-thumbnails/portrait.webp');
    expect(screen.getByText('No image')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(await screen.findByRole('button', { name: 'Preview consolidation' })).toBeEnabled();
  });

  it('automatically refreshes explicit conflict choices and identity confirmation before token-bound apply', async () => {
    previewCatalogMerge.mockResolvedValueOnce({ proposed, conflicts: [{ path: '/name', source: source.name, survivor: survivor.name }], previewToken: 'old-token', counts: {} });
    const router = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(new URLSearchParams(router.state.location.search).get('mergeSource')).toBe(source.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview consolidation' }));
    expect(await screen.findByText('Name · Needs a choice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Consolidate locally' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Keep survivor value/ }));
    await waitFor(() => expect(previewCatalogMerge).toHaveBeenLastCalledWith({ sourceId: source.id, survivorId: survivor.id, fieldChoices: { '/name': 'survivor' } }, { silent: true }));
    const apply = await screen.findByRole('button', { name: 'Consolidate locally' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these are the same subject/ }));
    fireEvent.click(apply);
    await waitFor(() => expect(applyCatalogMerge).toHaveBeenCalledWith({ sourceId: source.id, survivorId: survivor.id, fieldChoices: { '/name': 'survivor' }, previewToken: 'fresh-token' }, { silent: true }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows locked local candidates with guidance, filters foreign and wrong-type records and blocks a locked direct source link', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [source, { ...source, id: 'foreign', name: 'Foreign example', originInstanceId: 'peer-example' }, { ...source, id: 'locked', name: 'Locked example', payload: { locked: true } }, { ...source, id: 'other-type', name: 'Other example', type: 'object' }] });
    await show();
    expect(screen.getByRole('button', { name: 'Select Example alias' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select Foreign|Select Other/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Locked example' })).toBeInTheDocument();
    expect(screen.getByText(/Locked · unlock in its profile/)).toBeInTheDocument();
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: { ...source, payload: { locked: true } } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(await screen.findByText(/The selected source is locked. Open its profile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview consolidation' })).toBeDisabled();
    expect(previewCatalogMerge).not.toHaveBeenCalled();
  });

  it('invalidates an apply preview after a stale-state rejection', async () => {
    applyCatalogMerge.mockRejectedValue(new Error('Catalog changed; preview again'));
    await show({ route: '/casting/example-survivor/profile?mergeSource=example-source' });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview consolidation' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm these are the same subject/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Consolidate locally' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog changed; preview again');
    expect(screen.queryByRole('button', { name: 'Consolidate locally' })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('moves keyboard focus to the selected proposal and back to search when cleared', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(await screen.findByRole('region', { name: 'Consolidation preview' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Clear source selection' }));
    expect(screen.getByRole('textbox', { name: 'Find another character' })).toHaveFocus();
  });

  it('waits for every choice, invalidates confirmation on edits, and only applies the latest preview', async () => {
    const conflicts = [
      { path: '/name', source: source.name, survivor: survivor.name },
      { path: '/payload/role', source: 'Artist', survivor: 'Guide' },
    ];
    previewCatalogMerge.mockResolvedValueOnce({ proposed, conflicts, previewToken: 'unresolved', counts: {} });
    await show({ route: '/casting/example-survivor/profile?mergeSource=example-source' });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview consolidation' }));
    const keepValues = await screen.findAllByRole('radio', { name: /Keep survivor value/ });
    fireEvent.click(keepValues[0]);
    expect(previewCatalogMerge).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 field choices remaining. Choose one value for each field below.')).toBeInTheDocument();
    fireEvent.click(keepValues[1]);
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm these/ }));
    expect(screen.getByRole('button', { name: 'Consolidate locally' })).toBeEnabled();
    let finishPreview;
    previewCatalogMerge.mockImplementationOnce(() => new Promise((resolve) => { finishPreview = resolve; }));
    fireEvent.click(screen.getAllByRole('radio', { name: /Use source value/ })[0]);
    expect(screen.queryByRole('checkbox', { name: /I confirm these/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Consolidate locally' })).not.toBeInTheDocument();
    expect(applyCatalogMerge).not.toHaveBeenCalled();
    await act(async () => finishPreview({ proposed, conflicts: [], previewToken: 'latest-token', counts: {} }));
    expect(screen.getByRole('checkbox', { name: /I confirm these/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Consolidate locally' }));
    await waitFor(() => expect(applyCatalogMerge).toHaveBeenCalledWith({
      sourceId: source.id, survivorId: survivor.id,
      fieldChoices: { '/name': 'source', '/payload/role': 'survivor' }, previewToken: 'latest-token',
    }, { silent: true }));
  });

  it('preserves choices after automatic refresh fails and offers a retry beside confirmation', async () => {
    previewCatalogMerge.mockResolvedValueOnce({ proposed, conflicts: [{ path: '/name', source: source.name, survivor: survivor.name }], previewToken: 'old', counts: {} })
      .mockRejectedValueOnce(new Error('Preview service unavailable'));
    await show({ route: '/casting/example-survivor/profile?mergeSource=example-source' });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview consolidation' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Use source value/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview service unavailable');
    expect(screen.getByRole('radio', { name: /Use source value/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /I confirm these/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    expect(await screen.findByRole('checkbox', { name: /I confirm these/ })).not.toBeChecked();
    expect(applyCatalogMerge).not.toHaveBeenCalled();
  });

  it('rechecks a locked source without losing the selected identity', async () => {
    getCatalogIngredientDetails.mockResolvedValueOnce({ ingredient: { ...source, payload: { locked: true } } });
    const router = await show({ route: '/casting/example-survivor/profile?mergeSource=example-source' });
    expect(screen.getByRole('link', { name: 'Open source profile' })).toHaveAttribute('href', '/casting/example-source');
    expect(screen.queryByRole('button', { name: 'Search candidates' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck source' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview consolidation' })).toBeEnabled());
    expect(new URLSearchParams(router.state.location.search).get('mergeSource')).toBe(source.id);
    expect(previewCatalogMerge).not.toHaveBeenCalled();
  });

  it('preserves a recovery refusal and never offers force recovery', async () => {
    const receipt = { id: 'example-receipt', sourceId: source.id, survivorId: survivor.id, beforeState: { ingredients: [source, survivor] }, createdAt: '2026-01-01' };
    listCatalogMergeHistory.mockResolvedValue({ items: [{ ...receipt, beforeState: undefined }], nextOffset: null });
    getCatalogMergeReceipt.mockResolvedValue(receipt);
    recoverCatalogMerge.mockRejectedValue(new Error('Merged state changed; recovery would overwrite later work'));
    await show();
    expect(getCatalogMergeReceipt).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect originals' }));
    expect(await screen.findByText('Archived original: Example alias')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this consolidation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recover consolidation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('recovery would overwrite later work');
    expect(recoverCatalogMerge).toHaveBeenCalledWith('example-receipt', { silent: true });
    expect(screen.queryByRole('button', { name: /force/i })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('pages history summaries and deep-links only the selected archived receipt', async () => {
    const receipt = { id: 'receipt-one', sourceId: source.id, survivorId: survivor.id, createdAt: '2026-01-01' };
    listCatalogMergeHistory.mockResolvedValueOnce({ items: [receipt], nextOffset: 10 })
      .mockResolvedValueOnce({ items: [{ ...receipt, id: 'receipt-two' }], nextOffset: null });
    getCatalogMergeReceipt.mockResolvedValue({ ...receipt, beforeState: { ingredients: [source, survivor] } });
    const router = await show();
    expect(getCatalogMergeReceipt).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more history' }));
    await waitFor(() => expect(listCatalogMergeHistory).toHaveBeenLastCalledWith(survivor.id, expect.objectContaining({ limit: 10, offset: 10 })));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect originals' }))[0]);
    expect(new URLSearchParams(router.state.location.search).get('mergeReceipt')).toBe('receipt-one');
    expect(await screen.findByText('Archived original: Example alias')).toBeInTheDocument();
    expect(getCatalogMergeReceipt).toHaveBeenCalledTimes(1);
  });

  it('rejects a direct receipt link belonging to a different ingredient', async () => {
    getCatalogMergeReceipt.mockResolvedValue({ id: 'unrelated-receipt', sourceId: 'other-source', survivorId: 'other-survivor', beforeState: { ingredients: [source] } });
    await show({ route: '/casting/example-survivor/profile?mergeReceipt=unrelated-receipt' });
    expect(await screen.findByRole('alert')).toHaveTextContent('This receipt does not belong to the current record.');
    expect(screen.queryByRole('button', { name: 'Recover this consolidation' })).not.toBeInTheDocument();
    expect(recoverCatalogMerge).not.toHaveBeenCalled();
  });

  it('blocks consolidation while profile edits are unsaved', async () => {
    await show({ disabledReason: 'Save or discard profile edits before consolidating.' });
    expect(screen.getByText('Save or discard profile edits before consolidating.')).toBeInTheDocument();
    expect(listCatalogIngredients).not.toHaveBeenCalled();
    expect(previewCatalogMerge).not.toHaveBeenCalled();
  });
});
