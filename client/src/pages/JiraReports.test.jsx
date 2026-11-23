import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
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
