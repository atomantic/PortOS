import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  attachTerminalTouchScroll,
  attachTerminalWheelScroll,
  measureTerminalGeometry,
  planTouchScrollSteps,
  resetTerminalWheelScroll,
  scrollTerminalLines,
  scrollTerminalPage,
  sendTerminalPageKey,
} from './terminalScroll.js';

// A stand-in for the xterm instance carrying only what this module reads. The real
// Terminal is not needed here: these tests pin the event ownership and key sequence
// that the Shell's xterm instance exposes to the PTY.
const makeTerminal = ({ alt = true, rows = 24, height = 480, mouseTrackingMode = 'none' } = {}) => {
  const el = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  el.appendChild(screen);
  document.body.appendChild(el);
  screen.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height, right: 900, bottom: 50 + height });
  return {
    element: el,
    rows,
    buffer: { active: { type: alt ? 'alternate' : 'normal' } },
    modes: { mouseTrackingMode },
    input: vi.fn(),
    scrollLines: vi.fn(),
  };
};

const touchEvent = (type, touches) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.touches = touches.map((clientY) => ({ clientY }));
  return ev;
};

afterEach(() => { document.body.innerHTML = ''; });

describe('measureTerminalGeometry', () => {
  it('derives the row height from the rendered screen, not the outer container', () => {
    expect(measureTerminalGeometry(makeTerminal({ rows: 24, height: 480 }))).toEqual({ rowHeightPx: 20 });
  });

  it('falls back to a nominal row height before the terminal has been laid out', () => {
    expect(measureTerminalGeometry(makeTerminal({ rows: 24, height: 0 }))).toEqual({ rowHeightPx: 18 });
    expect(measureTerminalGeometry(null)).toEqual({ rowHeightPx: 18 });
  });
});

describe('planTouchScrollSteps', () => {
  it('holds back a sub-row drag and carries the remainder into the next one', () => {
    expect(planTouchScrollSteps(8, 20)).toEqual({ steps: 0, remainderPx: 8 });
    expect(planTouchScrollSteps(24, 20)).toEqual({ steps: 1, remainderPx: 4 });
  });

  it('truncates toward zero in both directions', () => {
    expect(planTouchScrollSteps(-45, 20)).toEqual({ steps: -2, remainderPx: -5 });
    expect(planTouchScrollSteps(45, 20)).toEqual({ steps: 2, remainderPx: 5 });
  });

  it('is inert without a usable row height', () => {
    expect(planTouchScrollSteps(120, 0)).toEqual({ steps: 0, remainderPx: 120 });
  });
});

describe('alternate-screen page keys', () => {
  it('sends standard PageUp/PageDown sequences through xterm input', () => {
    const term = makeTerminal();
    expect(sendTerminalPageKey(term, -1)).toBe(true);
    expect(sendTerminalPageKey(term, 1)).toBe(true);
    expect(term.input.mock.calls).toEqual([['\x1b[5~', false], ['\x1b[6~', false]]);
  });

  it('returns false when the terminal cannot accept input', () => {
    expect(sendTerminalPageKey(null, -1)).toBe(false);
    expect(sendTerminalPageKey({ input: null }, -1)).toBe(false);
    expect(sendTerminalPageKey({ input: vi.fn() }, 0)).toBe(false);
  });
});

describe('scrollTerminalLines', () => {
  it('uses the real scrollback API in the normal buffer', () => {
    const term = makeTerminal({ alt: false });
    expect(scrollTerminalLines(term, -5)).toBe(-5);
    expect(term.scrollLines).toHaveBeenCalledWith(-5);
    expect(term.input).not.toHaveBeenCalled();
  });

  it('uses the app page key for each alternate-buffer step', () => {
    const term = makeTerminal();
    expect(scrollTerminalLines(term, -3)).toBe(-3);
    expect(term.input.mock.calls).toEqual([
      ['\x1b[5~', false],
      ['\x1b[5~', false],
      ['\x1b[5~', false],
    ]);
  });

  it('bounds a large alternate-buffer request', () => {
    const term = makeTerminal();
    expect(scrollTerminalLines(term, -5000)).toBe(-64);
    expect(term.input).toHaveBeenCalledTimes(64);
  });

  it('is a no-op for zero, a fractional delta, or no terminal', () => {
    const term = makeTerminal();
    expect(scrollTerminalLines(term, 0)).toBe(0);
    expect(scrollTerminalLines(term, 0.4)).toBe(0);
    expect(scrollTerminalLines(null, -3)).toBe(0);
    expect(term.input).not.toHaveBeenCalled();
  });
});

