# Unreleased Changes

## Added

- **Collapsed-sidebar section flyout.** Hovering or focusing any multi-child section icon (Brain, Calendar, Chief of Staff, Comms, Create, Dev Tools, Digital Twin, MeatSpace, POST, Settings, System, Wiki) while the sidebar is collapsed opens a fixed-position popover to its right listing the section's children — so siblings (e.g. **Writers Room** under **Create**, which defaults to Media Gen) stay reachable without expanding the whole sidebar. Clicking a child navigates and closes the flyout; a 180 ms grace period lets the user move from icon → popover without it snapping shut. Renders via `position: fixed` so it escapes the nav scroller's `overflow-x-hidden` clipping. ARIA: `role="menu"` + `aria-haspopup="menu"` + `aria-expanded` on the trigger; keyboard focus on the icon also opens the flyout.

## Changed

## Fixed

- **Writers Room loaded empty in dev (Vite on `:5554`) while production worked.** All five `mountedRef` guards in the Writers Room and Ask pages used `useRef(true)` plus a cleanup-only `useEffect(() => () => { mountedRef.current = false; }, [])` to skip post-`await` `setState` after unmount. In React 18 `<StrictMode>` (dev only), the mount → cleanup → mount cycle flipped the ref to `false` permanently and never reset it, so every async fetch resolved with the guard tripped and folders/works/exercises/analyses/draft saves never reached state. Fixed by setting `mountedRef.current = true` at the top of the same effect — production builds (port `:5553`/`:5555`) were unaffected because StrictMode does not double-mount in production. Touched: `client/src/pages/WritersRoom.jsx`, `client/src/components/writers-room/{ExercisePanel,AiPanel,WorkEditor}.jsx`, `client/src/pages/Ask.jsx`.

## Removed
