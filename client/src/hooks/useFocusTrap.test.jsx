import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import useFocusTrap from './useFocusTrap.js';
import { noPointerFocusSurfaceProps } from '../lib/a11yKeyboard.js';

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

// A dialog whose keyboard belongs to its CONTENT, not to its first button — so
// it aims initial focus at a non-tabbable header (RapidReaderModal's shape).
function HeaderFocusDialog() {
  const ref = useRef(null);
  const headerRef = useRef(null);
  useFocusTrap(true, ref, { initialFocusRef: headerRef });
  return (
    <div ref={ref} data-testid="dialog">
      <div ref={headerRef} tabIndex={-1} data-testid="header">
        <button>first</button>
      </div>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

// Initial focus aimed at an ordinary TABBABLE input (a capture box) followed by
// a button — the CmdK capture shape.
function InputFocusDialog() {
  const ref = useRef(null);
  const inputRef = useRef(null);
  useFocusTrap(true, ref, { initialFocusRef: inputRef });
  return (
    <div ref={ref} data-testid="dialog">
      <input ref={inputRef} aria-label="thought" />
      <button>capture</button>
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

  describe('with an initialFocusRef aimed outside the tab order', () => {
    it('honours the requested target instead of the first focusable', () => {
      render(<HeaderFocusDialog />);
      expect(document.activeElement).toBe(screen.getByTestId('header'));
    });

    // The target is tabIndex=-1, so it is not IN the focusable list — without
    // steering, Shift+Tab from it fell through to the browser and walked
    // straight out of the modal (WCAG 2.1.2).
    it('keeps Shift+Tab inside the dialog, wrapping to the last control', () => {
      render(<HeaderFocusDialog />);
      fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(screen.getByText('last'));
    });

    it('sends a forward Tab to the first control', () => {
      render(<HeaderFocusDialog />);
      fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
      expect(document.activeElement).toBe(screen.getByText('first'));
    });
  });

  describe('with an initialFocusRef aimed at a tabbable input', () => {
    it('lets forward Tab reach the next control', () => {
      render(<InputFocusDialog />);
      expect(document.activeElement).toBe(screen.getByLabelText('thought'));
      const dialog = screen.getByTestId('dialog');
      expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true); // not prevented → browser advances
      screen.getByText('capture').focus();
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(document.activeElement).toBe(screen.getByLabelText('thought'));
    });

    it('wraps Shift+Tab from the first control to the last', () => {
      render(<InputFocusDialog />);
      fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(screen.getByText('capture'));
    });
  });

  // A surface that owns a key refuses pointer focus for its buttons, so a HUD
  // button that opens a dialog never becomes document.activeElement. Restoring
  // to <body> on close would strand the keyboard user (WCAG 2.4.3).
  it('restores focus to a clicked opener whose pointer focus was suppressed', () => {
    function PointerHarness({ active }) {
      return (
        <div {...noPointerFocusSurfaceProps}>
          <button data-testid="opener">opener</button>
          {active && <Dialog active={active} />}
        </div>
      );
    }
    const { rerender } = render(<PointerHarness active={false} />);
    const opener = screen.getByTestId('opener');

    // The surface cancels the mousedown, so the opener never takes focus.
    fireEvent.mouseDown(opener);
    expect(document.activeElement).not.toBe(opener);

    rerender(<PointerHarness active />);
    expect(document.activeElement).toBe(screen.getByText('first'));

    rerender(<PointerHarness active={false} />);
    expect(document.activeElement).toBe(opener);
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
