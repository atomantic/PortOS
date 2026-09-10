import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { it, expect } from 'vitest';
import AppQuality from './AppQuality';

it('shows zero as a real score and explains excluded categories in the breakdown', () => {
  const app = { id: 'portos-default', quality: { score: 0, ratedCategories: 1, totalCategories: 25, categories: [
    { id: 'security', label: 'Security', score: 0, coverage: 'broad', confidence: 'high', summary: 'Critical failure', scannedFiles: 5, totalFiles: 5, worstSeverity: 10 },
    { id: 'ux', label: 'UX', score: 80, coverage: 'partial', stale: true, summary: 'Only one journey inspected' },
  ] } };
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Quality: 0/100' })).toBeInTheDocument();
  expect(screen.getByText('Stale · partial')).toBeInTheDocument();
  expect(screen.getByText(/1\/25 categories contribute/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Configure/ })).toHaveAttribute('href', '/apps/portos-default/tasks');
});

it('links an unassessed tile to its app overview without inventing a score', () => {
  render(<MemoryRouter><AppQuality app={{ id: 'other' }} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Quality: not assessed' })).toHaveAttribute('href', '/apps/other/overview');
});
