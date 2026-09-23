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

it('shows zero as a real score up front and keeps the scoring explanation in a tooltip', async () => {
  const app = { id: 'portos-default', quality: { score: 0, ratedCategories: 1, totalCategories: 25, categories: [
    { id: 'security', label: 'Security', score: 0, coverage: 'broad', confidence: 'high', summary: 'Critical failure', scannedFiles: 5, totalFiles: 5, worstSeverity: 10 },
    { id: 'ux', label: 'UX', score: 80, coverage: 'partial', stale: true, summary: 'Only one journey inspected' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByRole('heading', { name: 'Quality: 0/100' })).toBeInTheDocument();
  expect(screen.getAllByText('Stale · partial')).not.toHaveLength(0);
  expect(screen.getByText(/1\/25 categories contribute/)).toBeInTheDocument();
  expect(screen.queryByText(/Equal-weight mean/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'How the quality score works' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent(/Equal-weight mean/);
  // Metrics-only visitors never see the run or schedule forms until they ask.
  expect(screen.queryByText('Runner')).not.toBeInTheDocument();
  expect(screen.queryByText('Schedule form')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
  expect(screen.getByRole('menuitem', { name: 'Scheduled audit runners' })).toHaveAttribute('href', '/cos/schedule');
});

it('links an unassessed tile to its app quality tab without inventing a score', () => {
  render(<MemoryRouter><AppQuality app={{ id: 'other' }} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Quality: not assessed' })).toHaveAttribute('href', '/apps/other/quality');
});

it('explains why completed maintenance can still have no saved assessment', async () => {
  render(<MemoryRouter><AppQuality app={{ id: 'example', quality: { score: null, categories: [] } }} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/No audit assessment saved yet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'How the quality score works' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent(/Earlier runs are not scored retroactively/);
});

it('distinguishes saved but excluded evidence from an app that was never assessed', async () => {
  const app = { id: 'example', quality: { score: null, ratedCategories: 0, totalCategories: 25, categories: [
    { id: 'security', label: 'Security', score: 60, coverage: 'partial', confidence: 'high', assessedAt: '2026-09-10T00:00:00Z' },
  ] } };
  const { rerender } = render(<MemoryRouter><AppQuality app={app} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Quality: no qualifying score' })).toBeInTheDocument();
  rerender(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/Saved assessments do not qualify/)).toBeInTheDocument();
  expect(screen.getByText('60/100')).toBeInTheDocument();
});

it('identifies federated evidence and incomplete scores without linking to a local audit run', async () => {
  const app = { id: 'portos-default', quality: { score: 80, federation: { available: 1, unavailable: 1 }, categories: [
    { id: 'security', label: 'Security', score: 80, coverage: 'broad', sourcePeerId: 'peer-a', agentId: 'remote-run' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.getByText(/1 peers unavailable or incompatible/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Security actions' }));
  expect(screen.getByRole('menuitem', { name: 'View instances' })).toHaveAttribute('href', '/instances');
  expect(screen.queryByRole('menuitem', { name: 'View audit run' })).not.toBeInTheDocument();
});

it('keeps secondary category actions in a row menu beside the run shortcut', async () => {
  const app = { id: 'example', quality: { categories: [
    { id: 'security', label: 'Security', score: 80, coverage: 'broad', confidence: 'high', agentId: 'run-1', summary: 'No material defects' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  expect(screen.queryByText('No material defects')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Security assessment details' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('No material defects');
  fireEvent.click(screen.getByRole('button', { name: 'Security actions' }));
  expect(screen.getByRole('menuitem', { name: 'Runner settings' })).toHaveAttribute('href', '/cos/schedule?task=security');
  expect(screen.getByRole('menuitem', { name: 'View audit run' })).toHaveAttribute('href', '/cos/agents/run-1');
});

it('sorts the category breakdown by worst score or oldest last run', async () => {
  const app = { id: 'example', quality: { categories: [
    { id: 'ux', label: 'UX', score: 80, coverage: 'broad', assessedAt: '2026-09-12T00:00:00Z' },
    { id: 'security', label: 'Security', score: 20, coverage: 'broad', assessedAt: '2026-09-13T00:00:00Z' },
    { id: 'perf', label: 'Perf', score: null, coverage: 'unavailable' },
    { id: 'tests', label: 'Tests', score: 60, coverage: 'broad', assessedAt: '2026-09-10T00:00:00Z' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  const sortBy = screen.getByRole('combobox', { name: 'Sort by' });
  expect(sortBy).toHaveValue('score');
  let rowLabels = screen.getAllByRole('row').slice(1).map(row => within(row).queryByRole('rowheader')?.textContent);
  expect(rowLabels.filter(Boolean)).toEqual(['Security', 'Tests', 'UX', 'Perf']);

  fireEvent.change(sortBy, { target: { value: 'oldest-run' } });
  rowLabels = screen.getAllByRole('row').slice(1).map(row => within(row).queryByRole('rowheader')?.textContent);
  expect(rowLabels.filter(Boolean)).toEqual(['Perf', 'Tests', 'UX', 'Security']);
});

it('opens the run and schedule forms in a deep-linked drawer while preserving URL filters', async () => {
  const app = { id: 'example', quality: { categories: [
    { id: 'security', label: 'Security', score: null, coverage: 'unavailable' },
    { id: 'ux', label: 'UX', score: null, coverage: 'unavailable' },
  ] } };
  render(<MemoryRouter initialEntries={['/apps/example/quality?period=30']}><AppQuality app={app} detail /></MemoryRouter>);
  await screen.findByText(/No scored assessments/);
  const link = screen.getByRole('link', { name: 'Run Security check' });
  expect(link).toHaveAttribute('href', '/apps/example/quality?period=30&qualityPanel=run&qualityCheck=security');
  fireEvent.click(link);
  expect(within(screen.getByRole('dialog', { name: 'Run quality checks' })).getByText('Runner')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('Runner')).not.toBeInTheDocument();
  // The header's Run drops the row preselection so it opens on the default set.
  expect(screen.getByRole('link', { name: 'Run checks' })).toHaveAttribute('href', '/apps/example/quality?period=30&qualityPanel=run');
  fireEvent.click(screen.getByRole('link', { name: 'Schedule' }));
  expect(within(screen.getByRole('dialog', { name: 'Weekly quality schedule' })).getByText('Schedule form')).toBeInTheDocument();
});

describe('AppQuality snapshot publishing', () => {
  const publishingApp = { id: 'example', publishQualitySnapshot: true, quality: { score: 80, categories: [] } };

  it('offers the publish action only for an app that opted in', async () => {
    const { rerender } = render(<MemoryRouter><AppQuality app={{ ...publishingApp, publishQualitySnapshot: false }} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);
    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Publish snapshot now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));

    rerender(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
    expect(screen.getByRole('menuitem', { name: 'Publish snapshot now' })).toBeInTheDocument();
  });

  it('reports the pull request that carries the snapshot into the repo', async () => {
    publishAppQualitySnapshot.mockResolvedValue({
      success: true, published: true, hash: 'abc1234def', path: '.quality.json',
      prUrl: 'https://github.com/example/app/pull/42',
    });
    render(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);

    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publish snapshot now' }));

    await waitFor(() => expect(publishAppQualitySnapshot).toHaveBeenCalledWith('example'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Quality snapshot pull request opened; it merges immediately'));
  });

  it('explains a refusal instead of claiming a commit that never happened', async () => {
    publishAppQualitySnapshot.mockResolvedValue({ success: true, published: false, reason: 'no-changes', path: '.quality.json' });
    render(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);

    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publish snapshot now' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Snapshot already up to date in .quality.json'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says an unsupported snapshot file was left in place', async () => {
    publishAppQualitySnapshot.mockResolvedValue({ success: true, published: false, reason: 'unsupported-format', path: '.quality.json' });
    render(<MemoryRouter><AppQuality app={publishingApp} detail /></MemoryRouter>);
    await screen.findByText(/No scored assessments/);

    fireEvent.click(screen.getByRole('button', { name: 'More quality actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publish snapshot now' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      'The committed quality file is in an unsupported format. Publish left it in place.'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
