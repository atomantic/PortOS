// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../components/Layout', () => ({ default: () => <div>Owner layout</div> }));
vi.mock('./Dashboard', () => ({ default: () => null }));
vi.mock('../hooks/useCatalogTypes.jsx', () => ({ CatalogTypesProvider: vi.fn(({ children }) => children) }));
vi.mock('../services/api', () => ({ getSettings: vi.fn(), updateSettings: vi.fn(), getSelfInstance: vi.fn(), PORTOS_APP_ID: 'example-app' }));
import App from '../App';
import * as api from '../services/api';
import { CatalogTypesProvider } from '../hooks/useCatalogTypes.jsx';

const ticket = 'a'.repeat(48);
const mount = () => render(<MemoryRouter initialEntries={['/eidoverse/guest']}><App /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', `/eidoverse/guest#${ticket}`);
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
it('loads only visitor metadata and the remote renderer, without private PortOS bootstrap', async () => {
  const request = vi.fn(async () => Response.json({
    host: { protocol: 'http', port: 5563 }, identity: { name: 'guest-example', world: 'example-world', avatar: 'example.vrm' },
  }));
  vi.stubGlobal('fetch', request);
  mount();
  const iframe = await screen.findByTitle('Guest Eidoverse world');
  const url = new URL(iframe.src);
  expect(url.hostname).toBe(window.location.hostname);
  expect(url.searchParams.get('guest')).toBe('1');
  expect(url.searchParams.get('name')).toBe('guest-example');
  expect(url.searchParams.get('world')).toBe('example-world');
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/eidoverse/travel/guest', expect.objectContaining({ headers: { 'X-Eidoverse-Guest': ticket } }));
  expect(api.getSettings).not.toHaveBeenCalled();
  expect(api.getSelfInstance).not.toHaveBeenCalled();
  expect(api.updateSettings).not.toHaveBeenCalled();
  expect(CatalogTypesProvider).not.toHaveBeenCalled();
  expect(screen.queryByText('Owner layout')).not.toBeInTheDocument();
});
it('keeps an expired invitation on the guest page instead of redirecting to owner login', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable or has expired');
  expect(window.location.hash).toBe(`#${ticket}`);
  expect(screen.queryByTitle('Guest Eidoverse world')).not.toBeInTheDocument();
});
