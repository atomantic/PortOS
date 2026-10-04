import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFullWidthRoute } from './lib/layoutRoutes.js';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { maskComments, stringLiterals } from './test/classNameScan.js';

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
});
