import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_COMMANDS, NAV_FEATURE_IDS, SECTION_FEATURE, getNavAliasMap, resolveNavCommand } from './navManifest.js';
import { INSTANCE_FEATURE_IDS } from './instanceFeatureRegistry.js';
import { PORTOS_APP_ID } from './appIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PAGE = path.join(REPO_ROOT, 'client/src/pages/Settings.jsx');

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
  { prefix: '/models', file: 'client/src/components/models/ModelsTabsHeader.jsx', kind: 'links', constName: 'TABS',
    nestedIdSources: [
      { parent: 'llms', file: 'client/src/components/settings/LocalLlmTab.jsx', constName: 'LLM_NAV_SUBROUTES' },
    ] },
  { prefix: '/media', file: 'client/src/pages/MediaGen.jsx', kind: 'ids', constName: 'TABS', allowBasePrefix: true },
  { prefix: '/music', file: 'client/src/pages/Music.jsx', kind: 'ids', constName: 'TABS', allowBasePrefix: true },
  { prefix: '/sharing', file: 'client/src/pages/Sharing.jsx', kind: 'links', constName: 'SECTIONS' },
  { prefix: '/system-resources', file: 'client/src/pages/SystemHealthPage.jsx', kind: 'ids', constName: 'RESOURCE_TABS', allowBasePrefix: true },
  // POST's morse tab has routed `:mode` sub-pages (/post/morse/copy|send) and the
  // memory tab has the Elements study sub-page (/post/memory/elements) plus its
  // own routed practice modes — none are top-level switch cases, so declare their
  // sources so the guard covers them in both directions (nav ↔ real sub-page).
  // Adding an entry flows automatically. `parent` may itself be a multi-segment
  // path, which is how the two-deep Elements modes are declared.
  { prefix: '/post', file: 'client/src/components/meatspace/tabs/PostTab.jsx', kind: 'switch', switchVar: 'tab',
    nestedIdSources: [
      { parent: 'morse', file: 'client/src/components/meatspace/post/MorseTrainer.jsx', constName: 'MODES' },
      { parent: 'memory', file: 'client/src/components/meatspace/tabs/PostTab.jsx', constName: 'MEMORY_SUBROUTES' },
      { parent: 'memory/elements', file: 'client/src/components/meatspace/post/ElementsSong.jsx', constName: 'PRACTICE_MODES' },
      { parent: 'wordplay', file: 'client/src/components/meatspace/post/WordplayTrainer.jsx', constName: 'GAME_MODES' },
      { parent: 'rhetoric', file: 'client/src/components/meatspace/post/RhetoricTrainer.jsx', constName: 'RHETORIC_MODES' },
      { parent: 'progress', file: 'client/src/components/meatspace/post/PostProgress.jsx', constName: 'PROGRESS_SUBROUTES' },
    ] },
];

