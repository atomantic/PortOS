import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MergeAction } from './PullRequestActionControls';

it('does not confirm an armed merge after it becomes disabled', () => {
  const onConfirm = vi.fn();
  const props = { pullRequest: { number: 7 }, idPrefix: 'merge-example', armed: true, merging: false,
    method: 'merge', onMethodChange: vi.fn(), deleteBranch: false, onDeleteBranchChange: vi.fn(), onConfirm, onCancel: vi.fn() };
  const view = render(<MergeAction {...props} />);
  expect(screen.getByRole('button', { name: 'Merge #7' })).toBeEnabled();
  view.rerender(<MergeAction {...props} disabled />);
  const confirm = screen.getByRole('button', { name: 'Merge #7' });
  fireEvent.click(confirm);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(confirm).toBeDisabled();
});