describe('scrollTerminalPage', () => {
  it('moves a normal-buffer screenful minus one row of overlap', () => {
    const term = makeTerminal({ alt: false, rows: 24 });
    scrollTerminalPage(term, -1);
    expect(term.scrollLines).toHaveBeenCalledWith(-23);
    scrollTerminalPage(term, 1);
    expect(term.scrollLines).toHaveBeenCalledWith(23);
  });

  it('uses one app page key in an alternate buffer', () => {
    const term = makeTerminal({ rows: 24 });
    expect(scrollTerminalPage(term, -1)).toBe(-1);
    expect(term.input).toHaveBeenCalledWith('\x1b[5~', false);
  });

  it('still moves a line on a one-row normal terminal', () => {
    const term = makeTerminal({ alt: false, rows: 1 });
    scrollTerminalPage(term, -1);
    expect(term.scrollLines).toHaveBeenCalledWith(-1);
  });
});

describe('attachTerminalWheelScroll', () => {
  it('translates alternate-buffer wheel input before xterm can send mouse input', () => {
    const term = makeTerminal();
    const xtermListener = vi.fn();
    term.element.addEventListener('wheel', xtermListener);
    const detach = attachTerminalWheelScroll(term);
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });

    term.element.dispatchEvent(event);

    expect(term.input).toHaveBeenCalledWith('\x1b[5~', false);
    expect(xtermListener).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    detach();
  });

  it('accumulates small pixel-mode deltas before sending a page key', () => {
    const term = makeTerminal({ rows: 24, height: 480 }); // 20px rows, four-line threshold
    const xtermListener = vi.fn();
    term.element.addEventListener('wheel', xtermListener);
    const detach = attachTerminalWheelScroll(term);

    for (let i = 0; i < 3; i++) {
      const event = new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true });
      term.element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(term.input).not.toHaveBeenCalled();

    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true }));
    expect(term.input).toHaveBeenCalledWith('\x1b[5~', false);
    expect(xtermListener).not.toHaveBeenCalled();
    detach();
  });

  it('maps a downward wheel to PageDown', () => {
    const term = makeTerminal();
    const detach = attachTerminalWheelScroll(term);
    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true }));
    expect(term.input).toHaveBeenCalledWith('\x1b[6~', false);
    detach();
  });

  it('resets fractional wheel state when the terminal session changes', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const detach = attachTerminalWheelScroll(term);
    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true }));

    resetTerminalWheelScroll(term);
    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }));

    expect(term.input).not.toHaveBeenCalled();
    detach();
  });

  it('leaves normal-buffer wheel input to xterm', () => {
    const term = makeTerminal({ alt: false });
    const xtermListener = vi.fn();
    term.element.addEventListener('wheel', xtermListener);
    const detach = attachTerminalWheelScroll(term);
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    term.element.dispatchEvent(event);
    expect(term.input).not.toHaveBeenCalled();
    expect(xtermListener).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    detach();
  });

  it('leaves shift-wheel input alone for browser horizontal-scroll behavior', () => {
    const term = makeTerminal();
    const xtermListener = vi.fn();
    term.element.addEventListener('wheel', xtermListener);
    const detach = attachTerminalWheelScroll(term);
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    // WheelEvent inherits its modifier state from MouseEvent, and not every DOM
    // implementation carries `shiftKey` through the WheelEvent constructor — pin it
    // on the instance so the shift branch is actually the one exercised (#6144).
    Object.defineProperty(event, 'shiftKey', { value: true });
    term.element.dispatchEvent(event);
    expect(term.input).not.toHaveBeenCalled();
    expect(xtermListener).toHaveBeenCalledTimes(1);
    detach();
  });

  it('leaves wheel input to xterm when the app enabled mouse tracking', () => {
    const term = makeTerminal({ mouseTrackingMode: 'any' });
    const xtermListener = vi.fn();
    term.element.addEventListener('wheel', xtermListener);
    const detach = attachTerminalWheelScroll(term);
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });

    term.element.dispatchEvent(event);

    expect(term.input).not.toHaveBeenCalled();
    expect(xtermListener).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    detach();
  });

  it('detaches the wheel listener', () => {
    const term = makeTerminal();
    const detach = attachTerminalWheelScroll(term);
    detach();
    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    expect(term.input).not.toHaveBeenCalled();
  });
});

