import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CatalogIngest from './CatalogIngest';
import { createCatalogScrap, extractFromCatalogScrap, pruneCatalogScrap, commitCatalogScrapDraft, ingestCatalogBrain } from '../services/apiCatalog';
import { listUniverseNames } from '../services/apiUniverseBuilder';
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../hooks/useProviderModels', () => ({ default: () => ({ providers: [], selectedProviderId: 'example-provider', selectedModel: 'example-model', availableModels: [], loading: false }) }));
vi.mock('../components/ProviderModelSelector', () => ({ default: ({ onEffortChange }) => <button type="button" onClick={() => onEffortChange('high')}>High effort</button> }));
vi.mock('../services/apiCatalog', () => ({ createCatalogScrap: vi.fn(), extractFromCatalogScrap: vi.fn(), pruneCatalogScrap: vi.fn(), commitCatalogScrapDraft: vi.fn(), ingestCatalogBrain: vi.fn() }));
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

it('carries the Brain-selected provider and model into a creative inbox handoff', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'brain-notes-scrap' } });
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'brain-notes-scrap' },
    draft: { ideas: [{ name: 'A captured idea', summary: 'A useful fragment.' }] },
  });

  render(
    <MemoryRouter initialEntries={[{
      pathname: '/catalog/ingest',
      state: {
        prefill: {
          title: 'Creative notes from Brain',
          rawText: 'A captured idea.',
          providerOverride: 'ollama',
          modelOverride: 'example-model',
        },
      },
    }]}>
      <CatalogIngest />
    </MemoryRouter>,
  );

  await screen.findByDisplayValue('A captured idea.');
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await waitFor(() => expect(extractFromCatalogScrap).toHaveBeenCalledWith(
    'brain-notes-scrap',
    { providerOverride: 'ollama', modelOverride: 'example-model' },
    expect.anything(),
  ));
});

// Regression (#7615): the brain-bridge handoff runs from the mount effect, so
// reading the universe list out of component STATE there captures the
// pre-load empty array and the capture-source Reality default never resolves —
// the select silently falls back to Unassigned, which is the exact unlinked
// outcome #7615 exists to stop. Hold the list in a ref so the mount-effect
// closure sees it.
it('defaults a brain-bridge ingest to the Reality universe even though it starts from the mount effect', async () => {
  // The shipped seed (#7616) is matched by id, so a renamed Reality still
  // resolves — a name-only match would fall through to Unassigned here.
  listUniverseNames.mockResolvedValue([{ id: 'uni-other', name: 'Example Universe' }, { id: 'universe-reality', name: 'Home' }]);
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
  expect(screen.getByLabelText('Catalogue into')).toHaveValue('universe-reality');

  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith(
    'brain-scrap',
    [expect.objectContaining({ name: 'Captured thought', type: 'idea' })],
    expect.objectContaining({ universeRef: 'universe-reality' }),
  ));
});

it('keeps partial extraction failures visible in review and excludes draft metadata from legacy payloads', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'partial-scrap' } });
  extractFromCatalogScrap.mockResolvedValue({ scrap: { id: 'partial-scrap' }, draft: {
    ideas: [{ draftId: 'draft-idea-1', sourceIdentity: 'a thought', name: 'Partial thought', summary: 'A supported fragment.' }],
    stages: [{ id: 'catalog-1', label: 'Part 1', status: 'completed' }, { id: 'catalog-2', label: 'Part 2', status: 'failed', error: 'Output capacity exceeded' }],
    coverage: { status: 'partial', failedChunks: [1] },
  } });
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [] });
  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'a thought' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));
  await screen.findByDisplayValue('Partial thought');
  expect(screen.getByRole('alert')).toHaveTextContent('Extraction is incomplete');
  expect(screen.getByRole('alert')).toHaveTextContent('Part 2: Output capacity exceeded');
  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith('partial-scrap',
    [expect.objectContaining({ payload: { summary: 'A supported fragment.' } })], expect.anything()));
});

