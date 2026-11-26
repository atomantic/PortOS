import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';

// The DOM test environment has no WebGL context. Render the controls mock
// alongside the canvas marker, skipping the scene's three.js host objects.
vi.mock('@react-three/fiber', async () => {
  const { Children } = await import('react');
  const { OrbitControls } = await import('../../lib/threeHelpers/controls.jsx');
  return {
    Canvas: ({ children, frameloop }) => (
      <div data-testid="goal-tree-canvas" data-frameloop={frameloop}>
        {Children.toArray(children).filter(child => child.type === OrbitControls)}
      </div>
    ),
    useFrame: () => {},
    useThree: () => null,
  };
});
vi.mock('../../lib/threeHelpers/controls.jsx', () => ({
  OrbitControls: ({ enableDamping }) => <div data-testid="goal-tree-orbit" data-damping={enableDamping} />,
}));

const { toastError, organizeGoals, createGoal, providerState } = vi.hoisted(() => ({
  toastError: vi.fn(),
  organizeGoals: vi.fn(),
  createGoal: vi.fn(),
  // Mutable so the organize tests can hand the view a selected provider (the
  // Organize button is disabled without one) while the rest keep the bare default.
  providerState: { selectedProviderId: '', selectedModel: '' },
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: () => {} }),
}));
vi.mock('../../services/apiGoals.js', () => ({
  createGoal,
  organizeGoals,
}));
vi.mock('../../hooks/useProviderModels', async () => {
  const { useState } = await import('react');
  const providers = [
    { id: 'provider-1', name: 'Example Provider', models: ['example-model', 'example-alternate'] },
    { id: 'provider-2', name: 'Other Provider', models: ['other-default', 'other-alternate'] },
  ];
  return {
    default: () => {
      const [selectedProviderId, setSelectedProviderId] = useState(providerState.selectedProviderId);
      const [selectedModel, setSelectedModel] = useState(providerState.selectedModel);
      return {
        providers, selectedProviderId, selectedModel,
        availableModels: providers.find(p => p.id === selectedProviderId)?.models || [],
        setSelectedProviderId: id => { setSelectedProviderId(id); setSelectedModel(providers.find(p => p.id === id)?.models[0] || ''); },
        setSelectedModel, loading: false,
      };
    },
  };
});

// For lifecycle tests (#8108), the mock tracks whether edit state persists across goal switches.
vi.mock('./GoalDetailPanel', async (importOriginal) => {
  const actual = await importOriginal();
  const React = await import('react');
  return {
    ...actual,
    default: ({ goal, onClose, onRefresh }) => {
      const [isEditing, setIsEditing] = React.useState(false);
      const [formTitle, setFormTitle] = React.useState('');

      return (
        <div>
          <span data-testid="detail-panel-goal">{goal.title}</span>
          {isEditing && (
            <div data-testid="edit-form">
              <input
                data-testid="edit-form-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Edit title"
              />
              <button type="button" onClick={() => setIsEditing(false)}>cancel-edit</button>
            </div>
          )}
          {!isEditing && (
            <button type="button" onClick={() => { setIsEditing(true); setFormTitle(goal.title); }}>
              start-edit
            </button>
          )}
          <button type="button" onClick={onClose}>close-detail</button>
          <button type="button" onClick={onRefresh}>refresh-detail</button>
        </div>
      );
    },
  };
});

import GoalsTreeView from './GoalsTreeView';

// Invented placeholder goals — never real records from a running install.
const DATA = {
  flat: [
    { id: 'g1', title: 'Sail across an ocean', category: 'mastery', horizon: 'lifetime', goalType: 'apex' },
    { id: 'g2', title: 'Learn celestial navigation', category: 'mastery', horizon: '5-year', parentId: 'g1' },
    { id: 'g3', title: 'Restore the boat', category: 'creative', horizon: '3-year', parentId: 'g1' },
  ],
};

function RoutedTree({ data, onRefresh }) {
  const { goalId } = useParams();
  return <GoalsTreeView data={data} onRefresh={onRefresh} selectedGoalId={goalId} />;
}

