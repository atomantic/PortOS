import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_COMMANDS, getNavAliasMap, resolveNavCommand } from './navManifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Maps URL prefix → how to extract the page's own tab set from its source. Each
// page validates the :tab/:section param against this list, so the nav manifest
// must agree. Three source shapes are supported:
//   kind 'ids'    — `export const <constName> = [{ id: '<slug>', … }]`, where each
//                   tab lives at `<prefix>/<slug>` (Brain/CoS/Calendar/Goals/…).
//   kind 'links'  — `export const <constName> = [{ to|path: '<abs path>', … }]`,
//                   where the page's own tabs are the entries whose path is exactly
//                   `<prefix>` or under `<prefix>/`; entries pointing elsewhere
//                   (e.g. Settings' "Prompts" → /prompts) are cross-links, not tabs.
//   kind 'switch' — the page has no tab array; its tabs are a `switch (<switchVar>)`
//                   render-dispatch plus the `{ <switchVar> = '<id>' }` destructuring
//                   default (POST). Reading the switch directly means the guard
//                   can't drift from a parallel constant; inner subtab branches
//                   (`if (subtab === 'x')`) aren't cases, so drill-downs are excluded.
const TABBED_PAGES = [
  { prefix: '/brain', file: 'client/src/components/brain/constants.js', kind: 'ids', constName: 'TABS' },
  { prefix: '/cos', file: 'client/src/components/cos/constants.js', kind: 'ids', constName: 'TABS' },
  { prefix: '/digital-twin', file: 'client/src/components/digital-twin/constants.js', kind: 'ids', constName: 'TABS' },
  { prefix: '/meatspace', file: 'client/src/components/meatspace/constants.js', kind: 'ids', constName: 'TABS' },
  { prefix: '/calendar', file: 'client/src/pages/Calendar.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/goals', file: 'client/src/pages/Goals.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/insights', file: 'client/src/pages/Insights.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/privacy', file: 'client/src/pages/Privacy.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/messages', file: 'client/src/pages/Messages.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/wiki', file: 'client/src/pages/Wiki.jsx', kind: 'ids', constName: 'TABS' },
  { prefix: '/settings', file: 'client/src/components/settings/SettingsTabsHeader.jsx', kind: 'links', constName: 'TABS' },
  { prefix: '/sharing', file: 'client/src/pages/Sharing.jsx', kind: 'links', constName: 'SECTIONS' },
  // POST's morse tab has routed `:mode` sub-pages (/post/morse/copy|send) and the
  // memory tab has the Elements study sub-page (/post/memory/elements) — none are
  // top-level switch cases, so declare their sources so the guard covers them in
  // both directions (nav ↔ real sub-page). Adding an entry flows automatically.
  { prefix: '/post', file: 'client/src/components/meatspace/tabs/PostTab.jsx', kind: 'switch', switchVar: 'tab',
    nestedIdSources: [
      { parent: 'morse', file: 'client/src/components/meatspace/post/MorseTrainer.jsx', constName: 'MODES' },
      { parent: 'memory', file: 'client/src/components/meatspace/tabs/PostTab.jsx', constName: 'MEMORY_SUBROUTES' },
    ] },
];

// Pull the inner text of `export const <constName> = [ … ];` (requiring `export`
// also asserts the constant stays importable — a forgotten `export` fails loudly).
// Assumes a FLAT array (entries are `{ id|to|path, label, icon }` objects, no
// nested array literals): the non-greedy `]` stops at the first `];`, so a tab
// object carrying a nested array would truncate the block and drop later tabs.
// True for every tab/section constant today; revisit if a nested literal lands.
function extractConstArrayBlock(src, constName) {
  const block = src.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!block) throw new Error(`No exported ${constName} array found`);
  return block[1];
}

// The `case '…':` labels of a `switch (<switchVar>) { … }` block. Assumes the
// file's `switch (<switchVar>)` is the only one (cases are read to EOF); a second
// switch would loudly fold its cases in rather than fail silently. The case regex
// is line-anchored (`^\s*case`, multiline) so a `case '…':` inside a comment
// (`// case 'x':`) or string can't be counted as a real renderer case.
function extractSwitchCases(src, switchVar) {
  const block = src.match(new RegExp(`switch\\s*\\(\\s*${switchVar}\\s*\\)\\s*\\{([\\s\\S]*)`));
  if (!block) throw new Error(`No switch (${switchVar}) found`);
  return [...block[1].matchAll(/^\s*case\s+['"]([^'"]+)['"]\s*:/gm)].map((m) => m[1]);
}

