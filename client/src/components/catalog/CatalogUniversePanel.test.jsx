import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
import socket from '../../services/socket';
import { getCatalogUniverseContext, setCatalogUniverseOwner, forkCatalogIngredient, linkCatalogIngredient } from '../../services/apiCatalog';
import toast from '../ui/Toast';

const initial = { status: 'needs-review', owner: null, refs: [
  { refKind: 'universe', refId: 'first', role: 'canon-character', refName: 'First world', resolved: true },
  { refKind: 'series', refId: 'missing-series', role: 'cast', resolved: false, reason: 'missing-target' },
] };
function Harness(props) {
  const [context, setContext] = useState(initial);
  return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', type: 'character', name: 'Example courier' }} context={context} onContextChange={setContext} {...props} />;
}
beforeEach(() => vi.clearAllMocks());

describe('primitive ownership and fork controls', () => {
  it('shows the new membership immediately and permits a retry after an assignment failure', async () => {
    const owner = { refKind: 'universe', refId: 'second', role: 'owner', refName: 'Second world', resolved: true };
    const member = { ...owner, role: 'canon-character' };
    setCatalogUniverseOwner.mockRejectedValueOnce(new Error('Universe is full'))
      .mockResolvedValueOnce({ ...initial, status: 'owned', owner, refs: [...initial.refs, owner, member] });
    render(<MemoryRouter><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve ownership / fork…' }));
    await screen.findByRole('option', { name: 'Second world' });
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set owning universe' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Universe is full'));
    expect(screen.getByText('Ownership needs review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set owning universe' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set owning universe' }));
    await screen.findByText('Second world · Character canon');
    expect(screen.queryByRole('button', { name: 'Add to owning universe' })).toBeNull();
    expect(linkCatalogIngredient).not.toHaveBeenCalled();
  });

  it.each([false, true])('allows an independent fork from a read-only source unless its identity is fenced (%s)', async (fenced) => {
    forkCatalogIngredient.mockResolvedValue({ id: 'cat-chr-fork', type: 'character' });
    render(<MemoryRouter><Harness readOnly forkBlocked={fenced} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Fork / experiment with redesign…' }));
    await screen.findByRole('option', { name: 'Second world' });
    expect(screen.queryByRole('button', { name: 'Set owning universe' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'second' } });
    const button = screen.getByRole('button', { name: 'Create fork' });
    if (fenced) expect(button).toBeDisabled();
    else {
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/casting/cat-chr-fork'));
    }
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Fork / experiment with redesign…' }));
    await screen.findByRole('option', { name: 'First world (same universe · redesign)' });
    expect(screen.getByRole('button', { name: 'Create fork' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
    await waitFor(() => expect(forkCatalogIngredient).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create fork' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/casting/cat-chr-fork'));
    const first = forkCatalogIngredient.mock.calls[0][1];
    expect(first).toEqual({ universeId: 'second', name: 'Example courier', operationKey: expect.any(String) });
    expect(forkCatalogIngredient.mock.calls[1][1].operationKey).toBe(first.operationKey);
  });

  it('discards a redesign proposal after assigning an owner', async () => {
    const owner = { refKind: 'universe', refId: 'first', role: 'owner', refName: 'First world', resolved: true };
    setCatalogUniverseOwner.mockResolvedValue({ ...initial, status: 'owned', owner });
    function HarnessWithProposal() {
      const [context, setContext] = useState(initial);
      const [fields, setFields] = useState({ physicalDescription: 'A red coat.' });
      return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', type: 'character', name: 'Example courier' }} context={context}
        onContextChange={setContext} redesign={fields ? { fields, clear: () => setFields(null) } : null} />;
    }
    render(<MemoryRouter><HarnessWithProposal /></MemoryRouter>);
    await screen.findByLabelText('Destination universe');
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set owning universe' }));
    await screen.findByRole('button', { name: /Fork \/ experiment/ });
    fireEvent.click(screen.getByRole('button', { name: /Fork \/ experiment/ }));
    await screen.findByLabelText('Destination universe');
    expect(screen.queryByText(/The fork gets the redesigned physical description/)).not.toBeInTheDocument();
  });

  it('discards a redesign proposal when the fork dialog is cancelled', async () => {
    const owner = { refKind: 'universe', refId: 'first', role: 'owner', refName: 'First world', resolved: true };
    function Harness() {
      const [context, setContext] = useState({ status: 'owned', owner, refs: [owner] });
      const [fields, setFields] = useState({ physicalDescription: 'A red coat.' });
      return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', type: 'character', name: 'Example courier' }} context={context}
        onContextChange={setContext} redesign={fields ? { fields, clear: () => setFields(null) } : null} />;
    }
    render(<MemoryRouter><Harness /></MemoryRouter>);
    await screen.findByText(/The fork gets the redesigned physical description/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Fork \/ experiment/ }));
    await screen.findByLabelText('Destination universe');
    expect(screen.queryByText(/The fork gets the redesigned physical description/)).not.toBeInTheDocument();
  });

  it('seeds the fork with only the tapped images, grouped by age, and saves a redesign onto the fork', async () => {
    forkCatalogIngredient.mockResolvedValue({ id: 'cat-chr-fork', type: 'character' });
    const clear = vi.fn();
    const load = vi.fn();
    const owner = { refKind: 'universe', refId: 'first', role: 'owner', refName: 'First world', resolved: true };
    const seed = { ready: true, error: null, load, forms: [{ id: 'form-young', label: 'Child', age: 7 }],
      candidates: [{ mediaKey: 'adult.png', kind: 'portrait' }, { mediaKey: 'young-a.png', kind: 'portrait' },
        { mediaKey: 'young-a.png', kind: 'reference', library: { variant: { formId: 'form-young' } } },
        { mediaKey: 'young-b.png', kind: 'reference', library: { variant: { formId: 'form-young' } } }] };
    function SeedHarness() {
      const [context, setContext] = useState({ status: 'owned', owner, refs: [owner] });
      return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', type: 'character', name: 'Example courier' }} context={context} onContextChange={setContext}
        seed={seed} redesign={{ fields: { physicalDescription: 'A red coat.' }, clear }} />;
    }
    render(<MemoryRouter><SeedHarness /></MemoryRouter>);
    await screen.findByRole('option', { name: 'First world (same universe · redesign)' });
    expect(screen.getByText(/The fork gets the redesigned physical description/)).toBeInTheDocument();
    expect(screen.getByText('Child · 7')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Destination universe'), { target: { value: 'first' } });
    fireEvent.change(screen.getByLabelText('Fork name'), { target: { value: 'Example courier v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seed young-b.png (Child · 7)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Seed adult.png (Canonical)' }));
    expect(screen.getByRole('button', { name: 'Seed young-a.png (Child · 7)' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/casting/cat-chr-fork'));
    expect(forkCatalogIngredient.mock.calls[0][1]).toEqual({ universeId: 'first', name: 'Example courier v2', seedImages: ['adult.png', 'young-b.png'],
      fields: { physicalDescription: 'A red coat.' }, operationKey: expect.any(String) });
    expect(clear).toHaveBeenCalled();
  });
});


it('keeps incomplete usage distinct from unused and retries secondary failures', async () => {
  function PendingHarness() {
    const [context, setContext] = useState({ ...initial, refs: [], usageComplete: false });
    return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', name: 'Example courier', type: 'character' }} context={context} onContextChange={setContext} />;
  }
  getCatalogUniverseContext.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ ...initial, refs: [], usageComplete: true });
  render(<MemoryRouter><PendingHarness /></MemoryRouter>);
  await screen.findByRole('alert');
  expect(screen.queryByText('No linked containers')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry usage' }));
  await screen.findByText('No linked containers');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('retries a failed socket refresh after usage has already loaded', async () => {
  function LoadedHarness() {
    const [context, setContext] = useState({ ...initial, refs: [], usageComplete: true });
    return <CatalogUniversePanel ingredient={{ id: 'cat-chr-1', name: 'Example courier', type: 'character' }} context={context} onContextChange={setContext} />;
  }
  getCatalogUniverseContext.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ ...initial, usageComplete: true });
  render(<MemoryRouter><LoadedHarness /></MemoryRouter>);
  expect(getCatalogUniverseContext).not.toHaveBeenCalled();
  const refresh = socket.on.mock.calls.find(([event]) => event === 'catalog:primitive-changed')[1];
  await act(async () => { refresh({ ingredientId: 'cat-chr-1' }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Detailed usage could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Retry usage' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByText('missing')).toBeInTheDocument();
  expect(getCatalogUniverseContext).toHaveBeenCalledTimes(2);
});