// Pull the inner text of `export const <constName> = [ … ];` (requiring `export`
// also asserts the constant stays importable — a forgotten `export` fails loudly).
// The terminator is line-anchored, so a nested array literal — OPEN_WORLD_REGIONS'
// per-region `aliases: [...]`, the first such source here — closes with `],` mid-line
// and cannot end the block early. Only a `];` at column 0 terminates; a nested literal
// formatted that way would still truncate the guard, but no source does that today.
function extractConstArrayBlock(src, constName) {
  // Terminator is line-anchored (`^];`) so a NESTED array literal — e.g. the per-region
  // `aliases: [...]` in OPEN_WORLD_REGIONS, the first source here to carry one — can't end
  // the block early and silently truncate the guard to the entries above it.
  const block = src.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([\\s\\S]*?)^\\];`, 'm'));
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
function extractTabPaths(filePath, { kind, constName, switchVar, prefix, nestedIdSources, allowBasePrefix }) {
  const src = fs.readFileSync(filePath, 'utf8');
  const nested = (nestedIdSources || []).flatMap(({ parent, file, constName: c }) =>
    extractConstIds(path.join(REPO_ROOT, file), c).map((id) => `${prefix}/${parent}/${id}`));
  if (kind === 'switch') {
    return [...extractSwitchTabs(src, switchVar).map((id) => `${prefix}/${id}`), ...nested];
  }
  const block = extractConstArrayBlock(src, constName);
  if (kind === 'ids') {
    const ids = [...block.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => `${prefix}/${m[1]}`);
    return [...(allowBasePrefix ? [prefix, ...ids] : ids), ...nested];
  }
  // kind 'links': keep only entries that point at this page, dropping cross-links.
  return [
    ...[...block.matchAll(/(?:to|path):\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((p) => p === prefix || p.startsWith(`${prefix}/`)),
    ...nested,
  ];
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
      'Dev Tools', 'Goals', 'Health', 'Models', 'Settings', 'Identity', 'POST',
    ]);
    const bad = NAV_COMMANDS.filter((c) => !ALLOWED_SECTIONS.has(c.section));
    expect(bad.map((c) => `${c.id}:${c.section}`)).toEqual([]);
  });
});

describe('navManifest — persistent mind dashboard', () => {
  it.each(['mind-tools', 'persistent-mind-tools', 'tools-access'])(
    'opens the embedded tools panel for the %s alias',
    (alias) => {
      expect(resolveNavCommand(alias)?.path).toBe('/cos/mind?panel=tools');
    },
  );

  it('maps both former Mind Tools routes onto the embedded tools panel', () => {
    const tools = NAV_COMMANDS.find((command) => command.id === 'nav.cos.mind-tools');
    expect(tools?.previousPaths).toEqual(['/cos/tools', '/cos/mind/tools']);
  });
});

// Feature gating hides a page from the ⌘K palette and the sidebar. A typo in a
// `feature` tag would silently gate on a flag nothing can ever turn on, hiding
// the page on every install with no other symptom.
describe('nav contract — instance-feature gating', () => {
  it('every gated entry names a registered instance feature', () => {
    const unknown = NAV_FEATURE_IDS.filter((id) => !INSTANCE_FEATURE_IDS.includes(id));
    expect(unknown).toEqual([]);
  });

  // SECTION_FEATURE keys on the DISPLAY label, so renaming a section would
  // un-gate it silently — and every other assertion here would still pass,
  // because they filter on that same label and would simply match nothing.
  it('every SECTION_FEATURE key is a live section carrying that gate', () => {
    for (const [section, featureId] of SECTION_FEATURE) {
      const inSection = NAV_COMMANDS.filter((c) => c.section === section);
      expect(inSection.length, `no commands in section "${section}"`).toBeGreaterThan(0);
      expect(INSTANCE_FEATURE_IDS, `unregistered feature "${featureId}"`).toContain(featureId);
      expect(inSection.every((c) => c.feature === featureId)).toBe(true);
    }
  });

  it('gates the DataDog, JIRA, and GSD feature pages', () => {
    const byId = Object.fromEntries(NAV_COMMANDS.map((c) => [c.id, c.feature]));
    expect(byId['nav.devtools.datadog']).toBe('datadog');
    expect(byId['nav.devtools.jira']).toBe('jira');
    expect(byId['nav.devtools.jira-reports']).toBe('jira');
    expect(byId['nav.cos.gsd']).toBe('gsd');
  });

  it('gates the Eidoverse host page on its installed feature', () => {
    const command = NAV_COMMANDS.find((entry) => entry.id === 'nav.eidoverse');
    expect(command).toMatchObject({ path: '/eidoverse', feature: 'eidoverse' });
  });

  it('gates the complete Health section and MortalLoom settings', () => {
    const byId = Object.fromEntries(NAV_COMMANDS.map((c) => [c.id, c.feature]));
    expect([...SECTION_FEATURE]).toContainEqual(['Health', 'health']);
    expect(NAV_COMMANDS.filter((c) => c.section === 'Health').every((c) => c.feature === 'health')).toBe(true);
    expect(byId['nav.settings.mortalloom']).toBe('health');
  });

  it('leaves ungated pages untagged', () => {
    const gated = NAV_COMMANDS.filter((c) => c.feature).map((c) => c.id);
    expect(gated).toContain('nav.devtools.jira');
    expect(gated).not.toContain('nav.dashboard');
    expect(gated).not.toContain('nav.devtools.flows');
  });

  // Sidebar rows now derive path, label, section and feature directly from this
  // array. The former Layout source-scrape parity guards are intentionally gone:
  // there is no second structural declaration left for them to compare.
});

describe('resolveNavCommand — fuzzy matching', () => {
  it('resolves exact alias', () => {
    expect(resolveNavCommand('dashboard')?.path).toBe('/');
    expect(resolveNavCommand('tasks')?.path).toBe('/cos/tasks');
    expect(resolveNavCommand('goals')?.path).toBe('/goals/list');
  });

  it('resolves the Catalog settings phrase to the feature-local drawer', () => {
    expect(resolveNavCommand('catalog settings')?.path).toBe('/catalog?settings=1');
  });

  it('resolves every canonical System Resources section name', () => {
    expect(resolveNavCommand('system resources')?.path).toBe('/system-resources/overview');
    expect(resolveNavCommand('active queues')?.path).toBe('/system-resources/queues');
  });

  it('resolves the folded Model Resources aliases to Models → Status', () => {
    // The Dev Tools model-inventory page folded into /models/status (#4728),
    // which already answered "what is resident right now". Its aliases moved with
    // it rather than being dropped — a user who says "model resources" or
    // "downloaded models" must still land on the inventory, not nowhere.
    expect(resolveNavCommand('model resources')?.path).toBe('/models/status');
    expect(resolveNavCommand('downloaded models')?.path).toBe('/models/status');
  });

  it('resolves the moved model-management pages to their Models paths', () => {
    // Media models, LoRAs, LoRA training and embeddings moved out of Create and
    // Settings (#4728). Their command ids are unchanged (they are opaque and
    // persisted), so only these paths prove the move actually landed.
    expect(resolveNavCommand('media models')?.path).toBe('/models/media');
    expect(resolveNavCommand('loras')?.path).toBe('/models/loras');
    expect(resolveNavCommand('lora training')?.path).toBe('/models/training');
    expect(resolveNavCommand('embeddings')?.path).toBe('/models/embeddings');
    expect(resolveNavCommand('prompt guard')?.path).toBe('/models/llms/abuse');
    expect(resolveNavCommand('abuse-guard')?.path).toBe('/models/llms/abuse');
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
const MAIN_JSX = path.join(REPO_ROOT, 'client/src/main.jsx');
const SOCKET_JS = path.join(REPO_ROOT, 'client/src/services/socket.js');

// Concrete leaf routes that render a real page but are deliberately absent from
// the nav manifest — reached via an in-page button or as a create-mode sentinel,
// not from ⌘K / voice / the sidebar.
const NAV_COVERAGE_OPT_OUT = new Map([
  ['/*', 'catch-all 404 page — reached only by an unmatched URL, never a destination'],
  ['/ai/new', 'create-provider drawer, reached via the "Add Provider" button on /ai'],
  ['/apps/create', 'create-app form, reached via the "New App" button on /apps'],
  ['/creative-commission/new', 'create-commission drawer, reached via the "New Commission" button on /creative-commission'],
  ['/feature-agents/create', 'create-agent form, reached via the "New Agent" button'],
  ['/fableloom/join', 'scoped QR mobile join view, reached via scanned QR code with fragment credentials'],
  ['/login', 'auth gate — surfaced only when settings.secrets.auth is enabled, reached via 401 redirect'],
  ['/songbook/import', 'import-song form, reached via the "Import" button on /songbook'],
  ['/universes/new', 'create-mode sentinel for the Universe Builder editor'],
]);

// Element wrappers that forward to another route rather than render a page. A
// NEW redirect wrapper must be added here, or the scanner will treat it as a
// real page and (loudly, not silently) demand a nav entry for its route.
const REDIRECT_ELEMENT = /element=\{<\s*(Navigate|RedirectWithSearch|PrefixRedirect|CanonRedirect|UniverseRouteRedirect)\b/;

// Of those, the ones that REBASE a prefix and carry the trailing path (ids, tabs)
// onto the new one. The others forward to a fixed destination and discard
// whatever followed — correct for a static route, silently lossy for a param'd
// one, which is how a bookmark into a specific record turns into a landing on
// the index.
const SUFFIX_PRESERVING_ELEMENTS = new Set(['PrefixRedirect', 'UniverseRouteRedirect']);

// Flatten a stack of (possibly multi-segment, possibly "/") route path pieces
// into a single absolute path: ['/', 'media', 'image'] → '/media/image'.
function joinRoutePath(segments) {
  return `/${segments.flatMap((s) => s.split('/')).filter(Boolean).join('/')}`;
}

// Walk App.jsx line-by-line, tracking the stack of currently-open <Route>
// containers. Returns:
//  - required: absolute paths of every concrete, non-redirect, non-param leaf
//    route — the set that must each have a NAV_COMMANDS entry (or an opt-out)
//  - topLevel: absolute paths of concrete leaves directly under <Routes>, rather
//    than inside a layout/container route
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
  const topLevel = [];
  const redirects = []; // { from, to } for every forwarding leaf route
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
    // An index route resolves to its parent's path (e.g. the `/` index = Dashboard).
    const absolute = routePath === null
      ? joinRoutePath(stack)
      : joinRoutePath([...stack, routePath]);
    if (stack.length === 0) topLevel.push(absolute);

    // Redirects are recorded rather than dropped: a moved page's old path has to
    // keep landing somewhere, and that is only assertable if the scanner reports
    // where each forwarding route points. `to` is read off the same line — as a
    // plain string, or as a template literal whose only interpolation is the
    // PortOS app id (`/apps/${PORTOS_APP_ID}/submodules`). A `from`-only wrapper
    // (CanonRedirect) records nothing rather than a bogus target.
    const redirectElement = line.match(REDIRECT_ELEMENT);
    if (redirectElement) {
      const quoted = line.match(/\bto="([^"]*)"/);
      const templated = line.match(/\bto=\{`([^`]*)`\}/);
      const to = quoted?.[1] ?? templated?.[1]?.replace('${PORTOS_APP_ID}', PORTOS_APP_ID);
      if (to) redirects.push({ from: absolute, to, element: redirectElement[1] });
      continue;
    }

    if (absolute.split('/').some((s) => s.startsWith(':'))) continue; // param route
    required.push(absolute);
  }
  return { required: [...new Set(required)], topLevel: [...new Set(topLevel)], redirects, malformed, stackDepth: stack.length };
}

