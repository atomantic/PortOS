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
  resumeHtmlPageRun: vi.fn(),
}));
vi.mock('../components/htmlPages/HtmlPreviewFrame', () => ({
  default: ({ html, title }) => <div data-testid="frame" aria-label={title}>{html ? 'page' : 'empty'}</div>,
}));

import HtmlPages from './HtmlPages';
import { deleteHtmlPageRun, getHtmlPageRun, listHtmlPageModels, listHtmlPageRuns, resumeHtmlPageRun, startHtmlPageRuns } from '../services/apiHtmlPages.js';

const CATALOG = {
  models: [
    { backend: 'ollama', runtimeLabel: 'Ollama', modelId: 'example-a:7b', offline: false },
    { backend: 'ollama', runtimeLabel: 'Ollama', modelId: 'example-b:7b', offline: false },
  ],
  listErrors: [{ id: 'lmstudio', label: 'LM Studio', error: 'not reachable', offline: true }],
  defaultPages: ['Rain on Glass: droplets. Make it stunning.', 'Brass Orrery: clockwork. Make it stunning.', 'Ant Colony: nest. Make it stunning.', 'Geoboard: pegs', 'Parlour: a keyboard'],
  promptParts: { before: 'Create one standalone HTML file.\n\n', after: '\n\nRules:\n- Everything inline.' },
  pageCountMax: 5,
  briefMaxChars: 200,
};
const run = (id, modelId, extra = {}) => ({
  id, backend: 'ollama', modelId, pageCount: 2, themes: CATALOG.defaultPages.slice(0, 2), status: 'complete',
  progress: { done: 2, total: 2 }, createdAt: '2026-11-22T10:00:00Z', startedAt: '2026-11-22T10:00:00Z', finishedAt: '2026-11-22T10:02:00Z',
  detail: { summary: '2 of 2 pages pass every check' }, error: null,
  pages: [
    { theme: CATALOG.defaultPages[0], passed: 6, total: 6, elapsedMs: 1000, checks: [] },
    { theme: CATALOG.defaultPages[1], passed: 5, total: 6, elapsedMs: 2000, checks: [{ id: 'document', label: 'Complete HTML document', ok: false }], hitTokenLimit: true },
  ],
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
  it('shows stored runs with their outcome, and stays quiet about runtimes that are not running', async () => {
    renderPage();
    expect(await screen.findByText(/2 of 2 pages pass every check/)).toBeInTheDocument();
    expect(screen.getByText('model server went away')).toBeInTheDocument();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not running/)).not.toBeInTheDocument();
  });

  it('sends the briefs exactly as typed, one run per chosen model, and only on submit', async () => {
    startHtmlPageRuns.mockResolvedValue([run('n1', 'example-a:7b', { status: 'queued' }), run('n2', 'example-b:7b', { status: 'queued' })]);
    renderPage();
    await screen.findByText('Run a comparison');
    expect(startHtmlPageRuns).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: /Select models to run/ })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('example-a:7b'));
    fireEvent.click(screen.getByLabelText('example-b:7b'));
    fireEvent.change(screen.getByLabelText('Page 1'), { target: { value: '  A lighthouse at dusk\nwith a sweeping beam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove page 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 models × 2 pages' }));

    await waitFor(() => expect(startHtmlPageRuns).toHaveBeenCalledTimes(1));
    expect(startHtmlPageRuns.mock.calls[0][0]).toEqual({
      models: [{ backend: 'ollama', modelId: 'example-a:7b' }, { backend: 'ollama', modelId: 'example-b:7b' }],
      pages: ['  A lighthouse at dusk\nwith a sweeping beam  ', CATALOG.defaultPages[1]],
    });
    expect(await screen.findAllByText('Queued')).toHaveLength(2);
  });

  it('shows the fixed PortOS text and the full prompt built from the brief being typed', async () => {
    renderPage();
    await screen.findByText('Run a comparison');
    fireEvent.change(screen.getByLabelText('Page 1'), { target: { value: 'A lighthouse' } });
    fireEvent.click(screen.getByText('Show the full prompt for each page'));
    const full = 'Create one standalone HTML file.\n\nA lighthouse\n\nRules:\n- Everything inline.';
    expect(screen.getAllByText((_, el) => el?.tagName === 'PRE' && el.textContent === full)).toHaveLength(1);
    fireEvent.click(screen.getByText('Text PortOS adds around each brief'));
    expect(screen.getByText('Create one standalone HTML file.', { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByText('Rules: - Everything inline.', { selector: 'pre' })).toBeInTheDocument();
  });

  it('blocks a blank or over-long brief instead of altering it, and shows the count', async () => {
    renderPage();
    await screen.findByText('Run a comparison');
    fireEvent.click(screen.getByLabelText('example-a:7b'));
    const submit = screen.getByRole('button', { name: /Run 1 model/ });
    expect(submit).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Page 1'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    expect(screen.getByText('Write a brief for this page, or remove it.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Page 1'), { target: { value: 'x'.repeat(201) } });
    expect(submit).toBeDisabled();
    expect(screen.getByText('201 characters — the limit is 200.')).toBeInTheDocument();
    expect(screen.getByText('201/200')).toBeInTheDocument();
  });

  it('adds pages up to the cap and starts from the defaults again on reset', async () => {
    renderPage();
    await screen.findByText('Run a comparison');
    fireEvent.click(screen.getByRole('button', { name: 'Add a page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a page' }));
    expect(screen.queryByRole('button', { name: 'Add a page' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Page 5')).toHaveValue(CATALOG.defaultPages[4]);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the defaults' }));
    expect(screen.queryByLabelText('Page 4')).not.toBeInTheDocument();
  });

  it('labels a finished run by what its pages scored, never just "Complete" for a run with no usable page', async () => {
    listHtmlPageRuns.mockResolvedValue([
      run('ok', 'example-ok:7b'),
      run('none', 'example-none:7b', { detail: { verdict: 'failed', summary: '0 of 2 pages pass every check' } }),
      run('some', 'example-some:7b', { detail: { verdict: 'partial', summary: '1 of 2 pages pass every check' } }),
    ]);
    renderPage();
    expect(await screen.findByText('No usable pages')).toBeInTheDocument();
    expect(screen.getByText('Partial')).toBeInTheDocument();
    expect(screen.getAllByText('Complete')).toHaveLength(1);
  });

  it('puts the selection in the URL and renders every theme for every selected run side by side', async () => {
    renderPage();
    await screen.findByText(/2 of 2 pages pass every check/);
    const [first] = screen.getAllByRole('button', { name: 'Compare' });
    fireEvent.click(first);
    expect(screen.getByLabelText('query')).toHaveTextContent('?compare=r1');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(new URLSearchParams(screen.getByLabelText('query').textContent).get('compare')).toBe('r1,r2');

    const comparison = await screen.findByRole('region', { name: 'Comparison' });
    await waitFor(() => expect(within(comparison).getAllByTestId('frame')).toHaveLength(4));
    expect(within(comparison).getByLabelText('example-a:7b — Brass Orrery')).toBeInTheDocument();
    // Why a page scored low is shown under its frame, including a cut-off generation.
    expect(within(comparison).getAllByText('Failed: Complete HTML document').length).toBeGreaterThan(0);
    expect(within(comparison).getAllByText(/Stopped at the token limit/).length).toBeGreaterThan(0);
  });

  it('restores a comparison from a deep link', async () => {
    renderPage('/media/pages?compare=r2');
    const comparison = await screen.findByRole('region', { name: 'Comparison' });
    expect(await within(comparison).findAllByTestId('frame')).toHaveLength(2);
    expect(getHtmlPageRun).toHaveBeenCalledWith('r2', expect.anything());
  });

  it('refetches the list when a run changes, so progress arrives without polling', async () => {
    renderPage();
    await screen.findByText(/2 of 2 pages pass every check/);
    listHtmlPageRuns.mockResolvedValue([run('r1', 'example-a:7b', { status: 'generating', progress: { done: 1, total: 2 } })]);
    await emitRun({ id: 'r1' });
    expect(await screen.findByText('Generating 1/2')).toBeInTheDocument();
  });

  it('asks before deleting, then removes the run and drops it from the comparison', async () => {
    deleteHtmlPageRun.mockResolvedValue({ id: 'r1', deleted: true });
    renderPage('/media/pages?compare=r1');
    await screen.findByText(/2 of 2 pages pass every check/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete the example-a:7b run' }));
    expect(deleteHtmlPageRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }));
    await waitFor(() => expect(deleteHtmlPageRun).toHaveBeenCalledWith('r1', expect.anything()));
    await waitFor(() => expect(screen.queryByText(/2 of 2 pages pass every check/)).not.toBeInTheDocument());
    // The router commits location inside startTransition, which can land after the urgent list update
    // because the delete resolves outside act(); wait for it rather than reading it synchronously.
    await waitFor(() => expect(screen.getByLabelText('query')).not.toHaveTextContent('compare'));
  });

  it('offers Resume only on a failed run and shows it queued again', async () => {
    resumeHtmlPageRun.mockResolvedValue(run('r2', 'example-b:7b', { status: 'queued', pages: [] }));
    renderPage();
    await screen.findByText('model server went away');
    expect(screen.queryByRole('button', { name: 'Resume the example-a:7b run' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume the example-b:7b run' }));
    await waitFor(() => expect(resumeHtmlPageRun).toHaveBeenCalledWith('r2', expect.anything()));
    await waitFor(() => expect(screen.queryByText('model server went away')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Resume the example-b:7b run' })).not.toBeInTheDocument();
  });
});
