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

  // Uniquely catches Keep approved standing alone: the header already pointing at the
  // editor used to hide Review, leaving no visible alternative to Keep.
  it('offers Keep approved and Review side by side, each saying what it does', () => {
    const onAction = vi.fn();
    render(<StageChecklist items={items(readiness(null))} onAction={onAction} headerAnchor="mv-review-art" />);
    expect(screen.getByText('Approve it again as it is now.')).toBeTruthy();
    expect(screen.getByText('Check the changes first, then approve.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep approved' }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ run: 'keep-approval', stage: 'art' }));
    fireEvent.click(screen.getByRole('button', { name: /Review art direction/ }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ anchor: 'mv-review-art' }));
  });

  it('shows no Revert for a legacy approval without kept values', () => {
    render(<StageChecklist items={items(readiness(null))} onRevert={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Revert/ })).toBeNull();
  });
});

describe('StageChecklist on a finished step', () => {
  // Uniquely catches a finished step spending space on a box that asks for nothing.
  it('shows nothing once every required item is done, even with an open optional one', () => {
    const { container } = render(<StageChecklist items={[{ id: 'a', label: 'Track attached', done: true },
      { id: 'c', label: 'Song style read', done: false, optional: true }]} />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps one row per item while anything is left', () => {
    render(<StageChecklist items={[{ id: 'a', label: 'Track attached', done: true }, { id: 'b', label: 'Lyric timing verified', done: false, action: { label: 'Verify timing', anchor: 'x' } }]} onAction={vi.fn()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Verify timing/ })).toBeTruthy();
  });
});
