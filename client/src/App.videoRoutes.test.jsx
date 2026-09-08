import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';
vi.mock('./components/Layout', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./hooks/useCatalogTypes.jsx', () => ({ CatalogTypesProvider: ({ children }) => children }));
vi.mock('./services/api', () => ({ getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })), updateSettings: vi.fn(), getSelfInstance: vi.fn(() => Promise.resolve({})), PORTOS_APP_ID: 'portos' }));
vi.mock('./pages/MediaGen', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/VideoGen', () => ({ default: () => { const location = useLocation(); return <pre data-testid="clip-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
vi.mock('./pages/CreativeDirectorDetail', () => ({ default: () => { const location = useLocation(); return <pre data-testid="project-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
import App from './App.jsx';
it.each(['/media/video', '/video-gen'])('preserves clip handoff state through %s', async path => {
  const state = { remix: { ingredientIds: ['example-ingredient'] } };
  render(<MemoryRouter initialEntries={[{ pathname: path, search: '?settings=1', hash: '#clip', state }]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('clip-location')).textContent)).toEqual({ pathname: '/video/generate', search: '?settings=1', hash: '#clip', state });
});

it('normalizes a bare Video project URL while preserving its identity and handoff', async () => {
  const state = { selected: 'example' };
  render(<MemoryRouter initialEntries={[{ pathname: '/video/example-project', search: '?x=1', hash: '#shot', state }]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('project-location')).textContent)).toEqual({ pathname: '/creative-director/example-project/overview', search: '?x=1', hash: '#shot', state });
});


it('redirects a Video shot deep link to the same Creative Director shot', async () => {
  render(<MemoryRouter initialEntries={['/video/example-project/artifacts/example-shot?revision=2#script']}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('project-location')).textContent)).toMatchObject({ pathname: '/creative-director/example-project/artifacts/example-shot', search: '?revision=2', hash: '#script' });
});
