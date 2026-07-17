import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Coverage for the Character sheet's life-goals card (#2675). The load-bearing behavior:
// the card mirrors the goals service read-only, ranks by urgency without inventing a rank
// for goals that don't have one, and keeps "no goals" distinct from "couldn't read goals".
//
// All fixture goals use obviously-fake placeholder titles — never real goal data.

const getGoalsTree = vi.fn();

vi.mock('../../services/api', () => ({
  getGoalsTree: (...a) => getGoalsTree(...a),
}));

import GoalsCard, { selectTopGoals, progressPct, GOALS_PATH } from './GoalsCard';

const goal = (overrides = {}) => ({
  id: 'goal-1',
  title: 'Example Goal',
  status: 'active',
  progress: 40,
  urgency: 0.5,
  ...overrides,
});

// Scoped to the card's own region: the sheet renders other percentages, and a page-wide
// query would let a broken row pass.
const renderCard = async (goals) => {
  getGoalsTree.mockResolvedValue(goals === undefined ? {} : { flat: goals });
  render(<MemoryRouter><GoalsCard /></MemoryRouter>);
  const region = await screen.findByRole('region', { name: 'Life Goals' });
  await waitFor(() => expect(within(region).queryByText(/Loading goals/)).not.toBeInTheDocument());
  return within(region);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('selectTopGoals', () => {
  it('ranks most-urgent first', () => {
    const picked = selectTopGoals([
      goal({ id: 'a', urgency: 0.1 }),
      goal({ id: 'b', urgency: 0.9 }),
      goal({ id: 'c', urgency: 0.5 }),
    ]);
    expect(picked.map(g => g.id)).toEqual(['b', 'c', 'a']);
  });

  it('drops goals that are not active', () => {
    const picked = selectTopGoals([
      goal({ id: 'a' }),
      goal({ id: 'b', status: 'completed' }),
      goal({ id: 'c', status: 'abandoned' }),
    ]);
    expect(picked.map(g => g.id)).toEqual(['a']);
  });

  it('keeps a status-less goal rather than dropping it', () => {
    // MortalLoom-synced goals pass through normalizeGoal, whose defaults backfill every field
    // EXCEPT status. Dropping them would render a populated goal list as "No active goals
    // yet" — the exact lie the empty state must never tell.
    const picked = selectTopGoals([goal({ id: 'ml', status: undefined })]);
    expect(picked.map(g => g.id)).toEqual(['ml']);
  });

  it('ignores null entries without dropping the rest of the list', () => {
    const picked = selectTopGoals([null, goal({ id: 'a' })]);
    expect(picked.map(g => g.id)).toEqual(['a']);
  });

  it('sorts un-ranked goals last rather than treating null urgency as 0', () => {
    // urgency is null when the service has no horizon to rank against — that is "we don't
    // know", not "plenty of time". A null must never outrank a real 0.
    const picked = selectTopGoals([
      goal({ id: 'unranked', urgency: null }),
      goal({ id: 'relaxed', urgency: 0 }),
    ]);
    expect(picked.map(g => g.id)).toEqual(['relaxed', 'unranked']);
  });

  it('still lists goals in service order when NO goal has an urgency', () => {
    // The common no-birth-date install: an unranked list beats a bogus ranking, and beats
    // showing nothing at all.
    const picked = selectTopGoals([
      goal({ id: 'a', urgency: null }),
      goal({ id: 'b', urgency: null }),
    ]);
    expect(picked.map(g => g.id)).toEqual(['a', 'b']);
  });

  it('caps the list at the top N', () => {
    const picked = selectTopGoals(Array.from({ length: 9 }, (_, i) => goal({ id: `g${i}` })));
    expect(picked).toHaveLength(4);
  });

  it('does not mutate the caller’s array', () => {
    const goals = [goal({ id: 'a', urgency: 0.1 }), goal({ id: 'b', urgency: 0.9 })];
    selectTopGoals(goals);
    expect(goals.map(g => g.id)).toEqual(['a', 'b']);
  });
});

describe('progressPct', () => {
  it('rounds a real value and keeps a real 0', () => {
    expect(progressPct({ progress: 40.4 })).toBe(40);
    expect(progressPct({ progress: 0 })).toBe(0);
  });

  it('clamps out-of-range values instead of rendering an impossible bar', () => {
    expect(progressPct({ progress: 140 })).toBe(100);
    expect(progressPct({ progress: -5 })).toBe(0);
  });

  it('floors a missing or malformed progress to 0 rather than NaN', () => {
    expect(progressPct({})).toBe(0);
    expect(progressPct({ progress: 'abc' })).toBe(0);
  });
});

describe('GoalsCard — populated', () => {
  it('renders each active goal with its title, progress and a link to Goals', async () => {
    const card = await renderCard([
      goal({ id: 'a', title: 'Ship Example Project', progress: 25, urgency: 0.9 }),
      goal({ id: 'b', title: 'Learn Example Skill', progress: 60, urgency: 0.2 }),
    ]);

    expect(card.getByText('Ship Example Project')).toBeInTheDocument();
    expect(card.getByText('25%')).toBeInTheDocument();
    expect(card.getByText('Learn Example Skill')).toBeInTheDocument();
    expect(card.getByText('60%')).toBeInTheDocument();

    for (const link of card.getAllByRole('link')) {
      expect(link).toHaveAttribute('href', GOALS_PATH);
    }
  });

  it('orders the rendered rows most-urgent first', async () => {
    const card = await renderCard([
      goal({ id: 'a', title: 'Least Urgent Example', urgency: 0.1 }),
      goal({ id: 'b', title: 'Most Urgent Example', urgency: 0.9 }),
    ]);

    const rows = card.getAllByRole('link', { name: /Open in Goals/ });
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      'Most Urgent Example — 40% complete. Open in Goals',
      'Least Urgent Example — 40% complete. Open in Goals',
    ]);
  });

  it('names each row for assistive tech with its goal, progress and destination', async () => {
    // The bar is decorative, so the row's name is the only place progress reaches a screen
    // reader as part of the link.
    const card = await renderCard([goal({ title: 'Example Goal', progress: 25 })]);
    expect(card.getByRole('link', { name: 'Example Goal — 25% complete. Open in Goals' }))
      .toBeInTheDocument();
  });

  it('reads goals once from the tree endpoint, silently, and never writes them back', async () => {
    await renderCard([goal()]);
    // Surface, don't duplicate: a read-only mirror calls the read endpoint exactly once and
    // owns no write path at all.
    //
    // The TREE endpoint specifically: getGoals() hands back whatever urgency was last
    // WRITTEN, which decays as yearsRemaining falls, so ranking off it would let the sheet
    // order goals differently from the /goals page it links to. Only getGoalsTree()
    // re-derives urgency from current longevity.
    expect(getGoalsTree).toHaveBeenCalledTimes(1);
    // silent — the card renders its own error message, so request() must not toast it too.
    expect(getGoalsTree).toHaveBeenCalledWith({ silent: true });
  });
});

