import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OverviewTab from './OverviewTab';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

const stats = { rawSources: 0, total: 0 };

function renderTab() {
  return render(
    <MemoryRouter>
      <OverviewTab vaultId="v1" stats={stats} notes={[]} allNotes={[]} onRefresh={() => {}} />
    </MemoryRouter>
  );
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
