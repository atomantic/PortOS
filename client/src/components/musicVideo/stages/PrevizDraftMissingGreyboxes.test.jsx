import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PrevizDraftMissingGreyboxes from './PrevizDraftMissingGreyboxes.jsx';
import { draftCatalogGreybox, saveCatalogGreybox } from '../../../services/apiCatalog.js';

vi.mock('../../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{ id: 'p1', name: 'Provider 1', enabled: true }],
    selectedProviderId: 'p1',
    selectedModel: 'm1',
    availableModels: ['m1'],
    loading: false,
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
  }),
}));

vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../services/apiCatalog.js', () => ({
  draftCatalogGreybox: vi.fn(),
  saveCatalogGreybox: vi.fn(),
}));

const project = {
  id: 'mv-1',
  concept: {
    subjects: [
      { id: 'c-lead', kind: 'character', name: 'Lead Singer' },
      { id: 'p-diner', kind: 'place', name: 'Diner', ingredientId: 'cat-diner' },
      { id: 'p-motel', kind: 'place', name: 'Motel', ingredientId: 'cat-motel' },
    ],
  },
  scenes: [
    { sceneId: 's1', startSec: 0, endSec: 4, shotSheet: { view: 'Wide', characters: ['Lead Singer'], action: 'Lead enters the diner' } },
    { sceneId: 's2', startSec: 4, endSec: 8, shotSheet: { view: 'Close-up', characters: ['Lead Singer'], action: 'Lead sits at motel desk' } },
  ],
  previz: {
    cuts: [
      { id: 'cut-1', sceneId: 's1', startSec: 0, endSec: 4, placeSubjectId: 'p-diner', viewShotId: null, holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null },
      { id: 'cut-2', sceneId: 's2', startSec: 4, endSec: 8, placeSubjectId: 'p-motel', viewShotId: null, holderSubjectId: null, visibleSubjectIds: null, aimSubjectId: null },
    ],
    tracks: [],
  },
};

const sets = [
  { subject: { id: 'p-diner', name: 'Diner', ingredientId: 'cat-diner' }, cuts: 1 },
  { subject: { id: 'p-motel', name: 'Motel', ingredientId: 'cat-motel' }, cuts: 1 },
];

it('renders nothing when there are no draftable sets', () => {
  const { container } = render(
    <PrevizDraftMissingGreyboxes
      sets={[{ subject: { id: 'p-unknown', name: 'Unknown', ingredientId: null }, cuts: 1 }]}
      project={project}
      places={{}}
      locked={false}
      jobRunning={false}
      onSavePreviz={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();
});

it('drafts each set, pauses for review, and saves when confirmed', async () => {
  const onSavePreviz = vi.fn();
  const onPlaceUpdated = vi.fn();

  draftCatalogGreybox.mockResolvedValueOnce({
    greybox: {
      parts: [{ id: 'table', type: 'box', position: [0, 0, 0] }],
      anchors: [{ id: 'lead-mark', kind: 'figure', position: [1, 0, 2], facingDegrees: 90 }],
      shots: [{ id: 'cam-shot1', label: 'Shot 1', figures: [{ anchorId: 'lead-mark' }] }],
    },
    sentPrompt: 'Instruction prompt for diner',
    promptAdditions: [],
    providerId: 'p1',
    model: 'm1',
  }).mockResolvedValueOnce({
    greybox: {
      parts: [{ id: 'bed', type: 'box', position: [0, 0, 0] }],
      anchors: [{ id: 'lead-mark-2', kind: 'figure', position: [0, 0, 1], facingDegrees: 0 }],
      shots: [{ id: 'cam-shot2', label: 'Shot 2', figures: [{ anchorId: 'lead-mark-2' }] }],
    },
    sentPrompt: 'Instruction prompt for motel',
    promptAdditions: [],
    providerId: 'p1',
    model: 'm1',
  });

  saveCatalogGreybox.mockResolvedValue({ id: 'saved' });

  render(
    <PrevizDraftMissingGreyboxes
      sets={sets}
      project={project}
      places={{}}
      locked={false}
      jobRunning={false}
      onSavePreviz={onSavePreviz}
      onPlaceUpdated={onPlaceUpdated}
    />,
  );

  const startBtn = screen.getByRole('button', { name: /Draft missing greyboxes from shots/ });
  fireEvent.click(startBtn);

  // First set review step
  const dinerReview = await screen.findByRole('region', { name: /Review greybox draft for Diner/ });
  expect(dinerReview).toBeTruthy();
  expect(draftCatalogGreybox).toHaveBeenCalledWith('cat-diner', expect.objectContaining({
    instruction: expect.stringContaining('Shot 1'),
    providerId: 'p1',
  }), { silent: true });

  const saveDinerBtn = within(dinerReview).getByRole('button', { name: /Save & link cameras/ });
  fireEvent.click(saveDinerBtn);

  await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('cat-diner', expect.any(Object), { source: 'refine', silent: true }));
  expect(onPlaceUpdated).toHaveBeenCalledWith('cat-diner', expect.any(Object));
  expect(onSavePreviz).toHaveBeenCalled();

  // Second set review step
  const motelReview = await screen.findByRole('region', { name: /Review greybox draft for Motel/ });
  expect(motelReview).toBeTruthy();

  const saveMotelBtn = within(motelReview).getByRole('button', { name: /Save & link cameras \(Finish\)/ });
  fireEvent.click(saveMotelBtn);

  await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('cat-motel', expect.any(Object), { source: 'refine', silent: true }));
  expect(onSavePreviz).toHaveBeenCalledTimes(2);
});

it('allows skipping a set during review', async () => {
  const onSavePreviz = vi.fn();

  draftCatalogGreybox.mockResolvedValue({
    greybox: { parts: [], anchors: [], shots: [] },
    sentPrompt: 'prompt',
    promptAdditions: [],
  });

  render(
    <PrevizDraftMissingGreyboxes
      sets={sets}
      project={project}
      places={{}}
      locked={false}
      jobRunning={false}
      onSavePreviz={onSavePreviz}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /Draft missing greyboxes from shots/ }));

  const dinerReview = await screen.findByRole('region', { name: /Review greybox draft for Diner/ });
  fireEvent.click(within(dinerReview).getByRole('button', { name: /Skip set/ }));

  // Moved directly to Motel review without saving Diner
  const motelReview = await screen.findByRole('region', { name: /Review greybox draft for Motel/ });
  expect(motelReview).toBeTruthy();
  expect(saveCatalogGreybox).not.toHaveBeenCalled();
});
