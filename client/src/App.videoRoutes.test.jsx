import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';
vi.mock('./components/Layout', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/Dashboard', () => ({ default: () => null }));
vi.mock('./hooks/useCatalogTypes.jsx', () => ({ CatalogTypesProvider: ({ children }) => children }));
vi.mock('./services/api', () => ({ getSettings: vi.fn(() => Promise.resolve({ timezone: 'UTC' })), updateSettings: vi.fn(), getSelfInstance: vi.fn(() => Promise.resolve({})), PORTOS_APP_ID: 'portos' }));
vi.mock('./pages/MediaGen', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/VideoGen', () => ({ default: () => { const location = useLocation(); return <pre data-testid="clip-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</pre>; } }));
import App from './App.jsx';
it.each(['/media/video', '/video-gen'])('preserves clip handoff state through %s', async path => {
  const state = { remix: { ingredientIds: ['example-ingredient'] } };
  render(<MemoryRouter initialEntries={[{ pathname: path, search: '?settings=1', hash: '#clip', state }]}><App /></MemoryRouter>);
  expect(JSON.parse((await screen.findByTestId('clip-location')).textContent)).toEqual({ pathname: '/video/generate', search: '?settings=1', hash: '#clip', state });
});
