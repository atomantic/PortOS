import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CatalogUnlockNotice from './CatalogUnlockNotice';
import { getCatalogIngredientDetails, updateCatalogIngredient } from '../../services/apiCatalog';
import { getUniverse, setUniverseCanonLock } from '../../services/apiUniverseBuilder';

vi.mock('../../services/apiCatalog', () => ({ getCatalogIngredientDetails: vi.fn(), updateCatalogIngredient: vi.fn() }));
vi.mock('../../services/apiUniverseBuilder', () => ({ getUniverse: vi.fn(), setUniverseCanonLock: vi.fn() }));
const record = { id: 'example-object', type: 'object', name: 'Example object', payload: { locked: true, description: 'Saved description' } };
const confirmed = { ...record, payload: { ...record.payload, locked: false } };
const details = { ingredient: record, refs: [] };
const onUnlocked = vi.fn();
const onPendingChange = vi.fn();
const show = (props = {}) => render(<CatalogUnlockNotice record={record} onUnlocked={onUnlocked} onPendingChange={onPendingChange} {...props} />);
beforeEach(() => {
  vi.resetAllMocks();
  getCatalogIngredientDetails.mockResolvedValueOnce(details).mockResolvedValue({ ingredient: confirmed, refs: [] });
  updateCatalogIngredient.mockResolvedValue(confirmed);
});

describe('contextual catalog unlock', () => {
  it('coalesces repeated clicks and confirms the saved lock without rendering', async () => {
    let finish;
    updateCatalogIngredient.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    const button = screen.getByRole('button', { name: 'Unlock for rendering' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(updateCatalogIngredient).toHaveBeenCalledWith(record.id, { payload: confirmed.payload }, { silent: true });
    await act(async () => finish(confirmed));
    expect(onUnlocked).toHaveBeenCalledWith(confirmed);
    view.rerender(<CatalogUnlockNotice record={confirmed} onUnlocked={onUnlocked} onPendingChange={onPendingChange} />);
    expect(screen.getByRole('status')).toHaveTextContent('Unlocked. Choose Generate');
  });

  it.each(['character', 'place', 'object'])('uses the supported canon lock mutation for %s', async (type) => {
    getCatalogIngredientDetails.mockReset().mockResolvedValueOnce({ ingredient: { ...record, type }, refs: [{ refKind: 'universe', refId: 'example-universe' }] })
      .mockResolvedValue({ ingredient: confirmed });
    const field = { character: 'characters', place: 'places', object: 'objects' }[type];
    getUniverse.mockResolvedValue({ [field]: [{ id: 'example-entry', ingredientId: record.id }] });
    show({ record: { ...record, type } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(setUniverseCanonLock).toHaveBeenCalledWith('example-universe', type, 'example-entry', false, { silent: true });
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
  });

  it('skips deleted universe refs when resolving a standalone record', async () => {
    getCatalogIngredientDetails.mockReset().mockResolvedValueOnce({ ...details, refs: [{ refKind: 'universe', refId: 'deleted-universe' }] })
      .mockResolvedValue({ ingredient: confirmed });
    getUniverse.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(confirmed));
    expect(updateCatalogIngredient).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to a catalog write when universe access is forbidden', async () => {
    getCatalogIngredientDetails.mockReset().mockResolvedValue({ ...details, refs: [{ refKind: 'universe', refId: 'private-universe' }] });
    getUniverse.mockRejectedValue(Object.assign(new Error('Access forbidden'), { status: 403 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Access forbidden');
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
  });

  it('keeps a rejected permission visible and permits retry without clearing the lock', async () => {
    updateCatalogIngredient.mockRejectedValue(new Error('Read-only access: unlocking is not permitted'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Read-only access');
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unlock for rendering' })).toBeEnabled();
  });

  it('does not offer an enabled mutation while the parent is read-only or saving', () => {
    show({ disabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(getCatalogIngredientDetails).not.toHaveBeenCalled();
  });

  it('does not mutate after navigation while resolving the target', async () => {
    let finish;
    getCatalogIngredientDetails.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    view.unmount();
    await act(async () => finish(details));
    expect(updateCatalogIngredient).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('ignores a completed mutation after the selected record is left', async () => {
    let finish;
    updateCatalogIngredient.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    await waitFor(() => expect(updateCatalogIngredient).toHaveBeenCalled());
    view.unmount();
    await act(async () => finish(confirmed));
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('retains the lock when canon projection did not persist it', async () => {
    getCatalogIngredientDetails.mockReset().mockResolvedValue(details);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still locked');
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
