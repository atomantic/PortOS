// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../components/Layout', () => ({ default: () => <div>Owner layout</div> }));
vi.mock('./Dashboard', () => ({ default: () => null }));
import App from '../App';

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
  expect(url.pathname).toBe('/eidoverse-host/');
  expect(url.searchParams.get('guest')).toBe('1');
  expect(url.searchParams.get('name')).toBe('guest-example');
  expect(url.searchParams.get('world')).toBe('example-world');
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/eidoverse/travel/guest', expect.objectContaining({ headers: { 'X-Eidoverse-Guest': ticket } }));
  expect(screen.queryByText('Owner layout')).not.toBeInTheDocument();
  // header must stay a top-level banner landmark, a sibling of <main> (#18286)
  expect(screen.getByRole('banner')).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('main')).not.toContainElement(screen.getByRole('banner'));
  // Vernacular labeling (#7459, corrected by #7634): a guest visit shows two
  // distinct classes — the shared PortOS design every install renders the
  // same way, and the host's own private vernacular build — never a blanket
  // claim that everything observed is the host's private invention.
  expect(screen.getByText(/shared PortOS world design/)).toBeInTheDocument();
  expect(screen.getByText(/local vernacular/)).toBeInTheDocument();
});
it('keeps an expired invitation on the guest page instead of redirecting to owner login', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable or has expired');
  expect(window.location.hash).toBe(`#${ticket}`);
  expect(screen.queryByTitle('Guest Eidoverse world')).not.toBeInTheDocument();
});
