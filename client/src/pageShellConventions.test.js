import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFullWidthRoute } from './lib/layoutRoutes.js';
import { NAV_COMMANDS } from '../../server/lib/navManifest.js';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { maskComments, stringLiterals } from './test/classNameScan.js';

// Full-bleed editors that intentionally have no title bar. Empty until a
// Create destination's work surface is the chrome. A hand-rolled <h1> is
// not an allowlist reason (#10994).
const CREATE_PAGE_HEADER_ALLOWLIST = new Set();

const root = dirname(fileURLToPath(import.meta.url));

// App's lazy imports and Route declarations are the real page inventory. Resolve
// aliases (XPage, RapidReaderPage) rather than guessing a filename from the tag.
function pageRoutes(app) {
  const modules = new Map([...app.matchAll(/const\s+(\w+)\s*=\s*lazyWithReload\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g)]
    .map((match) => [match[1], match[2]]));
  for (const match of app.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) modules.set(match[1], match[2]);
  const shell = app.slice(app.indexOf('<Route path="/" element={<Layout />}'));
  return [...shell.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)\b/g)]
    .filter((match) => modules.has(match[2]))
    .map((match) => ({ path: `/${match[1]}`, component: match[2], module: modules.get(match[2]) }));
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
  // Nested outlets (Media Gen's /media/image) are declared as child paths, so
  // the flat route list only has the parent. The parent owns the title bar.
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
// group's shell and are out of this check.
export function createPagesMissingPageHeader(commands, routeList, readSource, allowlist = CREATE_PAGE_HEADER_ALLOWLIST) {
  const failures = [];
  for (const command of commands) {
    if (command.section !== 'Create' || command.tabGroup) continue;
    const pathname = String(command.path || '').split('?')[0];
    if (!pathname || allowlist.has(pathname)) continue;
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

function violations(routes, sourceFor, classify = isFullWidthRoute) {
  const failures = [];
  for (const route of routes) {
    if (!classify(route.path) && ownsShell(sourceFor(route))) failures.push(`${route.path}: ${route.component} owns its PageHeader shell`);
    // A param sibling mounting the same page must retain its index shell even
    // if the page's implementation delegates its header/body to a child.
    const index = routes.find((entry) => entry.component === route.component &&
      !entry.path.includes(':') && route.path.startsWith(`${entry.path}/:`));
    if (index && classify(index.path) && !classify(route.path)) failures.push(`${route.path}: differs from ${index.path}`);
  }
  return failures;
}

const tracked = new Set(trackedSourceFiles(resolve(root, '..')).map((file) => resolve(root, '..', file)));
const routes = pageRoutes(readFileSync(resolve(root, 'App.jsx'), 'utf8'));
const sourceFor = ({ module }) => {
  const path = resolve(root, module);
  const file = [path, `${path}.jsx`, `${path}.js`].find(existsSync);
  if (!file || !tracked.has(file)) throw new Error(`Missing tracked route module: ${module}`);
  return readFileSync(file, 'utf8');
};

describe('page shell conventions', () => {
  it('pairs routed PageHeader workspaces and their detail routes with the full-width shell', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(violations(routes, sourceFor)).toEqual([]);
  });

  it('rejects a probe workspace in the padded shell and a missed param sibling', () => {
    const probe = [{ path: '/probe', component: 'Probe' }, { path: '/probe/:id', component: 'Probe' }];
    expect(violations(probe, () => '<div className="flex h-full"><PageHeader /></div>', () => false)).toHaveLength(2);
    expect(violations(probe, () => '<Child />', (path) => path === '/probe')).toEqual(['/probe/:id: differs from /probe']);
    expect(violations(probe, () => '<div className="flex-1 overflow-auto"><PageHeader /></div>', () => true)).toEqual([]);
    expect(violations(probe, () => '<div><PageHeader /></div>', () => false)).toEqual([]);
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
    expect(createPagesMissingPageHeader(commands, probeRoutes, bare, new Set())).toEqual([
      '/probe-create: ProbeCreate has no PageHeader',
    ]);
    expect(createPagesMissingPageHeader(commands, probeRoutes, () => '<PageHeader title="Probe" />', new Set())).toEqual([]);
    expect(createPagesMissingPageHeader(commands, probeRoutes, bare, new Set(['/probe-create']))).toEqual([]);
  });
});
