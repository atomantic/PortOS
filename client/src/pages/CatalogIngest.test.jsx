import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CatalogIngest from './CatalogIngest';
import { createCatalogScrap, pruneCatalogScrap, commitCatalogScrapDraft, ingestCatalogBrain } from '../services/apiCatalog';
import { listUniverseNames } from '../services/apiUniverseBuilder';
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../hooks/useProviderModels', () => ({ default: () => ({ providers: [], selectedProviderId: 'example-provider', selectedModel: 'example-model', availableModels: [], loading: false }) }));
vi.mock('../components/ProviderModelSelector', () => ({ default: ({ onEffortChange }) => <button type="button" onClick={() => onEffortChange('high')}>High effort</button> }));
vi.mock('../services/apiCatalog', () => ({ createCatalogScrap: vi.fn(), pruneCatalogScrap: vi.fn(), commitCatalogScrapDraft: vi.fn(), ingestCatalogBrain: vi.fn() }));
vi.mock('../services/apiUniverseBuilder', () => ({ listUniverseNames: vi.fn().mockResolvedValue([]) }));
it('prunes only on request, keeps the brainstorm, and saves edited selected suggestions', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'example-scrap' } });
  pruneCatalogScrap.mockResolvedValue({ scrap: { id: 'example-scrap' }, draft: { ideas: [{ name: 'Moon story', summary: 'A missing moon.' }], scenes: [{ name: 'Argument', summary: 'Two travelers argue.' }] } });
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [] });
  render(<MemoryRouter initialEntries={['/catalog/ingest?mode=babble']}><CatalogIngest /></MemoryRouter>);
  expect(pruneCatalogScrap).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Babble freely/), { target: { value: 'A missing moon and arguing travelers.' } });
  fireEvent.click(screen.getByText('High effort'));
  fireEvent.click(screen.getByRole('button', { name: 'Prune into suggestions' }));
  await screen.findByDisplayValue('Moon story');
  expect(createCatalogScrap).toHaveBeenCalledWith(expect.objectContaining({ rawText: 'A missing moon and arguing travelers.' }), expect.anything());
  expect(pruneCatalogScrap).toHaveBeenCalledWith('example-scrap', { providerId: 'example-provider', model: 'example-model', effort: 'high' }, expect.anything());
  expect(commitCatalogScrapDraft).not.toHaveBeenCalled();
  fireEvent.change(screen.getByDisplayValue('Moon story'), { target: { value: 'The lost moon' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Argument' }));
  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith('example-scrap', [expect.objectContaining({ name: 'The lost moon', type: 'idea' })], expect.anything()));
});

// Regression (#7615): the brain-bridge handoff runs from the mount effect, so
// reading the universe list out of component STATE there captures the
// pre-load empty array and the capture-source Reality default never resolves —
// the select silently falls back to Unassigned, which is the exact unlinked
// outcome #7615 exists to stop. Hold the list in a ref so the mount-effect
// closure sees it.
it('defaults a brain-bridge ingest to the Reality universe even though it starts from the mount effect', async () => {
  listUniverseNames.mockResolvedValue([{ id: 'uni-other', name: 'Example Universe' }, { id: 'uni-reality', name: 'Reality' }]);
  // Resolves a macrotask later than the universe list — the real ordering,
  // where a tiny GET beats an LLM extraction by seconds.
  ingestCatalogBrain.mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve({ scrap: { id: 'brain-scrap' }, draft: { ideas: [{ name: 'Captured thought', summary: 'From the brain inbox.' }] } }), 0);
  }));
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [{ id: 'cat-idea-1' }] });

  render(
    <MemoryRouter initialEntries={[{ pathname: '/catalog/ingest', state: { brainIngest: { brainType: 'note', brainId: 'note-1', title: 'Captured' } } }]}>
      <CatalogIngest />
    </MemoryRouter>,
  );

  await screen.findByDisplayValue('Captured thought');
  expect(screen.getByLabelText('Catalogue into')).toHaveValue('uni-reality');

  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith(
    'brain-scrap',
    [expect.objectContaining({ name: 'Captured thought', type: 'idea' })],
    expect.objectContaining({ universeRef: 'uni-reality' }),
  ));
});
