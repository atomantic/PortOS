import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import RouteErrorFallback from './RouteErrorFallback';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../utils/staleChunkReload';

vi.mock('../utils/staleChunkReload', () => ({
  isStaleChunkError: vi.fn(),
  reloadOnceForStaleChunk: vi.fn(),
}));

const renderRouteError = async (error) => {
  const router = createMemoryRouter([
    {
      path: '/',
      errorElement: <RouteErrorFallback />,
      element: <Outlet />,
      children: [
        { index: true, element: <div>Loaded page</div> },
        {
          path: 'broken',
          loader: () => { throw error; },
          element: <div>Broken page</div>,
        },
      ],
    },
  ], { initialEntries: ['/broken'] });

  let view;
  await act(async () => {
    view = render(<RouterProvider router={router} />);
    await router.initialize();
  });
  return view;
};

describe('RouteErrorFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isStaleChunkError.mockReturnValue(false);
  });

  it('triggers stale-chunk recovery for a render-phase dynamic import failure', async () => {
    const error = new Error('Failed to fetch dynamically imported module');
    isStaleChunkError.mockReturnValue(true);
    reloadOnceForStaleChunk.mockReturnValue(true);

    await renderRouteError(error);

    expect(isStaleChunkError).toHaveBeenCalledWith(error, { duringRender: true });
    expect(reloadOnceForStaleChunk).toHaveBeenCalledOnce();
  });

  it('explains that the page failed and offers recovery actions', async () => {
    await renderRouteError(new Error('Importing a module script failed'));

    expect(screen.getByRole('heading', { name: 'PortOS could not load this page' })).toBeInTheDocument();
    expect(screen.getByText('Importing a module script failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to dashboard' })).toBeInTheDocument();
  });

  it('returns to the dashboard without reloading', async () => {
    const user = userEvent.setup();
    await renderRouteError(new Error('Server unavailable'));

    await user.click(screen.getByRole('button', { name: 'Go to dashboard' }));

    expect(screen.getByText('Loaded page')).toBeInTheDocument();
  });

  it('handles a route error response', async () => {
    await renderRouteError(new Response(null, { status: 503, statusText: 'Service Unavailable' }));

    expect(screen.getByText('Service Unavailable')).toBeInTheDocument();
  });

  it('reloads when retry is clicked', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const user = userEvent.setup();
    await renderRouteError(new Error('Server unavailable'));

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
