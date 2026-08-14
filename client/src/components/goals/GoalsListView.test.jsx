import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useParams } from 'react-router';

const { toastError, toastSuccess, organizeGoals, createGoal, applyGoalOrganization } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  organizeGoals: vi.fn(),
  createGoal: vi.fn(),
  applyGoalOrganization: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: toastSuccess }),
}));
vi.mock('../../services/api', () => ({
  createGoal,
  organizeGoals,
  applyGoalOrganization,
}));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'provider-1', name: 'Example Provider' }],
    selectedProviderId: 'provider-1',
    selectedModel: 'example-model',
    availableModels: ['example-model'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

// The real detail panel drags in the whole goal-editing surface (and its own API reads);
// these tests are about WHICH goal the URL opens, so a stand-in that reports the goal it
// was handed — and exposes its close/refresh callbacks — is the honest seam.
vi.mock('./GoalDetailPanel', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: ({ goal, onClose, onRefresh }) => (
      <div>
        <span>Detail panel: {goal.title}</span>
        <button type="button" onClick={onClose}>close-detail</button>
        <button type="button" onClick={onRefresh}>refresh-detail</button>
      </div>
    ),
  };
});

import GoalsListView from './GoalsListView';

// Invented placeholder goals — never real records from a running install.
const GOALS = [
  { id: 'g1', title: 'Sail across an ocean', category: 'mastery', horizon: 'lifetime', goalType: 'apex', children: [] },
  { id: 'g2', title: 'Restore the boat', category: 'creative', horizon: '3-year', children: [] },
];
// The Organize button only renders once there are >= 2 goals to reorganize.
const DATA = { roots: GOALS, flat: GOALS };

// Mirrors pages/Goals.jsx: the route owns which goal is open, the view just reads it.
function RoutedList({ onRefresh, data }) {
  const { goalId } = useParams();
  return <GoalsListView data={data} onRefresh={onRefresh} selectedGoalId={goalId} />;
}

function LocationProbe() {
  return <span data-testid="pathname">{useLocation().pathname}</span>;
}

const currentPath = () => screen.getByTestId('pathname').textContent;

const renderList = async (onRefresh = vi.fn(), { path = '/goals/list', data = DATA } = {}) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/goals/list" element={<RoutedList onRefresh={onRefresh} data={data} />} />
        <Route path="/goals/list/:goalId" element={<RoutedList onRefresh={onRefresh} data={data} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {});
  return onRefresh;
};

// A minimal suggestion that forces applyOrganizationSuggestion down the "create a new
// apex first" branch, so a rejected createGoal makes it return false.
const NEW_APEX_SUGGESTION = {
  apexGoal: { existingId: null, suggestedTitle: 'Example apex', suggestedDescription: '' },
  organization: [{ id: 'g1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' }],
  suggestedSubApex: [],
};

const clickOrganize = async (user) => {
  await user.click(screen.getByRole('button', { name: /organize/i }));
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleOrganize error toasting', () => {
  // Guards #3515: this handler owns the "Failed to organize goals" toast, so the
  // request helper must be told to stay quiet — otherwise a failed AI run stacks
  // two error toasts on top of each other.
  it('asks the API helper to stay silent and toasts the failure exactly once', async () => {
    const user = userEvent.setup();
    organizeGoals.mockRejectedValue(new Error('Organization failed'));
    await renderList();

    await clickOrganize(user);

    expect(organizeGoals).toHaveBeenCalledWith(
      { providerId: 'provider-1', model: 'example-model' },
      { silent: true },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to organize goals');
  });
});

describe('handleOrganize apply-failure path', () => {
  // Guards #3516: applyOrganizationSuggestion folds every API failure into a `false`
  // return. Ignoring it toasted "Goal hierarchy applied" over a backend that never
  // took the change.
  it('toasts an error and no success when applying the hierarchy fails', async () => {
    const user = userEvent.setup();
    organizeGoals.mockResolvedValue(NEW_APEX_SUGGESTION);
    createGoal.mockRejectedValue(new Error('apex create failed'));
    const onRefresh = await renderList();

    await clickOrganize(user);

    // The apply helper stays silent so this handler is the only toast source.
    expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ goalType: 'apex' }), { silent: true });
    expect(applyGoalOrganization).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to apply goal hierarchy');
    // Still refreshed — a partial apply must not leave a stale list on screen.
    expect(onRefresh).toHaveBeenCalled();
  });

  it('toasts success and refreshes when the hierarchy applies cleanly', async () => {
    const user = userEvent.setup();
    organizeGoals.mockResolvedValue(NEW_APEX_SUGGESTION);
    createGoal.mockResolvedValue({ id: 'apex-1' });
    applyGoalOrganization.mockResolvedValue(true);
    const onRefresh = await renderList();

    await clickOrganize(user);

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Goal hierarchy applied');
    expect(onRefresh).toHaveBeenCalled();
  });
});

// #4121: which goal is open lives in the URL, never in local state — so a specific goal is
// shareable, bookmarkable, reload-safe, and linkable from the Character sheet's Goals card.
describe('routed goal selection', () => {
  it('opens no panel on the bare list route', async () => {
    await renderList();
    expect(screen.queryByText(/Detail panel:/)).not.toBeInTheDocument();
  });

  it('navigates to the goal’s own route when a row is clicked', async () => {
    const user = userEvent.setup();
    await renderList();

    await user.click(screen.getByText('Restore the boat'));

    expect(currentPath()).toBe('/goals/list/g2');
    expect(screen.getByText('Detail panel: Restore the boat')).toBeInTheDocument();
  });

  it('opens the deep-linked goal on mount, without a click', async () => {
    await renderList(vi.fn(), { path: '/goals/list/g1' });
    expect(screen.getByText('Detail panel: Sail across an ocean')).toBeInTheDocument();
  });

  it('closes the panel by returning to the index when the open goal is clicked again', async () => {
    const user = userEvent.setup();
    await renderList(vi.fn(), { path: '/goals/list/g1' });

    await user.click(screen.getByText('Sail across an ocean'));

    expect(currentPath()).toBe('/goals/list');
    expect(screen.queryByText(/Detail panel:/)).not.toBeInTheDocument();
  });

  it('returns to the index when the panel closes or the goal is mutated', async () => {
    const user = userEvent.setup();
    const onRefresh = await renderList(vi.fn(), { path: '/goals/list/g1' });

    await user.click(screen.getByRole('button', { name: 'refresh-detail' }));

    expect(currentPath()).toBe('/goals/list');
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows a not-found fallback for a stale or deleted goal id', async () => {
    await renderList(vi.fn(), { path: '/goals/list/deleted-goal' });

    expect(screen.getByText('Goal not found')).toBeInTheDocument();
    expect(screen.queryByText(/Detail panel:/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to goals' })).toHaveAttribute('href', '/goals/list');
  });

  it('does NOT claim "not found" when the goal tree itself failed to load', async () => {
    // The sentinel rule: "we could not read your goals" must never render as "this goal
    // does not exist" — the deep link may be perfectly valid.
    await renderList(vi.fn(), { path: '/goals/list/g1', data: null });
    expect(screen.queryByText('Goal not found')).not.toBeInTheDocument();
  });
});
