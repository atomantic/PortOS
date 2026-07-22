import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CollapsibleText from './CollapsibleText';

// jsdom reports 0 for both scrollHeight and clientHeight, so nothing measures as
// overflowing unless we force it.
const forceOverflow = () =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

afterEach(() => vi.restoreAllMocks());

describe('CollapsibleText', () => {
  it('clamps overflowing text and toggles the clamp on expand', () => {
    forceOverflow();
    render(<CollapsibleText id="t1" text={'long '.repeat(500)} />);

    const p = document.getElementById('t1');
    expect(p).toHaveClass('line-clamp-2');

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(p).not.toHaveClass('line-clamp-2');
    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('renders no toggle when the text fits', () => {
    render(<CollapsibleText id="t2" text="short" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.getElementById('t2')).toHaveClass('line-clamp-2');
  });

  it('keeps the toggle visible while expanded even though the clamp is gone', () => {
    // Removing the clamp collapses scrollHeight to fit, so a re-measure on the
    // expanded path would hide the toggle mid-expand and strand the user with no
    // way back. The effect early-returns while expanded to prevent that.
    const spy = forceOverflow();
    render(<CollapsibleText id="t3" text={'long '.repeat(500)} />);

    spy.mockReturnValue(0);
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));

    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('drops a stale toggle when the text shrinks below the clamp', () => {
    const spy = forceOverflow();
    const { rerender } = render(<CollapsibleText id="t6" text={'long '.repeat(500)} />);
    expect(screen.getByRole('button', { name: /Show more/ })).toBeInTheDocument();

    spy.mockReturnValue(0);
    rerender(<CollapsibleText id="t6" text="now short" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wires the toggle to the text it controls', () => {
    forceOverflow();
    render(<CollapsibleText id="t4" text={'long '.repeat(500)} />);

    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-controls', 't4');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('forwards a caller className alongside the clamp', () => {
    render(<CollapsibleText id="t5" text="hi" className="text-sm text-gray-500 mt-1" />);
    const p = document.getElementById('t5');
    expect(p).toHaveClass('text-sm', 'text-gray-500', 'mt-1', 'line-clamp-2');
  });
});
