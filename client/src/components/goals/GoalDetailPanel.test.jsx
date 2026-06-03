import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The panel fires getActivities()/getCalendarAccounts() on mount; stub them so the
// read view renders without network. The badge assertions below only care about
// the static read-mode markup.
vi.mock('../../services/api', () => ({
  getActivities: vi.fn(() => Promise.resolve([])),
  getCalendarAccounts: vi.fn(() => Promise.resolve([])),
}));

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

const renderPanel = (goal = baseGoal) =>
  render(
    <GoalDetailPanel goal={goal} allGoals={[goal]} onClose={() => {}} onRefresh={() => {}} />
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GoalDetailPanel badge migration to <Pill>', () => {
  it('renders the category/horizon/status badges with the shared Pill structural shape', () => {
    renderPanel();
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

  it('renders the urgency badge as a Pill with its computed color and warning icon', () => {
    renderPanel();
    const urgency = screen.getByText('80% urgency');
    expect(urgency.className).toContain('inline-flex');
    expect(urgency.className).toContain('bg-gray-700');
    // urgency >= 0.7 → red text + an AlertTriangle icon rendered inside the Pill.
    expect(urgency.className).toContain('text-red-400');
    expect(urgency.querySelector('svg')).not.toBeNull();
  });

  it('renders read-only tag chips as Pills with a leading Tag icon', () => {
    renderPanel();
    const tag = screen.getByText('focus');
    expect(tag.className).toContain('inline-flex');
    expect(tag.className).toContain('text-port-accent');
    expect(tag.querySelector('svg')).not.toBeNull();
  });

  it('does not emit a stray border-color utility for bordered={false} bare Pills', () => {
    renderPanel();
    const category = screen.getByText('Mastery');
    // bordered={false} strips both the `border` width and any tone border-color.
    expect(category.className).not.toMatch(/\bborder\b/);
  });

  it('keeps the goal-type badge as its own non-standard-size span (not a Pill)', () => {
    // sub-apex exercises the goalType !== 'standard' branch; its text-xs+px-1.5 size
    // is intentionally left un-migrated so Pill's padding can't shift it.
    renderPanel({ ...baseGoal, goalType: 'sub-apex' });
    const typeBadge = screen.getByText('Sub-Apex');
    expect(typeBadge.tagName).toBe('SPAN');
    expect(typeBadge.className).toContain('px-1.5');
    expect(typeBadge.className).not.toContain('inline-flex');
  });

  it('keeps the todo-priority badge as its own px-1 span (not a Pill)', () => {
    // px-1 is tighter than Pill's xs (px-1.5); migrating would widen it, so it
    // stays a native span. Pin that so the exception can't silently regress.
    renderPanel({
      ...baseGoal,
      todos: [{ id: 't-1', title: 'do thing', status: 'todo', priority: 'high' }],
    });
    const priorityBadge = screen.getByText('high');
    expect(priorityBadge.tagName).toBe('SPAN');
    expect(priorityBadge.className).toContain('px-1');
    expect(priorityBadge.className).not.toContain('inline-flex');
  });
});
