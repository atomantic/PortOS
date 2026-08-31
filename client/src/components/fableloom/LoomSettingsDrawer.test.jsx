import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  reformatLoomEpisode: vi.fn(),
  updateLoom: vi.fn(),
}));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [] }) }));
vi.mock('../ProviderModelSelector', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { reformatLoomEpisode, updateLoom } from '../../services/api';
import toast from '../ui/Toast';
import LoomSettingsDrawer from './LoomSettingsDrawer';

const scene = (id, format) => ({ id, title: id, prose: `Prose for ${id}.`, format, transitions: [] });

// Two episodes, all scenes still prose while the loom is pinned to teleplay —
// the state right after an author flips the format select.
const makeLoom = (episodes) => ({
  id: 'loom-1',
  name: 'Example Loom',
  format: 'teleplay',
  playSettings: {},
  episodes,
});

const twoEpisodes = () => makeLoom([
  { id: 'ep-1', title: 'Pilot', nodes: [scene('s1'), scene('s2')] },
  { id: 'ep-2', title: 'Second', nodes: [scene('s3')] },
]);

const renderDrawer = (loom, props = {}) => {
  const onLoomUpdate = vi.fn();
  const onRewritten = vi.fn();
  render(
    <MemoryRouter>
      <LoomSettingsDrawer
        open
        onClose={() => {}}
        loom={loom}
        onLoomUpdate={onLoomUpdate}
        onRewritten={onRewritten}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onLoomUpdate, onRewritten };
};

const clickRewrite = (user) => user.click(screen.getByRole('button', { name: /^Rewrite \d+ scene/ }));

beforeEach(() => vi.clearAllMocks());

describe('LoomSettingsDrawer rewrite', () => {
  it('walks the episodes one request at a time instead of one request for the loom', async () => {
    const user = userEvent.setup();
    const loom = twoEpisodes();
    reformatLoomEpisode
      .mockResolvedValueOnce({ loom, rewritten: 2, episodeRemaining: 0, remaining: 1, capped: false })
      .mockResolvedValueOnce({ loom, rewritten: 1, episodeRemaining: 0, remaining: 0, capped: false });
    const { onLoomUpdate } = renderDrawer(loom);

    // The count is the scenes that still need converting, not every scene.
    expect(screen.getByRole('button', { name: 'Rewrite 3 scenes as teleplay' })).toBeInTheDocument();
    await clickRewrite(user);

    await waitFor(() => expect(reformatLoomEpisode).toHaveBeenCalledTimes(2));
    expect(reformatLoomEpisode.mock.calls.map((c) => c[1])).toEqual(['ep-1', 'ep-2']);
    expect(reformatLoomEpisode.mock.calls[0][2]).toEqual({ format: 'teleplay' });
    // Each response folds back in as it lands rather than after the whole walk.
    expect(onLoomUpdate).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rewrote 3 scenes as teleplay'));
  });

  it('names the episode in flight', async () => {
    const user = userEvent.setup();
    const loom = twoEpisodes();
    // Both calls stay pending until released, so each episode's line is
    // observable rather than a frame that flashes past.
    const release = [];
    reformatLoomEpisode.mockImplementation(() => new Promise((resolve) => { release.push(resolve); }));
    renderDrawer(loom);
    await clickRewrite(user);

    expect(await screen.findByText('Rewriting episode 1 of 2 — Pilot…')).toBeInTheDocument();
    release[0]({ loom, rewritten: 2, episodeRemaining: 0, remaining: 1, capped: false });
    expect(await screen.findByText('Rewriting episode 2 of 2 — Second…')).toBeInTheDocument();

    release[1]({ loom, rewritten: 1, episodeRemaining: 0, remaining: 0, capped: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByText(/Rewriting episode/)).not.toBeInTheDocument();
  });

  it('says how much of a long episode is left while it re-asks', async () => {
    const user = userEvent.setup();
    const loom = makeLoom([{ id: 'ep-1', title: 'Pilot', nodes: [scene('s1')] }]);
    const release = [];
    reformatLoomEpisode.mockImplementation(() => new Promise((resolve) => { release.push(resolve); }));
    renderDrawer(loom);
    await clickRewrite(user);

    expect(await screen.findByText('Rewriting episode 1 of 1 — Pilot…')).toBeInTheDocument();
    release[0]({ loom, rewritten: 20, episodeRemaining: 5, remaining: 5, capped: true });
    expect(await screen.findByText('Rewriting episode 1 of 1 — Pilot… 5 scenes left in it.')).toBeInTheDocument();
    release[1]({ loom, rewritten: 5, episodeRemaining: 0, remaining: 0, capped: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('asks the same episode again while the server says it stopped at its ceiling', async () => {
    const user = userEvent.setup();
    const loom = makeLoom([{ id: 'ep-1', title: 'Pilot', nodes: [scene('s1')] }]);
    reformatLoomEpisode
      .mockResolvedValueOnce({ loom, rewritten: 20, episodeRemaining: 5, remaining: 5, capped: true })
      .mockResolvedValueOnce({ loom, rewritten: 5, episodeRemaining: 0, remaining: 0, capped: false });
    renderDrawer(loom);
    await clickRewrite(user);

    await waitFor(() => expect(reformatLoomEpisode).toHaveBeenCalledTimes(2));
    expect(reformatLoomEpisode.mock.calls.map((c) => c[1])).toEqual(['ep-1', 'ep-1']);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rewrote 25 scenes as teleplay'));
  });

  it('does NOT re-ask an episode the model merely dropped scenes in', async () => {
    const user = userEvent.setup();
    const loom = makeLoom([{ id: 'ep-1', title: 'Pilot', nodes: [scene('s1'), scene('s2')] }]);
    // Not capped: nothing went unsent, so asking again would only re-send a
    // refusal. The leftover rides the toast instead.
    reformatLoomEpisode.mockResolvedValue({ loom, rewritten: 1, episodeRemaining: 1, remaining: 1, capped: false });
    renderDrawer(loom);
    await clickRewrite(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Rewrote 1 scene — 1 left, run it again to finish',
    ));
    expect(reformatLoomEpisode).toHaveBeenCalledTimes(1);
  });

  it('stops the walk when an episode fails, keeping what the earlier ones wrote', async () => {
    const user = userEvent.setup();
    const loom = twoEpisodes();
    reformatLoomEpisode
      .mockResolvedValueOnce({ loom, rewritten: 2, episodeRemaining: 0, remaining: 1, capped: false })
      .mockRejectedValueOnce(new Error('provider unreachable'));
    const { onRewritten } = renderDrawer(loom);
    await clickRewrite(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('provider unreachable'));
    expect(reformatLoomEpisode).toHaveBeenCalledTimes(2);
    // The selection is cleared up front AND the record re-read afterwards — the
    // failed walk still changed scene text on the server.
    expect(onRewritten).toHaveBeenNthCalledWith(1, { refetch: false });
    expect(onRewritten).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Rewriting episode/)).not.toBeInTheDocument();
  });

  it('offers no rewrite at all once every scene is already in the target format', () => {
    renderDrawer(makeLoom([{ id: 'ep-1', title: 'Pilot', nodes: [scene('s1', 'teleplay')] }]));
    expect(screen.queryByRole('button', { name: /^Rewrite/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Every scene you have is already written as teleplay/)).toBeInTheDocument();
  });
});

describe('LoomSettingsDrawer audience participation', () => {
  it('saves the helper role together with its required communication medium', async () => {
    updateLoom.mockResolvedValue({
      ...makeLoom([]),
      participationMode: 'helper',
      audienceCommunicationMedium: 'A silver mirror.',
    });
    const user = userEvent.setup();
    renderDrawer({ ...makeLoom([]), participationMode: 'protagonist' });

    await user.selectOptions(screen.getByLabelText('Audience role'), 'helper');
    expect(screen.getByText(/need a communication medium before the role can be saved/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Communication medium'), 'A silver mirror.');
    await user.tab();

    await waitFor(() => expect(updateLoom).toHaveBeenCalledWith('loom-1', {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A silver mirror.',
    }, { silent: true }));
  });

  it('resets an unsaved helper selection when the drawer closes', async () => {
    const user = userEvent.setup();
    const loom = { ...makeLoom([]), participationMode: 'protagonist' };
    const props = {
      loom,
      onClose: () => {},
      onLoomUpdate: vi.fn(),
      onRewritten: vi.fn(),
    };
    const { rerender } = render(<LoomSettingsDrawer open {...props} />);

    await user.selectOptions(screen.getByLabelText('Audience role'), 'helper');
    expect(updateLoom).not.toHaveBeenCalled();
    rerender(<LoomSettingsDrawer open={false} {...props} />);
    rerender(<LoomSettingsDrawer open {...props} />);

    expect(screen.getByLabelText('Audience role')).toHaveValue('protagonist');
  });
});

describe('LoomSettingsDrawer character continuity', () => {
  it('associates the canonical protagonist with a Universe wardrobe and locks it by default', async () => {
    const user = userEvent.setup();
    const loom = makeLoom([]);
    updateLoom.mockResolvedValue({
      ...loom,
      protagonistCharacterId: 'char-1',
      protagonistWardrobeId: 'coat',
      protagonistWardrobeLocked: true,
    });
    renderDrawer(loom, {
      universe: {
        id: 'universe-1',
        characters: [{
          id: 'char-1',
          name: 'Aria',
          referenceSheetImageRef: 'aria-sheet.png',
          wardrobes: [{ id: 'coat', name: 'Travel coat' }],
          identityPack: { assets: [] },
        }],
      },
    });

    await user.selectOptions(screen.getByLabelText('Canonical protagonist'), 'char-1');
    await user.selectOptions(screen.getByLabelText('Canonical protagonist wardrobe'), 'coat');

    await waitFor(() => expect(updateLoom).toHaveBeenLastCalledWith('loom-1', {
      protagonistWardrobeId: 'coat',
      protagonistWardrobeLocked: true,
    }, { silent: true }));
    expect(screen.getByRole('status')).toHaveTextContent('1 character sheet');
    expect(screen.getByRole('status')).toHaveTextContent('Identity pack missing neutral, profile, full-body');
    expect(screen.getByRole('checkbox', { name: /Lock this wardrobe across on-screen scenes/ })).toBeChecked();
  });
});
