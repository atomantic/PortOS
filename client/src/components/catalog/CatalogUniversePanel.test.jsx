import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (io) => ({ ...await io(), useNavigate: () => navigate }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../services/apiUniverseBuilder', () => ({ listUniverseNames: async () => [
  { id: 'first', name: 'First world' }, { id: 'second', name: 'Second world' },
] }));
vi.mock('../../services/apiCatalog', () => ({
  getCatalogUniverseContext: vi.fn(), setCatalogUniverseOwner: vi.fn(), forkCatalogIngredient: vi.fn(),
  linkCatalogIngredient: vi.fn(), unlinkCatalogIngredient: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import CatalogUniversePanel from './CatalogUniversePanel';
import { setCatalogUniverseOwner, forkCatalogIngredient } from '../../services/apiCatalog';

const initial = { status: 'needs-review', owner: null, refs: [
  { refKind: 'universe', refId: 'first', role: 'canon-character', refName: 'First world', resolved: true },
  { refKind: 'series', refId: 'missing-series', role: 'cast', resolved: false, reason: 'missing-target' },
] };
function Harness() {
  const [context, setContext] = useState(initial);
  return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', type: 'character', name: 'Example courier' }} context={context} onContextChange={setContext} />;
}
beforeEach(() => vi.clearAllMocks());

describe('primitive ownership and fork controls', () => {
  it('shows legacy/missing usages, resolves ownership explicitly, then forks with a deliberate asset choice and stable retry key', async () => {
    const owner = { refKind: 'universe', refId: 'first', role: 'owner', refName: 'First world', resolved: true };
    setCatalogUniverseOwner.mockResolvedValue({ ...initial, status: 'owned', owner });
    forkCatalogIngredient.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce({ id: 'cat-chr-fork', type: 'character' });
    render(<MemoryRouter><Harness /></MemoryRouter>);
    expect(screen.getByText('Ownership needs review')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /missing-series/ })).toBeNull();
    expect(screen.getByText('missing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve ownership / fork…' }));
    await screen.findByRole('option', { name: 'First world' });
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set owning universe' }));
    await waitFor(() => expect(screen.queryByText('Ownership needs review')).toBeNull());
    expect(setCatalogUniverseOwner).toHaveBeenCalledWith('cat-chr-1', 'first', { silent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Fork into another universe…' }));
    await screen.findByRole('option', { name: 'Second world' });
    expect(screen.getByRole('button', { name: 'Create fork' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'second' } });
    fireEvent.click(screen.getByLabelText('Reuse image files as independent references on the fork'));
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
    await waitFor(() => expect(forkCatalogIngredient).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create fork' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/casting/cat-chr-fork'));
    const first = forkCatalogIngredient.mock.calls[0][1];
    expect(first).toMatchObject({ universeId: 'second', name: 'Example courier', copyImages: true });
    expect(forkCatalogIngredient.mock.calls[1][1].operationKey).toBe(first.operationKey);
  });
});
