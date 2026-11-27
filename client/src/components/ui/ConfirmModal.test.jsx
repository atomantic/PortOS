import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ConfirmModal from './ConfirmModal';

afterEach(cleanup);

it('renders a scrollable confirmation with non-submit controls', () => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmModal
      open
      titleId="test-confirm-title"
      title="Confirm removal"
      confirmLabel="Remove"
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p>Removal details</p>
    </ConfirmModal>
  );

  expect(screen.getByRole('dialog', { name: 'Confirm removal' })).toBeInTheDocument();
  expect(screen.getByText('Removal details').parentElement).toHaveClass('overflow-y-auto');

  const close = screen.getByRole('button', { name: 'Close' });
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const confirm = screen.getByRole('button', { name: 'Remove' });
  for (const button of [close, cancel, confirm]) {
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
  }
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
