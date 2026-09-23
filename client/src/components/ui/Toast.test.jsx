import { useEffect } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

import { toast, Toaster, COLLAPSE_AFTER_MS } from './Toast.jsx';

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Toast on an insecure origin', () => {
  // Regression: `add()` minted ids with a bare `crypto.randomUUID()`, which is
  // undefined outside a secure context. PortOS is routinely reached over plain
  // HTTP via Tailscale, so EVERY toast threw `crypto.randomUUID is not a
  // function` there — including the error toasts the API client raises to
  // report a failure, which surfaced it as an unhandled rejection.
  it('renders without crypto.randomUUID (plain HTTP via Tailscale)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    render(<Toaster />);
    expect(() => act(() => { toast.error('Request failed'); })).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
  });
});

describe('Toaster accessibility', () => {
  it('exposes the toast stack as a labelled notification region', () => {
    render(<Toaster />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toBeInTheDocument();
  });

  it('announces a default toast politely (role="status") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast('Saved'); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
    // role="status" already implies aria-live="polite"; pairing both
    // double-announces in iOS VoiceOver, so aria-live must be absent.
    expect(status).not.toHaveAttribute('aria-live');
  });

  it('announces an error toast assertively (role="alert") without a redundant aria-live', () => {
    render(<Toaster />);
    act(() => { toast.error('Boom'); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Boom');
    // role="alert" already implies aria-live="assertive".
    expect(alert).not.toHaveAttribute('aria-live');
  });

  it('hides the decorative status glyph from assistive tech', () => {
    render(<Toaster />);
    act(() => { toast.success('Done'); });
    const status = screen.getByRole('status');
    const glyph = status.querySelector('[aria-hidden="true"]');
    expect(glyph).toHaveTextContent('✓');
  });
});

describe('loading spinner', () => {
  // Regression: the loading icon was the `⟳` glyph with `animate-spin` on it.
  // The rotation origin is the center of the span's line box, but the glyph's
  // ink sits off that point, so it wobbled instead of turning in place — very
  // visible on "PortOS is restarting...", which spins for the whole restart.
  // The spinning element must be an SVG whose arc is centered in its viewBox.
  it('spins an SVG, never a text glyph', () => {
    render(<Toaster />);
    act(() => { toast.loading('PortOS is restarting...'); });

    const status = screen.getByRole('status');
    const spinner = status.querySelector('.animate-spin');
    expect(spinner?.tagName.toLowerCase()).toBe('svg');
    // A glyph carried along by the rotation would reintroduce the wobble.
    expect(spinner).toHaveTextContent('');
  });

  it('lets a caller-supplied icon override the spinner', () => {
    render(<Toaster />);
    act(() => { toast.loading('Uploading', { icon: '⬆' }); });

    const status = screen.getByRole('status');
    expect(status.querySelector('[aria-hidden="true"]')).toHaveTextContent('⬆');
    expect(status.querySelector('.animate-spin')).toBeNull();
  });
});

/** Why a never-dismissing toast has to fold away: see COLLAPSE_AFTER_MS. */
describe('long-lived toasts stop blocking the page', () => {
  const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  // Every test here measures a timeout, so fake timers are mandatory — a test
  // that forgot them would silently no-op every `advance()`.
  beforeEach(() => {
    vi.useFakeTimers();
    render(<Toaster />);
  });

  it('collapses a persistent toast to a pill that no longer covers the page', () => {
    act(() => { toast('Install out of sync', { duration: Infinity, icon: '⚠️' }); });

    // Still a full-size toast for the first COLLAPSE_AFTER_MS.
    expect(screen.getByRole('status')).toBeVisible();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();

    advance(COLLAPSE_AFTER_MS);

    // The body is hidden (out of hit-testing and out of the a11y tree) and only
    // a corner pill remains.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('leaves transient toasts alone — they never live long enough to block anything', () => {
    act(() => { toast('Saved'); });

    // The default 4s toast is dismissed well before the collapse threshold, so
    // it must never sprout a pill on its way out.
    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();
  });

  it('re-expands when the pill is clicked, and re-collapses on its own', () => {
    // Distinct text per test: identical content within DEDUP_WINDOW_MS is
    // dropped, and the fingerprint map outlives an individual test.
    act(() => { toast('New build available', { duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);

    // `detail: 1` marks this a pointer/touch activation. Say it explicitly:
    // jsdom defaults `detail` to 0, which the component reads as a KEYBOARD
    // activation and answers by taking focus — so a bare `fireEvent.click`
    // here would silently test the wrong gesture and fail.
    fireEvent.click(screen.getByRole('button', { name: /show notification/i }), { detail: 1 });
    expect(screen.getByRole('status')).toBeVisible();

    // No pinning on expand — a tap on a touch device (no mouseleave ever
    // arrives) must still fold the toast back away.
    advance(COLLAPSE_AFTER_MS);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the toast open while focus is inside it', () => {
    act(() => {
      toast(() => <button type="button">Reconcile</button>, { duration: Infinity, label: 'Install out of sync' });
    });

    fireEvent.focus(screen.getByRole('button', { name: 'Reconcile' }));
    advance(COLLAPSE_AFTER_MS * 2);
    // Collapsing here would `display: none` the focused button and dump focus
    // on <body> mid-interaction.
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeVisible();

    fireEvent.blur(screen.getByRole('button', { name: 'Reconcile' }));
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('unfolds a collapsed toast when it is updated in place', () => {
    act(() => { toast.loading('Restarting PortOS...', { id: 'restart', duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: /show notification/i })).toBeVisible();

    // Same id, new content: the swap has something to say, so it must not land
    // inside a pill nobody thinks to open.
    act(() => { toast.success('PortOS restarted', { id: 'restart' }); });
    expect(screen.getByRole('status')).toHaveTextContent('PortOS restarted');
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();
  });

  it('moves focus into the toast when the pill is expanded from the keyboard', () => {
    act(() => {
      toast(() => <button type="button">Reconcile</button>, {
        duration: Infinity,
        label: 'Install out of sync',
      });
    });
    advance(COLLAPSE_AFTER_MS);

    // Activating the pill unmounts it. Without a handover focus lands on
    // <body> and the toast's own buttons leave the tab sequence entirely.
    // `detail: 0` is what makes this a KEYBOARD activation — the browser
    // synthesizes Enter/Space clicks with no click count.
    const pill = screen.getByRole('button', { name: /show notification/i });
    pill.focus();
    fireEvent.click(pill, { detail: 0 });

    const body = screen.getByRole('status');
    expect(document.activeElement).toBe(body);
    expect(document.activeElement).not.toBe(document.body);
    // ...and the toast stays put while it holds focus.
    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  });

  it('does not steal focus when the pill is expanded by pointer', () => {
    act(() => { toast('Build is stale', { duration: Infinity }); });
    advance(COLLAPSE_AFTER_MS);

    // Model what a real browser does, or this test proves nothing: Chrome
    // FOCUSES a <button> on mouse-down, so `document.activeElement` is the pill
    // for an ordinary click too — a guard written against it reads "keyboard"
    // here and steals focus. jsdom's bare `fireEvent.click` neither focuses the
    // button nor sets `detail`, which is how an activeElement-based guard
    // passed this test while parking the toast open forever in Chrome (measured
    // via CDP against the live page). So focus the pill AND send `detail: 1`.
    const pill = screen.getByRole('button', { name: /show notification/i });
    pill.focus();
    fireEvent.click(pill, { detail: 1 });

    // Focus must NOT have been handed to the body: `onFocus` there takes the
    // focus hold, and nothing would ever release it.
    expect(document.activeElement).not.toBe(screen.getByRole('status'));

    // The invariant that actually matters — no expand path may leave the toast
    // parked. Whatever the activation, it folds itself away again.
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Build is stale' })).toBeVisible();
  });

  it('keeps focus held even after the pointer sweeps over the toast and leaves', () => {
    // Hover and focus are independent holds. A single shared flag lets the
    // pointer leaving release a hold that focus still owns, and the collapse
    // then `display: none`s the very button the keyboard user is sitting on.
    act(() => {
      toast(() => <button type="button">Reconcile now</button>, {
        duration: Infinity,
        label: 'Install out of sync',
      });
    });

    const button = screen.getByRole('button', { name: 'Reconcile now' });
    const body = screen.getByRole('status');

    fireEvent.focus(button);       // keyboard user tabs in
    fireEvent.mouseEnter(body);    // pointer drifts across the toast
    fireEvent.mouseLeave(body);    // and off again — focus is still inside

    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('button', { name: 'Reconcile now' })).toBeVisible();

    // Once focus actually leaves, nothing is holding it open any more.
    fireEvent.blur(button);
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Install out of sync' })).toBeVisible();
  });

  it('keeps hover held even after focus leaves the toast', () => {
    // The mirror image: focus departing must not release the pointer's hold.
    act(() => { toast('Update available', { duration: Infinity }); });

    const body = screen.getByRole('status');
    fireEvent.mouseEnter(body);
    fireEvent.focus(body);
    fireEvent.blur(body);

    advance(COLLAPSE_AFTER_MS * 2);
    expect(screen.getByRole('status')).toBeVisible();

    fireEvent.mouseLeave(body);
    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Update available' })).toBeVisible();
  });

  it('folds on the content\'s own schedule when it passes collapseAfter', () => {
    // The agent-feedback card sets duration: Infinity only because it runs a
    // 15s dismiss of its own. Folding at the 8s default would hide its rating
    // buttons for the last 7s of a life the caller did bound.
    const OWN_BOUND = COLLAPSE_AFTER_MS * 2;
    act(() => {
      toast(() => <button type="button">Rate</button>, {
        duration: Infinity,
        label: 'Agent finished',
        collapseAfter: OWN_BOUND,
      });
    });

    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Rate' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /show notification/i })).toBeNull();

    // Still folds — a longer delay is not an opt-out. The card clears its own
    // dismiss timer once expanded, and an unbounded card is the click sink.
    advance(OWN_BOUND - COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Agent finished' })).toBeVisible();
  });

  it('ignores a collapseAfter that would switch the fold off entirely', () => {
    // `Infinity` here would read as "never fold" and hand back the very
    // click-eating overlay this exists to remove, so it must not be honoured.
    act(() => { toast('Stuck forever', { duration: Infinity, collapseAfter: Infinity }); });

    advance(COLLAPSE_AFTER_MS);
    expect(screen.getByRole('button', { name: 'Show notification: Stuck forever' })).toBeVisible();
  });

  it('reveals the Alt+Shift+N hint to screen readers on an actionable (render-prop) toast', () => {
    act(() => {
      toast(() => <button type="button">Reconcile</button>, { duration: Infinity, label: 'Install out of sync' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Press Alt+Shift+N to reach its actions.');
  });

  it('does not add the hint to a plain string toast', () => {
    act(() => { toast('Export complete'); });
    expect(screen.getByRole('status')).not.toHaveTextContent('Alt+Shift+N');
  });

  it('hides rather than unmounts, so a self-dismissing toast keeps its timers', () => {
    const unmounted = vi.fn();
    function SelfManaging() {
      useEffect(() => unmounted, []);
      return <span>Agent finished</span>;
    }
    act(() => { toast(() => <SelfManaging />, { duration: Infinity, label: 'Agent finished' }); });

    advance(COLLAPSE_AFTER_MS);

    // Unmounting the body would destroy the render-prop's own auto-dismiss
    // timer and strand the pill on screen forever.
    expect(unmounted).not.toHaveBeenCalled();
    expect(screen.getByText('Agent finished')).toBeInTheDocument();
  });
});

/**
 * #8117: a finite toast's dismiss timer used to be armed once, outside React,
 * at creation — hover and focus could not touch it, so a keyboard user
 * reaching for an Undo button lost it mid-reach, and a mouse user hovering
 * over Undo could lose it while still reading. It now lives inside
 * `ToastItem` and pauses/resumes around the same `held` (hover-or-focus-
 * within) state that already gates the pill collapse above.
 */
describe('finite toasts pause their dismiss timer while held', () => {
  const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
    render(<Toaster />);
  });

  it('stays present past its duration while hovered, then dismisses after the remaining time once released', () => {
    act(() => { toast('Dismissed: a warning · Undo', { duration: 8000 }); });

    const status = screen.getByRole('status');
    fireEvent.mouseEnter(status);

    // Well past the original 8s deadline — still here because the pointer is
    // holding it open.
    advance(20000);
    expect(screen.getByRole('status')).toBeVisible();

    fireEvent.mouseLeave(status);

    // Hover started immediately after creation, so none of the original 8s
    // had elapsed — the full 8s is still owed after release.
    advance(7000);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1000);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays present past its duration while focus is inside it, then dismisses after release', () => {
    act(() => {
      toast(() => <button type="button">Undo</button>, { duration: 8000, label: 'Comment fix applied' });
    });

    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.focus(button);

    advance(20000);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();

    fireEvent.blur(button);
    advance(8000);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses only after the REMAINING time, not the full duration, once released partway through', () => {
    act(() => { toast('Saved with a note', { duration: 8000 }); });

    const status = screen.getByRole('status');
    advance(5000); // 3s left on the clock
    fireEvent.mouseEnter(status);
    advance(10000); // held well past the original deadline
    fireEvent.mouseLeave(status);

    advance(2999);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('restarts the countdown when a same-id swap changes only the duration, not the content', () => {
    // Regression: an Infinity→finite swap that keeps identical content/type
    // must still reset the countdown. `remainingRef` was previously left at
    // its stale Infinity value, and `setTimeout(fn, Infinity)` clamps to 0 in
    // JS — the toast would have dismissed on the very next tick instead of
    // honouring the new duration.
    act(() => { toast('Reconnecting to the agent...', { id: 'agent-status', duration: Infinity }); });
    advance(50000); // never dismisses on its own while Infinity

    act(() => { toast('Reconnecting to the agent...', { id: 'agent-status', duration: 5000 }); });

    advance(4999);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('restarts the countdown from the new duration on a same-id content swap (loading → success)', () => {
    act(() => { toast.loading('Applying fix...', { id: 'apply-fix' }); });
    advance(50000); // loading is Infinity — never dismisses on its own

    act(() => { toast.success('Fix applied · Undo', { id: 'apply-fix', duration: 6000 }); });

    // The new 6s duration, not any leftover from the (nonexistent) loading timer.
    advance(5999);
    expect(screen.getByRole('status')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Alt+Shift+N focuses the newest toast, and Escape returns focus', () => {
  const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  const pressJumpShortcut = () => {
    fireEvent.keyDown(document, { altKey: true, shiftKey: true, code: 'KeyN' });
  };

  it("focuses the newest toast's first button in one keystroke", () => {
    render(<Toaster />);
    act(() => {
      toast(() => <button type="button">Undo</button>, { duration: Infinity, label: 'Dismissed a warning' });
    });

    pressJumpShortcut();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
  });

  it('holds the toast open once the jump lands focus inside it, even past its duration', () => {
    render(<Toaster />);
    act(() => {
      toast(() => <button type="button">Undo</button>, { duration: 8000, label: 'Dismissed a warning' });
    });

    pressJumpShortcut();
    advance(20000);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('falls back to the toast body when it has no focusable control', () => {
    render(<Toaster />);
    act(() => { toast('Backup finished'); });

    pressJumpShortcut();
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });

  it('ignores the shortcut while typing in an editable field', () => {
    render(
      <>
        <input aria-label="search" />
        <Toaster />
      </>
    );
    act(() => { toast(() => <button type="button">Undo</button>, { duration: Infinity, label: 'x' }); });

    const input = screen.getByRole('textbox', { name: 'search' });
    input.focus();
    fireEvent.keyDown(input, { altKey: true, shiftKey: true, code: 'KeyN' });

    expect(document.activeElement).toBe(input);
  });

  it('restores focus to the previously focused element on Escape', () => {
    render(
      <>
        <button type="button">Page button</button>
        <Toaster />
      </>
    );
    act(() => {
      toast(() => <button type="button">Undo</button>, { duration: Infinity, label: 'x' });
    });

    const pageButton = screen.getByRole('button', { name: 'Page button' });
    pageButton.focus();
    expect(document.activeElement).toBe(pageButton);

    pressJumpShortcut();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(document.activeElement).toBe(pageButton);
  });
});
