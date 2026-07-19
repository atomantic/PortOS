import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

// The panel fires getActivities()/getCalendarAccounts() on mount; stub them so the
// read view renders without network. The badge assertions below only care about
// the static read-mode markup.
vi.mock('../../services/api', () => ({
  getActivities: vi.fn(() => Promise.resolve([])),
  getCalendarAccounts: vi.fn(() => Promise.resolve([])),
  updateGoal: vi.fn(() => Promise.resolve({})),
}));

import * as api from '../../services/api';

import GoalDetailPanel from './GoalDetailPanel';

const baseGoal = {
  id: 'g-1',
  title: 'Master the craft',
  description: 'A description',
  category: 'mastery',
  horizon: '5-year',
  status: 'active',
  goalType: 'standard',
  progress: 40,
  urgency: 0.8,
  tags: ['focus'],
  todos: [],
  milestones: [],
  checkIns: [
    { id: 'ci-1', date: '2026-05-01', status: 'on-track', actualProgress: 40 },
  ],
};

const renderPanel = async (goal = baseGoal) => {
  const view = render(
    <GoalDetailPanel goal={goal} allGoals={[goal]} onClose={() => {}} onRefresh={() => {}} />
  );

  await act(async () => { await Promise.resolve(); });
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GoalDetailPanel badge migration to <Pill>', () => {
  it('renders the category/horizon/status badges with the shared Pill structural shape', async () => {
    await renderPanel();
    // Pill emits `inline-flex items-center gap-1 rounded` + the sm size's `text-xs px-2 py-0.5`.
    const category = screen.getByText('Mastery');
    expect(category.className).toContain('inline-flex');
    expect(category.className).toContain('rounded');
    expect(category.className).toContain('px-2');
    expect(category.className).toContain('py-0.5');
    expect(category.className).toContain('text-xs');
    // Data-driven colors are still supplied via className (tone="bare").
    expect(category.className).toContain('text-blue-400');
    expect(category.className).toContain('bg-blue-500/20');

    const horizon = screen.getByText('5 Years');
    expect(horizon.className).toContain('inline-flex');
    expect(horizon.className).toContain('bg-gray-700');

    const status = screen.getByText('active');
    expect(status.className).toContain('inline-flex');
    expect(status.className).toContain('text-gray-400');
  });

  it('renders the urgency badge as a Pill with its computed color and warning icon', async () => {
    await renderPanel();
    const urgency = screen.getByText('80% urgency');
    expect(urgency.className).toContain('inline-flex');
    expect(urgency.className).toContain('bg-gray-700');
    // urgency >= 0.7 → red text + an AlertTriangle icon rendered inside the Pill.
    expect(urgency.className).toContain('text-red-400');
    expect(urgency.querySelector('svg')).not.toBeNull();
  });

  it('renders read-only tag chips as Pills with a leading Tag icon', async () => {
    await renderPanel();
    const tag = screen.getByText('focus');
    expect(tag.className).toContain('inline-flex');
    expect(tag.className).toContain('text-port-accent');
    expect(tag.querySelector('svg')).not.toBeNull();
  });

  it('does not emit a stray border-color utility for bordered={false} bare Pills', async () => {
    await renderPanel();
    const category = screen.getByText('Mastery');
    // bordered={false} strips both the `border` width and any tone border-color.
    expect(category.className).not.toMatch(/\bborder\b/);
  });

  it('keeps the goal-type badge as its own non-standard-size span (not a Pill)', async () => {
    // sub-apex exercises the goalType !== 'standard' branch; its text-xs+px-1.5 size
    // is intentionally left un-migrated so Pill's padding can't shift it.
    await renderPanel({ ...baseGoal, goalType: 'sub-apex' });
    const typeBadge = screen.getByText('Sub-Apex');
    expect(typeBadge.tagName).toBe('SPAN');
    expect(typeBadge.className).toContain('px-1.5');
    expect(typeBadge.className).not.toContain('inline-flex');
  });

  it('keeps the todo-priority badge as its own px-1 span (not a Pill)', async () => {
    // px-1 is tighter than Pill's xs (px-1.5); migrating would widen it, so it
    // stays a native span. Pin that so the exception can't silently regress.
    await renderPanel({
      ...baseGoal,
      todos: [{ id: 't-1', title: 'do thing', status: 'todo', priority: 'high' }],
    });
    const priorityBadge = screen.getByText('high');
    expect(priorityBadge.tagName).toBe('SPAN');
    expect(priorityBadge.className).toContain('px-1');
    expect(priorityBadge.className).not.toContain('inline-flex');
  });
});

describe('GoalDetailPanel provenance chip', () => {
  it('renders an Inferred provenance chip when an AI-derived reading is present', async () => {
    // baseGoal carries urgency: 0.8 → the urgency/feasibility readings are modeled,
    // so the header must declare provenance the same way the insight surfaces do.
    await renderPanel();
    expect(screen.getByText('Inferred')).toBeTruthy();
  });

  it('omits the provenance chip when there is no AI-derived reading', async () => {
    // A goal with neither urgency nor feasibility has nothing modeled to attribute.
    await renderPanel({ ...baseGoal, urgency: undefined, feasibility: undefined });
    expect(screen.queryByText('Inferred')).toBeNull();
  });

  it('suppresses the provenance chip in edit mode (readings are off-screen)', async () => {
    // Edit mode swaps the urgency/activity-budget read view for the edit form, so
    // a chip attributing those readings would point at content no longer shown.
    await renderPanel();
    expect(screen.getByText('Inferred')).toBeTruthy(); // read mode: present
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Inferred')).toBeNull();
  });
});

describe('GoalDetailPanel Daily Driver feature-area override (issue #2679)', () => {
  it('shows the category default (greyed) when no per-goal override is set', async () => {
    // mastery → ['post', 'memory'] → "Daily POST, Memory" per goalFeatureMap.
    await renderPanel();
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText(/Default \(Mastery\):/)).toBeTruthy();
    expect(screen.getByText(/Daily POST, Memory/)).toBeTruthy();
  });

  it('initializes the multi-select from goal.featureAreas and reflects selection', async () => {
    await renderPanel({ ...baseGoal, featureAreas: ['writersRoom'] });
    fireEvent.click(screen.getByText('Edit'));
    const writersBtn = screen.getByRole('button', { name: /Writers Room/ });
    expect(writersBtn.getAttribute('aria-pressed')).toBe('true');
    // With an override present, the category-default hint is hidden.
    expect(screen.queryByText(/Default \(/)).toBeNull();
  });

  it('round-trips the override through updateGoal when saved', async () => {
    await renderPanel(); // no override → falls back to category default
    fireEvent.click(screen.getByText('Edit'));
    // Toggle two areas on, then save.
    fireEvent.click(screen.getByRole('button', { name: /Universes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Tribe/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    expect(api.updateGoal).toHaveBeenCalledWith(
      'g-1',
      expect.objectContaining({ featureAreas: ['universes', 'tribe'] })
    );
  });

  it('sends an empty featureAreas array when the override is cleared (falls back to category default)', async () => {
    await renderPanel({ ...baseGoal, featureAreas: ['universes'] });
    fireEvent.click(screen.getByText('Edit'));
    // Toggle the sole selected area off.
    fireEvent.click(screen.getByRole('button', { name: /Universes/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    expect(api.updateGoal).toHaveBeenCalledWith(
      'g-1',
      expect.objectContaining({ featureAreas: [] })
    );
  });
});