it('preserves rename and reorder stability and updates relationship endpoint labels', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-stable' } });
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'scrap-stable' },
    draft: {
      characters: [{ draftId: 'chr-1', name: 'Ada Lovelace', payload: { role: 'Mentor' } }],
      objects: [{ draftId: 'obj-1', name: 'Pocket Watch', payload: { description: 'Golden watch' } }],
      relationships: [
        { fromDraftId: 'chr-1', toDraftId: 'obj-1', kind: 'owned-by', evidence: 'Ada carries the golden watch.' },
      ],
    },
  });
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [] });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'Ada and her watch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Ada Lovelace');
  expect(screen.getByDisplayValue('Pocket Watch')).toBeTruthy();

  // Check relationship card shows initial names, kind badge, and evidence
  expect(screen.getByText('Owned by')).toBeTruthy();
  expect(screen.getByText('(inverse: Owns)')).toBeTruthy();
  expect(screen.getByText('“Ada carries the golden watch.”')).toBeTruthy();

  // Rename Ada Lovelace inline
  fireEvent.change(screen.getByDisplayValue('Ada Lovelace'), { target: { value: 'Countess Ada' } });

  // Relationship review card updates endpoint name to "Countess Ada"
  expect(screen.getByText('Countess Ada')).toBeTruthy();

  // Both items are still checked by stable draftId
  expect(screen.getByRole('checkbox', { name: 'Include Countess Ada' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Include Pocket Watch' })).toBeChecked();

  // Commit
  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith(
    'scrap-stable',
    [
      expect.objectContaining({ draftId: 'chr-1', name: 'Countess Ada', type: 'character' }),
      expect.objectContaining({ draftId: 'obj-1', name: 'Pocket Watch', type: 'object' }),
    ],
    expect.objectContaining({
      relationships: [
        expect.objectContaining({
          fromDraftId: 'chr-1',
          toDraftId: 'obj-1',
          kind: 'owned-by',
          evidence: 'Ada carries the golden watch.',
        }),
      ],
    }),
  ));
});

it('supports relationship link opt-out with explicit empty commit array', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-opt-out' } });
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'scrap-opt-out' },
    draft: {
      characters: [{ draftId: 'chr-1', name: 'Ada Lovelace' }],
      objects: [{ draftId: 'obj-1', name: 'Pocket Watch' }],
      relationships: [
        { fromDraftId: 'chr-1', toDraftId: 'obj-1', kind: 'owned-by', evidence: 'Ada carries the watch' },
      ],
    },
  });
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [] });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'Ada with watch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Ada Lovelace');

  // Opt-out of the relationship by unchecking it
  const relCheckbox = screen.getByRole('checkbox', { name: 'Include relationship Ada Lovelace Owned by Pocket Watch' });
  expect(relCheckbox).toBeChecked();
  fireEvent.click(relCheckbox);
  expect(relCheckbox).not.toBeChecked();

  // Commit
  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith(
    'scrap-opt-out',
    expect.any(Array),
    expect.objectContaining({
      relationships: [], // Explicitly empty array!
    }),
  ));
});

it('disables relationship and provides feedback when an endpoint is deselected without auto-selecting', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-endpoint-desel' } });
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'scrap-endpoint-desel' },
    draft: {
      characters: [{ draftId: 'chr-1', name: 'Ada Lovelace' }],
      objects: [{ draftId: 'obj-1', name: 'Pocket Watch' }],
      relationships: [
        { fromDraftId: 'chr-1', toDraftId: 'obj-1', kind: 'owned-by', evidence: 'Ada carries the watch' },
      ],
    },
  });
  commitCatalogScrapDraft.mockResolvedValue({ ingredients: [] });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'Ada with watch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Ada Lovelace');

  // Deselect Pocket Watch
  const watchCheckbox = screen.getByRole('checkbox', { name: 'Include Pocket Watch' });
  fireEvent.click(watchCheckbox);
  expect(watchCheckbox).not.toBeChecked();

  // Relationship checkbox is now disabled
  const relCheckbox = screen.getByRole('checkbox', { name: 'Include relationship Ada Lovelace Owned by Pocket Watch' });
  expect(relCheckbox).toBeDisabled();

  // Visible feedback in role="status"
  expect(screen.getByRole('status')).toHaveTextContent('Disabled — Pocket Watch is deselected');

  // Interacting with disabled relationship does not re-select Pocket Watch
  fireEvent.click(relCheckbox);
  expect(watchCheckbox).not.toBeChecked();

  // Commit sends only Ada and empty relationships list
  fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
  await waitFor(() => expect(commitCatalogScrapDraft).toHaveBeenCalledWith(
    'scrap-endpoint-desel',
    [expect.objectContaining({ draftId: 'chr-1', name: 'Ada Lovelace' })],
    expect.objectContaining({ relationships: [] }),
  ));
});

