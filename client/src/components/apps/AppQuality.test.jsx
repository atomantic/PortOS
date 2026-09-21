import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import AppQuality from './AppQuality';
vi.mock('./AppQualityRunner', () => ({ default: ({ children }) => children(<div>Runner</div>) }));
// The schedule form owns its own async load and is covered by its own suite.
vi.mock('./AppQualityScheduleForm', () => ({ default: () => <div>Schedule form</div> }));
vi.mock('../../services/apiApps', () => ({
  getAppQualityHistory: vi.fn().mockResolvedValue({ points: [], totalCategories: 25 }),
  publishAppQualitySnapshot: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { publishAppQualitySnapshot } from '../../services/apiApps';
import toast from '../ui/Toast';

it('shows zero as a real score and explains excluded categories in the breakdown', async () => {
  const app = { id: 'portos-default', quality: { score: 0, ratedCategories: 1, totalCategories: 25, categories: [
    { id: 'security', label: 'Security', score: 0, coverage: 'broad', confidence: 'high', summary: 'Critical failure', scannedFiles: 5, totalFiles: 5, worstSeverity: 10 },
    { id: 'ux', label: 'UX', score: 80, coverage: 'partial', stale: true, summary: 'Only one journey inspected' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByRole('heading', { name: 'Quality: 0/100' })).toBeInTheDocument();
  expect(screen.getByText('Stale · partial')).toBeInTheDocument();
  expect(screen.getByText(/1\/25 categories contribute/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Scheduled audit runners/ })).toHaveAttribute('href', '/cos/schedule');
  expect(screen.getByRole('table').parentElement).not.toHaveClass('overflow-auto', 'xl:max-h-[calc(100vh-19rem)]');
});

it('links an unassessed tile to its app quality tab without inventing a score', () => {
  render(<MemoryRouter><AppQuality app={{ id: 'other' }} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Quality: not assessed' })).toHaveAttribute('href', '/apps/other/quality');
});

it('explains why completed maintenance can still have no saved assessment', async () => {
  render(<MemoryRouter><AppQuality app={{ id: 'example', quality: { score: null, categories: [] } }} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/Earlier runs are not scored retroactively/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Scheduled audit runners/ })).toHaveAttribute('href', '/cos/schedule');
});

it('distinguishes saved but excluded evidence from an app that was never assessed', async () => {
  const app = { id: 'example', quality: { score: null, ratedCategories: 0, totalCategories: 25, categories: [
    { id: 'security', label: 'Security', score: 60, coverage: 'partial', confidence: 'high', assessedAt: '2026-09-10T00:00:00Z' },
  ] } };
  const { rerender } = render(<MemoryRouter><AppQuality app={app} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Quality: no qualifying score' })).toBeInTheDocument();
  rerender(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/Saved assessments do not currently qualify/)).toBeInTheDocument();
  expect(screen.getByText('60/100')).toBeInTheDocument();
});

it('identifies federated evidence and incomplete scores without linking to a local audit run', async () => {
  const app = { id: 'portos-default', quality: { score: 80, federation: { available: 1, unavailable: 1 }, categories: [
    { id: 'security', label: 'Security', score: 80, coverage: 'broad', sourcePeerId: 'peer-a', agentId: 'remote-run' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/1 peers unavailable or incompatible/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View instances' })).toHaveAttribute('href', '/instances');
  expect(screen.queryByRole('link', { name: 'Audit run' })).not.toBeInTheDocument();
});

it('makes the category actions and header navigation look like distinct clickable controls', async () => {
  const app = { id: 'example', publishQualitySnapshot: true, quality: { categories: [
    { id: 'security', label: 'Security', score: 80, coverage: 'broad', confidence: 'high', agentId: 'run-1' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByRole('link', { name: 'Scheduled audit runners' })).toHaveClass('inline-flex', 'border', 'rounded');
  expect(screen.getByRole('link', { name: 'View agents' })).toHaveClass('inline-flex', 'border', 'rounded');
  expect(screen.getByRole('button', { name: 'Publish snapshot now' })).toHaveClass('inline-flex', 'border', 'rounded');
  expect(screen.getByRole('link', { name: 'Configure and run Security' })).toHaveClass('inline-flex', 'bg-port-accent/15', 'border', 'rounded');
  expect(screen.getByRole('link', { name: 'View audit run for Security' })).toHaveClass('inline-flex', 'border', 'bg-port-bg/40', 'rounded');
  expect(screen.getByRole('rowheader', { name: /Security/ })).toHaveClass('px-3', 'py-2.5');
});

it('orders the category breakdown from lowest score to highest, with unscored categories last', async () => {
  const app = { id: 'example', quality: { categories: [
    { id: 'ux', label: 'UX', score: 80, coverage: 'broad' },
    { id: 'security', label: 'Security', score: 20, coverage: 'broad' },
    { id: 'perf', label: 'Perf', score: null, coverage: 'unavailable' },
    { id: 'tests', label: 'Tests', score: 60, coverage: 'broad' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  const rowLabels = screen.getAllByRole('row').slice(1).map(row => within(row).queryByRole('rowheader')?.textContent);
  expect(rowLabels.filter(Boolean)).toEqual(['SecurityRunner settings', 'TestsRunner settings', 'UXRunner settings', 'PerfRunner settings']);
});

it('opens the shared runner beside unavailable category evidence while preserving URL filters', async () => {
  const app = { id: 'example', quality: { categories: [
    { id: 'security', label: 'Security', score: null, coverage: 'unavailable' },
    { id: 'ux', label: 'UX', score: null, coverage: 'unavailable' },
  ] } };
  render(<MemoryRouter initialEntries={['/apps/example/quality?period=30']}><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  const link = screen.getByRole('link', { name: 'Configure and run Security' });
  expect(link).toHaveAttribute('href', '/apps/example/quality?period=30&qualityCheck=security#quality-runner');
  fireEvent.click(link);
  const table = screen.getByRole('table');
  expect(within(table).getByText('Runner')).toBeInTheDocument();
  expect(screen.getAllByText('Runner')).toHaveLength(1);
  expect(screen.getAllByText('unavailable')).toHaveLength(2);
});

describe('AppQuality snapshot publishing', () => {
  const publishingApp = { id: 'example', publishQualitySnapshot: true, quality: { score: 80, categories: [] } };

  it('offers the publish action only for an app that opted in', async () => {
    const { rerender } = render(<MemoryRouter><AppQuality app={{ ...publishingApp, publishQualitySnapshot: false }} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);
    expect(screen.queryByRole('button', { name: 'Publish snapshot now' })).not.toBeInTheDocument();

    rerender(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Publish snapshot now' })).toBeInTheDocument();
  });

  it('reports the pull request that carries the snapshot into the repo', async () => {
    publishAppQualitySnapshot.mockResolvedValue({
      success: true, published: true, hash: 'abc1234def', path: '.quality.json',
      prUrl: 'https://github.com/example/app/pull/42',
    });
    render(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);

    fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot now' }));

    await waitFor(() => expect(publishAppQualitySnapshot).toHaveBeenCalledWith('example'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Quality snapshot pull request opened; it will merge when CI is green'));
  });

  it('explains a refusal instead of claiming a commit that never happened', async () => {
    publishAppQualitySnapshot.mockResolvedValue({ success: true, published: false, reason: 'no-changes', path: '.quality.json' });
    render(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);

    fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot now' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Snapshot already up to date in .quality.json'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
