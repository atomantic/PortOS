// Scrolling the Shell terminal — by touch at all, and inside a full-screen TUI.
//
// Two separate gaps land on one primitive, which is why one module covers both:
//
//   • xterm.js 6 has NO touch input path. Its viewport is VS Code's
//     SmoothScrollableElement: the scroll extent is virtual (there is no oversized
//     spacer element for the browser to scroll natively — the `.xterm-scroll-area`
//     of earlier versions is gone), and the only inputs it binds are `wheel` and
//     scrollbar drags; the vendored `Gesture` helper is never given a target. So a
//     swipe over the terminal does nothing at all, in ANY session. On a phone —
//     where watched agent runs are mostly read — that is the entire scroll story.
//
//   • The ALTERNATE screen buffer that a TUI takes (a watched `claude`/`codex` run,
//     `vim`, `less`, `htop`) has no scrollback by construction: `ybase` stays 0, so
//     `scrollLines()` and friends clamp to a no-op there. OpenCode's TUI also does
//     not use terminal mouse-wheel reports for its message viewport; its supported
//     path is the terminal's PageUp/PageDown key bindings.
//
// Normal-buffer scroll stays inside xterm through `scrollLines()`. In an alternate
// buffer, wheel events are captured before xterm's mouse protocol listener and
// translated to PageUp/PageDown escape sequences through `terminal.input()`. That
// keeps the event from becoming unsupported application mouse input while still
// letting the TUI own its conversation scroll region. The page buttons and touch
// gestures use that key path only when the app has not enabled mouse tracking.
//
// Scrolling back PAST a TUI, into what the shell printed before it started, stays
// impossible while it holds the alternate screen. That is terminal semantics, not a
// gap here.

// Used to bound a touch drag or a synthetic request instead of emitting an unbounded
// sequence of page keys when a gesture has a very large delta.
const MAX_SCROLL_STEPS = 64;

// A short trackpad gesture can produce many pixel-mode wheel events. Four logical
// lines is enough movement to make one page key useful without making each tiny
// event jump the TUI by a full viewport.
const WHEEL_PAGE_LINES = 4;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;

// Used when the terminal hasn't been laid out yet, so a swipe on a freshly-attached
// session still scrolls instead of silently accumulating pixels forever.
const FALLBACK_ROW_HEIGHT_PX = 18;

const isAltBuffer = (terminal) => terminal?.buffer?.active?.type === 'alternate';

// These are the standard xterm sequences OpenCode binds to its message page
// commands. Sending them through Terminal#input makes them flow through xterm's
// existing onData bridge to the PTY, without needing to know the server session id.
const PAGE_UP_SEQUENCE = '\x1b[5~';
const PAGE_DOWN_SEQUENCE = '\x1b[6~';

/** Send one standard terminal PageUp/PageDown key to an alternate-screen app. */
export const sendTerminalPageKey = (terminal, direction) => {
  if (!terminal || !direction || typeof terminal.input !== 'function') return false;
  terminal.input(direction < 0 ? PAGE_UP_SEQUENCE : PAGE_DOWN_SEQUENCE, false);
  return true;
};

// `.xterm-screen` is the element that is exactly rows × cellHeight; the outer
// `.xterm` container can carry padding that would skew a row height taken from it.
const screenElement = (terminal) => {
  const el = terminal?.element;
  return el ? el.querySelector('.xterm-screen') || el : null;
};

/**
 * Measure the terminal once per gesture. This is a layout-forcing read, and PortOS
 * runs xterm's DOM renderer, so reading on every touchmove costs a style+layout flush
 * at touch frequency. The row height cannot change inside a gesture we consume.
 */
export const measureTerminalGeometry = (terminal) => {
  const rect = screenElement(terminal)?.getBoundingClientRect();
  const rows = terminal?.rows || 0;
  return {
    rowHeightPx: rect?.height > 0 && rows ? rect.height / rows : FALLBACK_ROW_HEIGHT_PX,
  };
};

// A screenful, minus one row of overlap so the reader keeps a line of context — the
// same convention a normal terminal's Page Up/Down control uses.
const terminalPageLines = (terminal) => Math.max(1, (terminal?.rows ?? 1) - 1);

const wheelDeltaLines = (event, rowHeightPx) => {
  if (event.deltaMode === WHEEL_DELTA_MODE_LINE) return event.deltaY;
  if (event.deltaMode === WHEEL_DELTA_MODE_PAGE) return event.deltaY * WHEEL_PAGE_LINES;
  return event.deltaY / rowHeightPx;
};

const wheelScrollResetters = new WeakMap();
const touchScrollResetters = new WeakMap();

