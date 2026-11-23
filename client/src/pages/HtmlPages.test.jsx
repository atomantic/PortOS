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

// The real picker and its provider fetch are covered by their own suites; here it is two plain selects over what the page hands it.
vi.mock('../hooks/useProviderModels', async () => {
  const { useState } = await import('react');
  return {
    default: () => {
      const [selectedProviderId, setProviderId] = useState('');
      const [selectedModel, setSelectedModel] = useState('');
      const setSelectedProviderId = (id) => { setProviderId(id); setSelectedModel(id ? 'example-model' : ''); };
      const availableModels = selectedProviderId ? ['example-model'] : [];
      return { providers: [{ id: 'example-cli', name: 'Example CLI' }], loading: false, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel };
    },
  };
});
vi.mock('../components/ProviderModelSelector', () => ({
  default: ({ providers, selectedProviderId, selectedModel, availableModels, onProviderChange, onModelChange, onEffortChange, label, modelLabel }) => (
    <div>
      <label>{label}
        <select value={selectedProviderId} onChange={(e) => onProviderChange(e.target.value)}>
          <option value="">—</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>{modelLabel}
        <select value={selectedModel} onChange={(e) => onModelChange(e.target.value)}>
          {availableModels.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => onEffortChange('high')}>{`High effort for ${label}`}</button>
    </div>
  ),
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

  it('runs installed models picked in the shared picker, sending the briefs exactly as typed and only on submit', async () => {
    startHtmlPageRuns.mockResolvedValue([run('n1', 'example-a:7b', { status: 'queued' }), run('n2', 'example-b:7b', { status: 'queued' })]);
    renderPage();
    await screen.findByText('Models');
    expect(startHtmlPageRuns).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Pick a model to run/ })).toBeDisabled();

    // Installed models are offered per runtime beside the configured providers, with no separate checkbox list.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Provider 1'), { target: { value: 'installed:ollama' } });
    expect(screen.getByLabelText('Model 1')).toHaveValue('example-a:7b');
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Provider 2'), { target: { value: 'installed:ollama' } });
    fireEvent.change(screen.getByLabelText('Model 2'), { target: { value: 'example-b:7b' } });

    fireEvent.change(screen.getByLabelText('Page 1'), { target: { value: '  A lighthouse at dusk\nwith a sweeping beam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove page 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 models × 2 pages' }));

    await waitFor(() => expect(startHtmlPageRuns).toHaveBeenCalledTimes(1));
    expect(startHtmlPageRuns.mock.calls[0][0]).toEqual({
      models: [{ backend: 'ollama', modelId: 'example-a:7b' }, { backend: 'ollama', modelId: 'example-b:7b' }],
      routes: [],
      pages: ['  A lighthouse at dusk\nwith a sweeping beam  ', CATALOG.defaultPages[1]],
    });
    expect(await screen.findAllByText('Queued')).toHaveLength(2);
  });

  it('runs a provider, model and effort alongside an installed model, and blocks the same pick twice', async () => {
    startHtmlPageRuns.mockImplementation(async (body) => body.routes.map((r, i) => run(`route-${i}`, r.model, { status: 'queued', backend: 'provider', route: { ...r, providerName: 'Example CLI' } })));
    renderPage();
    await screen.findByText('Models');
    fireEvent.change(screen.getByLabelText('Provider 1'), { target: { value: 'example-cli' } });
    fireEvent.click(screen.getByRole('button', { name: 'High effort for Provider 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Provider 2'), { target: { value: 'installed:ollama' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Provider 3'), { target: { value: 'installed:ollama' } });
    expect(screen.getByText('Already picked above.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run 3 models × 3 pages' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove model 3' }));

    fireEvent.click(screen.getByRole('button', { name: 'Run 2 models × 3 pages' }));
    await waitFor(() => expect(startHtmlPageRuns).toHaveBeenCalledTimes(1));
    expect(startHtmlPageRuns.mock.calls[0][0]).toMatchObject({
      models: [{ backend: 'ollama', modelId: 'example-a:7b' }],
      routes: [{ providerId: 'example-cli', model: 'example-model', effort: 'high' }],
    });
    expect(await screen.findByText(/Example CLI · high/)).toBeInTheDocument();
  });

  it('shows the fixed PortOS text and the full prompt built from the brief being typed', async () => {
    renderPage();
    await screen.findByText('Models');
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
    await screen.findByText('Models');
    fireEvent.change(screen.getByLabelText('Provider 1'), { target: { value: 'installed:ollama' } });
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
    await screen.findByText('Models');
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

  it('offers Resume on a failed run, Retry on a finished one with a failing page, and shows it queued again', async () => {
    resumeHtmlPageRun.mockResolvedValue(run('r2', 'example-b:7b', { status: 'queued', pages: [] }));
    renderPage();
    await screen.findByText('model server went away');
    expect(screen.queryByRole('button', { name: 'Resume the example-a:7b run' })).not.toBeInTheDocument();
    // example-a finished, but one of its pages failed a check.
    expect(screen.getByRole('button', { name: 'Retry the example-a:7b run' })).toHaveTextContent('Retry failed pages');
    fireEvent.click(screen.getByRole('button', { name: 'Resume the example-b:7b run' }));
    await waitFor(() => expect(resumeHtmlPageRun).toHaveBeenCalledWith('r2', expect.anything()));
    await waitFor(() => expect(screen.queryByText('model server went away')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Resume the example-b:7b run' })).not.toBeInTheDocument();
  });
});