// Settings owns a small declarative redirect map for retired tabs, while App.jsx
// owns redirects that need their own route element. Keep both forms in the
// previous-path contract so a migration can use the existing Settings page
// without turning a route-only client edit into an application-root change.
function scanSettingsRedirects(settingsSrc) {
  const block = settingsSrc.match(/const REDIRECTS\s*=\s*\{([\s\S]*?)^\};/m);
  if (!block) throw new Error('No REDIRECTS object found in Settings.jsx');
  return [...block[1].matchAll(/^\s*['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]\s*,?$/gm)]
    .map((match) => ({ from: `/settings/${match[1]}`, to: match[2] }));
}

describe('nav coverage — every navigable App.jsx route has a manifest entry', () => {
  // Query string / hash on a manifest path (e.g. /media/image?settings=1) is a
  // deep-link variant of a real route; compare on the bare path.
  const navPaths = new Set(NAV_COMMANDS.map((c) => c.path.split(/[?#]/)[0]));
  const scan = scanRoutes(fs.readFileSync(APP_JSX, 'utf8'));
  const settingsRedirects = scanSettingsRedirects(fs.readFileSync(SETTINGS_PAGE, 'utf8'));
  const routePaths = new Set(scan.required);
  const byFrom = new Map([...scan.redirects, ...settingsRedirects].map((r) => [r.from, r]));

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

  it('keeps the hosted audience join route outside the chrome layout', () => {
    // The hosted audience shell owns a full dynamic viewport and must not be
    // nested under Layout's shorter overflow-hidden main (#5499).
    expect(scan.topLevel).toContain('/fableloom/join');
  });

  it('keeps hosted audience joins free of authenticated app bootstraps', () => {
    // A password-gated install must not redirect a QR audience device before
    // the fragment token reaches FableLoomHostedJoin (#5499).
    const appSrc = fs.readFileSync(APP_JSX, 'utf8');
    const mainSrc = fs.readFileSync(MAIN_JSX, 'utf8');
    const socketSrc = fs.readFileSync(SOCKET_JS, 'utf8');
    expect(appSrc).toMatch(/useTimezoneBootstrap\(!isHostedAudienceRoute\)/);
    expect(appSrc).toMatch(/useDocumentTitle\(!isHostedAudienceRoute\)/);
    expect(appSrc).toMatch(/isHostedAudienceRoute\s*\?\s*routeContent/);
    expect(mainSrc).toContain("const isHostedAudienceRoute = window.location.pathname.replace(/\\/+$/, '')");
    expect(socketSrc).toMatch(/autoConnect: !isHostedAudienceRoute/);
  });

  // Every page that has ever moved leaves its old path behind in bookmarks, in
  // stale ⌘K history, and in links other installs' peers may hold. A move that
  // forgets the redirect 404s all of them, and nothing else in this file would
  // notice — the coverage guard above only looks at where routes point NOW.
  //
  // Driven by each command's own `previousPaths`, NOT a list maintained here: the
  // declaration then lives beside the path that moved, and the next move is one
  // edit in navManifest.js instead of two files that can disagree.
  // Compare the full destination, including any query that opens a feature-local
  // drawer or selects a subview.
  it('keeps a redirect from every declared previous path to its current one', () => {
    const broken = NAV_COMMANDS
      .flatMap((c) => (c.previousPaths || []).map((from) => ({ from, to: c.path, id: c.id })))
      .filter(({ from, to }) => byFrom.get(from)?.to !== to)
      .map(({ from, to, id }) => `${id}: ${from} → ${byFrom.get(from)?.to ?? 'NO REDIRECT'} (want ${to})`);
    expect(broken).toEqual([]);
  });

  // Landing on the right PAGE is only half of it. A previous path with a `:param`
  // segment was a deep link into one record, so its redirect has to carry that
  // segment across — swapping the PrefixRedirect for a bare <Navigate to="/models/training">
  // still points at the right page and would pass the check above, while every
  // bookmarked dataset quietly lands on the index instead.
  it('preserves the record id when a parameterized previous path redirects', () => {
    const lossy = NAV_COMMANDS
      .flatMap((c) => (c.previousPaths || []).map((from) => ({ from, id: c.id })))
      .filter(({ from }) => from.split('/').some((seg) => seg.startsWith(':')))
      .map(({ from, id }) => ({ from, id, hit: byFrom.get(from) }))
      .filter(({ hit }) => !hit || !SUFFIX_PRESERVING_ELEMENTS.has(hit.element))
      .map(({ from, id, hit }) => `${id}: ${from} forwards via ${hit?.element ?? 'NO REDIRECT'}, which drops the trailing segment`);
    expect(lossy).toEqual([]);
  });

  // The guard above is only as good as what it is pointed at, and it reads a
  // field that is easy to simply not add. Pin the moves already made so deleting
  // a `previousPaths` entry fails here rather than silently shrinking coverage.
  it('still declares the previous paths of the pages already moved', () => {
    const declared = new Set(NAV_COMMANDS.flatMap((c) => c.previousPaths || []));
    const missing = [
      '/settings/local-llm',   // #4736 — Local LLM management left Settings
      '/media/models',         // #4728 — the rest of model management left Create/Settings/Dev Tools
      '/media/loras',
      '/media/training',
      '/settings/embeddings',
      '/system-resources/models',
      // The dataset workbench was its own deep-linkable path, and a bookmark into
      // one dataset breaks just as silently as the index.
      '/media/training/:datasetId',
      // The rest of the moves App.jsx already redirected but nothing declared.
      // A pinned sidebar row is a STORED route path, so an undeclared move made
      // the pin stop resolving and vanish on the next update — the client reads
      // these to map a stored path onto where its page lives now.
      '/openworld', '/city',              // retired OpenWorld routes
      '/devtools/submodules',
      '/devtools/runs',
      '/settings/contacts',
      '/settings/signal',
      '/settings/catalog',
      '/imessage',
      '/system-health',
      '/datadog',
      '/jira',
      '/image-gen',
      '/video-gen',
      '/media-history',
      '/annotate', '/annotate/:mediaKey',
      '/media/sprites', '/media/sprites/:id',
      '/media/3d', '/media/3d/:id',
      '/media/creative-director', '/media/creative-director/:id/:tab',
      '/media/music-video', '/media/music-video/:projectId',
      '/media/universe-builder', '/media/universe-builder/:universeId',
      '/universe-builder', '/universe-builder/:universeId',
    ].filter((p) => !declared.has(p));
    expect(missing).toEqual([]);
  });

  // A redirect that forwards to a path nothing serves is a 404 with extra steps.
  it('every redirect lands on a real route or nav destination', () => {
    const known = new Set([...routePaths, ...navPaths]);
    const dangling = scan.redirects
      // A RELATIVE target (`to="overview"`) resolves against its own route, so it
      // has no absolute path to look up — /feature-agents/:id → overview and the
      // two pipeline/story tab defaults are all this shape.
      .filter((r) => r.to.startsWith('/'))
      .map((r) => ({ ...r, bare: r.to.split(/[?#]/)[0] }))
      // A param route can't be enumerated by path, so accept any target whose
      // parent segment is served (e.g. /models/training covers the :datasetId
      // drill-down the PrefixRedirect rebases onto).
      .filter(({ bare }) => !known.has(bare)
        && !known.has(bare.split('/').slice(0, -1).join('/')))
      .map((r) => `${r.from} → ${r.to}`);
    expect(dangling).toEqual([]);
  });

  it('opt-out list has no stale entries', () => {
    // A stale opt-out is one whose route no longer exists, or that has since
    // gained a manifest entry (so it should just be removed from the allow-list).
    const stale = [...NAV_COVERAGE_OPT_OUT.keys()]
      .filter((p) => !routePaths.has(p) || navPaths.has(p));
    expect(stale).toEqual([]);
  });
});

// The POST Practice Library (`/post/explore`) is a page of hard-coded deep links
// into every POST test surface — the one place a user can browse what exists.
// A typo or a renamed mode there produces a card that opens a blank tab, and
// nothing else in the app would notice. Every link it ships must therefore be a
// path the nav manifest already registers, which is also what makes each of
// those surfaces reachable from ⌘K and voice.
describe('nav contract — POST Practice Library links are registered destinations', () => {
  const CATALOG_FILES = [
    // Owns DRILL_PRACTICE_LINKS — where most catalog cards get their href, so
    // scanning only the catalog would leave the DERIVED half unguarded.
    'client/src/components/meatspace/post/constants.js',
    'client/src/components/meatspace/post/practiceCatalog.js',
    'client/src/components/meatspace/post/PracticeLibrary.jsx',
    'client/src/components/meatspace/post/PostSessionLauncher.jsx',
    'client/src/components/meatspace/post/BrowseCatalogLink.jsx',
    // The sidebar's POST section — a link there that no command registers is
    // unreachable from ⌘K and voice.
    'client/src/components/Layout.jsx',
  ];
  const navPaths = new Set(NAV_COMMANDS.map((c) => c.path));

  for (const file of CATALOG_FILES) {
    it(`${file} links only at registered POST paths`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      // Both quote styles: JS object values use single quotes, JSX `to="…"` uses
      // double. Route PARAMS (`:id`) are excluded — those are dynamic detail
      // routes that deliberately carry no manifest entry.
      const links = [...src.matchAll(/['"](\/post\/[^'"${}]*)['"]/g)]
        .map((m) => m[1])
        .filter((p) => !p.includes(':'));
      expect(links.length).toBeGreaterThan(0);
      const unregistered = [...new Set(links)].filter((p) => !navPaths.has(p));
      expect(unregistered).toEqual([]);
    });
  }
});