describe('GoalsCard — empty', () => {
  it('prompts the user to set goals and links to Goals when none exist', async () => {
    const card = await renderCard([]);

    expect(card.getByText('No active goals yet.')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Set your goals/ })).toHaveAttribute('href', GOALS_PATH);
    // A real empty state, not a broken/blank block.
    expect(card.queryByRole('link', { name: /Open in Goals/ })).not.toBeInTheDocument();
  });

  it('does NOT show the empty state for a MortalLoom-shaped goal with no status', async () => {
    // The false-empty regression, pinned at the rendered level: a user whose goals sync in
    // without a status field must still see them on the sheet.
    const card = await renderCard([goal({ title: 'Example Synced Goal', status: undefined })]);
    expect(card.getByText('Example Synced Goal')).toBeInTheDocument();
    expect(card.queryByText('No active goals yet.')).not.toBeInTheDocument();
  });

  it('shows the empty state when every goal is completed or abandoned', async () => {
    // Goals exist, but none are active — the card is about what you're working toward now.
    const card = await renderCard([
      goal({ id: 'a', status: 'completed' }),
      goal({ id: 'b', status: 'abandoned' }),
    ]);
    expect(card.getByText('No active goals yet.')).toBeInTheDocument();
  });
});

describe('GoalsCard — error', () => {
  it('says the goals could not be loaded rather than claiming there are none', async () => {
    // The sentinel rule: "we could not read this" must not read as "you have never done this".
    getGoalsTree.mockRejectedValue(new Error('network'));
    render(<MemoryRouter><GoalsCard /></MemoryRouter>);

    const card = within(await screen.findByRole('region', { name: 'Life Goals' }));
    await waitFor(() => expect(card.getByText(/could not be loaded/)).toBeInTheDocument());
    expect(card.queryByText('No active goals yet.')).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Open Goals' })).toHaveAttribute('href', GOALS_PATH);
  });

  it('treats a malformed payload as an error, not as an empty goal list', async () => {
    const card = await renderCard(undefined);
    expect(card.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(card.queryByText('No active goals yet.')).not.toBeInTheDocument();
  });
});
