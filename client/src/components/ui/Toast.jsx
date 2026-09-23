/**
 * Toast notification system — replaces react-hot-toast
 * Supports: toast(), toast.success(), toast.error(), toast.loading(), toast.dismiss(), <Toaster />
 * Render-prop toasts: toast((t) => <Component t={t} />, opts) — t has { id }
 *
 * A `duration: Infinity` toast collapses to a corner pill after
 * COLLAPSE_AFTER_MS so it stops blocking clicks on the page beneath it. Such a
 * toast with render-prop content MUST pass `label` — the pill can't name itself
 * from JSX, and `a11yConventions.test.js` enforces it. Content that runs its
 * own dismiss timer passes `collapseAfter` to fold on its schedule instead.
 */

import { Loader2 } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { uuidv4 } from '../../lib/uuid.js';
import { isEditableTarget } from '../../lib/a11yKeyboard.js';

let toasts = [];
let toastSeq = 0;
const listeners = new Set();

function notify() {
  listeners.forEach(fn => fn([...toasts]));
}

const DEFAULT_DURATION = 4000;
const DEDUP_WINDOW_MS = 1500;

// How long a `duration: Infinity` toast stays at full size before folding into
// a corner pill. The stack is `fixed`, `z-[9999]` and `pointer-events-auto`, so
// a toast that never dismisses is a permanent click sink over the page: an
// install whose `outOfSync` notice parked in the bottom-right corner covered
// the CoS task form's Screenshot and Attach buttons, and clicking them did
// nothing at all — no picker, no error, nothing in the console.
//
// Only unbounded toasts collapse. A finite duration is a bound the caller
// already chose and it clears itself, so folding one early would hide an action
// the caller meant to keep offering for the whole time (the manuscript
// Undo-fix toast runs 10s and its Undo button is the only one there is).
//
// A toast whose bound lives INSIDE its content rather than in `duration` passes
// `collapseAfter` to say so. `useAgentFeedbackToast` is the case: it sets
// `duration: Infinity` only because the card runs its own 15s dismiss, so the
// default 8s would fold the rating controls away for the last 7s of a life the
// caller did bound. Worse, re-opening the pill does NOT restart that inner
// timer, so a card re-expanded at 10s vanished 5s later, mid-click. Passing the
// content's own bound lines the two up. It is a delay, never an opt-out: when
// that card is expanded it clears its dismiss timer and becomes truly
// unbounded — the widest click sink of the set — so it still has to fold.
export const COLLAPSE_AFTER_MS = 8000;

// Fingerprint → expiry timestamp. Same content+type within DEDUP_WINDOW_MS is
// silently dropped so a single user action that flows through multiple error
// channels (API client toast + socket error:occurred + error:notified) doesn't
// stack 3-4 identical red toasts. Render-prop content (functions) is never
// deduped — those are intentional custom UIs and the caller controls identity.
const recentFingerprints = new Map();
const fingerprintFor = (content, type) =>
  typeof content === 'string' ? `${type}::${content}` : null;

