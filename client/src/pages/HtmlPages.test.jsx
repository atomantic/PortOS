import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const socketHandlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event).add(fn); },
    off: (event, fn) => socketHandlers.get(event)?.delete(fn),
    emit: vi.fn(),
    connected: true,
  },
}));
const emitRun = async (payload) => act(async () => {
  for (const fn of socketHandlers.get('html-page-run:changed') || []) fn(payload);
});

vi.mock('../services/apiHtmlPages.js', () => ({
  listHtmlPageModels: vi.fn(),
  listHtmlPageRuns: vi.fn(),
  getHtmlPageRun: vi.fn(),
  startHtmlPageRuns: vi.fn(),
  deleteHtmlPageRun: vi.fn(),
}));
vi.mock('../components/htmlPages/HtmlPreviewFrame', () => ({
  default: ({ html, title }) => <div data-testid="frame" aria-label={title}>{html ? 'page' : 'empty'}</div>,
}));

import HtmlPages from './HtmlPages';
import { deleteHtmlPageRun, getHtmlPageRun, listHtmlPageModels, listHtmlPageRuns, startHtmlPageRuns } from '../services/apiHtmlPages.js';

const CATALOG = {
  models: [
    { backend: 'ollama', runtimeLabel: 'Ollama', modelId: 'example-a:7b', offline: false },
    { backend: 'ollama', runtimeLabel: 'Ollama', modelId: 'example-b:7b', offline: false },
  ],
  listErrors: [{ id: 'lmstudio', label: 'LM Studio', error: 'not reachable', offline: true }],
  themes: ['Rain on Glass: droplets', 'Brass Orrery: clockwork', 'Ant Colony: nest'],
  promptExample: 'Create one standalone HTML file.\n\nTheme: Rain on Glass: droplets.',
  pageCountMax: 3,
  pageCountDefault: 2,
};
const run = (id, modelId, extra = {}) => ({
  id, backend: 'ollama', modelId, pageCount: 2, themes: CATALOG.themes.slice(0, 2), status: 'complete',
  progress: { done: 2, total: 2 }, createdAt: '2026-11-22T10:00:00Z', startedAt: '2026-11-22T10:00:00Z', finishedAt: '2026-11-22T10:02:00Z',
  detail: { summary: '2 of 2 pages complete and self-contained' }, error: null,
  pages: [{ theme: CATALOG.themes[0], passed: 5, total: 5, elapsedMs: 1000 }, { theme: CATALOG.themes[1], passed: 4, total: 5, elapsedMs: 2000 }],
  ...extra,
});
const fullRun = (r) => ({ ...r, pages: r.pages.map((p) => ({ ...p, html: '<html></html>' })) });

function Probe() {
  return <output aria-label="query">{useLocation().search}</output>;
}
const renderPage = (entry = '/media/pages') => render(<MemoryRouter initialEntries={[entry]}><HtmlPages /><Probe /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  listHtmlPageModels.mockResolvedValue(CATALOG);
  listHtmlPageRuns.mockResolvedValue([run('r1', 'example-a:7b'), run('r2', 'example-b:7b', { status: 'failed', error: 'model server went away', pages: [] })]);
  getHtmlPageRun.mockImplementation(async (id) => fullRun(id === 'r1' ? run('r1', 'example-a:7b') : run('r2', 'example-b:7b')));
});

describe('HtmlPages', () => {
  it('shows stored runs with their outcome, and says which runtime could not be read', async () => {
    renderPage();
    expect(await screen.findByText(/2 of 2 pages complete and self-contained/)).toBeInTheDocument();
    expect(screen.getByText('model server went away')).toBeInTheDocument();
    expect(screen.getByText(/LM Studio \(not running\)/)).toBeInTheDocument();
  });

  it('names the exact prompt and queues one run per chosen model only on submit', async () => {
    startHtmlPageRuns.mockResolvedValue([run('n1', 'example-a:7b', { status: 'queued' }), run('n2', 'example-b:7b', { status: 'queued' })]);
    renderPage();
    await screen.findByText('Run a comparison');
    expect(screen.getByText(/Theme: Rain on Glass/)).toBeInTheDocument();
    expect(startHtmlPageRuns).not.toHaveBeenCalled();

    const submit = screen.getByRole('button', { name: /Select models to run/ });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText('example-a:7b'));
    fireEvent.click(screen.getByLabelText('example-b:7b'));
    fireEvent.change(screen.getByLabelText('Pages per model'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 models × 3 pages' }));

    await waitFor(() => expect(startHtmlPageRuns).toHaveBeenCalledTimes(1));
    expect(startHtmlPageRuns.mock.calls[0][0]).toEqual({
      models: [{ backend: 'ollama', modelId: 'example-a:7b' }, { backend: 'ollama', modelId: 'example-b:7b' }],
      pageCount: 3,
    });
    expect(await screen.findAllByText('Queued')).toHaveLength(2);
  });

  it('puts the selection in the URL and renders every theme for every selected run side by side', async () => {
    renderPage();
    await screen.findByText(/2 of 2 pages complete and self-contained/);
    const [first] = screen.getAllByRole('button', { name: 'Compare' });
    fireEvent.click(first);
    expect(screen.getByLabelText('query')).toHaveTextContent('?compare=r1');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(new URLSearchParams(screen.getByLabelText('query').textContent).get('compare')).toBe('r1,r2');

    const comparison = await screen.findByRole('region', { name: 'Comparison' });
    await waitFor(() => expect(within(comparison).getAllByTestId('frame')).toHaveLength(4));
    expect(within(comparison).getByLabelText('example-a:7b — Brass Orrery')).toBeInTheDocument();
  });

  it('restores a comparison from a deep link', async () => {
    renderPage('/media/pages?compare=r2');
    const comparison = await screen.findByRole('region', { name: 'Comparison' });
    expect(await within(comparison).findAllByTestId('frame')).toHaveLength(2);
    expect(getHtmlPageRun).toHaveBeenCalledWith('r2', expect.anything());
  });

  it('refetches the list when a run changes, so progress arrives without polling', async () => {
    renderPage();
    await screen.findByText(/2 of 2 pages complete and self-contained/);
    listHtmlPageRuns.mockResolvedValue([run('r1', 'example-a:7b', { status: 'generating', progress: { done: 1, total: 2 } })]);
    await emitRun({ id: 'r1' });
    expect(await screen.findByText('Generating 1/2')).toBeInTheDocument();
  });

  it('asks before deleting, then removes the run and drops it from the comparison', async () => {
    deleteHtmlPageRun.mockResolvedValue({ id: 'r1', deleted: true });
    renderPage('/media/pages?compare=r1');
    await screen.findByText(/2 of 2 pages complete and self-contained/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete the example-a:7b run' }));
    expect(deleteHtmlPageRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }));
    await waitFor(() => expect(deleteHtmlPageRun).toHaveBeenCalledWith('r1', expect.anything()));
    await waitFor(() => expect(screen.queryByText(/2 of 2 pages complete and self-contained/)).not.toBeInTheDocument());
    expect(screen.getByLabelText('query')).not.toHaveTextContent('compare');
  });
});
