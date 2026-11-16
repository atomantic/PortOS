/**
 * `useUnsavedChangesGuard(isDirty, opts)` returns `{ blocked, proceed, reset }`, parking router
 * navigation behind a prompt while a form has unsaved edits.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useBlocker } from 'react-router';

// Guards an editor's unsaved draft against BOTH exit doors (#3958):
//   1. In-app router navigation (sidebar link, ⌘K jump, voice `ui_navigate`, Back), which a page-local handler can't see; react-router's `useBlocker` parks it and hands back `proceed()` / `reset()`.
//   2. Tab close / reload via `beforeunload`, which the browser owns.
//
// REQUIRES a data router (`createBrowserRouter` + `<RouterProvider>`, wired in `client/src/main.jsx`); `useBlocker` throws under `<BrowserRouter>`, so tests must mount under `createMemoryRouter` + `<RouterProvider>`.
// The caller renders its OWN confirm UI from `blocked` (an `InlineConfirmRow`, never `window.confirm`; see client/src/AGENTS.md) and discarding is its job: reset the draft, then call `proceed()`.
//   const { blocked, proceed, reset } = useUnsavedChangesGuard(isDirty);
//   {blocked && <InlineConfirmRow onConfirm={discardAndProceed} onCancel={reset} … />}
//
// `scopePath`: the path prefix this editor OWNS, for an editor whose in-page moves change the pathname (a splat route like `/pipeline/series/:id/manuscript/*` swaps the issue segment without remounting, so a
// plain pathname comparison would confirm on every issue tab click). Navigation under the prefix passes through; leaving it parks. A plain string, not a predicate, so an unmemoized inline function can't re-register the blocker every render.
export default function useUnsavedChangesGuard(isDirty, { beforeUnload = true, scopePath } = {}) {
  // Same-location navigations (re-clicking the current link, a search-param tweak) don't unmount the editor, so there's nothing to guard.
  const shouldBlock = useCallback(({ currentLocation, nextLocation }) => {
    if (!isDirty) return false;
    if (currentLocation.pathname === nextLocation.pathname) return false;
    // Segment-aware, not a bare `startsWith`: a sibling that merely shares the prefix (`/…/manuscript-export`) is a real exit, and letting it through would discard the draft silently.
    const inScope = !!scopePath && (
      nextLocation.pathname === scopePath || nextLocation.pathname.startsWith(`${scopePath}/`)
    );
    return !inScope;
  }, [isDirty, scopePath]);
  const blocker = useBlocker(shouldBlock);
  const blocked = blocker.state === 'blocked';
  // A caller's discard handler and the clean-draft effect can both run in one commit; the effect retains the old blocker object, so its state alone can't prevent a second proceed().
  const proceededRef = useRef(null);
  const proceed = useCallback(() => {
    if (blocker.state !== 'blocked' || proceededRef.current === blocker) return;
    proceededRef.current = blocker;
    blocker.proceed();
  }, [blocker]);

  // Once the draft settles while a navigation is parked (Save with the confirm up, or typed back to the stored value) the navigation RUNS; dropping it would swallow the click.
  useEffect(() => {
    if (!isDirty) proceed();
  }, [isDirty, proceed]);

  // Tab close / reload — the browser owns this prompt; preventDefault arms it.
  // `returnValue` is the legacy signal, still what some browsers actually read,
  // so set both or the tab can close without asking.
  useEffect(() => {
    if (!beforeUnload || !isDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [beforeUnload, isDirty]);

  // `proceed` / `reset` exist only while blocked — the optional call keeps a
  // stale confirm's button from throwing after the blocker went idle.
  const reset = useCallback(() => blocker.reset?.(), [blocker]);

  // Memoized: callers pass this object to `<UnsavedChangesConfirm guard>` and
  // name its members in dep arrays, so a fresh literal per render would be a
  // guaranteed miss on every editor's hot typing path.
  return useMemo(() => ({ blocked, proceed, reset }), [blocked, proceed, reset]);
}