describe('attachTerminalTouchScroll', () => {
  it('scrolls an alternate buffer after a half-viewport drag', () => {
    const term = makeTerminal({ rows: 24, height: 480 }); // 20px rows, 240px page threshold
    const detach = attachTerminalTouchScroll(term);

    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    // Finger moves DOWN 260px → pull older output into view.
    const move = touchEvent('touchmove', [560]);
    term.element.dispatchEvent(move);

    expect(term.input).toHaveBeenCalledWith('\x1b[5~', false);
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  it('scrolls down when the alternate-buffer finger moves up', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [40]));
    expect(term.input).toHaveBeenCalledWith('\x1b[6~', false);
    detach();
  });

  it('scrolls an ordinary shell session row-by-row', () => {
    const term = makeTerminal({ alt: false, rows: 24, height: 480 });
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const move = touchEvent('touchmove', [360]);
    term.element.dispatchEvent(move);
    expect(term.scrollLines).toHaveBeenCalledWith(-3);
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  it('leaves a sub-row drag alone so a tap still reaches the TUI', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const move = touchEvent('touchmove', [305]);
    term.element.dispatchEvent(move);
    expect(term.input).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
    detach();
  });

  it('still scrolls an alternate buffer before layout is available', () => {
    const term = makeTerminal({ rows: 24, height: 0 }); // 18px fallback, 216px threshold
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [520]));
    expect(term.input).toHaveBeenCalledWith('\x1b[5~', false);
    detach();
  });

  it('measures once per gesture rather than on every move', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const screen = term.element.querySelector('.xterm-screen');
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const measure = vi.spyOn(screen, 'getBoundingClientRect');
    for (let y = 320; y <= 500; y += 20) term.element.dispatchEvent(touchEvent('touchmove', [y]));
    expect(measure).not.toHaveBeenCalled();
    detach();
  });

  it('ignores a two-finger gesture (pinch-zoom belongs to the browser)', () => {
    const term = makeTerminal();
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300, 400]));
    term.element.dispatchEvent(touchEvent('touchmove', [200, 500]));
    expect(term.input).not.toHaveBeenCalled();
    detach();
  });

  it('does not carry drag distance across separate gestures', () => {
    const term = makeTerminal({ alt: false, rows: 24, height: 480 });
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [315]));
    term.element.dispatchEvent(touchEvent('touchend', []));
    expect(term.scrollLines).not.toHaveBeenCalled();
    // A fresh 15px drag must not combine with the first gesture's remainder.
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [315]));
    expect(term.scrollLines).not.toHaveBeenCalled();
    detach();
  });

  it('detaches every listener', () => {
    const term = makeTerminal();
    const detach = attachTerminalTouchScroll(term);
    detach();
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [600]));
    expect(term.input).not.toHaveBeenCalled();
  });

  it('returns a safe no-op when the terminal has no element yet', () => {
    expect(() => attachTerminalTouchScroll(null)()).not.toThrow();
    expect(() => attachTerminalTouchScroll({})()).not.toThrow();
  });
});
