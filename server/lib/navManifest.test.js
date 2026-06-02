import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_COMMANDS, getNavAliasMap, resolveNavCommand } from './navManifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Maps URL prefix → file holding the page's TABS constant. Each page validates
// the :tab param against its own TABS list, so the nav manifest must agree.
const TABBED_PAGES = [
  { prefix: '/brain', constantsFile: 'client/src/components/brain/constants.js' },
  { prefix: '/cos', constantsFile: 'client/src/components/cos/constants.js' },
  { prefix: '/digital-twin', constantsFile: 'client/src/components/digital-twin/constants.js' },
  { prefix: '/meatspace', constantsFile: 'client/src/components/meatspace/constants.js' },
];

// Extract `id: '<value>'` from the first `export const TABS = [ ... ];` block.
function extractTabIds(constantsPath) {
  const src = fs.readFileSync(constantsPath, 'utf8');
  const block = src.match(/export const TABS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error(`No TABS array found in ${constantsPath}`);
  return [...block[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
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

describe('nav contract — tabbed pages match their TABS constants', () => {
  for (const { prefix, constantsFile } of TABBED_PAGES) {
    describe(prefix, () => {
      // Read inside it() bodies (not at describe time) so a moved/renamed
      // constants file surfaces as a focused test failure rather than
      // aborting the entire suite during Vitest's collection phase.
      const navEntries = NAV_COMMANDS.filter((c) => c.path.startsWith(`${prefix}/`));
      const navTabs = navEntries.map((c) => ({ tab: c.path.slice(prefix.length + 1), command: c }));

      it('every nav manifest tab resolves to a real TAB id', () => {
        const tabIdSet = new Set(extractTabIds(path.join(REPO_ROOT, constantsFile)));
        const orphans = navTabs
          .filter(({ tab }) => !tabIdSet.has(tab))
          .map(({ command, tab }) => `${command.id} (${command.path}) → unknown tab "${tab}"`);
        expect(orphans).toEqual([]);
      });

      it('every TAB id is reachable via the nav manifest', () => {
        const tabIds = extractTabIds(path.join(REPO_ROOT, constantsFile));
        const navTabSet = new Set(navTabs.map((t) => t.tab));
        const missing = tabIds.filter((id) => !navTabSet.has(id));
        expect(missing).toEqual([]);
      });
    });
  }
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
  ['/templates', 'legacy templates page, intentionally not surfaced in nav'],
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
