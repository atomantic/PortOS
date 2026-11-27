/**
 * The route tree is the single declaration of two things that used to live in
 * parallel tables: which `<main>` shell a page renders in (the pathless
 * FullWidthMain / PaddedMain layout routes) and where a moved page's old path
 * lands (generated from NAV_COMMANDS[].previousPaths). Only a real render
 * settles either, because React Router ranks every route against its
 * neighbours — a generated redirect competing with a `:tab/:recordId` route,
 * or a detail route landing outside its index's shell, is invisible to a scan.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';
import { NAV_COMMANDS } from '../../server/lib/navManifest.js';
import { previousPathRedirects, previousPathStaticDepth } from './lib/previousPaths.js';
import shellSnapshot from './test/pageShellSnapshot.json';

// Every page is lazy; stand each one in with a probe that names its module and
// reports the location it rendered at.
vi.mock('./utils/lazyWithReload', () => ({
  lazyWithReload: (loader) => {
    const page = String(loader).match(/pages\/(\w+)/)?.[1] ?? 'unknown';
    if (page === 'Media3DWorkspace') return Outlet;
    return function PageProbe() {
      const { pathname, search, hash } = useLocation();
      return <pre data-testid="page" data-page={page}>{`${pathname}${search}${hash}`}</pre>;
    };
  },
}));
vi.mock('./components/Layout', () => ({ default: () => <Outlet /> }));
vi.mock('./services/apiAppShell.js', () => ({ getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })), updateSettings: vi.fn(), getSelfInstance: vi.fn(() => Promise.resolve({})) }));

import App from './App.jsx';

const sample = (pattern, value) => pattern.split('/').map((segment) => (segment.startsWith(':') || segment === '*' ? value : segment)).join('/') || '/';

function renderAt(path) {
  cleanup();
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  return screen.getByTestId('page');
}

describe('page shells', () => {
  // Snapshot of the retired pathname classifier (`isFullWidthRoute`) for every
  // App.jsx page route, taken before it was deleted. A route added later is free
  // to pick its shell; one listed here moving is a layout regression.
  it.each(Object.entries(shellSnapshot))('%s renders in the %s shell', (pattern, shell) => {
    const page = renderAt(sample(pattern, 'sample'));
    expect(page.dataset.page).not.toBe('NotFound');
    expect(page.closest('main')?.dataset.shell).toBe(shell);
  });

  it('opens the browser call console in the full-width shell', () => {
    const page = renderAt('/voice/call');
    expect(page.dataset.page).toBe('VoiceCall');
    expect(page.closest('main')?.dataset.shell).toBe('full');
  });

  it('opens General from the Settings root', () => {
    const page = renderAt('/settings');
    expect(page.dataset.page).toBe('Settings');
    expect(page.textContent).toBe('/settings/general');
  });

  it.each(['/no-such-page/at/all', '/devtools/flows?flow=peer-sync'])('renders %s as NotFound in the padded shell', (path) => {
    const page = renderAt(path);
    expect(page.dataset.page).toBe('NotFound');
    expect(page.closest('main')?.dataset.shell).toBe('padded');
  });
});

describe('previous-path redirects', () => {
  const redirects = previousPathRedirects(NAV_COMMANDS);

  it.each([
    ['/cos/run-events?run=example#events', '/cos/runs/events?run=example#events', 'ChiefOfStaff'],
    ['/cos/workflow?hours=24', '/cos/schedule/timeline?hours=24', 'ChiefOfStaff'],
    ['/cos/digest', '/cos/briefing/digest', 'ChiefOfStaff'],
    ['/casting?scope=example', '/catalog/casting?scope=example', 'CreativeLibrary'],
    ['/environments', '/catalog/environments', 'CreativeLibrary'],
    ['/objects', '/catalog/objects', 'CreativeLibrary'],
    ['/imessage/chat%3Bexample?keep=1#msg', '/messages/imessage/chat%3Bexample?keep=1#msg', 'Messages'],
    ['/devtools/agents', '/devtools/processes/agents', 'ProcessesPage'],
    ['/media/threejs', '/3d/threejs', 'ThreejsModels'],
    ['/media/threejs/example-model?image=example.png#preview', '/3d/threejs/example-model?image=example.png#preview', 'ThreejsModelDetail'],
    ['/media/3d/example-model', '/3d/example-model', 'Media3DDetail'],
    ['/create/media', '/media', 'MediaGen'],
    ['/create/story', '/writers-room', 'WritersRoom'],
  ])('keeps %s on its original feature', (from, to, pageName) => {
    const page = renderAt(from);
    expect(page.dataset.page).toBe(pageName);
    expect(page.textContent).toBe(to);
  });

  it('declares each previous path once, and never as a live destination', () => {
    const froms = redirects.map((r) => r.from);
    expect(new Set(froms).size).toBe(froms.length);
    const live = new Set(NAV_COMMANDS.map((c) => c.path.split('?')[0]));
    expect(froms.filter((from) => live.has(from))).toEqual([]);
  });

  // The record id, query and hash of a bookmark all survive the move unless the
  // command opts out (`preservePreviousPathSuffix: false`, a retired feature).
  it.each(redirects.map((r) => [r.from, r.to, r]))('%s lands on %s', (from, to, redirect) => {
    const page = renderAt(`${sample(from, 'rec-1')}?keep=1#frag`);
    expect(page.dataset.page).not.toBe('NotFound');
    const landed = new URL(page.textContent, 'http://portos.invalid');
    const target = new URL(to, 'http://portos.invalid');
    const dynamic = from.split('/').filter(Boolean).length > previousPathStaticDepth(from);
    const suffix = redirect.preserveSuffix && dynamic
      ? `/${sample(from, 'rec-1').split('/').filter(Boolean).slice(previousPathStaticDepth(from)).join('/')}`
      : '';
    // A destination may chain one more default-tab hop (`/creative-director/:id` → `/overview`).
    const expected = `${target.pathname}${suffix}`;
    const onTarget = landed.pathname === expected || landed.pathname.startsWith(`${expected}/`);
    expect(onTarget, `${landed.pathname} is not ${expected}`).toBe(true);
    for (const [key, value] of target.searchParams) expect(landed.searchParams.get(key)).toBe(value);
    expect(landed.searchParams.get('keep')).toBe('1');
    expect(landed.hash).toBe('#frag');
  });
});
