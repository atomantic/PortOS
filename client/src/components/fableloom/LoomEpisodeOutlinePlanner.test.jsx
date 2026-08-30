import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toastMocks }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], loading: false }) }));
vi.mock('../../hooks/useFableLoomAiRun', () => ({
  default: () => ({ run: null, begin: () => '00000000-0000-4000-8000-000000000001', fail: vi.fn() }),
}));
vi.mock('../ProviderModelSelector', () => ({ default: () => <div data-testid="outline-route">Outline AI route</div> }));

vi.mock('../../services/api', () => ({
  generateLoomEpisodeOutline: vi.fn(),
  reviewLoomEpisodeOutline: vi.fn(),
  updateLoomEpisode: vi.fn(),
  validateLoomEpisodeOutline: vi.fn(),
}));

import * as api from '../../services/api';
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
    await user.click(expand);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('saves edited log-lines before the deterministic validation request', async () => {
    const user = userEvent.setup();
    const updatedLoom = { ...loom, episodes: [{ ...episode, storyOutline: { ...outline, validation: { status: 'draft', issues: [] } } }] };
    api.updateLoomEpisode.mockResolvedValueOnce(updatedLoom);
    api.validateLoomEpisodeOutline.mockResolvedValueOnce({
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

    await waitFor(() => expect(api.updateLoomEpisode).toHaveBeenCalled());
    expect(api.validateLoomEpisodeOutline).toHaveBeenCalledWith('loom-1', 'ep-1', { silent: true });
    expect(await screen.findByText('Outline is structurally valid')).toBeInTheDocument();
  });
});
