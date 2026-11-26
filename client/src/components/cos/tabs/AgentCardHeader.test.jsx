import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentCardHeader from './AgentCardHeader';

it('keeps keyboard focus through the remove agent confirmation and cancellation', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  render(<AgentCardHeader agent={{ id: 'example-agent' }} inactive controls={{ completed: true, onDelete }} />);

  screen.getByRole('button', { name: 'Remove agent example-agent' }).focus();
  await user.keyboard('{Enter>3/}');
  expect(screen.getByRole('group', { name: 'Confirm remove agent' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Remove agent example-agent' })).toHaveFocus();
  expect(onDelete).not.toHaveBeenCalled();
});
