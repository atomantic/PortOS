import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GoalPlanSection from './GoalPlanSection';

const GOAL = {
  id: 'goal-1', targetDate: '2030-01-01', milestones: [{ id: 'm1' }],
  timeBlockConfig: {}, scheduledEvents: [{ id: 'e1' }]
};

const renderSection = (props = {}) => {
  const handlers = {
    handleRemoveSchedule: vi.fn(), handleAcceptPhases: vi.fn(), setProposedPhases: vi.fn()
  };
  render(
    <GoalPlanSection
      goal={GOAL} pendingActions={new Set()} planOpen setPlanOpen={vi.fn()}
      generatingPhases={false} handleGeneratePhases={vi.fn()}
      proposedPhases={null} handleAcceptDecomposition={vi.fn()}
      decomposing={false} handleDecompose={vi.fn()} proposedDecomposition={null}
      setProposedDecomposition={vi.fn()} schedulingBusy={false}
      handleSchedule={vi.fn()} handleReschedule={vi.fn()}
      {...handlers} {...props}
    />
  );
  return handlers;
};

describe('GoalPlanSection', () => {
  it('requires inline confirmation before removing the schedule', () => {
    const { handleRemoveSchedule } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(handleRemoveSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Confirm remove schedule'));
    expect(handleRemoveSchedule).toHaveBeenCalledTimes(1);
  });

  it('cancelling the confirmation does not remove the schedule', () => {
    const { handleRemoveSchedule } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    fireEvent.click(screen.getByTitle('Cancel remove schedule'));
    expect(handleRemoveSchedule).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Confirm remove schedule')).toBeNull();
  });

  it('disables Accept Plan while accepting and reorders without mutating state objects', () => {
    const phases = [
      { _key: 'a', title: 'A', description: '', targetDate: '2030-01-01', order: 0 },
      { _key: 'b', title: 'B', description: '', targetDate: '2030-01-01', order: 1 }
    ];
    const { setProposedPhases } = renderSection({
      proposedPhases: phases, pendingActions: new Set(['accept-phases'])
    });
    expect(screen.getByRole('button', { name: 'Accept Plan' }).disabled).toBe(true);
    fireEvent.click(screen.getAllByLabelText('Move up')[1]);
    const next = setProposedPhases.mock.calls[0][0];
    expect(next.map(p => p._key)).toEqual(['b', 'a']);
    expect(next.map(p => p.order)).toEqual([0, 1]);
    expect(phases[0].order).toBe(0);
    expect(phases[1].order).toBe(1);
  });
});
