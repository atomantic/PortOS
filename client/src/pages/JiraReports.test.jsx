import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getJiraReport: vi.fn(),
  getJiraReports: vi.fn(),
  generateJiraReport: vi.fn(),
  getApps: vi.fn(),
}));

vi.mock('../services/apiSystem.js', () => ({
  getJiraReport: api.getJiraReport,
  getJiraReports: api.getJiraReports,
  generateJiraReport: api.generateJiraReport,
}));
vi.mock('../services/apiApps.js', () => ({ getApps: api.getApps }));

import JiraReports from './JiraReports';

const renderPage = async () => {
  render(
    <MemoryRouter>
      <JiraReports />
    </MemoryRouter>
  );
  await act(async () => {});
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('JiraReports prerequisites', () => {
  it('disables Generate Report and links to setup when no app has JIRA enabled', async () => {
    api.getJiraReports.mockResolvedValue([]);
    api.getApps.mockResolvedValue([{ id: 'a1', name: 'Plain App' }]);
    await renderPage();

    expect(screen.getByRole('button', { name: /generate report/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/apps');
    expect(screen.getAllByRole('link', { name: 'JIRA Instances' }).some((l) => l.getAttribute('href') === '/devtools/jira')).toBe(true);
  });

  it('keeps Generate Report enabled when a JIRA-enabled app exists', async () => {
    api.getJiraReports.mockResolvedValue([]);
    api.getApps.mockResolvedValue([{ id: 'a1', name: 'Jira App', jira: { enabled: true } }]);
    await renderPage();

    expect(screen.getByRole('button', { name: /generate report/i })).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Apps' })).toBeNull();
  });
});

it.each([false, true])('retries a failed reports read (has reports: %s)', async (hasReports) => {
  const reports = hasReports ? [{
    appId: 'app-example', appName: 'Example report', date: '2026-01-01', summary: { done: 1, inProgress: 0, todo: 0 },
  }] : [];
  api.getApps.mockResolvedValue([]);
  api.getJiraReports.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(reports);
  await renderPage();

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load JIRA reports');
  expect(screen.queryByText(/No reports yet/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasReports ? 'Example report' : /No reports yet/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
