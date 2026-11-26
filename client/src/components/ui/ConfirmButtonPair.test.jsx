import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';

import ConfirmButtonPair from './ConfirmButtonPair';

describe('ConfirmButtonPair', () => {
  it('renders default Delete/Cancel buttons with the error tone and no prompt', () => {
    render(<ConfirmButtonPair />);
    expect(screen.getByRole('group', { name: 'Delete?' })).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.className).toContain('bg-port-error/20');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    for (const button of [confirm, cancel]) {
      expect(button.className).toContain('pointer-coarse:min-h-11');
      expect(button.className).toContain('pointer-coarse:min-w-11');
      expect(button.className).toContain('pointer-coarse:justify-center');
    }
    // No prompt span when prompt is omitted.
    expect(screen.queryByText('Delete?')).toBeNull();
  });

  it.each([
    ['warning', 'bg-port-warning/20'],
    ['success', 'bg-port-success/20'],
  ])('applies the %s tone to the confirm button', (tone, expected) => {
    render(<ConfirmButtonPair tone={tone} />);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain(expected);
  });

  it('falls back to the error tone for an unknown tone', () => {
    render(<ConfirmButtonPair tone="nope" />);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-port-error/20');
  });

  it('renders a short inline prompt when supplied', () => {
    render(<ConfirmButtonPair prompt="Delete this note?" />);
    expect(screen.getByText('Delete this note?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delete this note?' })).toHaveFocus();
  });

  it('follows the old slot into a wrapped trigger when the pair closes', async () => {
    const user = userEvent.setup();
    function Actions() {
      const [armed, setArmed] = useState(false);
      return (
        <div>
          <button type="button">Other action</button>
          {armed ? <ConfirmButtonPair onCancel={() => setArmed(false)} /> : (
            <div><button type="button" onClick={() => setArmed(true)}>Delete note</button></div>
          )}
        </div>
      );
    }

    render(<Actions />);
    screen.getByRole('button', { name: 'Delete note' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('group', { name: 'Delete?' })).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Delete note' })).toHaveFocus();
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

  it('supports action-specific accessible labels', () => {
    render(
      <ConfirmButtonPair
        confirmAriaLabel="Confirm removing Living Room"
        cancelAriaLabel="Cancel removing Living Room"
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm removing Living Room' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel removing Living Room' })).toBeTruthy();
  });

  it('merges passthrough className onto the container', () => {
    render(<ConfirmButtonPair ariaLabel="x" className="shrink-0" />);
    expect(screen.getByRole('group', { name: 'x' }).className).toContain('shrink-0');
  });
});
