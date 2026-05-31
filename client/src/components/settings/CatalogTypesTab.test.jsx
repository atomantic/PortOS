import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn(),
  createCatalogType: vi.fn(),
  updateCatalogType: vi.fn(),
  deleteCatalogType: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { CatalogTypesTab } from './CatalogTypesTab';
import { CatalogTypesProvider } from '../../hooks/useCatalogTypes.jsx';
import { listCatalogTypes, createCatalogType, deleteCatalogType } from '../../services/apiCatalogTypes';
import toast from '../ui/Toast';

const renderTab = () => render(
  <CatalogTypesProvider>
    <CatalogTypesTab />
  </CatalogTypesProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogTypes.mockResolvedValue({ types: [] });
});

describe('CatalogTypesTab', () => {
  it('lists built-in types read-only', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('Built-in')).toBeTruthy());
    expect(screen.getByText('Character')).toBeTruthy();
    expect(screen.getByText('Concept')).toBeTruthy();
  });

  it('creates a user type through the field builder', async () => {
    createCatalogType.mockResolvedValue({ types: [] });
    renderTab();
    await waitFor(() => expect(screen.getByText('Built-in')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New type/i }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Faction' } });
    fireEvent.click(screen.getByRole('button', { name: /Add field/i }));
    fireEvent.change(screen.getByLabelText('Field label'), { target: { value: 'Creed' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save type/i }));
    });

    expect(createCatalogType).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'faction',
        label: 'Faction',
        fields: [expect.objectContaining({ key: 'creed', label: 'Creed' })],
      }),
      { silent: true },
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('arms then deletes a user type', async () => {
    listCatalogTypes.mockResolvedValue({
      types: [{ id: 'faction', label: 'Faction', system: false, primaryContentKey: 'creed', fields: [{ key: 'creed', label: 'Creed', kind: 'longtext' }] }],
    });
    deleteCatalogType.mockResolvedValue({ types: [] });
    renderTab();
    await waitFor(() => expect(screen.getByText('Faction')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Delete Faction/i));
    const confirm = await screen.findByRole('button', { name: /Confirm/i });
    await act(async () => { fireEvent.click(confirm); });

    expect(deleteCatalogType).toHaveBeenCalledWith('faction', { force: false, silent: true });
  });

  it('surfaces the in-use guard and offers a forced delete', async () => {
    listCatalogTypes.mockResolvedValue({
      types: [{ id: 'faction', label: 'Faction', system: false, primaryContentKey: 'creed', fields: [] }],
    });
    const inUse = Object.assign(new Error('Catalog type "faction" has ingredients — pass ?force=true to delete it anyway'), { code: 'CATALOG_TYPE_IN_USE' });
    deleteCatalogType.mockRejectedValueOnce(inUse).mockResolvedValueOnce({ types: [] });
    renderTab();
    await waitFor(() => expect(screen.getByText('Faction')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Delete Faction/i));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Confirm/i })); });
    // First attempt was refused (non-force).
    expect(deleteCatalogType).toHaveBeenLastCalledWith('faction', { force: false, silent: true });
    expect(toast.error).toHaveBeenCalled();

    // Confirm again → forced delete.
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Confirm/i })); });
    expect(deleteCatalogType).toHaveBeenLastCalledWith('faction', { force: true, silent: true });
  });
});
