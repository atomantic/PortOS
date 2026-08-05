import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// jsdom has no WebGL context, so the three.js stack can't mount. The stub drops
// `children` deliberately: rendering the scene would mount <mesh>/<bufferGeometry>
// as unknown DOM elements and hand back HTMLElements where three.js objects are
// expected. The scene's own maths are covered by goalTreeScene.test.js instead —
// this file covers the chrome around the canvas.
vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="goal-tree-canvas" />,
  useFrame: () => {},
  useThree: () => null,
}));
vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  Billboard: () => null,
  Text: () => null,
}));

const { toastError, organizeGoals, providerState } = vi.hoisted(() => ({
  toastError: vi.fn(),
  organizeGoals: vi.fn(),
  // Mutable so the organize tests can hand the view a selected provider (the
  // Organize button is disabled without one) while the rest keep the bare default.
  providerState: { providers: [], selectedProviderId: '', selectedModel: '', availableModels: [] },
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: () => {} }),
}));
vi.mock('../../services/api', () => ({
  createGoal: vi.fn(),
  organizeGoals,
}));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    ...providerState,
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
  }),
}));

import GoalsTreeView from './GoalsTreeView';

// Invented placeholder goals — never real records from a running install.
const DATA = {
  flat: [
    { id: 'g1', title: 'Sail across an ocean', category: 'mastery', horizon: 'lifetime', goalType: 'apex' },
    { id: 'g2', title: 'Learn celestial navigation', category: 'mastery', horizon: '5-year', parentId: 'g1' },
    { id: 'g3', title: 'Restore the boat', category: 'creative', horizon: '3-year', parentId: 'g1' },
  ],
};

const renderTree = async (data = DATA) => {
  render(<GoalsTreeView data={data} onRefresh={vi.fn()} />);
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

describe('empty state', () => {
  it('skips the canvas when there is nothing to lay out', async () => {
    await renderTree({ flat: [] });
    expect(screen.queryByTestId('goal-tree-canvas')).not.toBeInTheDocument();
    expect(screen.getByText(/no goals to display/i)).toBeInTheDocument();
  });
});

describe('handleOrganize error toasting', () => {
  // Guards #3515: this handler owns the "Failed to organize goals" toast, so the
  // request helper must be told to stay quiet — otherwise a failed AI run stacks
  // two error toasts on top of each other.
  beforeEach(() => {
    Object.assign(providerState, {
      providers: [{ id: 'provider-1', name: 'Example Provider' }],
      selectedProviderId: 'provider-1',
      selectedModel: 'example-model',
      availableModels: ['example-model'],
    });
  });
  afterEach(() => {
    Object.assign(providerState, { providers: [], selectedProviderId: '', selectedModel: '', availableModels: [] });
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