it('renders alert and disables commit when draft entries exceed 200 or relationships exceed 1,000', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-overflow' } });
  const ideas = Array.from({ length: 201 }, (_, i) => ({
    draftId: `idea-${i}`,
    name: `Idea ${i}`,
    summary: `Summary ${i}`,
  }));
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'scrap-overflow' },
    draft: { ideas, relationships: [] },
  });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'many ideas' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Idea 0');

  // Alert is visible
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Draft exceeds capacity limits');
  expect(alert).toHaveTextContent('201 entries (max 200)');

  // Commit button is disabled
  const commitBtn = screen.getByRole('button', { name: /Commit/ });
  expect(commitBtn).toBeDisabled();
});

it('renders alert and disables commit when relationships exceed 1,000', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-rel-overflow' } });
  const rels = Array.from({ length: 1001 }, (_, i) => ({
    id: `rel-${i}`,
    fromDraftId: 'chr-1',
    toDraftId: 'obj-1',
    kind: 'related-to',
  }));
  extractFromCatalogScrap.mockResolvedValue({
    scrap: { id: 'scrap-rel-overflow' },
    draft: {
      characters: [{ draftId: 'chr-1', name: 'Ada' }],
      objects: [{ draftId: 'obj-1', name: 'Watch' }],
      relationships: rels,
    },
  });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'many relations' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Ada');

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Draft exceeds capacity limits');
  expect(alert).toHaveTextContent('1001 relationships (max 1,000)');

  const commitBtn = screen.getByRole('button', { name: /Commit/ });
  expect(commitBtn).toBeDisabled();
});

it('renders retry button on partial failures which re-extracts without silent auto-saving', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'scrap-retry' } });
  extractFromCatalogScrap
    .mockResolvedValueOnce({
      scrap: { id: 'scrap-retry' },
      draft: {
        ideas: [{ draftId: 'idea-1', name: 'Incomplete Idea', summary: 'Some text' }],
        stages: [
          { id: 'chunk-1', label: 'Chunk 1', status: 'completed' },
          { id: 'chunk-2', label: 'Chunk 2', status: 'failed', error: 'Provider quota limit' },
        ],
      },
    })
    .mockResolvedValueOnce({
      scrap: { id: 'scrap-retry' },
      draft: {
        ideas: [
          { draftId: 'idea-1', name: 'Incomplete Idea', summary: 'Some text' },
          { draftId: 'idea-2', name: 'Complete Idea', summary: 'All good' },
        ],
        stages: [
          { id: 'chunk-1', label: 'Chunk 1', status: 'completed' },
          { id: 'chunk-2', label: 'Chunk 2', status: 'completed' },
        ],
      },
    });

  render(<MemoryRouter initialEntries={['/catalog/ingest']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Raw text/), { target: { value: 'chunk retry test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));

  await screen.findByDisplayValue('Incomplete Idea');
  expect(commitCatalogScrapDraft).not.toHaveBeenCalled();

  // Retry extraction button in the partial failure alert
  const retryBtn = screen.getByRole('button', { name: 'Retry extraction' });
  fireEvent.click(retryBtn);

  await screen.findByDisplayValue('Complete Idea');
  expect(extractFromCatalogScrap).toHaveBeenCalledTimes(2);
  expect(commitCatalogScrapDraft).not.toHaveBeenCalled();
});


it('retains the operation key after a lost response and rotates it for edited reviewed content', async () => {
  createCatalogScrap.mockResolvedValue({ scrap: { id: 'example-retry-scrap' } });
  pruneCatalogScrap.mockResolvedValue({ scrap: { id: 'example-retry-scrap' }, draft: { ideas: [{ name: 'Example retry idea' }] } });
  commitCatalogScrapDraft.mockRejectedValue(new Error('Response lost'));
  render(<MemoryRouter initialEntries={['/catalog/ingest?mode=babble']}><CatalogIngest /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/Babble freely/), { target: { value: 'Example retry source.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prune into suggestions' }));
  await screen.findByDisplayValue('Example retry idea');
  const commit = () => screen.getByRole('button', { name: /Commit/ });
  fireEvent.click(commit());
  await waitFor(() => expect(commit()).not.toBeDisabled());
  const firstKey = commitCatalogScrapDraft.mock.lastCall[2].operationKey;
  expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
  fireEvent.click(commit());
  await waitFor(() => expect(commit()).not.toBeDisabled());
  expect(commitCatalogScrapDraft.mock.lastCall[2].operationKey).toBe(firstKey);
  fireEvent.change(screen.getByDisplayValue('Example retry idea'), { target: { value: 'Example changed idea' } });
  fireEvent.click(commit());
  await waitFor(() => expect(commit()).not.toBeDisabled());
  expect(commitCatalogScrapDraft.mock.lastCall[2].operationKey).not.toBe(firstKey);
});
