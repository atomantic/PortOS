import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { NAV_COMMANDS } from '../../../../../server/lib/navManifest.js';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { maskComments, stringLiterals } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const root = join(REPO_ROOT, 'client/src');

// App's lazy imports and Route declarations are the real page inventory. Resolve
// aliases (XPage, RapidReaderPage) rather than guessing a filename from the tag.
// A route's shell is the pathless FullWidthMain / PaddedMain layout route it sits
// under — the declaration itself, so there is no parallel table to cross-check.
function pageRoutes(app) {
  const modules = new Map([...app.matchAll(/const\s+(\w+)\s*=\s*lazyWithReload\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g)]
    .map((match) => [match[1], match[2]]));
  for (const match of app.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) modules.set(match[1], match[2]);
  const lines = app.slice(app.indexOf('<Route path="/" element={<Layout />}')).split('\n');
  const stack = [];
  const routes = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '</Route>') {
      stack.pop();
      if (!stack.length) break;
      continue;
    }
    if (!line.startsWith('<Route')) continue;
    const element = line.match(/element=\{<(\w+)\b/)?.[1];
    if (!stack.length) {
      stack.push({ path: '', shell: null, layout: true });
      continue;
    }
    const parent = stack.at(-1);
    const path = line.match(/\bpath="([^"]+)"/)?.[1];
    const shell = element === 'FullWidthMain' ? 'full' : element === 'PaddedMain' ? 'padded' : parent.shell;
    const full = path ? `${parent.path}/${path}` : parent.path;
    // Nested outlets (Media Gen's /media/image) render inside their parent page,
    // which owns the title bar, so only a shell's direct children are pages.
    if (path && parent.layout && modules.has(element)) routes.push({ path: full, component: element, module: modules.get(element), shell });
    if (!line.endsWith('/>')) stack.push({ path: full, shell, layout: !path });
  }
  return routes;
}

function ownsShell(raw) {
  const source = maskComments(raw);
  return /<PageHeader\b/.test(source) && stringLiterals(source).some(({ value }) =>
    /(?:^|\s)h-full(?:\s|$)/.test(value) ||
    (/(?:^|\s)flex-1(?:\s|$)/.test(value) && /(?:^|\s)overflow-(?:auto|y-auto)(?:\s|$)/.test(value)));
}

function matchRoute(routeList, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const route of routeList) {
    const routeParts = route.path.split('/').filter(Boolean);
    if (routeParts.length !== parts.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) score += 1;
      else if (routeParts[i] === parts[i]) score += 2;
      else { ok = false; break; }
    }
    if (ok && score > bestScore) {
      best = route;
      bestScore = score;
    }
  }
  if (best) return best;
  // Nested outlets (Media Gen's /media/image) are not in the page list; their
  // parent owns the title bar.
  let prefix = null;
  for (const route of routeList) {
    if (route.path.includes(':')) continue;
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      if (!prefix || route.path.length > prefix.path.length) prefix = route;
    }
  }
  return prefix;
}

// Create destinations without a tab group each render the shared title bar.
// Tab-grouped siblings (Media Gen image, Music artists, …) share their
// group's shell and are out of this check. A hand-rolled <h1> never substitutes for
// PageHeader (#10994); there is no exemption list.
export function createPagesMissingPageHeader(commands, routeList, readSource) {
  const failures = [];
  for (const command of commands) {
    if (command.section !== 'Create' || command.tabGroup) continue;
    const pathname = String(command.path || '').split('?')[0];
    if (!pathname) continue;
    const route = matchRoute(routeList, pathname);
    if (!route) {
      failures.push(`${command.path}: no route`);
      continue;
    }
    const source = maskComments(readSource(route));
    if (!/<PageHeader\b/.test(source)) failures.push(`${pathname}: ${route.component} has no PageHeader`);
  }
  return failures;
}

function violations(routes, sourceFor) {
  const failures = [];
  for (const route of routes) {
    if (route.shell !== 'full' && ownsShell(sourceFor(route))) failures.push(`${route.path}: ${route.component} owns its PageHeader shell`);
    // A param sibling mounting the same page must retain its index shell even
    // if the page's implementation delegates its header/body to a child.
    const index = routes.find((entry) => entry.component === route.component &&
      !entry.path.includes(':') && route.path.startsWith(`${entry.path}/:`));
    if (index && index.shell === 'full' && route.shell !== 'full') failures.push(`${route.path}: differs from ${index.path}`);
  }
  return failures;
}

const tracked = new Set(trackedSourceFiles(resolve(root, '..')).map((file) => resolve(root, '..', file)));
const routes = pageRoutes(readText(resolve(root, 'App.jsx')));
const sourceFor = ({ module }) => {
  const path = resolve(root, module);
  const file = [path, `${path}.jsx`, `${path}.js`].find(existsSync);
  if (!file || !tracked.has(file)) throw new Error(`Missing tracked route module: ${module}`);
  return readText(file);
};

describe('page shell conventions', () => {
  it('pairs routed PageHeader workspaces and their detail routes with the full-width shell', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((route) => !route.shell)).toEqual([]);
    expect(violations(routes, sourceFor)).toEqual([]);
  });

  it('rejects a probe workspace in the padded shell and a missed param sibling', () => {
    const probe = (indexShell, detailShell) => [
      { path: '/probe', component: 'Probe', shell: indexShell },
      { path: '/probe/:id', component: 'Probe', shell: detailShell },
    ];
    expect(violations(probe('padded', 'padded'), () => '<div className="flex h-full"><PageHeader /></div>')).toHaveLength(2);
    expect(violations(probe('full', 'padded'), () => '<Child />')).toEqual(['/probe/:id: differs from /probe']);
    expect(violations(probe('full', 'full'), () => '<div className="flex-1 overflow-auto"><PageHeader /></div>')).toEqual([]);
    expect(violations(probe('padded', 'padded'), () => '<div><PageHeader /></div>')).toEqual([]);
  });

  it('gives every Create page without a tab group a PageHeader', () => {
    expect(createPagesMissingPageHeader(NAV_COMMANDS, routes, sourceFor)).toEqual([]);
  });

  it('rejects a probe Create page with a bare h1', () => {
    const commands = [
      { path: '/probe-create', section: 'Create', label: 'Probe' },
      { path: '/probe-tab', section: 'Create', tabGroup: 'probe', label: 'Tab' },
    ];
    const probeRoutes = [
      { path: '/probe-create', component: 'ProbeCreate' },
      { path: '/probe-tab', component: 'ProbeTab' },
    ];
    const bare = () => '<main><h1>Probe</h1></main>';
    expect(createPagesMissingPageHeader(commands, probeRoutes, bare)).toEqual([
      '/probe-create: ProbeCreate has no PageHeader',
    ]);
    expect(createPagesMissingPageHeader(commands, probeRoutes, () => '<PageHeader title="Probe" />')).toEqual([]);
  });
});
