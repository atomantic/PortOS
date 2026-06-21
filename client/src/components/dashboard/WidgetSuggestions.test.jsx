import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import WidgetSuggestions from './WidgetSuggestions';

// `quick-stats` ships with gate: (s) => s.apps.length > 0 — a deterministic
// fixture lets us exercise the "data populated but widget missing" path
// without mocking the registry.

describe('WidgetSuggestions', () => {
  const emptyState = { apps: [], usage: null };
  const populatedState = {
    apps: [{ id: 'a1', name: 'app', overallStatus: 'online' }],
    usage: { currentStreak: 5, longestStreak: 5, hourlyActivity: [0, 0, 1, 0] },
  };

  it('renders nothing when every gated widget is already present', () => {
    const { container } = render(
      <WidgetSuggestions
        presentWidgetIds={['quick-stats', 'activity-streak', 'hourly-activity']}
        dashboardState={populatedState}
        onAdd={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no gated widget has data', () => {
    const { container } = render(
      <WidgetSuggestions presentWidgetIds={[]} dashboardState={emptyState} onAdd={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('suggests a missing-but-data-populated widget', () => {
    render(<WidgetSuggestions presentWidgetIds={[]} dashboardState={populatedState} onAdd={() => {}} />);
    expect(screen.getByText(/Quick Stats/)).toBeDefined();
  });

  it('calls onAdd with only the widget id — no layout shape passed', async () => {
    const onAdd = vi.fn().mockResolvedValue();
    render(<WidgetSuggestions presentWidgetIds={['cos']} dashboardState={populatedState} onAdd={onAdd} />);
    fireEvent.click(screen.getByLabelText('Add Quick Stats to layout'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('quick-stats');
    expect(onAdd.mock.calls[0]).toHaveLength(1);
    // add() clears `submitting` in a .finally() microtask after onAdd resolves —
    // flush it inside act() so that setState doesn't land after the test returns.
    await act(async () => {});
  });

  it('dismissing a suggestion hides it for the lifetime of the mount', () => {
    render(<WidgetSuggestions presentWidgetIds={[]} dashboardState={populatedState} onAdd={() => {}} />);
    expect(screen.queryByText(/Quick Stats/)).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Dismiss Quick Stats suggestion'));
    expect(screen.queryByText(/Quick Stats/)).toBeNull();
  });

  it('throttles to one in-flight add — rapid second click is dropped', async () => {
    let resolveFirst;
    const onAdd = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve; }));
    render(<WidgetSuggestions presentWidgetIds={[]} dashboardState={populatedState} onAdd={onAdd} />);
    // Both Quick Stats AND Activity Streak gate true on populatedState.
    fireEvent.click(screen.getByLabelText('Add Quick Stats to layout'));
    fireEvent.click(screen.getByLabelText('Add Activity Streak to layout'));
    // Only the first click fired onAdd; without the throttle, both would
    // fire with stale presentWidgetIds and the second PUT would drop the
    // first added widget.
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('quick-stats');
    // Resolving the in-flight add clears `submitting` in a .finally() microtask;
    // flush it inside act() so the setState is wrapped.
    await act(async () => { resolveFirst(); });
  });
});
