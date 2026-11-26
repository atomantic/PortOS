import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { findEnabledByRole } from '../../test/enabledBarrier.js';

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toastMocks }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], loading: false }) }));
vi.mock('../../hooks/useFableLoomAiRun', () => ({
  default: () => ({ run: null, begin: () => '00000000-0000-4000-8000-000000000001', fail: vi.fn() }),
}));
vi.mock('../ProviderModelSelector', () => ({ default: ({ onProviderChange, onModelChange, onEffortChange }) => <button type="button" onClick={() => { onProviderChange('writer'); onModelChange('example-model'); onEffortChange('low'); }}>Select outline route</button> }));

vi.mock('../../services/apiFableLoom.js', () => ({
  generateLoomEpisodeOutline: vi.fn(),
  startLoomEpisodeShotRun: vi.fn(),
  getLoomEpisodeShotRun: vi.fn(async () => null),
  cancelLoomEpisodeShotRun: vi.fn(),
  getLoom: vi.fn(),
  applyLoomEpisodeShots: vi.fn(),
  reviewLoomEpisodeOutline: vi.fn(),
  updateLoomEpisode: vi.fn(),
  validateLoomEpisodeOutline: vi.fn(),
}));

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
import socket from '../../services/socket';
import { updateLoomEpisode, validateLoomEpisodeOutline, startLoomEpisodeShotRun } from '../../services/apiFableLoom.js';
import LoomEpisodeOutlinePlanner from './LoomEpisodeOutlinePlanner';

const outline = {
  version: 1,
  startKey: 's1',
  scenes: [
    { key: 's1', title: 'Signal', summary: 'A signal arrives.', playbackMode: 'cut', audienceConnection: 'disconnected', transitions: [{ targetKey: 's2', intent: 'follow it' }] },
    { key: 's2', title: 'Choice', summary: 'The signal demands a cost.', playbackMode: 'decision', audienceConnection: 'connected', transitions: [{ targetKey: 's3', intent: 'answer' }, { targetKey: 's4', intent: 'wait' }] },
    { key: 's3', title: 'Answer', summary: 'The answer opens a door.', playbackMode: 'cut', isEnding: true, endingLabel: 'Open door', transitions: [] },
    { key: 's4', title: 'Wait', summary: 'The silence grows.', playbackMode: 'cut', isEnding: true, endingLabel: 'Long night', transitions: [] },
  ],
  validation: { status: 'valid', issues: [] },
};

