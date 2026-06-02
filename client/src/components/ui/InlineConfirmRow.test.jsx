import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import InlineConfirmRow from './InlineConfirmRow';

describe('InlineConfirmRow', () => {
  it('renders the question with default Delete/Cancel labels and error tone', () => {
    render(<InlineConfirmRow question="Delete this? This cannot be undone." />);
    expect(screen.getByText('Delete this? This cannot be undone.')).toBeTruthy();
    const wrapper = screen.getByText('Delete this? This cannot be undone.').closest('div');
    expect(wrapper.className).toContain('bg-port-error/10');
    expect(wrapper.className).toContain('border-port-error/30');
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.className).toContain('bg-port-error');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('fires onConfirm and onCancel for the respective buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<InlineConfirmRow question="x" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('honors custom labels and button titles', () => {
    render(
      <InlineConfirmRow
        question="x"
        confirmText="Remove"
        cancelText="Keep"
        confirmTitle="Confirm delete"
        cancelTitle="Cancel delete"
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Remove' });
    expect(confirm.getAttribute('title')).toBe('Confirm delete');
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('title')).toBe('Cancel delete');
  });

  it('omits the title attribute when no title prop is supplied', () => {
    render(<InlineConfirmRow question="x" />);
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('title')).toBeNull();
  });

  it('merges passthrough className after tone classes', () => {
    render(<InlineConfirmRow question="x" className="mb-2" />);
    const wrapper = screen.getByText('x').closest('div');
    expect(wrapper.className).toContain('mb-2');
    expect(wrapper.className).toContain('bg-port-error/10');
  });

  it('falls back to the error tone for an unknown tone value', () => {
    render(<InlineConfirmRow question="x" tone="bogus" />);
    const wrapper = screen.getByText('x').closest('div');
    expect(wrapper.className).toContain('bg-port-error/10');
  });

  it('renders buttons as type=button so they never submit a surrounding form', () => {
    render(<InlineConfirmRow question="x" />);
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('type')).toBe('button');
  });

  it('forwards passthrough props (data-*/aria-*) to the root like sibling primitives', () => {
    render(<InlineConfirmRow question="x" data-testid="confirm-row" aria-label="Confirm deletion" />);
    const wrapper = screen.getByTestId('confirm-row');
    expect(wrapper.getAttribute('aria-label')).toBe('Confirm deletion');
  });

  it('defaults to the box variant (rounded border, text-xs)', () => {
    render(<InlineConfirmRow question="x" />);
    const wrapper = screen.getByText('x').closest('div');
    expect(wrapper.className).toContain('rounded');
    expect(wrapper.className).not.toContain('border-b');
    expect(screen.getByText('x').className).toContain('text-xs');
  });

  it('renders a full-width bottom-border strip at text-sm for the separator variant', () => {
    render(<InlineConfirmRow question="x" variant="separator" />);
    const wrapper = screen.getByText('x').closest('div');
    expect(wrapper.className).toContain('border-b');
    expect(wrapper.className).not.toContain('rounded');
    expect(screen.getByText('x').className).toContain('text-sm');
    // Buttons keep the shared (box) styling — filled confirm + ghost cancel with hover.
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-port-error');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('hover:text-white');
  });

  it('falls back to the box variant for an unknown variant value', () => {
    render(<InlineConfirmRow question="x" variant="bogus" />);
    const wrapper = screen.getByText('x').closest('div');
    expect(wrapper.className).toContain('rounded');
    expect(wrapper.className).not.toContain('border-b');
  });
});