function add(content, opts = {}, type = 'default') {
  // `uuidv4`, not `crypto.randomUUID` — the latter is undefined on insecure
  // origins (PortOS over plain HTTP via Tailscale), where it threw out of
  // every toast, including the ones the API client raises to report a failure.
  const id = opts.id || uuidv4();
  const duration = opts.duration !== undefined ? opts.duration : (type === 'loading' ? Infinity : DEFAULT_DURATION);

  // Skip if an identical toast was just shown — but only when the caller
  // didn't supply an explicit id (explicit id = caller is intentionally
  // updating the same toast, e.g. a loading-then-success swap).
  if (!opts.id) {
    const fp = fingerprintFor(content, type);
    if (fp) {
      const now = Date.now();
      // Sweep expired entries opportunistically.
      for (const [k, exp] of recentFingerprints) {
        if (exp <= now) recentFingerprints.delete(k);
      }
      const expiry = recentFingerprints.get(fp);
      if (expiry && expiry > now) return id;
      recentFingerprints.set(fp, now + DEDUP_WINDOW_MS);
    }
  }

  // `label` names the toast once it collapses to a pill — required for
  // render-prop content, whose JSX the pill can't summarise on its own.
  // `collapseAfter` is validated, not merely read: a non-finite value (a stray
  // `Infinity` meaning "never fold") would disable the fold entirely and hand
  // back the click-eating overlay, so anything but a finite positive number
  // falls back to the default rather than being honoured.
  const collapseAfter = Number.isFinite(opts.collapseAfter) && opts.collapseAfter > 0
    ? opts.collapseAfter
    : COLLAPSE_AFTER_MS;
  // `seq` marks WHEN this entry was last touched, independent of its
  // position in `toasts` — a same-id re-add (loading→success) replaces the
  // entry IN PLACE at its original array index so the stack doesn't jump, so
  // array order alone can't answer "which toast is newest" once an update
  // has happened. The Alt+Shift+N jump below reads this instead of `[last]`.
  const entry = { id, type, content, icon: opts.icon, duration, style: opts.style, label: opts.label, collapseAfter, seq: ++toastSeq };

  const idx = toasts.findIndex(t => t.id === id);
  toasts = idx !== -1
    ? [...toasts.slice(0, idx), entry, ...toasts.slice(idx + 1)]
    : [...toasts, entry];
  notify();

  // The finite-duration dismiss timer used to be armed HERE, at creation, and
  // never touched again — so hovering or focusing a toast (the `held` state
  // below) could not pause it, and a keyboard user reaching for an Undo
  // button lost it mid-reach. It now lives in `ToastItem`'s own effect, which
  // can see `held` and pause/resume around it (#8117).
  return id;
}

function dismiss(id) {
  toasts = id !== undefined ? toasts.filter(t => t.id !== id) : [];
  notify();
}

export const toast = Object.assign(
  (content, opts = {}) => add(content, opts, 'default'),
  {
    success: (content, opts = {}) => add(content, opts, 'success'),
    error:   (content, opts = {}) => add(content, opts, 'error'),
    loading: (content, opts = {}) => add(content, opts, 'loading'),
    warning: (content, opts = {}) => add(content, opts, 'warning'),
    dismiss,
  }
);

export default toast;

const TYPE_ICON = { success: '✓', error: '✕', warning: '⚠' };
const TYPE_CLASS = { success: 'text-port-success', error: 'text-port-error', loading: 'text-gray-400', warning: 'text-port-warning' };

