# Sidebar IA Collapse + Pinned/Recent — Design

**Issue:** #713 — Collapse sidebar to 8–10 top-level domains + Pinned + Recent
**Slug:** `issue-713` (plan origin: `codex5-sidebar-collapse-ia`)
**Date:** 2026-06-04
**Status:** Approved

## Problem

The sidebar (`client/src/components/Layout.jsx`) carries **16 top-level entries** — 3 singles (Dashboard, Review Hub, City) plus 13 collapsible domains (Apps, Brain, Calendar, Chief of Staff, Comms, Create, Dev Tools, Digital Twin, MeatSpace, POST, Settings, System, Wiki). Each domain expands to 8–15 children, several of which are mis-filed (a child whose route belongs to another domain's tree). The rail is long, deep, and a flat dump of every page. The issue asks to collapse to ~8–10 top-level domains, push deep tabs into each page's own tab bar + Cmd+K, and add Pinned + Recent sections driven by the user's working set.

## Chosen approach

**Approach B — ~10 Primary domains + a collapsed "More" group.** Primary domains render normally; the long tail lives under one collapsed `More` section. Pinned + Recent sit at the very top of the rail. This honors "8–10 at top level" without amputating real features (a hard-10 fold would bury or drop Create, POST, Wiki, System, and most of Digital Twin).

**Hybrid nesting rule (governing principle):**
- A **folded page-domain** = **one sidebar link**; the destination page renders its own tab bar (Wiki, Comms pages). The sidebar never shows `Brain > Wiki > Log` — it shows `Brain > Wiki`, and Log/Graph/Browse are tabs inside the Wiki page. This is the issue's stated intent: "deep tabs pushed into each page's local tab bar and Cmd+K."
- **Dynamic working-set lists** keep the existing triple-depth `grandChildren` mechanism (Create > Universes > [universe name], Create > Pipeline > [series name], Apps list). Triple-depth is correct only when the third level is *user data*, not fixed page chrome.

## Final nav tree

### Top of rail (new)
- **★ Pinned** — user-pinned pages. Manual. localStorage. Hidden when empty.
- **🕑 Recent** — last 5 distinct visited pages, pure MRU. localStorage. Excludes pinned + current page. Hidden when empty.
- separator

### Primary domains
Alphabetical after the Dashboard/City top block, per the CLAUDE.md alphabetical-nav rule.

| Domain | Change |
|---|---|
| Dashboard, Review Hub, City | unchanged singles (top block) |
| **Apps** | unchanged (dynamic children) |
| **Brain** | absorbs **Comms** (Inbox, Drafts, Config, Sync, OpenClaw, Social Agents) + **Wiki** (single link → `/wiki/overview`; page owns its tabs) |
| **Calendar** | unchanged |
| **Chief of Staff** | gains **System Tasks** (`/cos/jobs`), moved out of the System group (it is a `/cos/*` route mis-filed under System) |
| **Create** | unchanged — stays primary (too large for More); keeps Universes/Pipeline triple-depth grandChildren |
| **Dev Tools** | absorbs **System** group content: Data, Instances, Loops, Processes, Security (`/security`), Capabilities, Uploads, Ambient |
| **Goals** | promoted to top level as a single domain entry (was under Digital Twin) → `/goals/list`; its own page tabs (List, Tree) stay in the page |
| **Health** | renamed from **MeatSpace** (paths under `/meatspace/*` unchanged) |
| **Settings** | unchanged |

### More (new, collapsed group at bottom)
- **Identity** — the Digital Twin remainder: Overview, Ask Yourself, Autobiography, Character, Documents, Enrich, Export, Identity, Import, Interview, Personas, Taste, Test, Time Capsule, Accounts. (Goals is promoted out of this group to a Primary domain. Ask Yourself (`/ask`) stays here as a child of Identity — it is still reachable directly via Cmd+K by its existing `ask` alias.)
- **POST**

### Mis-grouping sweep (full audit, per user request)
The audit distinguishes *deliberate short-route-in-correct-domain* (e.g. `/ask` under Digital Twin, `/insights` under Brain, `/prompts` + `/ai` under Settings, `/browser` + `/shell` under Dev Tools) — which are correct and stay — from genuine mis-filings where a child's route belongs to another domain's tree:
- `/cos/jobs` "System Tasks" — was under **System**, is a `/cos/*` route → **Chief of Staff**. ✅
- `/devtools/processes` "Processes" — a `/devtools/*` route under System; since System folds into Dev Tools, it lands in Dev Tools either way. No conflict.

No other genuine mis-filings found.

## Data model — Pinned + Recent

State lives in **localStorage** (per-browser). Recent is inherently per-device "what I did here," and Pinned matches the existing `portos-sidebar-collapsed` + dashboard-pick local pattern. No server/federation work. Upgradeable to synced settings later if desired.

### `client/src/utils/navWorkingSet.js` (pure, unit-tested)
- `RECENT_KEY = 'portos-nav-recent'`, `PINNED_KEY = 'portos-nav-pinned'`, `RECENT_CAP = 5`
- `recordVisit(path, list) -> string[]` — dedup, unshift, cap at `RECENT_CAP`; returns next MRU list. Ignores falsy/non-string paths.
- `togglePin(path, list) -> string[]` — add/remove path; returns next pinned list.
- `isPinned(path, list) -> boolean`
- Pure: take/return arrays. No DOM access — localStorage I/O lives in the hook so the logic is testable in node.

### `client/src/hooks/useNavWorkingSet.js`
- Reads/writes both keys (lazy-init from localStorage, write-through on change).
- Records a visit when `location.pathname` changes.
- Exposes `{ pinned, recent, pin, unpin, isPinned }` where `pinned`/`recent` are resolved to `{ path, label, icon }` via a path→nav-entry lookup (built from the same nav data the sidebar renders) so rows show the correct label + icon. Unknown paths are dropped from display.
- Registered in `client/src/hooks/index.js` barrel + `README.md` row (catalog maintenance rule).

## Component & manifest changes

### `client/src/components/Layout.jsx`
- Rewrite the `navItems` array to the new tree (folds, renames, More group).
- Render **Pinned** and **Recent** sections above `navItems` (each hidden when its list is empty), using `useNavWorkingSet`.
- Add a per-row **pin toggle** affordance (small pin icon, visible on hover/focus) on leaf nav rows in expanded mode; clicking toggles pin state without navigating.
- Add the **More** group as a normal collapsible section at the bottom.
- Unchanged: `grandChildren` rendering, collapsed-rail flyout, auto-expand-on-active, mobile drawer, `isFullWidth` scroll logic (keyed on raw pathnames, independent of grouping).

### `server/lib/navManifest.js`
- Update each entry's `section` to the new group label so the Cmd+K palette headers stay aligned with the sidebar (CLAUDE.md contract):
  - Comms entries (`nav.messages.*`, `nav.openclaw`, `nav.social-agents`) → `Brain`
  - Wiki entries (`nav.wiki.*`) → `Brain`
  - System entries (`nav.data`, `nav.instances`, `nav.loops`, `nav.devtools.processes`, `nav.security`, `nav.capabilities`, `nav.uploads`, `nav.ambient`) → `Dev Tools`
  - `nav.cos.jobs` → `Chief of Staff`
  - MeatSpace entries (`nav.meatspace.*`) → `Health`
  - Digital Twin remainder (`nav.twin.*`, `nav.character`, `nav.ask`) → `Identity`
  - `nav.goals`, `nav.goals.tree` → `Goals` (matching the promoted primary domain)
- **Paths and ids stay stable** — Cmd+K and voice `ui_navigate` keep resolving every page unchanged. Only the display `section` (and any label) changes.

### `client/src/App.jsx`
- No route changes. Purely grouping + presentation.

## Testing
- `client/src/utils/navWorkingSet.test.js` — MRU dedup, ordering, cap-at-5, pin toggle add/remove, isPinned, falsy-path guards.
- `server/lib/navManifest.test.js` — existing shape-invariant tests auto-cover re-sectioned entries. Add an assertion that every entry's `section` is drawn from the allowed set of primary/More group labels, so a future stray section fails fast at load.
- Manual verification: collapsed-rail flyout still lists folded children (Wiki under Brain, System pages under Dev Tools); Cmd+K still resolves moved pages by their old aliases; Pinned/Recent render correct labels + icons and hide when empty.

## Out of scope (not in this PR)
- Server-synced pins across federated machines (localStorage is the chosen first cut).
- Frecency ranking for Recent (pure MRU chosen; frecency is YAGNI for v1).
- Any change to page-internal tab bars — they already exist and own their tabs.
