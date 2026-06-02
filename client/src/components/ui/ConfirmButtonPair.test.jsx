import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Trash2 } from 'lucide-react';

import ConfirmButtonPair from './ConfirmButtonPair';

describe('ConfirmButtonPair', () => {
  it('renders default Delete/Cancel buttons with the error tone and no prompt', () => {
    render(<ConfirmButtonPair />);
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.className).toContain('bg-port-error/20');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // No prompt span when prompt is omitted.
    expect(screen.queryByText('Delete?')).toBeNull();
  });

  it('renders a short inline prompt when supplied', () => {
    render(<ConfirmButtonPair prompt="Delete?" />);
    expect(screen.getByText('Delete?')).toBeTruthy();
  });

  it('fires onConfirm and onCancel for the respective buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmButtonPair onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('honors custom labels', () => {
    render(<ConfirmButtonPair confirmText="Yes" cancelText="No" />);
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('renders the confirm icon alongside the label', () => {
    render(<ConfirmButtonPair confirmIcon={Trash2} />);
    // lucide renders an <svg>; it sits inside the confirm button.
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.querySelector('svg')).not.toBeNull();
  });

  it('disables both buttons and shows a spinner while busy, keeping the label without busyText', () => {
    const { container } = render(<ConfirmButtonPair busy />);
    expect(screen.getByRole('button', { name: 'Delete' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('swaps the confirm label to busyText and shows a spinner when busy with busyText', () => {
    const { container } = render(
      <ConfirmButtonPair confirmText="Delete" busy busyText="Deleting" confirmIcon={Trash2} />,
    );
    expect(screen.getByRole('button', { name: 'Deleting' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    // The spinner svg renders (animate-spin) and the resting Trash2 is hidden.
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('exposes the group ariaLabel for assistive tech', () => {
    render(<ConfirmButtonPair ariaLabel="Confirm deletion of My App" />);
    expect(screen.getByRole('group', { name: 'Confirm deletion of My App' })).toBeTruthy();
  });

  it('merges passthrough className onto the container', () => {
    render(<ConfirmButtonPair ariaLabel="x" className="shrink-0" />);
    expect(screen.getByRole('group', { name: 'x' }).className).toContain('shrink-0');
  });
});
