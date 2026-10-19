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
  it('requires explicit conflict choices, a new preview and identity confirmation before token-bound apply', async () => {
    previewCatalogMerge.mockResolvedValueOnce({ proposed, conflicts: [{ path: '/name', source: source.name, survivor: survivor.name }], previewToken: 'old-token', counts: {} });
    const router = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(new URLSearchParams(router.state.location.search).get('mergeSource')).toBe(source.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview consolidation' }));
    expect(await screen.findByText('Resolve Name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Consolidate locally' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Keep survivor value/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview consolidation' }));
    await waitFor(() => expect(previewCatalogMerge).toHaveBeenLastCalledWith({ sourceId: source.id, survivorId: survivor.id, fieldChoices: { '/name': 'survivor' } }, { silent: true }));
    const apply = await screen.findByRole('button', { name: 'Consolidate locally' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these are the same subject/ }));
    fireEvent.click(apply);
    await waitFor(() => expect(applyCatalogMerge).toHaveBeenCalledWith({ sourceId: source.id, survivorId: survivor.id, fieldChoices: { '/name': 'survivor' }, previewToken: 'fresh-token' }, { silent: true }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('filters local unlocked same-type candidates and blocks a locked direct source link', async () => {
    listCatalogIngredients.mockResolvedValue({ items: [source, { ...source, id: 'foreign', name: 'Foreign example', originInstanceId: 'peer-example' }, { ...source, id: 'locked', name: 'Locked example', payload: { locked: true } }, { ...source, id: 'other-type', name: 'Other example', type: 'object' }] });
    await show();
    expect(screen.getByRole('button', { name: 'Select Example alias' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select Foreign|Select Locked|Select Other/ })).not.toBeInTheDocument();
    getCatalogIngredientDetails.mockResolvedValue({ ingredient: { ...source, payload: { locked: true } } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Example alias' }));
    expect(await screen.findByText('The selected source is locked. Consolidation never unlocks it.')).toBeInTheDocument();
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
