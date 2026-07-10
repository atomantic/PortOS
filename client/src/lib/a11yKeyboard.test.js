import { describe, it, expect, vi } from 'vitest';
import { onActivateKeyDown, clickableProps } from './a11yKeyboard.js';

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
