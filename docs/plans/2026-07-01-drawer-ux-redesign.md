# Slide-in config drawer redesign — tabbed / responsive / deep-linkable (#1966)

**Approved:** 2026-07-01 · **Epic:** #1966 · **Foundation:** #1967

## Context

PortOS's slide-in config drawers (Edit App, Media Generation Settings, CoS task
config, pipeline image-gen settings, sync detail) were poor UX: each dumped a
long, flat, single-column scroll into a narrow fixed-width panel with little
organization. On desktop they wasted horizontal space; on mobile they were an
endless scroll. The shared primitive `client/src/components/Drawer.jsx` was ~63
lines — a right-side `fixed inset-y-0 right-0` panel, `w-full` on mobile and a
single fixed `sm:w-[NNNpx]` bracket on desktop, with one flat `overflow-y-auto`
body and no internal grouping. Every large form became one long scroll, and
`SyncDetailDrawer` had even hand-rolled its own clone of the markup so it
inherited none of the primitive's behavior.

The goal: make large config surfaces **grouped/tabbed**, **responsive**, and able
to use **more of the screen** on wide displays, while degrading gracefully to a
full-screen sheet on mobile.

## Key finding — the tab machinery already existed

The redesign reused rather than invented:

- `client/src/components/ui/TabPills.jsx` — a mature, a11y-complete tab primitive
  with `underline`/`pills` variants, a `mobileDropdown` that collapses to a
  `<select>` under `sm`, and icons/counts/spinners.
- The URL-param-driven tabbed-settings pattern already used by `pages/Settings.jsx`
  — the same "URL is the source of truth for what's open" convention the rest of
  the app follows for routed views.

So #1966 reduced to enhancing the shared `Drawer` primitive with size variants +
an optional tabbed layout wired to `TabPills`, then migrating each large drawer
onto it.

## Decisions

1. **Size variants, mobile stays full-screen.** `Drawer` gained a `size` prop
   (`sm` 520px · `md` 640px · `lg` 720→880px · `xl` up to 1100px) that only
   affects the desktop bracket; mobile remains `w-full`. `lg`/`xl` intentionally
   use extra breakpoints so wide forms lay out in columns instead of a cramped
   single column inside a wide panel. `widthClass` stays as a back-compat escape
   hatch that overrides `size`. `bodyClassName` opts a tab into a multi-column
   grid on wide sizes.
2. **Optional tabbed layout, not mandatory.** Pass `tabs` + `activeTab` /
   `onTabChange` and the drawer renders a sticky `TabPills` bar under the header
   (collapsing to a `<select>` on mobile) and gives each tab its own scroll region
   that **resets on switch** (`key={currentTab}` remounts the panel) — so no
   single tab is ever page-length. Omit `tabs` and it stays the original
   flat-scroll drawer. Both controlled (`activeTab` + `onTabChange`) and
   uncontrolled tab state are supported, so a caller that doesn't care about
   deep-linking still gets working tab switching.
3. **Tabs vs. grouped sections.** Large surfaces (many logical groups) tab. A
   *medium* form that should stay fully visible above the fold uses the child's
   own labeled sections (`ImageGenSettingsForm`'s `grouped` prop) instead —
   because tabs hide inactive fields behind a click.
4. **Deep-linkable active tab.** New hook `client/src/hooks/useDrawerTab.js`
   returns `[activeTab, setActiveTab]` backed by a caller-named URL search param
   (`appTab`, `mediaTab`, …) so the open section is shareable, bookmarkable, and
   reload-safe. The caller owns the param name (a page may host more than one
   drawer) and passes the tab-id list so a stale/hand-edited deep link degrades to
   `defaultTab` instead of a blank panel. Tabs live in a search param — not a
   route `:tab` segment — because a drawer is an overlay on an already-routed page
   and can't own a path segment.
5. **Reuse `TabPills`, never roll a new tab bar.** A surface hosted in *both* a
   drawer and a page (like `ImageGenTab`, rendered by the ImageGen / VideoGen /
   StoryboardPanel drawers *and* the Settings page) renders its own internal
   `<TabPills variant="pills" mobileDropdown>` instead of the Drawer's built-in
   tabs, so the same grouping works in either host.
6. **State hoisting is a hard requirement of per-tab remount.** Because the body
   remounts per active tab, all mutable form state must live in the parent above
   the Drawer body — never in an uncontrolled input inside the form — or it
   silently resets on tab switch. Fields on a tab that may be unmounted at Save
   time must be validated explicitly, surfacing the offending tab via
   `setActiveTab()`.

## Foundation + per-surface migrations

- **#1967 (foundation, shipped)** — `Drawer` size variants + optional tabbed
  layout + `useDrawerTab`. Worked into `EditAppDrawer` and `ImageGenTab` as the
  reference call-sites; covered by `Drawer.test.jsx`.
- **#1968 (shipped)** — Edit App drawer → built-in tabs (General / Ports & TLS /
  Commands / Workflow / JIRA / DataDog), `size="lg"`, `useDrawerTab('appTab')`,
  `closeOnEsc/closeOnBackdrop={false}` to protect a long-lived form.
- **#1969 (shipped)** — Media Generation Settings (`ImageGenTab`) → internal
  `TabPills` pills sub-tabs (Backend / External / Local / Codex / Tokens / Expose
  / Test), `useDrawerTab('mediaTab')`; fixes the VideoGen / ImageGen /
  StoryboardPanel drawers and the Settings page in one change.
- **#1970 (shipped)** — Pipeline image-gen drawers (NounsStage, ComicScriptStage)
  → grouped sections via the shared `ImageGenSettingsForm` `grouped` prop at
  `size="md"` (medium form, no tabs).
- **#1971 (open)** — CoS task config drawer → tabs (Stage config / Global
  defaults / Per-app overrides).
- **#1972 (open)** — Reconcile the hand-rolled `SyncDetailDrawer` clone onto the
  shared `Drawer` primitive.
- **#1973 (this record)** — Document the convention in `CLAUDE.md` + this design
  record.

## Scoped out

- **Multi-open-instance id namespacing.** The tabbed body uses fixed element ids
  (`drawer-tabpanel-<tab>`, `tab-<tab>`). This is safe because a drawer is modal
  and single-open by contract — the backdrop + scroll-lock guarantee one drawer at
  a time, and a closed drawer renders nothing (`if (!open) return null`). Two
  drawers on one page use distinct URL params for their persisted tab state but
  never share the DOM open simultaneously, so the ids can't collide. Per-instance
  id namespacing was therefore deferred as unnecessary complexity; revisit only if
  a genuinely stacked/simultaneous multi-drawer surface is ever introduced.

## Verification

- `client/src/components/Drawer.test.jsx` covers the `size`/`widthClass` brackets
  and the tabbed layout.
- The convention is documented in `CLAUDE.md` (Config drawers bullet) and
  `useDrawerTab` carries its catalog row in `client/src/hooks/README.md` +
  barrel export in `client/src/hooks/index.js`.