export function Toaster({ position = 'bottom-right', toastOptions = {} }) {
  const [items, setItems] = useState([]);
  const regionRef = useRef(null);
  // Where to send focus back on Escape — only set while focus is parked
  // inside the notification region via the Alt+Shift+N jump below.
  const returnFocusRef = useRef(null);

  useEffect(() => {
    const fn = ts => setItems(ts);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  // The keyboard path into the notification region (#8117): the Toaster is
  // mounted last in `main.jsx` so its buttons sit at the very end of tab
  // order, and nothing previously moved focus there directly. Alt+Shift+N
  // focuses the newest toast's first control (falling back to the toast body,
  // which is always `tabIndex={-1}`); Escape while focus is inside a toast
  // returns it to whatever held it before the jump.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyN') {
        // `code`, not `key` — macOS remaps Option+letter to a different
        // character (Option+Shift+N is typically `˜`), which would silently
        // break the shortcut on every Mac if matched on `key`. Not routed
        // through `shouldIgnoreGlobalKey`: that predicate drops every
        // Alt-chorded keydown by default, and Alt is exactly the chord this
        // shortcut needs, so the editable-target guard is applied directly
        // instead.
        if (isEditableTarget(e.target)) return;
        // An open `aria-modal` dialog owns the focus trap (WCAG 2.4.3) —
        // jumping focus out to a toast behind it would break that trap, so
        // this stands down exactly like `shouldIgnoreGlobalKey`'s dialog
        // guard does for the shortcut hooks that route through it.
        if (document.querySelector('[aria-modal="true"]')) return;
        const region = regionRef.current;
        // `seq`, not array position — a same-id re-add (loading→success)
        // replaces the entry in place at its original index, so the LAST
        // item isn't necessarily the one most recently touched.
        const newest = items.reduce((a, b) => (!a || b.seq > a.seq ? b : a), null);
        if (!region || !newest) return;
        const toastEl = region.querySelector(`[data-toast-id="${newest.id}"]`);
        if (!toastEl) return;
        const focusTarget = toastEl.tagName === 'BUTTON'
          ? toastEl
          : (toastEl.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? toastEl);
        e.preventDefault();
        returnFocusRef.current = document.activeElement;
        focusTarget.focus();
        return;
      }
      if (e.key === 'Escape' && returnFocusRef.current && regionRef.current?.contains(document.activeElement)) {
        const toReturn = returnFocusRef.current;
        returnFocusRef.current = null;
        toReturn.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [items]);

  const posClass = {
    'bottom-right':  'bottom-4 right-4 items-end',
    'bottom-left':   'bottom-4 left-4 items-start',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
    'top-right':     'top-4 right-4 items-end',
    'top-left':      'top-4 left-4 items-start',
    'top-center':    'top-4 left-1/2 -translate-x-1/2 items-center',
  }[position] ?? 'bottom-4 right-4 items-end';

  return (
    // Notification region. Each toast is its own live region: role="alert"
    // (implicitly assertive) for errors, role="status" (implicitly polite)
    // otherwise, so screen readers announce toasts as they arrive. The role's
    // implicit live semantics are relied on WITHOUT a redundant aria-live —
    // pairing both on one node double-announces in iOS VoiceOver. Announcing
    // per-toast rather than on the container avoids the whole stack being
    // re-read when one entry changes.
    <div
      ref={regionRef}
      className={`fixed ${posClass} z-[9999] flex flex-col gap-2 pointer-events-none`}
      role="region"
      aria-label="Notifications"
      aria-keyshortcuts="Alt+Shift+N"
    >
      {items.map(t => (
        <ToastItem key={t.id} t={t} toastOptions={toastOptions} />
      ))}
    </div>
  );
}

function ToastItem({ t, toastOptions }) {
  const style = { padding: '12px 16px', borderRadius: '8px', ...toastOptions.style, ...t.style };
  const iconStr = t.icon ?? (t.type !== 'default' ? TYPE_ICON[t.type] : null);
  // The loading icon is `Loader2` — the same spinner the rest of the UI spins
  // (ConfirmButtonPair, TabPills) — and no longer the `⟳` glyph it used to be.
  // `animate-spin` rotates about the center of the element's box, and a glyph's
  // ink is not centered in its line box: the font's ascent/descent padding above
  // and below it is asymmetric, so the character is drawn off the box's midpoint
  // and spinning it traces a visible wobble instead of a clean circle ("PortOS is
  // restarting..." made it obvious, since that toast spins for the whole
  // restart). An icon whose arc is centered in a square viewBox puts the visual
  // center on the rotation origin, so it turns in place.
  // A caller-supplied `icon` still wins over the spinner — it's an explicit
  // override, and the type only picks the default.
  const showSpinner = t.type === 'loading' && !t.icon;
  const iconNode = showSpinner ? <Loader2 size={14} className="animate-spin" /> : iconStr;
  const iconClass = t.type !== 'default' ? TYPE_CLASS[t.type] : '';
  // The icon is 14px; centering it on the `text-sm` line box keeps it level
  // with the first line of the message rather than riding above it.
  const iconBoxClass = showSpinner ? 'inline-flex h-5 items-center' : '';
  // Only a toast that never dismisses itself can outstay its welcome and start
  // eating clicks — see COLLAPSE_AFTER_MS.
  const collapsible = t.duration === Infinity;
  const [collapsed, setCollapsed] = useState(false);
  // Held open while the pointer is over the toast or focus is inside it —
  // collapsing out from under a hover would yank the buttons the user is
  // reaching for, and collapsing while focus is inside would drop that focus
  // to <body>.
  //
  // Two flags, not one: hover and focus are independent holds, and a single
  // shared boolean lets whichever ends last clear the other's. Tab to the
  // toast's button, then sweep the pointer over the toast and off again, and
  // `mouseleave` would release a hold that focus still owns — 8s later the
  // still-focused button gets `display: none` and focus lands on <body>, the
  // exact thing this is here to prevent.
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const held = hovered || focusWithin;

  const collapseAfter = t.collapseAfter ?? COLLAPSE_AFTER_MS;

  useEffect(() => {
    if (!collapsible || collapsed || held) return undefined;
    const timer = setTimeout(() => setCollapsed(true), collapseAfter);
    return () => clearTimeout(timer);
  }, [collapsible, collapsed, held, collapseAfter]);

  // The finite-duration dismiss timer, moved here from `add()` (#8117) so it
  // can pause while `held` and resume with the time that was actually left,
  // instead of firing on a fixed wall-clock deadline a hovering mouse or a
  // focused button couldn't touch.
  //
  // `remainingRef` is the ms left on the countdown; it survives across
  // pause/resume because a ref, unlike state, doesn't trigger its own
  // re-render/effect cycle. `prevIdentityRef` detects a same-id swap that
  // needs a fresh countdown — content/type by reference (the same signal the
  // collapse-reset effect above uses, since they only change identity when
  // `add()` actually ran) PLUS `duration` itself: a swap that keeps identical
  // content/type but changes just the duration (e.g. an Infinity toast
  // re-added with a finite one) must still reset — otherwise `remainingRef`
  // keeps holding the stale duration, and if that was `Infinity`,
  // `setTimeout(fn, Infinity)` clamps to 0 and the toast would dismiss
  // almost immediately instead of honouring the new duration.
  const remainingRef = useRef(t.duration);
  const prevIdentityRef = useRef([t.content, t.type, t.duration]);

  useEffect(() => {
    const [prevContent, prevType, prevDuration] = prevIdentityRef.current;
    const isNewArm = prevContent !== t.content || prevType !== t.type || prevDuration !== t.duration;
    prevIdentityRef.current = [t.content, t.type, t.duration];

    if (t.duration === Infinity) return undefined;
    if (isNewArm) remainingRef.current = t.duration;
    if (held) return undefined;

    const start = Date.now();
    const timer = setTimeout(() => dismiss(t.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - start));
    };
  }, [t.id, t.duration, t.content, t.type, held]);

  // Re-entering `add()` with the same id replaces the entry in place (a
  // loading→success swap, a coalesced AI-status error picking up another
  // failure). That toast has something new to say, so unfold it — otherwise the
  // update lands inside a pill nobody opens. `content`/`type` only change
  // identity when `add()` actually ran, so this doesn't fire on re-renders.
  useEffect(() => { setCollapsed(false); }, [t.content, t.type]);

  // Collapsing HIDES the body, it does not unmount it: render-prop toasts own
  // their lifecycle (useAgentFeedbackToast's card runs its own auto-dismiss),
  // and unmounting would destroy those timers and strand the pill forever.
  // `display: none` inline beats the `flex` utility class, and takes the body
  // out of the a11y tree and out of hit-testing — which is the whole point.
  //
  // `collapsible` is re-read during render, not just in the effect, so a
  // loading→success swap on the same id (Infinity → 4000) unfolds in the same
  // commit. The reset effect below would get there a paint later, which shows
  // as a frame of pill over the new message.
  const isCollapsed = collapsed && collapsible;
  const bodyStyle = isCollapsed ? { ...style, display: 'none' } : style;

  // Expanding the pill unmounts the pill. If the keyboard had focus on it,
  // focus falls to <body> and the toast's own Reconcile/Reload/Ignore buttons
  // drop out of the tab sequence — the next Tab restarts from the top of the
  // document, past everything. So hand focus to the body it just revealed.
  //
  // Only for a KEYBOARD activation, detected by `detail === 0` — the click a
  // browser synthesizes from Enter/Space carries no click count, while a real
  // pointer click carries at least 1. `document.activeElement === the pill` is
  // NOT a usable substitute: Chrome focuses a button on mouse-down, so it reads
  // true for an ordinary click. Measured in headless Chrome against the running
  // page, that mis-detection moved focus into the body on a plain mouse click,
  // `onFocus` took the focus hold, and the toast never folded again — the exact
  // parked overlay this file exists to remove, handed back to the mouse users
  // who reported it. jsdom hides this: `fireEvent.click` doesn't focus the
  // button, so an activeElement-based guard passes the unit test and fails the
  // browser. The tests below therefore pass `detail` explicitly.
  const bodyRef = useRef(null);
  const refocusOnExpand = useRef(false);

  useEffect(() => {
    if (isCollapsed || !refocusOnExpand.current) return;
    refocusOnExpand.current = false;
    // Runs after commit, so the body is no longer `display: none` and can
    // actually take focus.
    bodyRef.current?.focus();
  }, [isCollapsed]);

  return (
    <>
      {isCollapsed && (
        // The pill deliberately carries no hover handlers: the timer effect
        // short-circuits on `collapsed` before it reads `held`, so they couldn't
        // change anything — and the pill unmounts on click, where no
        // `mouseleave` ever fires, which would strand `held` at true and
        // suppress the re-collapse below. Re-expanding doesn't pin the toast
        // open either; the timer just restarts, so a tap on a touch device
        // folds it away again on its own.
        <button
          type="button"
          data-toast-id={t.id}
          onClick={e => {
            refocusOnExpand.current = e.detail === 0;
            setCollapsed(false);
          }}
          aria-label={collapsedLabel(t)}
          className="pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-port-card border border-port-border shadow-lg text-sm"
        >
          <span className={iconClass} aria-hidden="true">{iconNode ?? '•'}</span>
        </button>
      )}
      <div
        ref={bodyRef}
        data-toast-id={t.id}
        style={bodyStyle}
        // Focusable only programmatically (see the refocus effect); -1 keeps
        // the body itself out of the tab sequence so it never sits between the
        // page's own controls.
        tabIndex={-1}
        role={t.type === 'error' ? 'alert' : 'status'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // onFocus/onBlur bubble in React, so these fire for the toast's buttons
        // too. Moving between two buttons inside the toast fires blur then
        // focus; both land in one batch, so the hold never blips false.
        onFocus={() => setFocusWithin(true)}
        onBlur={() => setFocusWithin(false)}
        className="pointer-events-auto flex items-start gap-2 shadow-lg text-sm max-w-[calc(100vw-2rem)] sm:max-w-[520px] bg-port-card border border-port-border">
        {iconNode && <span className={`shrink-0 ${iconClass} ${iconBoxClass}`} aria-hidden="true">{iconNode}</span>}
        <div className="flex-1 min-w-0">
          {typeof t.content === 'function' ? t.content({ id: t.id }) : <span>{t.content}</span>}
          {/* Render-prop toasts are the actionable ones — an Undo/Reconcile/
              Rate button that a screen-reader user hears announced but can't
              reach in the normal tab order (the Toaster mounts last in
              `main.jsx`). Naming the shortcut in the same live announcement
              tells them how to get there without needing sighted discovery of
              a global shortcuts list. */}
          {typeof t.content === 'function' && (
            <span className="sr-only"> Press Alt+Shift+N to reach its actions.</span>
          )}
        </div>
      </div>
    </>
  );
}

// Accessible name for the collapsed pill. String content names itself; a
// render-prop toast has to supply `label` or it collapses to an anonymous badge.
function collapsedLabel(t) {
  if (t.label) return `Show notification: ${t.label}`;
  if (typeof t.content === 'string') return `Show notification: ${t.content}`;
  return 'Show notification';
}
