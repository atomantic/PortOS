import { useCallback, useEffect } from 'react';
import { useBlocker } from 'react-router';

// Guards an editor's unsaved draft against BOTH exit doors (#3958):
//
//   1. In-app router navigation — a sidebar link, a ⌘K palette jump, a voice
//      `ui_navigate`, or the browser Back button. These never touch the page's
//      own controls, so a page-local handler can't see them; react-router's
//      `useBlocker` parks the navigation instead and hands back `proceed()` /
//      `reset()`.
//   2. Tab close / reload — `beforeunload`, which the browser owns.
//
// REQUIRES a data router (`createBrowserRouter` + `<RouterProvider>`, wired in
// `client/src/main.jsx`); `useBlocker` throws under a plain `<BrowserRouter>`.
// Tests rendering a page that uses this hook must mount it under
// `createMemoryRouter` + `<RouterProvider>`, not `<MemoryRouter>`.
//
// The caller renders its OWN confirm UI from `blocked` — an `InlineConfirmRow`,
// never `window.confirm` (see client/src/CLAUDE.md).
//
//   const { blocked, proceed, reset } = useUnsavedChangesGuard(isDirty);
//   {blocked && <InlineConfirmRow onConfirm={discardAndProceed} onCancel={reset} … />}
//
// Discarding is the CALLER's job — only it knows how to reset its draft — so a
// discard handler resets local state and then calls `proceed()`.
export default function useUnsavedChangesGuard(isDirty, { beforeUnload = true } = {}) {
  // Same-location navigations (a re-click on the link you're already on, a
  // search-param tweak on the current page) don't unmount the editor, so
  // there's nothing to guard — let them through rather than raising a confirm
  // the user can't explain.
  const shouldBlock = useCallback(({ currentLocation, nextLocation }) => (
    !!isDirty && currentLocation.pathname !== nextLocation.pathname
  ), [isDirty]);
  const blocker = useBlocker(shouldBlock);
  const blocked = blocker.state === 'blocked';

  // Once the draft settles while a navigation is parked — the user hit Save
  // with the confirm up, or typed the value back to what's stored — the
  // navigation they asked for RUNS. Dropping it would swallow the click: the
  // confirm hides and nothing ever navigates.
  useEffect(() => {
    if (!isDirty && blocker.state === 'blocked') blocker.proceed();
  }, [isDirty, blocker]);

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
  const proceed = useCallback(() => blocker.proceed?.(), [blocker]);
  const reset = useCallback(() => blocker.reset?.(), [blocker]);

  return { blocked, proceed, reset };
}