/** Clear pending scroll gestures before a reused terminal starts a new session. */
export const resetTerminalWheelScroll = (terminal) => {
  if (terminal && typeof terminal === 'object') {
    wheelScrollResetters.get(terminal)?.();
    touchScrollResetters.get(terminal)?.();
  }
};

/**
 * Scroll the normal terminal buffer by `lines` (negative = toward older output).
 * Alternate-screen apps have no terminal scrollback, so each requested logical
 * step becomes the app's supported PageUp/PageDown key instead.
 */
export const scrollTerminalLines = (terminal, lines) => {
  const requested = Math.trunc(lines);
  if (!terminal || !requested) return 0;

  // Normal buffer: the scrollback is real and only the real API moves it — the
  // viewport is virtual, so there is no native scroller a wheel event could drive.
  if (!isAltBuffer(terminal)) {
    terminal.scrollLines?.(requested);
    return requested;
  }

  const direction = requested < 0 ? -1 : 1;
  const steps = Math.min(Math.abs(requested), MAX_SCROLL_STEPS);
  let sent = 0;
  while (sent < steps && sendTerminalPageKey(terminal, direction)) sent++;
  return direction * sent;
};

/** Scroll one screenful. `direction` is -1 for up (older), 1 for down. */
export const scrollTerminalPage = (terminal, direction) => {
  if (isAltBuffer(terminal)) {
    return sendTerminalPageKey(terminal, direction) ? (direction < 0 ? -1 : 1) : 0;
  }
  return scrollTerminalLines(terminal, terminalPageLines(terminal) * (direction < 0 ? -1 : 1));
};

/**
 * Capture native wheel input for alternate-screen apps that expose scrolling as
 * keybindings instead of terminal mouse reports. Normal shell scrollback is left
 * entirely to xterm's own viewport listener.
 */
export const attachTerminalWheelScroll = (terminal) => {
  const el = terminal?.element;
  if (!el?.addEventListener) return () => {};

  let remainderLines = 0;
  const rowHeightPx = measureTerminalGeometry(terminal).rowHeightPx;

  const onWheel = (event) => {
    if (!isAltBuffer(terminal) || !event.deltaY || event.shiftKey) {
      remainderLines = 0;
      return;
    }
    // An app that enabled terminal mouse tracking owns this wheel event. In
    // particular, do not turn Vim/htop/tmux mouse input into an extra page key.
    if (terminal.modes?.mouseTrackingMode !== 'none') {
      remainderLines = 0;
      return;
    }

    const totalLines = remainderLines + wheelDeltaLines(event, rowHeightPx);
    const pages = Math.trunc(totalLines / WHEEL_PAGE_LINES);
    remainderLines = totalLines - pages * WHEEL_PAGE_LINES;
    // xterm's alternate-buffer fallback sends cursor keys for this event. Swallow
    // it even before a page threshold is reached so a small trackpad delta cannot
    // leak an unsupported sequence into the TUI.
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    if (pages) scrollTerminalLines(terminal, pages);
  };

  const reset = () => { remainderLines = 0; };
  wheelScrollResetters.set(terminal, reset);
  el.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    reset();
    if (wheelScrollResetters.get(terminal) === reset) wheelScrollResetters.delete(terminal);
    el.removeEventListener('wheel', onWheel, { capture: true });
  };
};

/**
 * Convert accumulated drag distance into whole scroll steps, keeping the sub-row
 * remainder so a slow drag adds up instead of being truncated away every frame.
 * `accumPx` is positive when the finger moved UP (content scrolls down), matching the
 * sign convention of `scrollTerminalLines`.
 */
export const planTouchScrollSteps = (accumPx, rowHeightPx) => {
  if (!(rowHeightPx > 0)) return { steps: 0, remainderPx: accumPx };
  const steps = Math.trunc(accumPx / rowHeightPx);
  return { steps, remainderPx: accumPx - steps * rowHeightPx };
};

/**
 * Make a one-finger drag scroll the terminal. Returns a detach function.
 *
 * Shell scrollback and mouse-aware apps scroll row-by-row. Apps without mouse
 * tracking retain page-key scrolling because they expose no generic line-scroll API.
 */
