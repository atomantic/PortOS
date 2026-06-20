import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const copyToClipboard = vi.fn();
vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: (...args) => copyToClipboard(...args),
}));

import CopyableId from './CopyableId';

describe('CopyableId', () => {
  beforeEach(() => copyToClipboard.mockClear());

  it('renders nothing without an id', () => {
    const { container } = render(<CopyableId id={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a truncated id but copies the full id on click', () => {
    render(<CopyableId id="abcdef1234567890" />);
    // Default 8-char prefix + ellipsis.
    expect(screen.getByText('abcdef12…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(copyToClipboard).toHaveBeenCalledWith('abcdef1234567890', 'ID copied');
  });

  it('exposes the FULL id via title tooltip and aria-label (the documented way to read it)', () => {
    render(<CopyableId id="abcdef1234567890" />);
    // The visible text is truncated, but both the tooltip and the screen-reader
    // label must carry the full id — that is the component's stated contract.
    expect(screen.getByTitle('Copy id: abcdef1234567890')).toBeTruthy();
    expect(screen.getByLabelText('Copy id abcdef1234567890')).toBeTruthy();
  });

  it('does not truncate an id shorter than the char window', () => {
    render(<CopyableId id="short" chars={8} />);
    expect(screen.getByText('short')).toBeTruthy();
  });

  it('stops click propagation so it does not trigger row handlers', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <CopyableId id="abcdef1234567890" />
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
