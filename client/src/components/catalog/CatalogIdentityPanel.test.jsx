import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CatalogIdentityPanel from './CatalogIdentityPanel';
import { getSelfInstance } from '../../services/apiSystem';
import { getCatalogIngredientDetails, listCatalogIngredients } from '../../services/apiCatalog';
import * as api from '../../services/apiCatalogIdentity';

const { handlers } = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('../../services/socket', () => ({ default: { on: (event, handler) => handlers.set(event, handler), off: (event) => handlers.delete(event) } }));
vi.mock('../../services/apiSystem', () => ({ getSelfInstance: vi.fn() }));
vi.mock('../../services/apiCatalog', () => ({ getCatalogIngredientDetails: vi.fn(), listCatalogIngredients: vi.fn() }));
vi.mock('../../services/apiCatalogIdentity', () => ({
  listCatalogIdentities: vi.fn(), getCatalogIdentity: vi.fn(), previewCatalogIdentity: vi.fn(), createCatalogIdentity: vi.fn(),
  importCatalogIdentity: vi.fn(), acceptCatalogIdentity: vi.fn(), advanceCatalogIdentity: vi.fn(), abortCatalogIdentity: vi.fn(), recoverCatalogIdentity: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));

const survivor = { id: 'shared-survivor', type: 'character', name: 'Example Keeper', originInstanceId: 'owner-one', payload: { locked: false, role: 'Guide' } };
const source = { ...survivor, id: 'shared-source', name: 'Example Traveler', originInstanceId: 'owner-two' };
const snapshot = record => ({ ingredients: [{ ...record, origin_instance_id: record.originInstanceId }], refs: [], sources: [], media: [{ id: `${record.id}-asset`, ingredient_id: record.id, media_key: 'example-reference.png' }], relations: [], revisions: [] });
const plan = { version: 1, sourceId: source.id, survivorId: survivor.id, sourceOwner: source.originInstanceId, survivorOwner: survivor.originInstanceId,
  source: snapshot(source), survivor: snapshot(survivor), proposed: { name: survivor.name, payload: survivor.payload }, fieldChoices: {} };
const operation = { id: 'example-operation', sourceId: source.id, survivorId: survivor.id, sourceOwner: 'owner-two', survivorOwner: 'owner-one', localOwner: 'owner-one', state: 'proposed', plan, planHash: 'reviewed-plan', updatedAt: '2026-01-01T12:00:00Z' };

async function show({ record = survivor, query = '', disabledReason } = {}) {
  const router = createMemoryRouter([{ path: '/casting/:id', element: <CatalogIdentityPanel record={record} disabledReason={disabledReason} /> }], { initialEntries: [`/casting/${record.id}${query}`] });
  render(<RouterProvider router={router} />);
  if (!query.includes('identitySource') && !query.includes('identityOperation')) fireEvent.click(screen.getByRole('button', { name: 'Shared canonical identity' }));
  await act(async () => {});
  return router;
}

beforeEach(() => {
  vi.resetAllMocks(); handlers.clear();
  getSelfInstance.mockResolvedValue({ instanceId: 'owner-one' });
  getCatalogIngredientDetails.mockResolvedValue({ ingredient: source });
  listCatalogIngredients.mockResolvedValue({ items: [source] });
  api.listCatalogIdentities.mockResolvedValue({ items: [], nextOffset: null });
  api.getCatalogIdentity.mockImplementation(async id => ({ ...operation, id }));
  api.previewCatalogIdentity.mockResolvedValue({ plan, planHash: 'reviewed-plan', conflicts: [] });
  api.createCatalogIdentity.mockImplementation(async body => ({ ...operation, id: body.operationId }));
  api.acceptCatalogIdentity.mockResolvedValue({ ...operation, state: 'prepared' });
});

describe('shared canonical identity operator workflow', () => {
  it('deep-links the pair and requires conflict resolution plus a fresh reviewed plan before creation', async () => {
    api.previewCatalogIdentity.mockResolvedValueOnce({ plan, planHash: 'unresolved', conflicts: [{ path: '/name', source: source.name, survivor: survivor.name }] });
    const router = await show();
    fireEvent.click(screen.getByRole('button', { name: `Select source ${source.name}` }));
    expect(new URLSearchParams(router.state.location.search).get('identitySource')).toBe(source.id);
    expect(new URLSearchParams(router.state.location.search).get('identitySurvivor')).toBe(survivor.id);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    expect(await screen.findByText('Resolve Name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create shared identity proposal' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Keep survivor value/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    const create = await screen.findByRole('button', { name: 'Create shared identity proposal' });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /These records describe the same subject/ }));
    fireEvent.click(create);
    await waitFor(() => expect(api.createCatalogIdentity).toHaveBeenCalledWith({ operationId: expect.any(String), sourceId: source.id, survivorId: survivor.id, fieldChoices: { '/name': 'survivor' }, planHash: 'reviewed-plan' }, { silent: true }));
    const createdId = api.createCatalogIdentity.mock.calls[0][0].operationId;
    expect(api.previewCatalogIdentity.mock.calls[0][0].operationId).toBe(createdId);
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('identityOperation')).toBe(createdId));
    expect(api.acceptCatalogIdentity).not.toHaveBeenCalled();
  });

  it('retries an uncertain creation with the same URL-bound ID and exact body, then uses a fresh ID after an aborted attempt', async () => {
    api.createCatalogIdentity.mockRejectedValueOnce(new Error('Connection lost after sending')).mockImplementation(async body => ({ ...operation, id: body.operationId }));
    api.abortCatalogIdentity.mockImplementation(async id => ({ ...operation, id, state: 'aborted' }));
    const router = await show({ query: '?identitySource=shared-source' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /These records describe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create shared identity proposal' }));
    const retry = await screen.findByRole('button', { name: 'Retry same creation request' });
    await waitFor(() => expect(retry).toBeEnabled());
    const firstBody = api.createCatalogIdentity.mock.calls[0][0];
    expect(new URLSearchParams(router.state.location.search).get('identityAttempt')).toBe(firstBody.operationId);
    expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Shared canonical identity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shared canonical identity' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry same creation request' }));
    await screen.findByRole('button', { name: 'Abort uncommitted proposal' });
    expect(api.createCatalogIdentity.mock.calls[1][0]).toEqual(firstBody);
    fireEvent.click(screen.getByRole('button', { name: 'Abort uncommitted proposal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm coordinator abort' }));
    await screen.findByText('Aborted · no canonical consolidation applied');
    fireEvent.click(screen.getByRole('button', { name: 'Close selected operation' }));
    fireEvent.click(await screen.findByRole('button', { name: `Select source ${source.name}` }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    await screen.findByRole('checkbox', { name: /These records describe/ });
    expect(api.previewCatalogIdentity.mock.calls.at(-1)[0].operationId).not.toBe(firstBody.operationId);
  });

  it('lets the coordinator abort without requiring dirty form edits to be saved or records unlocked', async () => {
    api.getCatalogIdentity.mockResolvedValue({ ...operation, state: 'prepared' });
    api.abortCatalogIdentity.mockResolvedValue({ ...operation, state: 'aborted' });
    await show({ query: '?identityOperation=example-operation', disabledReason: 'Save profile edits first' });
    const abort = await screen.findByRole('button', { name: 'Abort uncommitted proposal' });
    expect(abort).toBeEnabled();
    fireEvent.click(abort);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm coordinator abort' }));
    expect(await screen.findByText('Aborted · no canonical consolidation applied')).toBeInTheDocument();
    expect(api.abortCatalogIdentity).toHaveBeenCalledWith(operation.id, { silent: true });
  });

  it('resets the reviewed preview when the URL selects a different attempt for the same pair', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const router = await show({ query: `?identitySource=shared-source&identityAttempt=${firstId}` });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    await screen.findByRole('checkbox', { name: /These records describe/ });
    await act(async () => { await router.navigate(`/casting/shared-survivor?identitySource=shared-source&identityAttempt=${secondId}`); });
    expect(screen.queryByRole('checkbox', { name: /These records describe/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview shared identity' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview shared identity' }));
    await screen.findByRole('checkbox', { name: /These records describe/ });
    expect(api.previewCatalogIdentity.mock.calls.map(([body]) => body.operationId)).toEqual([firstId, secondId]);
  });

  it('imports the coordinator instance ID, then separately accepts the exact plan as the source owner', async () => {
    getSelfInstance.mockResolvedValue({ instanceId: 'owner-two' });
    const imported = { ...operation, localOwner: 'owner-two' };
    api.importCatalogIdentity.mockResolvedValue(imported);
    api.getCatalogIdentity.mockResolvedValue(imported);
    api.acceptCatalogIdentity.mockResolvedValue({ ...imported, state: 'prepared' });
    const router = await show({ record: source });
    fireEvent.change(screen.getByLabelText('Coordinator instance ID'), { target: { value: 'owner-one' } });
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: operation.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Import verified proposal' }));
    const accept = await screen.findByRole('button', { name: 'Accept as this owner' });
    expect(accept).toBeDisabled();
    expect(api.acceptCatalogIdentity).not.toHaveBeenCalled();
    expect(new URLSearchParams(router.state.location.search).get('identityPeer')).toBe('owner-one');
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept this exact reviewed plan/ }));
    fireEvent.click(accept);
    expect(await screen.findByText('Accepted here · reserved while awaiting the coordinator decision')).toBeInTheDocument();
    expect(api.importCatalogIdentity).toHaveBeenCalledWith({ peerId: 'owner-one', operationId: operation.id }, { silent: true });
    expect(api.acceptCatalogIdentity).toHaveBeenCalledWith(operation.id, operation.planHash, { silent: true });
    expect(screen.queryByRole('button', { name: 'Abort uncommitted proposal' })).not.toBeInTheDocument();
  });

  it('keeps an offline prepared operation inspectable and retries the same ID without claiming completion', async () => {
    api.getCatalogIdentity.mockResolvedValue({ ...operation, state: 'prepared' });
    api.advanceCatalogIdentity.mockRejectedValueOnce(new Error('Peer is offline')).mockResolvedValueOnce({ ...operation, state: 'committed', peerState: 'prepared' });
    await show({ query: '?identityOperation=example-operation' });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue / verify with other owner' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Peer is offline');
    expect(screen.getByText('Accepted here · reserved while awaiting the coordinator decision')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue / verify with other owner' }));
    expect(await screen.findByText(/Commitment here does not confirm adoption/)).toBeInTheDocument();
    expect(api.advanceCatalogIdentity.mock.calls.map(call => call[0])).toEqual([operation.id, operation.id]);
    expect(api.createCatalogIdentity).not.toHaveBeenCalled();
  });

  it('requires explicit guarded recovery and preserves a refusal rather than offering force', async () => {
    api.getCatalogIdentity.mockResolvedValue({ ...operation, state: 'committed', peerState: 'committed' });
    api.recoverCatalogIdentity.mockRejectedValue(new Error('Later edits prevent recovery'));
    await show({ query: '?identityOperation=example-operation' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review recovery' }));
    expect(api.recoverCatalogIdentity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept recovery as this owner' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Later edits prevent recovery');
    expect(api.recoverCatalogIdentity).toHaveBeenCalledWith(operation.id, operation.planHash, { silent: true });
    expect(screen.queryByRole('button', { name: /force/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Recovered here · original identities restored')).not.toBeInTheDocument();
  });

  it('rejects unrelated operation URLs and drops a late response after selecting another operation', async () => {
    let finishOld;
    api.getCatalogIdentity.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    api.getCatalogIdentity.mockResolvedValue({ ...operation, id: 'other-operation', sourceId: 'unrelated-source', survivorId: 'unrelated-survivor' });
    const router = await show({ query: '?identityOperation=example-operation' });
    await act(async () => { await router.navigate('/casting/shared-survivor?identityOperation=other-operation'); });
    expect(await screen.findByRole('alert')).toHaveTextContent('does not belong');
    await act(async () => { finishOld(operation); });
    expect(screen.queryByRole('button', { name: 'Accept as this owner' })).not.toBeInTheDocument();
    expect(api.acceptCatalogIdentity).not.toHaveBeenCalled();
  });

  it('refreshes selected receipts on matching events/reconnect, pages summaries, and never loads every plan', async () => {
    api.listCatalogIdentities.mockResolvedValueOnce({ items: [operation], nextOffset: 10 })
      .mockResolvedValue({ items: [{ ...operation, id: 'older-operation' }], nextOffset: null });
    await show();
    expect(api.getCatalogIdentity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load more identity operations' }));
    await waitFor(() => expect(api.listCatalogIdentities).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 })));
    fireEvent.click(screen.getByRole('button', { name: `Inspect operation ${operation.id}` }));
    await screen.findByRole('button', { name: 'Accept as this owner' });
    const reads = api.getCatalogIdentity.mock.calls.length;
    await act(async () => { handlers.get('catalog:identity-changed')({ operationId: 'unrelated' }); });
    expect(api.getCatalogIdentity).toHaveBeenCalledTimes(reads);
    await act(async () => { handlers.get('catalog:identity-changed')({ operationId: operation.id }); });
    await waitFor(() => expect(api.getCatalogIdentity).toHaveBeenCalledTimes(reads + 1));
    await act(async () => { handlers.get('connect')(); });
    await waitFor(() => expect(api.getCatalogIdentity).toHaveBeenCalledTimes(reads + 2));
  });

  it('does not offer unlock or eligible creation for locked records and preserves dirty-form gating', async () => {
    await show({ record: { ...survivor, payload: { locked: true } }, query: '?identitySource=shared-source', disabledReason: 'Save profile edits first' });
    expect(await screen.findByRole('button', { name: 'Preview shared identity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import verified proposal' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /unlock/i })).not.toBeInTheDocument();
    expect(api.previewCatalogIdentity).not.toHaveBeenCalled();
  });
});