const renderTree = async (data = DATA, selectedGoalId) => {
  const tree = <RoutedTree data={data} onRefresh={vi.fn()} />;
  const entry = selectedGoalId ? `/goals/tree/${selectedGoalId}` : '/goals/tree';
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/goals/tree" element={tree} />
        <Route path="/goals/tree/:goalId" element={tree} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('labels toggle', () => {
  // The bug this guards (#3280): the tree rendered unlabelled dots whose identity
  // was only reachable by hovering — which does not exist on a touch device. Names
  // must be on by DEFAULT; the toggle only exists to quiet a dense graph.
  it('defaults to showing goal names', async () => {
    await renderTree();
    expect(screen.getByRole('button', { name: /labels/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('turns labels off and back on', async () => {
    const user = userEvent.setup();
    await renderTree();
    const toggle = screen.getByRole('button', { name: /labels/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('names the control for screen readers and touch, where the text is hidden', async () => {
    await renderTree();
    // The word "Labels" is `hidden sm:inline`, so on a phone the icon is all
    // that renders — the accessible name has to come from aria-label.
    expect(screen.getByRole('button', { name: /labels/i })).toHaveAttribute('aria-label', 'Labels');
  });
});

it.each([
  [false, 'always', 'true'],
  [true, 'demand', 'false'],
])('applies the motion preference (%s) to canvas rendering and orbit damping', async (matches, frameloop, damping) => {
  const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches });
  try {
    await renderTree();
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(screen.getByTestId('goal-tree-canvas')).toHaveAttribute('data-frameloop', frameloop);
    expect(screen.getByTestId('goal-tree-orbit')).toHaveAttribute('data-damping', damping);
  } finally {
    matchMedia.mockRestore();
  }
});

it('exposes category toggle states and updates the goal picker with filters', async () => {
  const user = userEvent.setup();
  await renderTree();
  for (const name of ['Creative', 'Family', 'Health', 'Financial', 'Legacy', 'Mastery']) {
    expect(screen.getByRole('button', { name, pressed: true })).toHaveAttribute('type', 'button');
  }

  await user.click(screen.getByText('Browse goals'));
  const picker = within(screen.getByRole('region', { name: 'Goals 3D tree visualization' }));
  expect(picker.getByRole('button', { name: /restore the boat/i })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Creative' }));
  expect(screen.getByRole('button', { name: 'Creative', pressed: false })).toBeVisible();
  expect(picker.queryByRole('button', { name: /restore the boat/i })).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'Search goals' }), 'celestial');
  expect(picker.getByRole('button', { name: /learn celestial navigation/i })).toBeVisible();
  expect(picker.queryByRole('button', { name: /sail across an ocean/i })).not.toBeInTheDocument();
});

it('selects a goal from the keyboard and returns to it when Escape closes the details', async () => {
  const user = userEvent.setup();
  await renderTree();
  const browse = screen.getByText('Browse goals');
  browse.focus();
  await user.keyboard('{Enter}');
  await user.tab();
  const goal = screen.getByRole('button', { name: 'Sail across an ocean · Mastery · Lifetime' });
  expect(goal).toHaveFocus();

  await user.keyboard('{Enter}');
  const details = screen.getByTestId('detail-panel-goal');
  expect(details).toHaveTextContent('Sail across an ocean');
  expect(document.activeElement).toContainElement(details);
  expect(goal).toHaveAttribute('aria-current', 'true');

  await user.keyboard('{Escape}');
  expect(screen.queryByTestId('detail-panel-goal')).not.toBeInTheDocument();
  expect(goal).not.toHaveAttribute('aria-current');
  expect(goal).toHaveFocus();
});

it('exposes the Add form state and restores focus when Escape closes it', async () => {
  const user = userEvent.setup();
  await renderTree();
  const add = screen.getByRole('button', { name: 'Add', expanded: false });
  expect(add).toHaveAttribute('type', 'button');
  add.focus();
  await user.keyboard('{Enter}');
  expect(add).toHaveAttribute('aria-expanded', 'true');
  await user.tab();
  expect(screen.getByRole('textbox', { name: 'New goal title' })).toHaveFocus();

  await user.keyboard('{Escape}');
  expect(add).toHaveAttribute('aria-expanded', 'false');
  expect(add).toHaveFocus();
  expect(screen.queryByRole('textbox', { name: 'New goal title' })).not.toBeInTheDocument();
  expect(createGoal).not.toHaveBeenCalled();
});

it('dismisses the Add form before clearing an existing goal selection', async () => {
  const user = userEvent.setup();
  await renderTree(DATA, 'g1');
  await user.click(screen.getByRole('button', { name: 'Add' }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Add', expanded: false })).toHaveFocus();
  expect(screen.getByTestId('detail-panel-goal')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByTestId('detail-panel-goal')).not.toBeInTheDocument();
});

describe('empty state', () => {
  it('skips the canvas when there is nothing to lay out', async () => {
    await renderTree({ flat: [] });
    expect(screen.queryByTestId('goal-tree-canvas')).not.toBeInTheDocument();
    expect(screen.getByText(/no goals to display/i)).toBeInTheDocument();
  });
});

describe('filtered-empty state', () => {
  it('distinguishes filtered-out goals from a first-run empty tree and recovers', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.type(screen.getByRole('textbox'), 'zzz-no-match');
    expect(screen.getByText(/no goals match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no goals to display/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reset filters/i }));
    expect(screen.queryByText(/no goals match/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('goal-tree-canvas')).toBeInTheDocument();
  });
});

describe('handleOrganize error toasting', () => {
  // Guards #3515: this handler owns the "Failed to organize goals" toast, so the
  // request helper must be told to stay quiet — otherwise a failed AI run stacks
  // two error toasts on top of each other.
  beforeEach(() => {
    Object.assign(providerState, {
      selectedProviderId: 'provider-1',
      selectedModel: 'example-model',
    });
  });
  afterEach(() => {
    Object.assign(providerState, { selectedProviderId: '', selectedModel: '' });
  });

  it('disables organization while a request is pending', async () => {
    const user = userEvent.setup();
    let finish;
    organizeGoals.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await renderTree();
    await user.click(screen.getByRole('button', { name: /organize/i }));
    const pending = screen.getByRole('button', { name: /analyzing/i });
    expect(pending).toBeDisabled();
    await user.click(pending);
    expect(organizeGoals).toHaveBeenCalledTimes(1);
    await act(async () => { finish(null); });
    expect(screen.getByRole('button', { name: /organize/i })).toBeEnabled();
  });

  it('asks the API helper to stay silent and toasts the failure exactly once', async () => {
    const user = userEvent.setup();
    organizeGoals.mockRejectedValue(new Error('Organization failed'));
    await renderTree();

    await user.click(screen.getByRole('button', { name: /organize/i }));
    await act(async () => {});

    expect(organizeGoals).toHaveBeenCalledWith(
      { providerId: 'provider-1', model: 'example-model' },
      { silent: true },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to organize goals');
  });
});

// #9712: selecting the route must reach the request, without starting AI work
// until Organize is clicked; a pending request still locks all three controls.
it('organizes with the chosen provider and model only after submission', async () => {
  const user = userEvent.setup();
  let finish;
  organizeGoals.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await renderTree({ flat: DATA.flat.slice(0, 2) });
  const provider = screen.getByRole('combobox', { name: 'AI Provider' });
  await user.selectOptions(provider, 'provider-2');
  const model = screen.getByRole('combobox', { name: 'Model' });
  await user.selectOptions(model, 'other-alternate');
  expect(organizeGoals).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Organize' }));
  expect(organizeGoals).toHaveBeenCalledWith(
    { providerId: 'provider-2', model: 'other-alternate' }, { silent: true },
  );
  expect(provider).toBeDisabled();
  expect(model).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Analyzing...' })).toBeDisabled();
  await act(async () => { finish({ apexGoal: { existingId: null, suggestedTitle: 'Example apex' }, organization: [], suggestedSubApex: [] }); });
  expect(screen.getByText('Goal Organization')).toBeInTheDocument();
  expect(createGoal).not.toHaveBeenCalled();
});
