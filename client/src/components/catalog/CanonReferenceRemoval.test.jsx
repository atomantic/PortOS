import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CanonReferenceRemoval from './CanonReferenceRemoval';
import { getUniverse, removeUniverseCanonImageRef } from '../../services/apiUniverseBuilder';
vi.mock('../../services/apiCatalog', () => ({ getCatalogIngredientCards: vi.fn(async () => []) }));
vi.mock('../../services/apiUniverseBuilder', () => ({ getUniverse: vi.fn(), removeUniverseCanonImageRef: vi.fn() }));
it('confirms explicit reference removal using the owning embedded ID and preserves the asset/delta workflow', async () => {
  getUniverse.mockResolvedValue({ id: 'example-universe', characters: [{ id: 'example-entry', ingredientId: 'example-catalog' }] });
  let finish;
  removeUniverseCanonImageRef.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onRemoved = vi.fn();
  render(<CanonReferenceRemoval recordId="example-catalog" universeId="example-universe" kind="character" filename="example.png" onRemoved={onRemoved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference example.png' }));
  expect(removeUniverseCanonImageRef).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
  await waitFor(() => expect(removeUniverseCanonImageRef).toHaveBeenCalledWith('example-universe', 'character', 'example-entry', 'example.png', { silent: true }));
  expect(screen.getByRole('button', { name: 'Remove reference' })).toBeDisabled();
  await act(async () => finish({ universe: { characters: [{ id: 'example-entry', imageRefs: ['concurrent-append.png'] }] } }));
  expect(onRemoved).toHaveBeenCalledTimes(1);
});
describe('reference removal admission', () => {
  it('does not guess an embedded target when the owner no longer contains it', async () => {
    getUniverse.mockResolvedValue({ id: 'example-universe', characters: [] }); removeUniverseCanonImageRef.mockClear();
    render(<CanonReferenceRemoval recordId="missing" universeId="example-universe" kind="character" filename="example.png" onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference example.png' })); fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer has');
    expect(removeUniverseCanonImageRef).not.toHaveBeenCalled();
  });
});

it('resolves an ordinary local alias by canonical ID while retaining the original embedded entry ID', async () => {
  const { getCatalogIngredientCards } = await import('../../services/apiCatalog');
  getUniverse.mockResolvedValue({ id: 'example-universe', characters: [{ id: 'stable-entry', ingredientId: 'local-alias' }] });
  getCatalogIngredientCards.mockResolvedValue([{ id: 'local-alias', canonicalId: 'survivor', payload: {}, sharedIdentity: null }]);
  removeUniverseCanonImageRef.mockResolvedValue({});
  render(<CanonReferenceRemoval recordId="survivor" universeId="example-universe" kind="character" filename="example.png" onRemoved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference example.png' })); fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
  await waitFor(() => expect(removeUniverseCanonImageRef).toHaveBeenCalledWith('example-universe', 'character', 'stable-entry', 'example.png', { silent: true }));
});

it('refuses an ambiguous direct-plus-alias binding without removing any reference', async () => {
  const { getCatalogIngredientCards } = await import('../../services/apiCatalog');
  getUniverse.mockResolvedValue({ id: 'example-universe', characters: [{ id: 'direct', ingredientId: 'survivor' }, { id: 'old', ingredientId: 'local-alias' }] });
  getCatalogIngredientCards.mockResolvedValue([{ id: 'local-alias', canonicalId: 'survivor', payload: {}, sharedIdentity: null }]);
  removeUniverseCanonImageRef.mockClear();
  render(<CanonReferenceRemoval recordId="survivor" universeId="example-universe" kind="character" filename="example.png" onRemoved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference example.png' })); fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Multiple canon entries');
  expect(removeUniverseCanonImageRef).not.toHaveBeenCalled();
});
