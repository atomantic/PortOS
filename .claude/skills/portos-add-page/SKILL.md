---
name: portos-add-page
description: Register a new PortOS page or voice/palette action end to end — the NAV_COMMANDS entry shape in server/lib/navManifest.js, ⌘K palette wiring, voice ui_navigate aliases, and the fail-fast guards. Invoke when adding a route, a sidebar link, or a new voice-tool action.
---

# Adding a page (nav manifest, ⌘K, voice)

A new page is **three edits**:

1. **The page** — `client/src/pages/<Name>.jsx`, normally a `PageLayout` (a `PageHeader` over its own scrolling body).
2. **The route** — a lazy import plus `<Route>` in `client/src/App.jsx`, placed under the shell it renders in: `<Route element={<FullWidthMain />}>` for a page that owns its scroll (the default for a `PageLayout` page), or `<Route element={<PaddedMain />}>` for a plain document/form page (`/apps/create`). A param route that mounts the same page as its index goes in the same shell.
3. **The nav entry** — a `NAV_COMMANDS` row in `server/lib/navManifest.js` (shape below), plus a `NAV_PRESENTATION` icon for a sidebar row or in-page tab.

Moving or renaming a page needs no hand-written redirect: list the old path in the entry's `previousPaths` and App.jsx generates the redirect route.

PortOS has a single source of truth for navigation: `server/lib/navManifest.js` exports `NAV_COMMANDS` (every navigable page: `{ id, path, label, section, aliases, keywords }`) and `resolveNavCommand()` (the fuzzy resolver). It is consumed by:

- The **`⌘K` Command Palette** (`client/src/components/CmdKSearch.jsx`) via `GET /api/palette/manifest`.
- The **voice agent's `ui_navigate` tool** (`server/services/voice/tools/ui.js`) — so "take me to tasks" resolves through the same map the palette uses.

**When adding a new page, you MUST also add an entry to `NAV_COMMANDS`.** Adding only a `<Route>` in `App.jsx` will leave the page unreachable from `⌘K` and un-navigable by voice. Entry shape:

```js
{ id: 'nav.<section>.<slug>', path: '/foo/bar', label: 'Bar', section: 'Foo',
  aliases: ['foo-bar', 'bar'], keywords: ['synonyms', 'context'] }
```

- `id` — stable, dotted (`nav.brain.inbox`). Must be unique.
- `path` — exact route the client router matches; must start with `/`.
- `section` — matches the sidebar group label so the palette and sidebar stay visually aligned.
- `aliases` — short spoken/typed tokens the user is likely to say. The voice agent's fuzzy resolver tries each alias with tiered matching; more aliases = more forgiving voice navigation.
- `keywords` — extra terms used only by the palette's in-UI scorer (synonyms, feature names).
- `previousPaths` (optional) — every path the page answered to before, as route patterns (`/old/:id`, or `/old/*` for a whole retired subtree). Declaring it IS the redirect: App.jsx generates one redirect route per entry, carrying the trailing segments, query and hash (set `preservePreviousPathSuffix: false` when the old sub-paths mean nothing at the new page), and the sidebar migrates stored pins with the same match. `client/src/App.routes.test.jsx` renders every entry to prove where it lands; don't also hand-write a `<Route>` for it (`navManifest.test.js` fails). The other optional fields (`tabId`, `tabGroup`, `tabLabel`, `navGroup`, `parentPath`) are described in the header of `navManifest.js`.
- `feature` (optional) — gates the page on an optional instance feature (e.g. `post`, `datadog`, `jira`; the full list is `server/lib/instanceFeatureRegistry.js`). When the feature is off in **Settings > Features**, the entry disappears from `⌘K` and its sidebar row disappears too — the route itself keeps working, so a bookmark, a direct link, or voice `ui_navigate` still resolves. The manifest ships the tag and the CLIENT applies the gate (`useInstanceFeatures` + `client/src/lib/navFeatures.js`), which is what makes a toggle take effect without a reload. Whole sidebar sections gate through navManifest's `SECTION_FEATURE` map instead, so a new page in one of those sections inherits the gate with no tag. Sidebar rows are derived from `NAV_COMMANDS` (path, label, section and `feature` are inherited), so there is nothing to tag in `Layout.jsx`.
- **Sidebar row** — add the destination icon in `NAV_PRESENTATION` in `client/src/lib/navPresentation.js`. Its `NAV_PRESENTATION` projection omits tabs and child views owned by the configured hubs. `SidebarNav.jsx` renders the projection and `Layout.test.jsx` validates each projected path against `NAV_COMMANDS`. For a ⌘K/voice-only page, omit the destination icon.

Fail-fast guards at module load catch missing fields, non-slash paths, and duplicate ids — so a bad entry blocks server boot instead of silently breaking palette/voice.

**For NEW voice-tool-style actions that should appear in `⌘K`:** add the tool to its domain module under `server/services/voice/tools/` (they hold the action schemas; `server/services/voice/tools.js` assembles them into `TOOLS`), then whitelist its `id` in the `PALETTE_ACTIONS` array in `server/routes/palette.js` with a `section` + `label`. Do not duplicate the tool's description or parameters — the palette route hydrates them from `getToolSpecs()` at request time. DOM-driving tools (`ui_click`, `ui_fill`, etc.) stay off the palette whitelist because the palette has no live DOM context.

**Tests:** `server/lib/navManifest.test.js` asserts shape invariants + alias resolution; `server/routes/palette.test.js` asserts the manifest endpoint + action dispatch + whitelist enforcement. Any new entry is automatically covered by the shape-invariant tests.

## Also required for a new page

See `client/src/AGENTS.md` for the two client-side rules that go with this:

- **ID-based deep linking** — any selection lives in the URL via a route param, never in local `useState`.
- **Layout scroll mode** — the shell is where the `<Route>` sits (step 2 above): a normal title/nav page goes under `FullWidthMain`; only an intentional document/form route goes under `PaddedMain`. `client/src/test/guards/ui/pageShellConventions.test.js` fails when a `PageHeader` workspace lands in the padded shell. Full rule: "Pick the right Layout scroll mode" in `client/src/AGENTS.md`.

## Sub-nav on a phone

**A sub-nav that doesn't fit a phone collapses to icon links, never a `<select>`** (#7283 was reverted): pass `mobileCompact` to `TabPills` (icon-only below `sm`, `max-sm:sr-only` labels); `RouteTabsHeader` decides via `MOBILE_COMPACT_THRESHOLD`. **Reuse `TabPills`; never roll a new tab bar.** Each tab in a fixed section set needs a unique icon via `buildSectionNavTabs(getSectionNavTabs(s), NAV_PRESENTATION, s)` (throws on a missing one; `lib/navPresentation.test.js`). A `<select>` is only for unbounded data-driven lists sharing one glyph (FableLoomStory episodes); record pickers (`pages/StackerNews.jsx` account switcher) are not sub-navs. *Enforced:* `client/src/test/guards/ui/subNavConventions.test.js`.

## Navigation gating and background-work toggles

`NAV_COMMANDS` in `server/lib/navManifest.js` drives `⌘K` and voice `ui_navigate`: **a `<Route>` without an entry is unreachable from both** (procedure, feature gates, sidebar rows: [portos-add-page](SKILL.md)). Optional features gate navigation, never routes, and **a toggle that arms background work reconciles at toggle time** via one idempotent `reconcile…()` (`docs/INSTANCE_FEATURES.md`).
