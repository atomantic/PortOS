import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StageChecklist from './StageChecklist.jsx';
import { stageChecklist } from '../../lib/musicVideoStages.js';

describe('StageChecklist Revert buttons (#10241)', () => {
  const project = { id: 'example-project', scenes: [] };
  const readiness = (revertible) => ({ art: { approved: false, problems: [], stale: { approvedAt: null, changedFields: ['concept', 'cast'], ...(revertible ? { revertible } : {}) } } });
  const items = (r) => stageChecklist('cast-sets', project, r).filter((i) => i.id === 'approve-art');

  it('reverts a changed input by stage and field, and only those with a kept value', () => {
    const onRevert = vi.fn();
    render(<StageChecklist items={items(readiness(['concept']))} onRevert={onRevert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revert concept' }));
    expect(onRevert).toHaveBeenCalledWith('art', 'concept');
    expect(screen.queryByRole('button', { name: 'Revert cast' })).toBeNull();
  });

  it('shows no Revert for a legacy approval without kept values', () => {
    render(<StageChecklist items={items(readiness(null))} onRevert={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Revert/ })).toBeNull();
  });
});
