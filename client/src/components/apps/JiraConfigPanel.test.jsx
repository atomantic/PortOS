import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JiraConfigPanel from './JiraConfigPanel';

const api = vi.hoisted(() => ({
  getJiraInstances: vi.fn(),
  getJiraProjects: vi.fn(),
  getJiraBoards: vi.fn(),
  getJiraBoardSprints: vi.fn(),
  getJiraIssue: vi.fn(),
  searchJiraEpics: vi.fn(),
  updateApp: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const app = { id: 'app-1', jira: { enabled: true } };
const renderPanel = () => render(<MemoryRouter><JiraConfigPanel app={app} onSaved={() => {}} /></MemoryRouter>);

describe('JiraConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getJiraProjects.mockResolvedValue([]);
  });

  it('reports a failed instance read with Retry, not "No JIRA instances configured"', async () => {
    api.getJiraInstances.mockRejectedValueOnce(new Error('jira 500'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load JIRA instances — jira 500');
    expect(screen.queryByText(/No JIRA instances configured/)).not.toBeInTheDocument();

    api.getJiraInstances.mockResolvedValue({ instances: { i1: { id: 'i1', name: 'Example', baseUrl: 'https://jira.example.com' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('JIRA Instance')).toBeInTheDocument());
  });

  it('keeps the empty copy for a genuinely empty instance list', async () => {
    api.getJiraInstances.mockResolvedValue({ instances: {} });
    renderPanel();
    expect(await screen.findByText(/No JIRA instances configured/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