export const attachTerminalTouchScroll = (terminal) => {
  const el = terminal?.element;
  if (!el?.addEventListener) return () => {};

  // Reserve one-finger panning before the browser can claim the gesture. Keep
  // pinch zoom and taps available; waiting for a whole row in touchmove is too late
  // on mobile browsers, which can already have started scrolling an ancestor.
  const previousTouchAction = el.style.touchAction;
  el.style.touchAction = 'pinch-zoom';

  let lastY = null;
  let accumPx = 0;
  let geometry = null;
  let lastMoveAt = 0;
  let velocity = 0;
  let momentumFrame = null;

  const stopMomentum = () => {
    if (momentumFrame !== null) cancelAnimationFrame(momentumFrame);
    momentumFrame = null;
  };

  const end = () => {
    stopMomentum();
    lastY = null;
    accumPx = 0;
    geometry = null;
    velocity = 0;
  };

  const onEnd = () => {
    // Only local scrollback can coast safely. Sending delayed keys or mouse
    // reports could operate a different TUI after the finger has left the screen.
    const buffer = terminal.buffer?.active;
    if (lastY === null || isAltBuffer(terminal)
      || terminal.modes?.mouseTrackingMode !== 'none'
      || performance.now() - lastMoveAt > 80 || Math.abs(velocity) < 0.1) return end();
    lastY = null;
    let previousFrameAt = performance.now();
    const coast = (now) => {
      momentumFrame = null;
      if (terminal.buffer?.active !== buffer || isAltBuffer(terminal)
        || terminal.modes?.mouseTrackingMode !== 'none') return end();
      const elapsed = now - previousFrameAt;
      // A suspended tab must not replay a flick when it becomes visible again.
      if (elapsed > 80) return end();
      previousFrameAt = now;
      accumPx += velocity * elapsed;
      velocity *= Math.exp(-elapsed / 180);
      const { steps, remainderPx } = planTouchScrollSteps(accumPx, geometry.rowHeightPx);
      accumPx = remainderPx;
      if (steps) {
        const before = buffer.viewportY;
        terminal.scrollLines(steps);
        if (buffer.viewportY === before) return end();
      }
      if (Math.abs(velocity) < 0.1) return end();
      momentumFrame = requestAnimationFrame(coast);
    };
    momentumFrame = requestAnimationFrame(coast);
  };

  const onStart = (ev) => {
    end();
    // Two fingers is a pinch-zoom, which belongs to the browser.
    if (ev.touches?.length !== 1) return end();
    lastY = ev.touches[0].clientY;
    accumPx = 0;
    geometry = measureTerminalGeometry(terminal);
    lastMoveAt = performance.now();
  };

  const onMove = (ev) => {
    if (lastY == null) return;
    if (ev.touches?.length !== 1) return end();
    const y = ev.touches[0].clientY;
    const now = performance.now();
    const delta = lastY - y;
    const elapsed = now - lastMoveAt;
    // Cap release speed so a sparse event stream cannot fling thousands of rows.
    velocity = elapsed > 0 ? Math.max(-3, Math.min(3, delta / elapsed)) : 0;
    lastMoveAt = now;
    accumPx += delta;
    lastY = y;
    // Cancel even sub-row movement: it still belongs to this terminal gesture.
    if (ev.cancelable) ev.preventDefault();
    const mouseMode = terminal.modes?.mouseTrackingMode;
    // X10 reports presses only, not wheel events.
    const mouseScroll = mouseMode && mouseMode !== 'none' && mouseMode !== 'x10';
    // OpenCode's PageUp/PageDown bindings move the message viewport by a page,
    // not by one terminal row. Wait for roughly half a viewport before sending a
    // page key; normal shell scrollback remains row-granular.
    const stepHeight = isAltBuffer(terminal) && !mouseScroll
      ? Math.max(geometry.rowHeightPx, (terminal.rows || 1) * geometry.rowHeightPx / 2)
      : geometry.rowHeightPx;
    const { steps, remainderPx } = planTouchScrollSteps(accumPx, stepHeight);
    if (!steps) return;
    accumPx = remainderPx;
    if (mouseScroll) {
      // Let xterm encode the negotiated mouse protocol and coordinates. One wheel
      // event produces one report, regardless of delta magnitude, so emit bounded
      // row steps instead of turning a drag into one large jump or a page key.
      for (let i = 0; i < Math.min(Math.abs(steps), MAX_SCROLL_STEPS); i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WHEEL_DELTA_MODE_LINE,
          deltaY: Math.sign(steps),
          clientX: ev.touches[0].clientX,
          clientY: y,
        }));
      }
    } else {
      scrollTerminalLines(terminal, steps);
    }
  };

  touchScrollResetters.set(terminal, end);
  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd, { passive: true });
  el.addEventListener('wheel', stopMomentum, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  return () => {
    end();
    if (touchScrollResetters.get(terminal) === end) touchScrollResetters.delete(terminal);
    el.style.touchAction = previousTouchAction;
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('wheel', stopMomentum);
    el.removeEventListener('touchcancel', end);
  };
};