// The tab ids a `switch (<switchVar>)` render-dispatch serves, plus the
// destructuring default (`{ <switchVar> = '<id>' }`) — the tab with no explicit case.
function extractSwitchTabs(src, switchVar) {
  const def = src.match(new RegExp(`\\b${switchVar}\\s*=\\s*['"]([^'"]+)['"]`));
  if (!def) throw new Error(`No destructuring default for "${switchVar}" found`);
  return [def[1], ...extractSwitchCases(src, switchVar)];
}

// The `id:` values of an exported const array (`kind: 'ids'` shape), used to
// pull routed sub-page ids (e.g. morse's copy/send MODES) out of another file.
function extractConstIds(filePath, constName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const block = extractConstArrayBlock(src, constName);
  return [...block.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// The set of absolute tab paths a page serves under its own prefix.
function extractTabPaths(filePath, { kind, constName, switchVar, prefix, nestedIdSources }) {
  const src = fs.readFileSync(filePath, 'utf8');
  const nested = (nestedIdSources || []).flatMap(({ parent, file, constName: c }) =>
    extractConstIds(path.join(REPO_ROOT, file), c).map((id) => `${prefix}/${parent}/${id}`));
  if (kind === 'switch') {
    return [...extractSwitchTabs(src, switchVar).map((id) => `${prefix}/${id}`), ...nested];
  }
  const block = extractConstArrayBlock(src, constName);
  if (kind === 'ids') {
    return [...block.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => `${prefix}/${m[1]}`);
  }
  // kind 'links': keep only entries that point at this page, dropping cross-links.
  return [...block.matchAll(/(?:to|path):\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((p) => p === prefix || p.startsWith(`${prefix}/`));
}

describe('navManifest — shape invariants', () => {
  it('every command has id, path, label, section', () => {
    for (const cmd of NAV_COMMANDS) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.path).toMatch(/^\//);
      expect(cmd.label).toBeTruthy();
      expect(cmd.section).toBeTruthy();
    }
  });

  it('ids are unique', () => {
    const ids = NAV_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every section is one of the approved sidebar group labels', () => {
    const ALLOWED_SECTIONS = new Set([
      'Main', 'Apps', 'Brain', 'Calendar', 'Chief of Staff', 'Comms', 'Create',
      'Dev Tools', 'Goals', 'Health', 'Settings', 'Identity', 'POST',
    ]);
    const bad = NAV_COMMANDS.filter((c) => !ALLOWED_SECTIONS.has(c.section));
    expect(bad.map((c) => `${c.id}:${c.section}`)).toEqual([]);
  });
});

describe('resolveNavCommand — fuzzy matching', () => {
  it('resolves exact alias', () => {
    expect(resolveNavCommand('dashboard')?.path).toBe('/');
    expect(resolveNavCommand('tasks')?.path).toBe('/cos/tasks');
    expect(resolveNavCommand('goals')?.path).toBe('/goals/list');
  });

  it('resolves Universe Builder to the /universes index path', () => {
    // Promoted out of /media/universe-builder; renamed to /universes when the
    // list/table index landed (command id stays nav.create.universe-builder).
    // Nav alias must follow.
    const hit = resolveNavCommand('world builder');
    expect(hit?.path).toBe('/universes');
    expect(hit?.command?.id).toBe('nav.create.universe-builder');
  });

  it('resolves bare "health" to /cos/health (CoS owns the alias; meatspace keeps meatspace-health)', () => {
    // The CoS Health page is the canonical destination for "take me to health"
    // per the page's move into the Chief of Staff sidebar group. MeatSpace's
    // health tab is still reachable via the explicit `meatspace-health` alias.
    expect(resolveNavCommand('health')?.path).toBe('/cos/health');
    expect(resolveNavCommand('meatspace-health')?.path).toBe('/meatspace/health');
  });

  it('prefers the longest matching alias in endsWith/includes tiers', () => {
    // Multi-word voice phrasings like "take me to meatspace health" normalize
    // to "take-me-to-meatspace-health" and match BOTH `-health` and
    // `-meatspace-health` in the endsWith tier. The resolver picks the longest
    // candidate so the user reaches the more specific page.
    expect(resolveNavCommand('take me to meatspace health')?.path).toBe('/meatspace/health');
    expect(resolveNavCommand('meatspace health')?.path).toBe('/meatspace/health');
    // The bare "health" input still resolves to CoS Health (exact alias tier).
    expect(resolveNavCommand('take me to health')?.path).toBe('/cos/health');
  });

  it('resolves "pipeline" to the new Create Pipeline page (not CoS Workflow)', () => {
    // The `pipeline` alias used to belong to /cos/workflow; the new dedicated
    // Pipeline page owns it now. CoS Workflow keeps `pipeline` as a keyword.
    const hit = resolveNavCommand('pipeline');
    expect(hit?.path).toBe('/pipeline');
    expect(hit?.command?.id).toBe('nav.create.pipeline');
  });

  it('resolves multi-word voice phrasings that end on a known page', () => {
    // "take me to the tasks page" → normalized "take-me-to-the-tasks-page"
    // → the resolver's "key contained in norm" tier picks up "tasks" via the
    // trailing token fallback (tail = "page" doesn't match, then substring
    // "tasks" is present in the normalized input).
    expect(resolveNavCommand('chief of staff tasks')?.path).toBe('/cos/tasks');
    expect(resolveNavCommand('cos tasks')?.path).toBe('/cos/tasks');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(resolveNavCommand('BRAIN.')?.path).toBe('/brain/inbox');
    expect(resolveNavCommand('Review Hub!')?.path).toBe('/review');
  });

  it('returns null for unknown pages', () => {
    expect(resolveNavCommand('this-page-does-not-exist')).toBeNull();
    expect(resolveNavCommand('')).toBeNull();
    expect(resolveNavCommand(null)).toBeNull();
  });

  it('surfaces the matched alias for logging/telemetry', () => {
    const hit = resolveNavCommand('gsd');
    expect(hit?.matched).toBe('gsd');
    expect(hit?.path).toBe('/cos/gsd');
  });
});

describe('nav contract — tabbed pages match their tab constants', () => {
  for (const page of TABBED_PAGES) {
    const { prefix, file } = page;
    describe(prefix, () => {
      // The nav manifest paths owned by this page: exactly `<prefix>` (a default
      // section served at the bare prefix, e.g. /sharing → buckets) or anything
      // under `<prefix>/`. Compare on the bare path so deep-link query/hash
      // variants (e.g. /media/image?settings=1) normalize first.
      const navPaths = NAV_COMMANDS
        .map((c) => c.path.split(/[?#]/)[0])
        .filter((p) => p === prefix || p.startsWith(`${prefix}/`));

      // Read inside it() bodies (not at describe time) so a moved/renamed source
      // file surfaces as a focused test failure rather than aborting the entire
      // suite during Vitest's collection phase.
      it('every nav manifest path resolves to a real page tab', () => {
        const tabPaths = new Set(extractTabPaths(path.join(REPO_ROOT, file), page));
        const orphans = navPaths.filter((p) => !tabPaths.has(p));
        expect(orphans).toEqual([]);
      });

      it('every page tab is reachable via the nav manifest', () => {
        const tabPaths = extractTabPaths(path.join(REPO_ROOT, file), page);
        const navSet = new Set(navPaths);
        const missing = tabPaths.filter((p) => !navSet.has(p));
        expect(missing).toEqual([]);
      });
    });
  }
});

// Settings is the one tabbed page whose tab bar (SettingsTabsHeader.jsx `TABS`,
// the nav guard's source of truth for /settings) and render dispatch live in
// separate files: `Settings.jsx`'s `switch (activeTab)`. They're hand-kept in
// sync, so a tab added to the header (+ nav) but forgotten in the switch would
// silently render the default `general` view, and a `case` with no header entry
// is an orphan reachable only by URL. The nav↔header guard above can't see the
// switch; this pins header↔switch parity. Cross-links (Prompts → /prompts,
// Providers → /ai) point off /settings, so the `links` extractor already drops
// them — the two filtered sets are therefore expected to match exactly.
describe('nav contract — Settings tab bar header ↔ page switch parity', () => {
  const SETTINGS_HEADER = 'client/src/components/settings/SettingsTabsHeader.jsx';
  const SETTINGS_PAGE = 'client/src/pages/Settings.jsx';

  // Header tab ids that live under /settings/<id> (cross-links already filtered).
  // Require the trailing slash so a hypothetical bare `to: '/settings'` index entry
  // can't slice to '' and surface as a cryptic missing/orphan '' rather than a tab.
  const headerTabIds = () => extractTabPaths(path.join(REPO_ROOT, SETTINGS_HEADER), {
    kind: 'links', constName: 'TABS', prefix: '/settings',
  }).filter((p) => p.startsWith('/settings/')).map((p) => p.slice('/settings/'.length));

  const switchCaseIds = () => extractSwitchCases(
    fs.readFileSync(path.join(REPO_ROOT, SETTINGS_PAGE), 'utf8'), 'activeTab',
  );

  it('every Settings header tab has a renderTabContent switch case', () => {
    const cases = new Set(switchCaseIds());
    const missing = headerTabIds().filter((id) => !cases.has(id));
    expect(missing).toEqual([]);
  });

  it('every renderTabContent switch case has a Settings header tab', () => {
    const headerIds = new Set(headerTabIds());
    const orphans = switchCaseIds().filter((id) => !headerIds.has(id));
    expect(orphans).toEqual([]);
  });
});

describe('getNavAliasMap — voice-agent compatibility', () => {
  it('exposes every alias as a flat path map', () => {
    const map = getNavAliasMap();
    expect(map.dashboard).toBe('/');
    expect(map.tasks).toBe('/cos/tasks');
    expect(map.twin).toBe('/digital-twin/overview');
  });

  it('has no alias collisions (first-declared-wins guarantees deterministic resolution if any are introduced)', () => {
    const counts = {};
    for (const cmd of NAV_COMMANDS) {
      for (const a of (cmd.aliases || [])) counts[a] = (counts[a] || 0) + 1;
    }
    const collisions = Object.entries(counts).filter(([, n]) => n > 1);
    expect(collisions).toEqual([]);
  });
});

// ── Route ↔ nav-manifest coverage guard ────────────────────────────────────
// Parses the <Route path="…"> tree out of client/src/App.jsx and asserts every
// concrete, navigable leaf route resolves to a NAV_COMMANDS path. This catches
// the failure mode where a page is added to App.jsx (and maybe linked from
// inside another page) but never registered in the nav manifest, leaving it
// unreachable from ⌘K and voice (ui_navigate) — exactly how /local-llm/playground
// initially shipped. The shape-invariant guard above validates entry *shape*; it
// can't see a route that has no entry at all.
//
// Skipped (not destinations the manifest should cover):
//  - routes with a `:param` segment (detail/editor sub-routes; the :tab routes
//    are covered separately by the TABS contract above)
//  - redirect routes (<Navigate>, <RedirectWithSearch>, <CanonRedirect>,
//    <UniverseRouteRedirect>) — they forward to a real route, not a page
//  - container routes that only host children (their navigable destinations are
//    the child/index routes, e.g. /media's index redirects to /media/image)
//
// Routes intentionally kept out of nav go in NAV_COVERAGE_OPT_OUT with a reason;
// a second test fails if an opt-out entry goes stale (route deleted, or the path
// gained a manifest entry) so the allow-list can't quietly rot.
const APP_JSX = path.join(REPO_ROOT, 'client/src/App.jsx');

// Concrete leaf routes that render a real page but are deliberately absent from
// the nav manifest — reached via an in-page button or as a create-mode sentinel,
// not from ⌘K / voice / the sidebar.
const NAV_COVERAGE_OPT_OUT = new Map([
  ['/apps/create', 'create-app form, reached via the "New App" button on /apps'],
  ['/feature-agents/create', 'create-agent form, reached via the "New Agent" button'],
  ['/login', 'auth gate — surfaced only when settings.secrets.auth is enabled, reached via 401 redirect'],
  ['/universes/new', 'create-mode sentinel for the Universe Builder editor'],
]);

// Element wrappers that forward to another route rather than render a page. A
// NEW redirect wrapper must be added here, or the scanner will treat it as a
// real page and (loudly, not silently) demand a nav entry for its route.
const REDIRECT_ELEMENT = /element=\{<\s*(Navigate|RedirectWithSearch|CanonRedirect|UniverseRouteRedirect)\b/;

// Flatten a stack of (possibly multi-segment, possibly "/") route path pieces
// into a single absolute path: ['/', 'media', 'image'] → '/media/image'.
function joinRoutePath(segments) {
  return `/${segments.flatMap((s) => s.split('/')).filter(Boolean).join('/')}`;
}

// Walk App.jsx line-by-line, tracking the stack of currently-open <Route>
// containers. Returns:
//  - required: absolute paths of every concrete, non-redirect, non-param leaf
//    route — the set that must each have a NAV_COMMANDS entry (or an opt-out)
//  - malformed: <Route>-opening lines whose tag doesn't close on the same line
//  - stackDepth: open containers left unclosed at EOF
// The scanner assumes each <Route> is a single line (true in App.jsx today). A
// multi-line route would otherwise slip through silently — a multi-line *leaf*
// reads as a pathless index route (resolves to an already-covered parent, never
// flagged) and a multi-line *container* never gets pushed yet still pops on its
// </Route>, corrupting the stack. `malformed`/`stackDepth` make that assumption
// self-enforcing so it fails loudly instead. Returned (not thrown) so a bad
// App.jsx surfaces as a focused test failure rather than aborting collection.
function scanRoutes(appSrc) {
  const stack = []; // parent path segments of currently-open <Route> containers
  const required = [];
  const malformed = [];
  for (const rawLine of appSrc.split('\n')) {
    const line = rawLine.trim();
    if (line === '</Route>') { stack.pop(); continue; }
    if (!/^<Route\b/.test(line)) continue; // skips <Routes>, comments, JSX text

    // A single-line <Route> always closes its tag with `>` (container) or `/>`
    // (leaf). Anything else is a multi-line opener the scanner can't handle.
    if (!line.endsWith('>')) { malformed.push(line); continue; }

    // A `path=` attribute that didn't parse (e.g. single-quoted) must not be
    // silently mistaken for a pathless index route — flag it loudly instead.
    const pathMatch = line.match(/\bpath="([^"]*)"/);
    if (!pathMatch && /\bpath=/.test(line)) { malformed.push(line); continue; }
    const routePath = pathMatch ? pathMatch[1] : null; // null = index route

    // A container is a layout wrapper: push its segment so children resolve to
    // absolute paths, but don't require a manifest entry for the wrapper itself.
    if (!line.endsWith('/>')) {
      stack.push(routePath ?? '');
      continue;
    }
    if (REDIRECT_ELEMENT.test(line)) continue;

    // An index route resolves to its parent's path (e.g. the `/` index = Dashboard).
    const absolute = routePath === null
      ? joinRoutePath(stack)
      : joinRoutePath([...stack, routePath]);

    if (absolute.split('/').some((s) => s.startsWith(':'))) continue; // param route
    required.push(absolute);
  }
  return { required: [...new Set(required)], malformed, stackDepth: stack.length };
}

describe('nav coverage — every navigable App.jsx route has a manifest entry', () => {
  // Query string / hash on a manifest path (e.g. /media/image?settings=1) is a
  // deep-link variant of a real route; compare on the bare path.
  const navPaths = new Set(NAV_COMMANDS.map((c) => c.path.split(/[?#]/)[0]));
  const scan = scanRoutes(fs.readFileSync(APP_JSX, 'utf8'));
  const routePaths = new Set(scan.required);

  it('the line scanner saw every <Route> (single-line assumption holds)', () => {
    // A non-empty malformed list or unbalanced stack means a multi-line route
    // exists and would slip past the coverage check below — re-fold it to one
    // line, or upgrade the scanner before trusting the guard.
    expect(scan.malformed).toEqual([]);
    expect(scan.stackDepth).toBe(0);
  });

  it('each concrete leaf <Route> resolves to a NAV_COMMANDS path (or an opt-out)', () => {
    const uncovered = [...routePaths]
      .filter((p) => !navPaths.has(p) && !NAV_COVERAGE_OPT_OUT.has(p));
    expect(uncovered).toEqual([]);
  });

  it('opt-out list has no stale entries', () => {
    // A stale opt-out is one whose route no longer exists, or that has since
    // gained a manifest entry (so it should just be removed from the allow-list).
    const stale = [...NAV_COVERAGE_OPT_OUT.keys()]
      .filter((p) => !routePaths.has(p) || navPaths.has(p));
    expect(stale).toEqual([]);
  });
});
