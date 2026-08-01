import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  triggerGsdPhaseAction: vi.fn().mockResolvedValue({ ok: true }),
}));

import PhaseCard from './PhaseCard';

const PHASE = {
  id: '03-apple-health-integration',
  totalTasks: 4,
  completedTasks: 2,
  plans: [],
};

const renderCard = (props = {}) => render(
  <PhaseCard
    phase={PHASE}
    pendingAction={{ currentStep: 'planned', nextAction: 'execute' }}
    appId="example-app"
    expanded={false}
    onToggle={() => {}}
    {...props}
  />,
);

// The collapsed row is a toggle <button>, and the "next action" button used to
// be rendered INSIDE it. A <button> nested in a <button> is invalid HTML: the
// inner control is dropped from the tab order, so Execute/Plan/Verify could
// only ever be reached with a mouse. The two are siblings now.
describe('PhaseCard collapsed row (nested-interactive regression)', () => {
  it('does not nest the action button inside the toggle button', () => {
    const { container } = renderCard();
    const nested = [...container.querySelectorAll('button, a')]
      .filter((el) => el.querySelector('button, a'));
    expect(nested).toEqual([]);
  });

  it('keeps the action button focusable and clickable without toggling the row', async () => {
    const onToggle = vi.fn();
    renderCard({ onToggle });

    const action = screen.getByRole('button', { name: /execute/i });
    action.focus();
    expect(document.activeElement).toBe(action);

    // The handler awaits triggerGsdPhaseAction, so settle it inside act().
    await act(async () => { fireEvent.click(action); });
    // Sibling, not descendant — the click must not reach the row toggle.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('still expands when the row itself is clicked', () => {
    const onToggle = vi.fn();
    renderCard({ onToggle });
    fireEvent.click(screen.getByText('Apple Health Integration'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
