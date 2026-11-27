import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';

// The panel fires getActivities()/getCalendarAccounts() on mount; stub them so the
// read view renders without network. The badge assertions below only care about
// the static read-mode markup.
const { getInstanceFeatures } = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(() => Promise.resolve({ features: [{ id: 'post', enabled: true }] })),
}));
vi.mock('../../services/apiMeatspace.js', () => ({
  getActivities: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../services/apiCalendar.js', () => ({
  getCalendarAccounts: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../services/apiGoals.js', () => ({
  updateGoal: vi.fn(() => Promise.resolve({})),
  generateGoalPhases: vi.fn(),
  decomposeGoal: vi.fn(),
}));

vi.mock('../../services/apiAppShell.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getInstanceFeatures,
  getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })),
}));

import { updateGoal, generateGoalPhases, decomposeGoal } from '../../services/apiGoals.js';
import { getActivities } from '../../services/apiMeatspace.js';
import { getCalendarAccounts } from '../../services/apiCalendar.js';
import { __resetInstanceFeatureCache } from '../../hooks/useInstanceFeatures.js';

import { formatDateNumeric } from '../../utils/formatters';
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

const renderPanel = async (goal = baseGoal, onClose = () => {}) => {
  const view = render(
    <GoalDetailPanel goal={goal} allGoals={[goal]} onClose={onClose} onRefresh={() => {}} />
  );

  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
};

const openEdit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText('Edit'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetInstanceFeatureCache();
  getInstanceFeatures.mockResolvedValue({ features: [{ id: 'post', enabled: true }] });
});

