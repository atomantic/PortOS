---
name: portos-add-page
description: Register a new PortOS page or voice/palette action end to end — the NAV_COMMANDS entry shape in server/lib/navManifest.js, ⌘K palette wiring, voice ui_navigate aliases, and the fail-fast guards. Invoke when adding a route, a sidebar link, or a new voice-tool action.
---

# Adding a page (nav manifest, ⌘K, voice)

PortOS has a single source of truth for navigation: `server/lib/navManifest.js` exports `NAV_COMMANDS` (every navigable page: `{ id, path, label, section, aliases, keywords }`) and `resolveNavCommand()` (the fuzzy resolver). It is consumed by:

- The **`⌘K` Command Palette** (`client/src/components/CmdKSearch.jsx`) via `GET /api/palette/manifest`.
- The **voice agent's `ui_navigate` tool** (`server/services/voice/tools.js`) — so "take me to tasks" resolves through the same map the palette uses.

**When adding a new page, you MUST also add an entry to `NAV_COMMANDS`.** Adding only a `<Route>` in `App.jsx` and a sidebar link in `Layout.jsx` will leave the page unreachable from `⌘K` and un-navigable by voice. Entry shape:

```js
{ id: 'nav.<section>.<slug>', path: '/foo/bar', label: 'Bar', section: 'Foo',
  aliases: ['foo-bar', 'bar'], keywords: ['synonyms', 'context'] }
```

- `id` — stable, dotted (`nav.brain.inbox`). Must be unique.
- `path` — exact route the client router matches; must start with `/`.
- `section` — matches the sidebar group label so the palette and sidebar stay visually aligned.
- `aliases` — short spoken/typed tokens the user is likely to say. The voice agent's fuzzy resolver tries each alias with tiered matching; more aliases = more forgiving voice navigation.
- `keywords` — extra terms used only by the palette's in-UI scorer (synonyms, feature names).
- `feature` (optional) — gates the page on an optional instance feature (`post`, `datadog`, `jira`; see `server/lib/instanceFeatureRegistry.js`). When the feature is off in **Settings > Features**, the entry disappears from `⌘K` and its sidebar row disappears too — the route itself keeps working, so a bookmark, a direct link, or voice `ui_navigate` still resolves. The manifest ships the tag and the CLIENT applies the gate (`useInstanceFeatures` + `client/src/lib/navFeatures.js`), which is what makes a toggle take effect without a reload. Whole sidebar sections gate through navManifest's `SECTION_FEATURE` map instead, so a new page in one of those sections inherits the gate with no tag. **Tag the matching `Layout.jsx` row with the same `feature`** — the sidebar is a separate list, and `navManifest.test.js` fails when the two halves drift.

Fail-fast guards at module load catch missing fields, non-slash paths, and duplicate ids — so a bad entry blocks server boot instead of silently breaking palette/voice.

**For NEW voice-tool-style actions that should appear in `⌘K`:** add the tool to `server/services/voice/tools.js` (it's the single source of action schemas), then whitelist its `id` in the `PALETTE_ACTIONS` array in `server/routes/palette.js` with a `section` + `label`. Do not duplicate the tool's description or parameters — the palette route hydrates them from `getToolSpecs()` at request time. DOM-driving tools (`ui_click`, `ui_fill`, etc.) stay off the palette whitelist because the palette has no live DOM context.

**Tests:** `server/lib/navManifest.test.js` asserts shape invariants + alias resolution; `server/routes/palette.test.js` asserts the manifest endpoint + action dispatch + whitelist enforcement. Any new entry is automatically covered by the shape-invariant tests.

## Also required for a new page

See `client/src/AGENTS.md` for the two client-side rules that go with this:

- **ID-based deep linking** — any selection lives in the URL via a route param, never in local `useState`.
- **Layout scroll mode** — decide whether the route belongs in `Layout.jsx`'s `isFullWidth` list (page owns its own `overflow-y-auto`) or takes the default scrolling+padded `<main>`.
