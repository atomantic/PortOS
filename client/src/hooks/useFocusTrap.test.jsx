import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import useFocusTrap from './useFocusTrap.js';

afterEach(cleanup);

function Dialog({ active }) {
  const ref = useRef(null);
  useFocusTrap(active, ref);
  return (
    <div ref={ref} data-testid="dialog">
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

function Harness({ active }) {
  return (
    <>
      <button data-testid="opener">opener</button>
      {active && <Dialog active={active} />}
    </>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable element on activation', () => {
    render(<Dialog active />);
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('wraps focus from the last element to the first on Tab', () => {
    render(<Dialog active />);
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('wraps focus from the first element to the last on Shift+Tab', () => {
    render(<Dialog active />);
    const first = screen.getByText('first');
    first.focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('restores focus to the previously-focused element on deactivation', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(<Harness active />);
    // Focus moved into the dialog.
    expect(document.activeElement).toBe(screen.getByText('first'));

    rerender(<Harness active={false} />);
    // Focus returns to the opener.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('respects a child autoFocus instead of moving to the first focusable', () => {
    function AutoFocusDialog({ active }) {
      const ref = useRef(null);
      useFocusTrap(active, ref);
      return (
        <div ref={ref} data-testid="dialog">
          <button>close</button>
          <input data-testid="field" autoFocus />
        </div>
      );
    }
    render(<AutoFocusDialog active />);
    // React applies the input's autoFocus during commit; the trap must not
    // yank focus to the leading close button.
    expect(document.activeElement).toBe(screen.getByTestId('field'));
  });

  it('restores focus to the opener even when a child auto-focuses', () => {
    function AutoFocusDialog() {
      const ref = useRef(null);
      useFocusTrap(true, ref);
      return (
        <div ref={ref}>
          <input data-testid="field" autoFocus />
        </div>
      );
    }
    function AutoHarness({ active }) {
      return (
        <>
          <button data-testid="opener">opener</button>
          {active && <AutoFocusDialog />}
        </>
      );
    }
    const { rerender } = render(<AutoHarness active={false} />);
    screen.getByTestId('opener').focus();
    expect(document.activeElement).toBe(screen.getByTestId('opener'));

    rerender(<AutoHarness active />);
    expect(document.activeElement).toBe(screen.getByTestId('field'));

    rerender(<AutoHarness active={false} />);
    // The pre-open element was captured at render time (before the child's
    // autoFocus fired), so focus returns to the opener, not the input.
    expect(document.activeElement).toBe(screen.getByTestId('opener'));
  });

  it('focuses the container itself when there is nothing focusable inside', () => {
    function Empty() {
      const ref = useRef(null);
      useFocusTrap(true, ref);
      return <div ref={ref} data-testid="empty">no controls</div>;
    }
    render(<Empty />);
    const container = screen.getByTestId('empty');
    expect(container).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(container);
  });
});
