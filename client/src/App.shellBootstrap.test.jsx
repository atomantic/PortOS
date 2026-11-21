import { StrictMode, memo } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import App from './App.jsx';
import { ThemeProvider } from './components/ThemeContext.jsx';
import { useSidebarContext } from './components/SidebarContext.jsx';
import { getShellBootstrap } from './services/apiSystem.js';
import { startShellBootstrap } from './services/shellBootstrap.js';

const mock = vi.hoisted(() => {
  const events = new Map();
  return {
    pageRender: vi.fn(),
    contextRender: vi.fn(),
    socket: {
      connected: false,
      on(name, listener) {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(listener);
      },
      off(name, listener) { events.get(name)?.delete(listener); },
      emit: vi.fn(),
      deliver(name, data) { for (const listener of events.get(name) || []) listener(data); },
    },
  };
});
vi.mock('socket.io-client', () => ({ io: () => mock.socket }));

const SidebarConsumer = memo(function SidebarConsumer() {
  mock.contextRender(useSidebarContext());
  return null;
});

vi.mock('./utils/lazyWithReload', () => ({
  lazyWithReload: () => function ActivePage() {
    const { pathname } = useLocation();
    mock.pageRender(pathname);
    return <><h1>{pathname}</h1><SidebarConsumer /></>;
  },
}));

afterEach(() => vi.unstubAllGlobals());

it('keeps cold shell requests bounded and isolates bell and rail updates from the active page', async () => {
  vi.stubGlobal('__APP_VERSION__', 'test');
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  localStorage.setItem('portos-sidebar-collapsed', 'true');
  const bootstrap = {
    settings: { timezone: 'UTC' },
    selfInstance: { name: 'Example' },
    features: { features: [], groups: [] },
    voiceConfig: { enabled: false },
    maintenance: { state: 'normal' },
    passwordRisk: { enabled: true, revision: 'protected' },
    setup: { setup: { complete: true }, capabilities: [] },
    updateStatus: { updateAvailable: false },
    build: {},
  };
  const calls = [];
  const responses = {
    '/api/shell/bootstrap': bootstrap,
    '/api/notifications': { notifications: [], count: 0 },
    '/api/review/queue': { items: [], partial: false },
    '/api/apps': [{ id: 'example', name: 'Example application' }],
  };
  vi.stubGlobal('fetch', async (url) => {
    const path = new URL(url, window.location.origin).pathname;
    calls.push(path);
    return new Response(JSON.stringify(responses[path] ?? {}), { status: responses[path] ? 200 : 404 });
  });

  startShellBootstrap(() => getShellBootstrap({ silent: true }));
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/apps'] });
  render(<StrictMode><ThemeProvider><RouterProvider router={router} /></ThemeProvider></StrictMode>);
  await act(async () => {});

  expect(document.title).toBe('PortOS: Example');
  expect(screen.getByRole('heading', { name: '/apps' })).toBeInTheDocument();
  expect(calls.toSorted()).toEqual(['/api/notifications', '/api/review/queue', '/api/shell/bootstrap']);

  await act(async () => {
    mock.socket.connected = true;
    mock.socket.deliver('connect');
  });
  expect(calls.toSorted()).toEqual([
    '/api/notifications', '/api/notifications', '/api/review/queue', '/api/review/queue', '/api/shell/bootstrap',
  ]);

  const renderCount = mock.pageRender.mock.calls.length;
  const contextCount = mock.contextRender.mock.calls.length;
  await act(async () => {
    mock.socket.deliver('notifications:added', {
      id: 'n1', title: 'Example notification', timestamp: '2026-01-01T00:00:00Z', read: false,
    });
  });
  const sidebar = within(document.getElementById('app-sidebar'));
  fireEvent.click(sidebar.getByRole('button', { name: /Notifications/ }));
  expect(screen.getByRole('button', { name: 'View notification: Example notification' })).toBeInTheDocument();

  await act(async () => fireEvent.mouseEnter(sidebar.getByRole('button', { name: 'Apps', exact: true }).parentElement));
  const flyout = within(screen.getByRole('navigation', { name: 'Apps pages' }));
  expect(flyout.getByRole('link', { name: 'Example application' })).toHaveAttribute('href', '/apps/example');
  expect(mock.pageRender).toHaveBeenCalledTimes(renderCount);
  expect(mock.contextRender).toHaveBeenCalledTimes(contextCount);

  calls.length = 0;
  for (const path of ['/cos/tasks', '/brain/inbox']) {
    await act(async () => { await router.navigate(path); });
    expect(screen.getByRole('heading', { name: path })).toBeInTheDocument();
  }
  await act(async () => fireEvent(window, new Event('focus')));
  expect(calls).toEqual([]);
});
