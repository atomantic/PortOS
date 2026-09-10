import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { it, expect, vi } from 'vitest';
import AppQuality from './AppQuality';
vi.mock('./AppQualityRunner', () => ({ default: () => <div>Runner</div> }));
vi.mock('../../services/apiApps', () => ({ getAppQualityHistory: vi.fn().mockResolvedValue({ points: [], totalCategories: 25 }) }));

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
