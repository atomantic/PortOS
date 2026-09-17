/**
 * Models route redirects — the bookmarks a tab move leaves behind.
 *
 * `previousPaths` in `server/lib/navManifest.js` DECLARES that a page used to
 * answer to another path, and `navManifest.test.js` proves App.jsx still
 * redirects it. What that scan cannot see is where the redirect LANDS once
 * React Router has ranked it against its neighbours: `models/llms/runtimes`
 * competes with `models/:tab/:recordId`, which would render the LLMs tab with
 * an unknown sub-view instead. Only a real render settles it.
 */

import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';

vi.mock('./components/Layout', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./hooks/useCatalogTypes.jsx', () => ({ CatalogTypesProvider: ({ children }) => children }));
vi.mock('./services/api', () => ({ getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })), updateSettings: vi.fn(), getSelfInstance: vi.fn(() => Promise.resolve({})), PORTOS_APP_ID: 'portos' }));
vi.mock('./pages/Models', () => ({ default: () => { const location = useLocation(); return <pre data-testid="models-location">{location.pathname}</pre>; } }));

import App from './App.jsx';

it('lands the retired Runtimes pill URL on the Runtimes tab, not on LLMs', async () => {
  render(<MemoryRouter initialEntries={['/models/llms/runtimes']}><App /></MemoryRouter>);
  expect(await screen.findByTestId('models-location')).toHaveTextContent('/models/llms-runtimes');
});

it('still serves the LLMs sub-views that stayed behind', async () => {
  render(<MemoryRouter initialEntries={['/models/llms/abuse']}><App /></MemoryRouter>);
  expect(await screen.findByTestId('models-location')).toHaveTextContent('/models/llms/abuse');
});

// The AI Providers page became three views (#7567): /ai is the Presets view,
// and the retired Backend Connections deep links land on the Services view
// with their record id carried across — a UUID or slug names the same row.
vi.mock('./pages/AIProviders', () => ({ default: () => { const location = useLocation(); return <pre data-testid="ai-location">{location.pathname}{location.search}</pre>; } }));

it.each([
  ['/ai', '/ai/presets'],
  ['/ai?fleetStep=client', '/ai/presets?fleetStep=client'],
  ['/ai/new', '/ai/presets/new'],
  ['/ai/connections', '/ai/services'],
  ['/ai/connections/abc-123', '/ai/services/abc-123'],
  ['/ai/harnesses/claude/connections', '/ai/harnesses/claude'],
  ['/ai/harnesses/claude/connections/abc-123', '/ai/services/abc-123'],
])('redirects the retired %s to %s', async (from, to) => {
  render(<MemoryRouter initialEntries={[from]}><App /></MemoryRouter>);
  expect(await screen.findByTestId('ai-location')).toHaveTextContent(to);
});

// A preset whose id collides with the create route keeps the legacy editor alias.
it('still serves /ai/edit/:providerId as a working route rather than a redirect', async () => {
  render(<MemoryRouter initialEntries={['/ai/edit/new']}><App /></MemoryRouter>);
  expect(await screen.findByTestId('ai-location')).toHaveTextContent('/ai/edit/new');
});