const loom = { id: 'loom-1', name: 'Example Loom', episodes: [] };
const episode = { id: 'ep-1', number: 1, title: 'Pilot', synopsis: 'A signal arrives.', nodes: [], storyOutline: outline };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoomEpisodeOutlinePlanner', () => {
  it('shows the beat arc and only enables expansion after validation', async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(<LoomEpisodeOutlinePlanner open loom={loom} episode={episode} onLoomUpdate={vi.fn()} onExpand={onExpand} />);

    expect(screen.getByRole('heading', { name: 'Story beats → teleplay' })).toBeInTheDocument();
    expect(screen.getByText('Signal')).toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand validated outline to teleplay' });
    expect(expand).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Select outline route' }));
    await user.click(expand);
    expect(onExpand).toHaveBeenCalledWith({ providerId: 'writer', model: 'example-model', effort: 'low' });
  });

  it('requires fresh validation when the same episode receives a draft outline', async () => {
    const user = userEvent.setup();
    const validation = { issues: [], stats: { sceneCount: 4, decisionCount: 1, endingCount: 2, errorCount: 0 } };
    const validatedEpisode = { ...episode, storyOutline: { ...outline } };
    const validatedLoom = { ...loom, episodes: [validatedEpisode] };
    validateLoomEpisodeOutline.mockResolvedValue({
      loom: validatedLoom, outline: validatedEpisode.storyOutline, validation,
    });
    const onLoomUpdate = vi.fn();
    const onExpand = vi.fn();
    const planner = (record) => (
      <LoomEpisodeOutlinePlanner open loom={loom} episode={record} onLoomUpdate={onLoomUpdate} onExpand={onExpand} />
    );
    const { rerender } = render(planner(episode));

    await user.click(screen.getByRole('button', { name: 'Validate outline' }));
    await waitFor(() => expect(onLoomUpdate).toHaveBeenCalledWith(validatedLoom));
    rerender(planner(validatedEpisode));
    expect(screen.getByText('4 beats · 1 choices · 2 endings')).toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand validated outline to teleplay' });
    expect(expand).toBeEnabled();

    rerender(planner({
      ...episode, title: 'Revised pilot',
      storyOutline: { ...outline, validation: { status: 'draft', issues: [] } },
    }));
    expect(screen.getByText('Outline is a draft')).toBeInTheDocument();
    expect(expand).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Validate outline' }));
    await findEnabledByRole('button', { name: 'Expand validated outline to teleplay' });
  });

  it('preserves unsaved log-lines when the server updates the same episode', async () => {
    const user = userEvent.setup();
    const planner = (record) => <LoomEpisodeOutlinePlanner open loom={loom} episode={record} />;
    const { rerender } = render(planner(episode));

    await user.click(screen.getByTestId('outline-beat-s1').querySelector('button'));
    const summary = screen.getByLabelText('Log-line / summary');
    await user.type(summary, ' It names a ship.');
    rerender(planner({
      ...episode, synopsis: 'A changed synopsis.',
      storyOutline: { ...outline, validation: { status: 'draft', issues: [] } },
    }));

    expect(summary).toHaveValue('A signal arrives. It names a ship.');
    expect(screen.getByRole('button', { name: 'Save & validate' })).toBeEnabled();
  });

  it('saves edited log-lines before the deterministic validation request', async () => {
    const user = userEvent.setup();
    const updatedLoom = { ...loom, episodes: [{ ...episode, storyOutline: { ...outline, validation: { status: 'draft', issues: [] } } }] };
    updateLoomEpisode.mockResolvedValueOnce(updatedLoom);
    validateLoomEpisodeOutline.mockResolvedValueOnce({
      loom: { ...updatedLoom, episodes: [{ ...episode, storyOutline: { ...outline, validation: { status: 'valid', issues: [] } } }] },
      outline: { ...outline, validation: { status: 'valid', issues: [] } },
      validation: { issues: [], stats: { sceneCount: 4, decisionCount: 1, endingCount: 2, errorCount: 0 } },
    });
    render(<LoomEpisodeOutlinePlanner open loom={loom} episode={episode} onLoomUpdate={vi.fn()} />);

    await user.click(screen.getByTestId('outline-beat-s1').querySelector('button'));
    const summary = screen.getByLabelText('Log-line / summary');
    await user.clear(summary);
    await user.type(summary, 'The signal names a living ship.');
    await user.click(screen.getByRole('button', { name: 'Save & validate' }));

    await waitFor(() => expect(updateLoomEpisode).toHaveBeenCalled());
    expect(validateLoomEpisodeOutline).toHaveBeenCalledWith('loom-1', 'ep-1', { silent: true });
    expect(await screen.findByText('Outline is structurally valid')).toBeInTheDocument();
  });

  it('offers to replace an older teleplay when only outline-to-scene sync is invalid', async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    const replacementOutline = {
      ...outline,
      validation: {
        status: 'invalid',
        issues: [{
          code: 'TELEPLAY_SCENE_CONTRACT_MISMATCH',
          severity: 'error',
          message: 'The revised beat no longer matches the old teleplay scene contract.',
          sceneKey: 's1',
        }],
      },
    };
    const expandedEpisode = {
      ...episode,
      nodes: [{ id: 's1', title: 'Old scene' }],
      storyOutline: replacementOutline,
    };

    render(
      <LoomEpisodeOutlinePlanner
        open
        loom={loom}
        episode={expandedEpisode}
        onLoomUpdate={vi.fn()}
        onExpand={onExpand}
      />,
    );

    expect(screen.getByText('Outline is ready to replace the old teleplay')).toBeInTheDocument();
    const replace = screen.getByRole('button', { name: 'Replace old teleplay from this outline' });
    expect(replace).toBeEnabled();
    await user.click(replace);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('maps a playable challenge and its production phase onto a concrete beat', async () => {
    const user = userEvent.setup();
    const challengeLoom = {
      ...loom,
      seriesPlan: {
        plotPoints: [{
          id: 'plot-lock', kind: 'challenge', title: 'Open the sealed door',
          description: 'Recall the planted code.', episodeId: 'ep-1',
        }],
      },
    };
    updateLoomEpisode.mockImplementation(async (_loomId, _episodeId, patch) => ({
      ...challengeLoom,
      episodes: [{ ...episode, storyOutline: patch.storyOutline }],
    }));
    render(
      <LoomEpisodeOutlinePlanner
        open loom={challengeLoom} episode={episode} onLoomUpdate={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('outline-beat-s1').querySelector('button'));
    await user.selectOptions(screen.getByLabelText('Mapped plot point'), 'plot-lock');
    await user.selectOptions(screen.getByLabelText('Challenge phase'), 'failure');
    await user.click(screen.getByRole('button', { name: 'Save outline' }));

    await waitFor(() => expect(updateLoomEpisode).toHaveBeenCalledWith(
      'loom-1',
      'ep-1',
      expect.objectContaining({
        storyOutline: expect.objectContaining({
          scenes: expect.arrayContaining([expect.objectContaining({
            key: 's1', plotPointId: 'plot-lock', challengePhase: 'failure',
          })]),
        }),
      }),
      { silent: true },
    ));
  });
});

it('blocks competing outline work until shot planning settles', async () => {
  const run = { id: 'shots-example', loomId: 'loom-1', episodeId: 'ep-1', revision: 1, createdAt: '2026-01-01', status: 'running', message: 'Planning shots' };
  startLoomEpisodeShotRun.mockResolvedValue(run);
  render(<LoomEpisodeOutlinePlanner open loom={loom} episode={{ ...episode, nodes: [{ id: 'scene-1' }] }} onLoomUpdate={vi.fn()} onExpand={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Preview shot split' }));
  expect(screen.getByRole('button', { name: 'Refresh with AI' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Validate outline' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Expand validated outline to teleplay' })).toBeDisabled();
  expect(startLoomEpisodeShotRun).toHaveBeenCalledTimes(1);
  const accept = socket.on.mock.calls.findLast(([name]) => name === 'fableloom:shots:run')[1];
  await act(async () => accept({ ...run, revision: 2, status: 'completed', result: { review: { summary: 'Ready.' }, groups: [] } }));
  await findEnabledByRole('button', { name: 'Expand validated outline to teleplay' });
});
