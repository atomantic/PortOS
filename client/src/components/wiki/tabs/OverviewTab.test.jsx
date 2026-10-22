import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OverviewTab from './OverviewTab';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

const stats = { rawSources: 0, total: 0 };

function renderTab(allNotes = []) {
  return render(
    <MemoryRouter>
      <OverviewTab vaultId="v1" stats={stats} notes={[]} allNotes={allNotes} onRefresh={() => {}} />
    </MemoryRouter>
  );
}

const LINT_NOTE = [{ path: 'wiki/lint-report.md', name: 'lint-report', folder: 'wiki', modifiedAt: '2026-05-10T00:00:00.000Z' }];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

describe('OverviewTab empty Health Report', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says maintenance is off and links to System Tasks when the job is disabled', async () => {
    api.getCosJobs.mockResolvedValue({ jobs: [{ id: 'job-wiki-maintenance', enabled: false }] });
    renderTab();
    expect(await screen.findByText(/Weekly wiki maintenance is off/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'System Tasks' }).getAttribute('href')).toBe('/cos/jobs');
    expect(screen.queryByText(/will generate/)).toBeNull();
  });

  it('shows the next run when the job is enabled', async () => {
    api.getCosJobs.mockResolvedValue({
      jobs: [{ id: 'job-wiki-maintenance', enabled: true, nextRunAt: '2030-01-06T03:00:00.000Z' }],
    });
    renderTab();
    expect(await screen.findByText(/Weekly wiki maintenance is on/)).toBeTruthy();
    expect(screen.getByText(/next run/)).toBeTruthy();
  });

  it('reports unavailable status instead of off when the jobs request fails', async () => {
    api.getCosJobs.mockRejectedValue(new Error('boom'));
    renderTab();
    await waitFor(() => expect(screen.getByText(/status is unavailable/)).toBeTruthy());
    expect(screen.queryByText(/is off/)).toBeNull();
  });
});

describe('OverviewTab Health Report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosJobs.mockResolvedValue({ jobs: [] });
  });

  it('renders the lint report as Markdown and keeps the whole body past 2,000 characters', async () => {
    const tail = 'FINAL-FINDING-AFTER-2000-CHARS';
    const body = '# Wiki Lint Report\n\n**Zero structural issues**\n\n' + 'filler line.\n'.repeat(300) + tail;
    api.getNote.mockResolvedValue({ body, modifiedAt: '2026-05-10T00:00:00.000Z' });
    const { container } = renderTab(LINT_NOTE);
    expect(await screen.findByRole('heading', { name: 'Wiki Lint Report' })).toBeTruthy();
    expect(container.querySelector('strong').textContent).toBe('Zero structural issues');
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(container.textContent).toContain(tail);
    expect(api.getNote).toHaveBeenCalledWith('v1', 'wiki/lint-report.md', { silent: true });
  });

  it('opens the full report in the Browse tab', async () => {
    api.getNote.mockResolvedValue({ body: '# Report', modifiedAt: '2026-05-10T00:00:00.000Z' });
    render(
      <MemoryRouter initialEntries={['/wiki/overview']}>
        <OverviewTab vaultId="v1" stats={stats} notes={[]} allNotes={LINT_NOTE} onRefresh={() => {}} />
        <LocationProbe />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open full report' }));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Flint-report.md');
  });

  it('shows a retry state when the read fails, and retry reloads the report', async () => {
    api.getNote.mockRejectedValueOnce(new Error('boom'));
    api.getNote.mockResolvedValueOnce({ body: '# Recovered', modifiedAt: '2026-05-10T00:00:00.000Z' });
    renderTab(LINT_NOTE);
    expect(await screen.findByText("Couldn't load the health report")).toBeTruthy();
    expect(screen.queryByText('No lint report yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Recovered' })).toBeTruthy();
  });

  it('drops a superseded response that resolves after the vault has switched', async () => {
    let resolveFirst;
    api.getNote
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
      .mockResolvedValueOnce({ body: '# Vault B report', modifiedAt: '2026-05-10T00:00:00.000Z' });
    const tree = (vaultId) => (
      <MemoryRouter>
        <OverviewTab vaultId={vaultId} stats={stats} notes={[]} allNotes={LINT_NOTE} onRefresh={() => {}} />
      </MemoryRouter>
    );
    const { rerender } = render(tree('v1'));
    await waitFor(() => expect(api.getNote).toHaveBeenCalledTimes(1));
    rerender(tree('v2'));
    expect(await screen.findByRole('heading', { name: 'Vault B report' })).toBeTruthy();
    resolveFirst({ body: '# Vault A report', modifiedAt: '2026-05-10T00:00:00.000Z' });
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByRole('heading', { name: 'Vault A report' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Vault B report' })).toBeTruthy();
  });

  it('shows the empty state, not an error, when no lint report exists', async () => {
    renderTab([]);
    expect(await screen.findByText('No lint report yet')).toBeTruthy();
    expect(screen.queryByText("Couldn't load the health report")).toBeNull();
    expect(api.getNote).not.toHaveBeenCalled();
  });
});