describe('GoalDetailPanel accessibility', () => {
  it('exposes disclosure states and the latest check-in status while collapsed', async () => {
    await renderPanel({
      ...baseGoal,
      checkIns: [...baseGoal.checkIns, { id: 'ci-2', date: '2026-05-02', status: 'at-risk', actualProgress: 41 }],
    });

    for (const name of ['Plan', 'Check-ins (2) Latest status: At Risk', 'Log progress']) {
      const button = screen.getByRole('button', { name, expanded: false });
      expect(button).toHaveAttribute('type', 'button');
      fireEvent.click(button);
      expect(screen.getByRole('button', { name, expanded: true })).toBe(button);
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('announces todo states and names the items to delete or unlink', async () => {
    const date = '2026-05-01';
    const todos = [
      { id: 't1', title: 'Sketch', status: 'pending' },
      { id: 't2', title: 'Cut', status: 'in-progress' },
      { id: 't3', title: 'Measure', status: 'done' },
    ];
    await renderPanel({
      ...baseGoal,
      todos,
      progressLog: [
        { id: 'p1', date, note: 'First entry' },
        { id: 'p2', date, note: 'Second entry' },
      ],
      linkedActivities: [{ activityName: 'Practice' }],
      linkedCalendars: [{ subcalendarId: 'c1', subcalendarName: 'Workshop' }],
    });

    for (const todo of todos) {
      const toggle = screen.getByRole('button', { name: `Mark ${todo.title} as done`, pressed: todo.status === 'done' });
      expect(toggle).toHaveAccessibleDescription(todo.status === 'in-progress' ? 'Currently in progress' : '');
      expect(screen.getByRole('button', { name: `Delete todo ${todo.title}` })).toBeInTheDocument();
    }
    for (const name of [
      `Delete progress entry 1 from ${formatDateNumeric(date)}`,
      `Delete progress entry 2 from ${formatDateNumeric(date)}`,
      'Unlink Practice',
      'Unlink Workshop',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('names the proposed phase, milestone, and task controls', async () => {
    generateGoalPhases.mockResolvedValue([{ title: 'Prepare' }, { title: 'Build' }]);
    decomposeGoal.mockResolvedValue([{ title: 'First pass', tasks: [{ title: 'Make a pattern' }] }]);
    await renderPanel({ ...baseGoal, targetDate: '2026-12-05' });

    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decompose into Tasks' }));
    await screen.findByRole('button', { name: 'Delete task 1 in milestone 1: Make a pattern' });
    for (const name of [
      'Move phase 1 down', 'Move phase 2 up', 'Delete phase 1', 'Delete phase 2',
      'Move milestone 1 up', 'Move milestone 1 down', 'Delete milestone 1',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('groups named weekday toggles and reflects changes to their pressed state', async () => {
    await renderPanel({ ...baseGoal, timeBlockConfig: { preferredDays: ['mon'] } });
    await openEdit();

    const days = within(screen.getByRole('group', { name: 'Preferred days' }));
    expect(days.getAllByRole('button')).toHaveLength(7);
    for (const name of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      expect(days.getByRole('button', { name, pressed: name === 'Monday' })).toBeInTheDocument();
    }
    fireEvent.click(days.getByRole('button', { name: 'Monday', pressed: true }));
    expect(days.getByRole('button', { name: 'Monday', pressed: false })).toBeInTheDocument();
  });

  it('focuses the goal heading and dismisses with Escape from inside the panel', async () => {
    const onClose = vi.fn();
    await renderPanel(baseGoal, onClose);

    const heading = screen.getByRole('heading', { name: baseGoal.title, level: 2 });
    expect(heading).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('dismisses the open provenance popover before the detail panel', async () => {
    const onClose = vi.fn();
    await renderPanel(baseGoal, onClose);

    const chip = screen.getByRole('button', { name: 'Inferred' });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves Escape to form controls and preserves edits', async () => {
    const onClose = vi.fn();
    await renderPanel(baseGoal, onClose);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New todo title' }), { key: 'Escape' });
    await openEdit();
    const monday = within(screen.getByRole('group', { name: 'Preferred days' })).getByRole('button', { name: 'Monday' });
    fireEvent.keyDown(monday, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
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

  it('omits zero-minute estimates while preserving nonzero estimates and their units', async () => {
    await renderPanel({
      ...baseGoal,
      todos: [
        { id: 't-zero', title: 'zero estimate', status: 'todo', priority: 'low', estimateMinutes: 0 },
        { id: 't-estimate', title: 'estimated task', status: 'todo', priority: 'medium', estimateMinutes: 15 },
      ],
    });

    expect(screen.getByText('15m')).toBeTruthy();
    expect(screen.queryByText('0m')).toBeNull();
    expect(screen.queryByText('0', { exact: true })).toBeNull();
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
    await openEdit();
    expect(screen.queryByText('Inferred')).toBeNull();
  });
});

describe('GoalDetailPanel Daily Driver feature-area override (issue #2679)', () => {
  it('shows the category default (greyed) when no per-goal override is set', async () => {
    // mastery → ['post', 'memory'] → "Daily POST, Memory" per goalFeatureMap.
    await renderPanel();
    await openEdit();
    expect(screen.getByText(/Default \(Mastery\):/)).toBeTruthy();
    expect(screen.getByText(/Daily POST, Memory/)).toBeTruthy();
  });

  it('initializes the multi-select from goal.featureAreas and reflects selection', async () => {
    await renderPanel({ ...baseGoal, featureAreas: ['writersRoom'] });
    await openEdit();
    const writersBtn = screen.getByRole('button', { name: /Writers Room/ });
    expect(writersBtn.getAttribute('aria-pressed')).toBe('true');
    // With an override present, the category-default hint is hidden.
    expect(screen.queryByText(/Default \(/)).toBeNull();
  });

  it('round-trips the override through updateGoal when saved', async () => {
    await renderPanel(); // no override → falls back to category default
    await openEdit();
    // Toggle two areas on, then save.
    fireEvent.click(screen.getByRole('button', { name: /Universes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Tribe/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    expect(updateGoal).toHaveBeenCalledWith(
      'g-1',
      expect.objectContaining({ featureAreas: ['universes', 'tribe'] })
    );
  });

  it('sends an empty featureAreas array when the override is cleared (falls back to category default)', async () => {
    await renderPanel({ ...baseGoal, featureAreas: ['universes'] });
    await openEdit();
    // Toggle the sole selected area off.
    fireEvent.click(screen.getByRole('button', { name: /Universes/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    expect(updateGoal).toHaveBeenCalledWith(
      'g-1',
      expect.objectContaining({ featureAreas: [] })
    );
  });

  it('omits featureAreas when the selector was untouched (no stale-snapshot clobber of a concurrent peer edit)', async () => {
    // The editor sends a startEdit snapshot of every field. Re-sending an
    // untouched featureAreas would let that stale value win the whole-record LWW
    // merge and erase a featureAreas change a federated peer made while the editor
    // was open. Omitting the field lets the service preserve whatever is stored —
    // including any forward-unknown id from a newer peer, which is never dropped.
    await renderPanel({ ...baseGoal, featureAreas: ['someFutureAreaFromANewerPeer'] });
    await openEdit();
    // Change only the title; never touch the feature-area buttons.
    const titleInput = screen.getByDisplayValue('Master the craft');
    fireEvent.change(titleInput, { target: { value: 'Master the craft, revised' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    const [, payload] = updateGoal.mock.calls[0];
    expect(payload).not.toHaveProperty('featureAreas');
    expect(payload.title).toBe('Master the craft, revised');
  });

  it('preserves forward-unknown ids when the override IS changed', async () => {
    // A goal carries a forward-unknown id plus a known one; the user toggles
    // another known area. The unknown id (invisible in this install's UI) must
    // ride along untouched so it is never erased across federation.
    await renderPanel({ ...baseGoal, featureAreas: ['someFutureAreaFromANewerPeer', 'universes'] });
    await openEdit();
    // Toggle a different known area on → override changed.
    fireEvent.click(screen.getByRole('button', { name: /Tribe/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
      await Promise.resolve();
    });
    const [, payload] = updateGoal.mock.calls[0];
    expect(payload.featureAreas).toEqual(['someFutureAreaFromANewerPeer', 'universes', 'tribe']);
  });

  it('shows the category-default hint for an override of only forward-unknown ids', async () => {
    // Only forward-unknown ids selected → no visible button is active and the
    // Daily Driver falls back to the category default at read time, so the hint
    // must be shown (gating on known-selection, not raw array length).
    await renderPanel({ ...baseGoal, featureAreas: ['someFutureAreaFromANewerPeer'] });
    await openEdit();
    expect(screen.getByText(/Default \(Mastery\):/)).toBeTruthy();
    expect(screen.getByText(/Daily POST, Memory/)).toBeTruthy();
  });

  it('hides POST from the picker and falls back to the next enabled default when POST is disabled', async () => {
    getInstanceFeatures.mockResolvedValue({ features: [{ id: 'post', enabled: false }] });
    await renderPanel();
    await openEdit();
    expect(await screen.findByText(/Default \(Mastery\):/)).toBeTruthy();
    expect(screen.getByText(/Default \(Mastery\):/)).toHaveTextContent('Memory');
    expect(screen.queryByText(/Daily POST, Memory/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Daily POST/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Memory/ })).toBeTruthy();
  });
});

describe('GoalDetailPanel link picker load states', () => {
  it('shows an independent retryable error per list, and a distinct empty state on success', async () => {
    getActivities.mockRejectedValueOnce(new Error('activities down'));
    getCalendarAccounts.mockRejectedValueOnce(new Error('calendars down'));
    await renderPanel();

    expect(screen.getByText(/Could not load activities — activities down/)).toBeTruthy();
    expect(screen.getByText(/Could not load calendars — calendars down/)).toBeTruthy();
    expect(screen.queryByText('No activities available to link.')).toBeNull();
    expect(getActivities).toHaveBeenCalledWith({ silent: true });
    expect(getCalendarAccounts).toHaveBeenCalledWith({ silent: true });

    // Retry only the activities list; calendars stay in error.
    getActivities.mockResolvedValueOnce([{ name: 'Running' }]);
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(2);
    await act(async () => { fireEvent.click(retries[0]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('combobox', { name: 'Activity' })).toBeTruthy();
    expect(screen.queryByText(/Could not load activities/)).toBeNull();
    expect(screen.getByText(/Could not load calendars/)).toBeTruthy();
  });

  it('renders explicit empty copy when both lists load successfully but are empty', async () => {
    await renderPanel();
    expect(screen.getByText('No activities available to link.')).toBeTruthy();
    expect(screen.getByText('No calendars available to link.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('can clear and save a time block config after removing its last preferred day', async () => {
  await renderPanel({
    ...baseGoal,
    timeBlockConfig: { preferredDays: ['mon'], timeSlot: 'evening', sessionDurationMinutes: 90 },
  });
  await openEdit();

  fireEvent.click(screen.getByRole('button', { name: 'Monday', pressed: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear config' }));
  expect(screen.queryByRole('button', { name: 'Clear config' })).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByText('Save'));
  });
  expect(updateGoal).toHaveBeenCalledWith('g-1', expect.objectContaining({ timeBlockConfig: null }));
});
