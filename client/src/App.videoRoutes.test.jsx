import { it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';
vi.mock('./components/Layout', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./services/apiSystem.js', () => ({ getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })), updateSettings: vi.fn(), getSelfInstance: vi.fn(() => Promise.resolve({})) }));
vi.mock('./pages/MediaGen', () => ({ default: () => (
  <>
    <div data-testid="media-gen-shell" />
    <Outlet />
  </>
) }));
vi.mock('./pages/VideoGen', () => ({ default: () => { const location = useLocation(); return <pre data-testid="clip-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
vi.mock('./pages/MusicVideo', () => ({ default: () => { const location = useLocation(); return <pre data-testid="mv-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash })}</pre>; } }));
vi.mock('./pages/CreativeDirector', () => ({ default: () => { const location = useLocation(); return <pre data-testid="library-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
vi.mock('./pages/CreativeDirectorDetail', () => ({ default: () => { const location = useLocation(); return <pre data-testid="project-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
vi.mock('./pages/Media3D', () => ({ default: () => <p>Mesh library</p> }));
vi.mock('./pages/ThreejsModelDetail', () => ({ default: () => <p>Procedural model editor</p> }));
import App from './App.jsx';

it('opens a bookmarked Three.js model in the 3D workspace and switches to meshes', async () => {
  render(<MemoryRouter initialEntries={['/media/threejs/example-model']}><App /></MemoryRouter>);

  expect(await screen.findByText('Procedural model editor')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '3D', level: 1 })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Three.js', selected: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Meshes & Blender' }));
  expect(await screen.findByText('Mesh library')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Meshes & Blender', selected: true })).toBeInTheDocument();
});

it('keeps Generate Video inside the Media Gen tab shell', async () => {
  render(<MemoryRouter initialEntries={['/media/video']}><App /></MemoryRouter>);
  expect(await screen.findByTestId('media-gen-shell')).toBeInTheDocument();
  expect(screen.getByTestId('clip-location')).toBeInTheDocument();
});
it.each(['/video/generate', '/video-gen'])('preserves clip handoff state through %s', async path => {
  const state = { remix: { ingredientIds: ['example-ingredient'] } };
  render(<MemoryRouter initialEntries={[{ pathname: path, search: '?settings=1', hash: '#clip', state }]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('clip-location')).textContent)).toEqual({ pathname: '/media/video', search: '?settings=1', hash: '#clip', state });
});

it('redirects the retired Video library and preserves draft handoff state', async () => {
  const state = { remix: { ingredientIds: ['example-ingredient'] } };
  render(<MemoryRouter initialEntries={[{ pathname: '/video', search: '?new=video', hash: '#drafts', state }]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('library-location')).textContent)).toEqual({ pathname: '/creative-director', search: '?new=video', hash: '#drafts', state });
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

it.each([
  ['/media/music-video/example-mv/previz', '/music-video/example-mv/previz'],
  ['/media/music-video/example-mv/previz/scene/s1', '/music-video/example-mv/previz/scene/s1'],
])('redirects legacy music video link %s', async (from, to) => {
  render(<MemoryRouter initialEntries={[`${from}?x=1#h`]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('mv-location')).textContent)).toEqual({ pathname: to, search: '?x=1', hash: '#h' });
});
