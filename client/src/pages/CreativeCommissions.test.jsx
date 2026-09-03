import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listCommissions: vi.fn(),
  createCommission: vi.fn(),
  updateCommission: vi.fn(),
  deleteCommission: vi.fn(),
  runCommissionNow: vi.fn(),
}));
// The create drawer's config form loads model catalogs on mount — irrelevant to
// the index's empty state, and it would put real requests behind these renders.
vi.mock('../components/creative-commission/CommissionConfigForm.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import CreativeCommissions from './CreativeCommissions';
import { listCommissions } from '../services/api';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/creative-commission']}>
    <CreativeCommissions />
  </MemoryRouter>
);

describe('CreativeCommissions index empty state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes the empty state to the create drawer via a named link', async () => {
    listCommissions.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No commissions yet')).toBeInTheDocument();
    // The only actionTo conversion — assert the Link branch in situ so a
    // dropped actionTo/actionLabel leaves a detectable dead end.
    const cta = screen.getByRole('link', { name: 'Create your first commission' });
    expect(cta.getAttribute('href')).toBe('/creative-commission/new');
  });

  it('renders the commission list instead of the empty state once one exists', async () => {
    listCommissions.mockResolvedValue([
      { id: 'commission-1', name: 'Example Commission', enabled: true, schedule: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    renderPage();
    expect(await screen.findByText('Example Commission')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create your first commission' })).toBeNull();
  });
});
