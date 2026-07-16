import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import useKeyboardShortcuts, { isEditableTarget } from './useKeyboardShortcuts';

// Dispatch a keydown from `target` (the listener reads e.target). Defaults to
// the window itself, which is not an editable field. `fireEvent` returns false
// when the event was canceled, so return that as `defaultPrevented`.
function press(key, { target = window, meta = false, ctrl = false, alt = false } = {}) {
  const notCanceled = fireEvent.keyDown(target, { key, metaKey: meta, ctrlKey: ctrl, altKey: alt });
  return { defaultPrevented: !notCanceled };
}

afterEach(() => vi.restoreAllMocks());

describe('isEditableTarget', () => {
  it('flags the standard form fields and contentEditable, not plain elements', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});

describe('useKeyboardShortcuts', () => {
  it('fires the matching handler and preventDefaults the event', () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { a }));
    const event = press('a');
    expect(a).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores keys with no binding without preventDefault', () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { a }));
    const event = press('b');
    expect(a).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not bind while inactive', () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts(false, { a }));
    press('a');
    expect(a).not.toHaveBeenCalled();
  });

  it('ignores events from editable fields (typing the letter never misfires)', () => {
    const d = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { d }));
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    press('d', { target: textarea });
    document.body.removeChild(textarea);
    expect(d).not.toHaveBeenCalled();
  });

  it('skips ⌘/Ctrl/Alt chords so app/browser shortcuts win', () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { a }));
    press('a', { meta: true });
    press('a', { ctrl: true });
    press('a', { alt: true });
    expect(a).not.toHaveBeenCalled();
  });

  it('treats a falsy handler as a disabled shortcut (no throw, no preventDefault)', () => {
    renderHook(() => useKeyboardShortcuts(true, { a: undefined }));
    const event = press('a');
    expect(event.defaultPrevented).toBe(false);
  });

  it('always calls the latest handler without re-subscribing on every render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { rerender } = renderHook(({ fn }) => useKeyboardShortcuts(true, { a: fn }), {
      initialProps: { fn: first },
    });
    const keydownSubs = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    rerender({ fn: second });
    press('a');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // The handler swap must not have re-attached the window listener.
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown').length).toBe(keydownSubs);
  });

  it('ignores OS key auto-repeat so a held one-shot key fires once, not per tick', () => {
    const d = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { d }));
    fireEvent.keyDown(window, { key: 'd', repeat: true });
    expect(d).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'd' });
    expect(d).toHaveBeenCalledTimes(1);
  });

  it("space on a focused button activates the button, never a page ' ' shortcut", () => {
    const space = vi.fn();
    const g = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { ' ': space, g }));
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    // Space must fall through to native button activation (no preventDefault).
    const spaceEvent = press(' ', { target: btn });
    expect(space).not.toHaveBeenCalled();
    expect(spaceEvent.defaultPrevented).toBe(false);
    // Letter shortcuts still fire with a button focused — only ' ' collides
    // with activation semantics.
    press('g', { target: btn });
    expect(g).toHaveBeenCalledTimes(1);
    btn.remove();
    // Space from a non-interactive target still drives the page shortcut.
    press(' ');
    expect(space).toHaveBeenCalledTimes(1);
  });

  it('suppresses shortcuts while an aria-modal dialog is open (page card stays behind it)', () => {
    const d = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { d }));
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    press('d');
    expect(d).not.toHaveBeenCalled();
    document.body.removeChild(dialog);
    press('d');
    expect(d).toHaveBeenCalledTimes(1);
  });

  it('enabledInDialog lets a modal-owned shortcut fire even with an open dialog', () => {
    const d = vi.fn();
    renderHook(() => useKeyboardShortcuts(true, { d }, { enabledInDialog: true }));
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    press('d');
    document.body.removeChild(dialog);
    expect(d).toHaveBeenCalledTimes(1);
  });

  it('detaches the listener on unmount', () => {
    const a = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts(true, { a }));
    unmount();
    press('a');
    expect(a).not.toHaveBeenCalled();
  });
});
