import { describe, it, expect, vi, afterEach } from 'vitest';
import { onActivateKeyDown, clickableProps, isButtonActivation, isPressKey, isEditableTarget, shouldIgnoreGlobalKey, isFocusEscapeKey, noPointerFocusSurfaceProps } from './a11yKeyboard.js';

describe('onActivateKeyDown', () => {
  it('returns undefined when handler is not a function', () => {
    expect(onActivateKeyDown(undefined)).toBeUndefined();
    expect(onActivateKeyDown(null)).toBeUndefined();
    expect(onActivateKeyDown('nope')).toBeUndefined();
  });

  it('fires the handler and preventDefaults on Enter', () => {
    const handler = vi.fn();
    const preventDefault = vi.fn();
    onActivateKeyDown(handler)({ key: 'Enter', preventDefault });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('fires the handler on Space (both " " and legacy "Spacebar")', () => {
    const handler = vi.fn();
    const preventDefault = vi.fn();
    onActivateKeyDown(handler)({ key: ' ', preventDefault });
    onActivateKeyDown(handler)({ key: 'Spacebar', preventDefault });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it('ignores other keys', () => {
    const handler = vi.fn();
    const preventDefault = vi.fn();
    onActivateKeyDown(handler)({ key: 'a', preventDefault });
    onActivateKeyDown(handler)({ key: 'Tab', preventDefault });
    expect(handler).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('passes the event through to the handler', () => {
    const handler = vi.fn();
    const event = { key: 'Enter', preventDefault: vi.fn() };
    onActivateKeyDown(handler)(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('activates when the event originated on the element itself (target === currentTarget)', () => {
    const handler = vi.fn();
    const el = {};
    const preventDefault = vi.fn();
    onActivateKeyDown(handler)({ key: 'Enter', target: el, currentTarget: el, preventDefault });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores a key event that bubbled up from a focusable descendant (target !== currentTarget)', () => {
    const handler = vi.fn();
    const container = {};
    const innerButton = {};
    const preventDefault = vi.fn();
    // Enter on an inner <button> bubbles to the container's handler — it must
    // NOT fire the container action nor preventDefault the button's activation.
    onActivateKeyDown(handler)({ key: 'Enter', target: innerButton, currentTarget: container, preventDefault });
    expect(handler).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('clickableProps', () => {
  it('returns focusable button semantics by default', () => {
    const handler = vi.fn();
    const props = clickableProps(handler);
    expect(props.role).toBe('button');
    expect(props.tabIndex).toBe(0);
    expect(typeof props.onKeyDown).toBe('function');
    expect(props['aria-disabled']).toBeUndefined();
  });

  it('honors a custom role', () => {
    expect(clickableProps(vi.fn(), { role: 'tab' }).role).toBe('tab');
  });

  it('drops tabIndex/onKeyDown and marks aria-disabled when disabled', () => {
    const props = clickableProps(vi.fn(), { disabled: true });
    expect(props.role).toBe('button');
    expect(props['aria-disabled']).toBe(true);
    expect(props.tabIndex).toBeUndefined();
    expect(props.onKeyDown).toBeUndefined();
  });

  it('wires the same handler that onClick uses', () => {
    const handler = vi.fn();
    const props = clickableProps(handler);
    props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('isButtonActivation', () => {
  // No DOM here (node env) — a stub target with .closest is exactly the
  // surface the helper uses.
  const target = (match) => ({ closest: (sel) => (sel.includes('button') ? match : null) });
  const button = {};

  it('is true for Space on a button-like target', () => {
    expect(isButtonActivation({ key: ' ', target: target(button) })).toBe(true);
    expect(isButtonActivation({ code: 'Space', target: target(button) })).toBe(true);
    expect(isButtonActivation({ key: 'Spacebar', target: target(button) })).toBe(true);
  });

  it('is false for Space away from a button — a global Space hotkey still fires', () => {
    expect(isButtonActivation({ key: ' ', target: target(null) })).toBe(false);
  });

  it('is false for keys that do not activate a button', () => {
    // Enter DOES activate a button natively, but it also activates links and
    // submits forms, and no global hotkey defaults to it — only Space needs
    // the carve-out, so widening this would silently disable Enter shortcuts.
    expect(isButtonActivation({ key: 'Enter', target: target(button) })).toBe(false);
    expect(isButtonActivation({ key: 'a', target: target(button) })).toBe(false);
  });

  it('is false when the target cannot be inspected', () => {
    expect(isButtonActivation({ key: ' ', target: null })).toBe(false);
    expect(isButtonActivation({ key: ' ' })).toBe(false);
    expect(isButtonActivation(null)).toBe(false);
  });
});

describe('isPressKey', () => {
  it('accepts Enter and every spelling of Space', () => {
    expect(isPressKey({ key: 'Enter' })).toBe(true);
    expect(isPressKey({ key: ' ' })).toBe(true);
    expect(isPressKey({ key: 'Spacebar' })).toBe(true);
    expect(isPressKey({ code: 'Space' })).toBe(true);
  });

  it('rejects other keys and a missing event', () => {
    expect(isPressKey({ code: 'KeyA', key: 'a' })).toBe(false);
    expect(isPressKey({ key: 'Escape' })).toBe(false);
    expect(isPressKey(null)).toBe(false);
  });
});


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

describe('shouldIgnoreGlobalKey', () => {
  // Stand-ins for the two DOM surfaces the predicate reads. A stub `closest` is
  // exactly what isButtonActivation consults; the dialog is a real element,
  // because the predicate queries the document rather than any component.
  const buttonTarget = { tagName: 'BUTTON', closest: (sel) => (sel.includes('button') ? {} : null) };
  const plainTarget = { tagName: 'DIV', closest: () => null };
  const openDialog = () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
  };

  afterEach(() => {
    document.querySelectorAll('[aria-modal="true"]').forEach((el) => el.remove());
  });

  it('lets an ordinary keystroke through', () => {
    expect(shouldIgnoreGlobalKey({ key: 'a', target: plainTarget })).toBe(false);
  });

  it('ignores typing in an editable target', () => {
    expect(shouldIgnoreGlobalKey({ key: 'a', target: { tagName: 'INPUT' } })).toBe(true);
  });

  // The guard useKeyCapture was missing (#4748): Space on a focused button
  // belongs to the browser, and no caller may opt out of that.
  it('always ignores native button activation, whatever the options say', () => {
    expect(shouldIgnoreGlobalKey({ key: ' ', target: buttonTarget })).toBe(true);
    expect(shouldIgnoreGlobalKey({ key: ' ', target: buttonTarget }, {
      allowChords: true, ignoreRepeat: false, enabledInDialog: true,
    })).toBe(true);
  });

  it('ignores modifier chords unless allowChords', () => {
    const chord = { key: 'a', ctrlKey: true, target: plainTarget };
    expect(shouldIgnoreGlobalKey(chord)).toBe(true);
    expect(shouldIgnoreGlobalKey(chord, { allowChords: true })).toBe(false);
    expect(shouldIgnoreGlobalKey({ key: 'a', metaKey: true, target: plainTarget })).toBe(true);
    expect(shouldIgnoreGlobalKey({ key: 'a', altKey: true, target: plainTarget })).toBe(true);
  });

  it('ignores auto-repeat unless ignoreRepeat is off', () => {
    const repeat = { key: 'a', repeat: true, target: plainTarget };
    expect(shouldIgnoreGlobalKey(repeat)).toBe(true);
    expect(shouldIgnoreGlobalKey(repeat, { ignoreRepeat: false })).toBe(false);
  });

  it('ignores keys while an aria-modal dialog is open unless enabledInDialog', () => {
    openDialog();
    expect(shouldIgnoreGlobalKey({ key: 'a', target: plainTarget })).toBe(true);
    expect(shouldIgnoreGlobalKey({ key: 'a', target: plainTarget }, { enabledInDialog: true })).toBe(false);
  });
});

describe('isFocusEscapeKey', () => {
  it('is true only for a backtab — Shift+Tab is the "leave this widget" gesture', () => {
    expect(isFocusEscapeKey({ key: 'Tab', shiftKey: true })).toBe(true);
    // Plain Tab stays with the widget (shell completion), as do other keys.
    expect(isFocusEscapeKey({ key: 'Tab', shiftKey: false })).toBe(false);
    expect(isFocusEscapeKey({ key: 'Tab' })).toBe(false);
    expect(isFocusEscapeKey({ key: 'Escape', shiftKey: true })).toBe(false);
    expect(isFocusEscapeKey({ key: 'a', shiftKey: true })).toBe(false);
  });

  it('does not exclude chords — a Ctrl/Alt+Shift+Tab belongs to the browser or OS, not the widget', () => {
    expect(isFocusEscapeKey({ key: 'Tab', shiftKey: true, ctrlKey: true })).toBe(true);
    expect(isFocusEscapeKey({ key: 'Tab', shiftKey: true, altKey: true })).toBe(true);
  });

  it('is false for a missing event', () => {
    expect(isFocusEscapeKey(null)).toBe(false);
    expect(isFocusEscapeKey(undefined)).toBe(false);
  });
});

describe('noPointerFocusSurfaceProps', () => {
  const press = (el) => {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  };
  // React would call the handler during capture; dispatching from the target and
  // invoking it with the event is the same contract without a React tree.
  const surface = (html) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    root.addEventListener(
      'mousedown',
      (e) => noPointerFocusSurfaceProps.onMouseDownCapture(e),
      true,
    );
    return root;
  };

  it('cancels the mousedown default on a button, which is what would focus it', () => {
    const root = surface('<div><span><button id="b">go</button></span></div>');
    expect(press(root.querySelector('#b'))).toBe(true);

    // Only focus is suppressed — the click still reaches the handler.
    const clicked = vi.fn();
    root.querySelector('#b').addEventListener('click', clicked);
    root.querySelector('#b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('covers a nested target inside the button, and role=button too', () => {
    const root = surface('<button id="b"><span id="icon">i</span></button><div id="r" role="button">r</div>');
    expect(press(root.querySelector('#icon'))).toBe(true);
    expect(press(root.querySelector('#r'))).toBe(true);
    root.remove();
  });

  it('leaves non-button targets alone, so text inputs still focus and select', () => {
    const root = surface('<input id="i" /><p id="p">text</p>');
    expect(press(root.querySelector('#i'))).toBe(false);
    expect(press(root.querySelector('#p'))).toBe(false);
    root.remove();
  });
});
