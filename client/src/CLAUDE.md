# Client conventions (`client/src/`)

These apply to React/Vite client code. Universal constraints (functional programming, no try/catch, single-line logging, Zod validation, the Security Model, and the Sensitive Data & Privacy rules) live in the root `CLAUDE.md` and always apply.

## UI conventions

- **No window.alert/confirm** - use inline confirmations or toast notifications
- **Form labels need `htmlFor`/`id` pairing** - when adding a settings/config form field, wire `<label htmlFor="...">` to an `id="..."` on the input — screen readers and click-to-focus both depend on the association. The visual `block`/`mb-1` styling alone doesn't establish it.
- **Mobile responsive** - all pages should be mobile responsive friendly
- **Above the fold** - keep actionable content and info above the fold and design pages for maximum information and access without scrolling
- **No hardcoded localhost** - use `window.location.hostname` for URLs; app accessed via Tailscale remotely
- **Alphabetical navigation** - sidebar nav items in `Layout.jsx` are alphabetically ordered after the Dashboard+CyberCity top section and separator; children within collapsible sections are also alphabetical
- **Reactive UI updates** - after mutations (delete, create, update), update local state directly instead of refetching the entire list from the server. Use `setState(prev => prev.filter(...))` or similar patterns for immediate feedback

## Routing and deep linking

- **Linkable routes for all views** - tabbed pages use URL params, not local state (e.g., `/devtools/history` not `/devtools` with tab state)
- **ID-based deep linking for every selectable UI element** - any view that opens/selects a specific record (a project, item, scene, detail, editor, or master-detail selection) MUST encode that selection in the URL via a route param (`/music-video/:projectId`, `/media/timeline/:projectId`, `/media/creative-director/:id/:tab`) — never in local `useState`/`selectedId`. The URL is the single source of truth for "what is open," so every element is directly shareable, bookmarkable, and reachable from ⌘K, voice nav, and media job-completion hooks. Selection handlers `navigate()` to the id'd route; deletes/clears `navigate()` back to the index; render a "not found" fallback for stale/deleted ids. Add both the bare index route and the `:id` detail route in `App.jsx`, and keep the base path registered in `NAV_COMMANDS`.
- **New page → pick the right Layout scroll mode.** `Layout.jsx` has an `isFullWidth` route list: matched routes get a bare `relative overflow-hidden` `<main>` (the PAGE must own an internal `overflow-y-auto`, like the editor's `<section>`); unmatched routes get the default `overflow-auto p-4 md:p-6` scrolling+padded main. A list/index page (e.g. `/universes`, `/pipeline`) should usually be a plain `<div>` and stay OUT of `isFullWidth` so the main scrolls it; only full-bleed editors that manage their own scroll belong in the list. Match `/route/` (trailing slash) to scope full-width to detail/editor sub-routes without catching the bare index. A full-width page with no internal scroll container silently clips below the fold.

For the full "adding a new page" checklist (nav manifest entry shape, palette actions, voice aliases), invoke the `portos-add-page` skill.

## Config drawers

- **Config drawers → the shared tabbed `Drawer` convention.** Slide-in "settings over a feature page" surfaces use the shared `client/src/components/Drawer.jsx` primitive — never a hand-rolled `fixed inset-y-0 right-0` clone. Follow this convention instead of dumping another page-length flat scroll into a narrow panel (the epic #1966 redesign):
  - **Size.** Pass `size` (`sm` 520px · `md` 640px · `lg` 720→880px · `xl` up to 1100px). Widen for genuinely large forms so they can lay out in columns on desktop; keep small dialogs at `sm`. Mobile is always `w-full` (full-screen sheet) regardless of `size` — mobile-responsive is non-negotiable. `widthClass` is a back-compat escape hatch that overrides `size`.
  - **When to tab.** A large config surface (many fields / logical groups, e.g. Edit App's ~25 fields) should group its fields into `tabs={[{ id, label, icon?, count? }]}` + `activeTab` / `onTabChange` and render only the active tab's fields as `children` — not one page-length scroll. A *medium* form that should stay fully visible above the fold uses the child's own labeled sections instead (e.g. `ImageGenSettingsForm`'s `grouped` prop in the pipeline image-gen drawers), because tabs hide inactive fields behind a click.
  - **Per-tab scroll.** The drawer gives each tab its own scroll region that resets on switch (`key={currentTab}` remounts the panel) — so no single tab is ever page-length. Because the body remounts per tab, **all mutable form state must live above the Drawer body** in the parent component, never in an uncontrolled input inside the form, or it resets on tab switch (see `EditAppDrawer.jsx`'s state-hoisting comment). Validate fields on tabs that may be unmounted at Save time explicitly, and `setActiveTab()` to the offending tab to surface the error.
  - **Mobile `<select>` fallback + `TabPills`.** The tab bar is `client/src/components/ui/TabPills.jsx` (`mobileDropdown` collapses it to a `<select>` under `sm`) — **reuse it, never roll a new tab bar.** The `Drawer tabs` layout wires TabPills for you; a surface hosted in *both* a drawer and a page (like `ImageGenTab`) renders its own internal `<TabPills variant="pills" mobileDropdown>` instead so the same grouping works in either host.
  - **Deep-linkable active tab.** Drive `activeTab` from a URL search param via `useDrawerTab(paramName, defaultTab, tabIds)` (`client/src/hooks/useDrawerTab.js`) so the open section is shareable/bookmarkable/reload-safe — the same "URL is the source of truth for what's open" rule as routed views. The caller owns the param name (`appTab`, `mediaTab`, …) so a page can host more than one drawer; pass the id list so a stale deep link degrades to `defaultTab` instead of a blank panel.
  - **Long-lived forms** opt out of accidental dismissal with `closeOnEsc={false}` / `closeOnBackdrop={false}` so an Esc keystroke mid-edit doesn't discard the form.
  - **Worked examples:** `client/src/components/apps/EditAppDrawer.jsx` (built-in `tabs` layout, `size="lg"`, `useDrawerTab('appTab', …)`) and `client/src/components/settings/ImageGenTab.jsx` (internal `TabPills variant="pills"` sub-tabs, `useDrawerTab('mediaTab', …)`). The primitive is `Drawer.jsx`; the design record is `docs/plans/2026-07-01-drawer-ux-redesign.md`.

## Socket-driven UI

Socket lifecycle conventions (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards) are in the `portos-socket-ui` skill — invoke it before wiring a new socket-driven view.
