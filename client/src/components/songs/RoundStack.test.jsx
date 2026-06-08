import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import toast from '../ui/Toast';

// Mock the audio mixer — jsdom has no Web Audio. Track every created player so
// tests can assert which takes were passed and that old players get stopped.
const playerCalls = vi.hoisted(() => ({ takes: null, players: [], rejectPlay: false, deferPlay: false, resolvePlay: null }));
vi.mock('../../lib/songPlayback', () => ({
  createLayeredPlayer: (takes) => {
    playerCalls.takes = takes;
    const player = {
      play: vi.fn(() => {
        if (playerCalls.rejectPlay) return Promise.reject(new Error('boom'));
        // deferPlay simulates a still-decoding mix the test resolves on demand.
        if (playerCalls.deferPlay) return new Promise((res) => { playerCalls.resolvePlay = res; });
        return Promise.resolve();
      }),
      stop: vi.fn(),
      onEnded: vi.fn(),
    };
    playerCalls.players.push(player);
    return player;
  },
}));
// getUploadUrl is the only thing RoundStack needs from the api barrel.
vi.mock('../../services/api', () => ({ getUploadUrl: (f) => `/api/uploads/${f}` }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import RoundStack from './RoundStack.jsx';

const SCORE_A = ['clef: treble', 'key: C', 'time: 4/4', '', '| D4q(Hey) D4q(ho) D4h(home) |'].join('\n');
const SCORE_B = ['clef: treble', 'key: C', 'time: 4/4', '', '| F4q(Ah) F4q(poor) F4h(bird) |'].join('\n');

const SONGS = [
  {
    id: 'seed-hey-ho-nobody-home', title: 'Hey Ho Nobody Home', key: 'D minor', score: SCORE_A,
    sections: [{ id: 's1', label: 'Round', lyrics: 'Hey ho nobody home' }],
    recordings: [{ id: 'rec-1', filename: 'a.wav', muted: false }],
  },
  {
    id: 'seed-ah-poor-bird', title: 'Ah Poor Bird', key: 'D minor', score: SCORE_B,
    sections: [{ id: 's2', label: 'Verse', lyrics: 'Ah poor bird' }],
    recordings: [{ id: 'rec-2', filename: 'b.wav', muted: false }],
  },
];

const renderStack = (songs) => render(
  <MemoryRouter><RoundStack songs={songs} /></MemoryRouter>,
);

describe('RoundStack', () => {
  beforeEach(() => {
    playerCalls.takes = null;
    playerCalls.players = [];
    playerCalls.rejectPlay = false;
    playerCalls.deferPlay = false;
    playerCalls.resolvePlay = null;
    toast.error.mockClear();
  });

  it('renders nothing for an empty list', () => {
    const { container } = renderStack([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders a score and lyrics for each stacked song', () => {
    renderStack(SONGS);
    expect(screen.getByText('Hey Ho Nobody Home')).toBeTruthy();
    expect(screen.getByText('Ah Poor Bird')).toBeTruthy();
    expect(screen.getByText('Hey ho nobody home')).toBeTruthy();
    expect(screen.getByText('Ah poor bird')).toBeTruthy();
    // One rendered staff per song.
    expect(screen.getAllByLabelText('Sheet music notation')).toHaveLength(2);
  });

  it('plays the recorded takes from every song together', () => {
    renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    expect(playerCalls.takes).toHaveLength(2);
    // Ids are namespaced by song so two songs' takes can't collide in the mixer.
    expect(playerCalls.takes.map((t) => t.id)).toEqual([
      'seed-hey-ho-nobody-home:rec-1',
      'seed-ah-poor-bird:rec-2',
    ]);
    expect(playerCalls.players[0].play).toHaveBeenCalled();
  });

  it('hides the play button when no song has an audible take', () => {
    const muted = SONGS.map((s) => ({ ...s, recordings: [] }));
    renderStack(muted);
    expect(screen.queryByRole('button', { name: /Play all parts/i })).toBeNull();
  });

  it('resets to Play (and toasts) when playback fails', async () => {
    playerCalls.rejectPlay = true;
    renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    // The failed play() must not leave the button stuck on "Stop".
    await waitFor(() => expect(screen.getByRole('button', { name: /Play all parts/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Stop$/i })).toBeNull();
    expect(toast.error).toHaveBeenCalled();
  });

  it('stops the previous mix when the stacked songs change', () => {
    const { rerender } = renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    expect(playerCalls.players).toHaveLength(1);
    // Navigating to a different stack (songs prop changes) must silence the old mix.
    rerender(<MemoryRouter><RoundStack songs={[SONGS[0]]} /></MemoryRouter>);
    expect(playerCalls.players[0].stop).toHaveBeenCalled();
  });

  it('keeps playing across unrelated re-renders that do not change the recordings', () => {
    const { rerender } = renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    expect(playerCalls.players).toHaveLength(1);
    // Simulate an unrelated parent render (e.g. Save): a brand-new songs array of
    // cloned song objects with identical recordings. Playback must NOT tear down.
    rerender(<MemoryRouter><RoundStack songs={SONGS.map((s) => ({ ...s }))} /></MemoryRouter>);
    expect(playerCalls.players[0].stop).not.toHaveBeenCalled();
    expect(playerCalls.players).toHaveLength(1); // no new mixer spun up either
  });

  it('does not start the mix if stopped while still decoding', async () => {
    playerCalls.deferPlay = true; // play() stays pending until the test resolves it
    renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    // User stops before decode finishes — the mixer's own stop() can't cancel a
    // mid-decode play, so the generation guard must.
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    playerCalls.resolvePlay(); // decode "completes" after the stop
    await waitFor(() => expect(screen.getByRole('button', { name: /Play all parts/i })).toBeTruthy());
    expect(playerCalls.players[0].stop).toHaveBeenCalled();
  });
});
