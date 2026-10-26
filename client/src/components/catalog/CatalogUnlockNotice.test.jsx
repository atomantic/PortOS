import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CatalogUnlockNotice from './CatalogUnlockNotice';
import { setCatalogIngredientLock } from '../../services/apiCatalog';

vi.mock('../../services/apiCatalog', () => ({ setCatalogIngredientLock: vi.fn() }));
const record = { id: 'example-object', type: 'object', name: 'Example object', payload: { locked: true, description: 'Saved description' } };
const confirmed = { ...record, payload: { ...record.payload, locked: false } };
const onUnlocked = vi.fn();
const onPendingChange = vi.fn();
const show = (props = {}) => render(<CatalogUnlockNotice record={record} onUnlocked={onUnlocked} onPendingChange={onPendingChange} {...props} />);
beforeEach(() => { vi.resetAllMocks(); setCatalogIngredientLock.mockResolvedValue(confirmed); });

describe('contextual catalog unlock', () => {
  it('coalesces repeated clicks and changes only the flag without submitting a surrounding draft', async () => {
    let finish;
    setCatalogIngredientLock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = show();
    const button = screen.getByRole('button', { name: 'Unlock for rendering' });
    fireEvent.click(button); fireEvent.click(button);
    expect(setCatalogIngredientLock).toHaveBeenCalledTimes(1);
    expect(setCatalogIngredientLock).toHaveBeenCalledWith(record.id, false, { silent: true });
    expect(button).toBeDisabled();
    await act(async () => finish(confirmed));
    expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining(confirmed));
    view.rerender(<CatalogUnlockNotice record={confirmed} onUnlocked={onUnlocked} onPendingChange={onPendingChange} />);
    expect(screen.getByRole('status')).toHaveTextContent('Unlocked. Choose Generate');
  });
  it('keeps server refusals visible without clearing the persisted lock', async () => {
    setCatalogIngredientLock.mockRejectedValue(new Error('Identity is read-only'));
    show(); fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Identity is read-only');
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unlock for rendering' })).toBeEnabled();
  });
  it.each([{ disabled: true }, { record: { ...record, sharedIdentity: { writable: false } } }])('disables writes for pending/read-only contexts', props => {
    show(props); fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    expect(setCatalogIngredientLock).not.toHaveBeenCalled();
  });
  it('drops a completed mutation after leaving the selected record', async () => {
    let finish;
    setCatalogIngredientLock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = show(); fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    view.unmount(); await act(async () => finish(confirmed));
    expect(onUnlocked).not.toHaveBeenCalled();
  });
  it('refuses an unconfirmed response and leaves the lock displayed', async () => {
    setCatalogIngredientLock.mockResolvedValue(record);
    show(); fireEvent.click(screen.getByRole('button', { name: 'Unlock for rendering' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not confirmed'));
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
