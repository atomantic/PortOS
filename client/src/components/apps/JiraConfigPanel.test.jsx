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

  describe('with an instance selected', () => {
    const instance = { instances: { i1: { id: 'i1', name: 'Example', baseUrl: 'https://jira.example.com' } } };
    const savedApp = (jira) => ({ id: 'app-1', jira: { enabled: true, instanceId: 'i1', ...jira } });
    const renderApp = (jira) => render(<MemoryRouter><JiraConfigPanel app={savedApp(jira)} onSaved={() => {}} /></MemoryRouter>);

    beforeEach(() => {
      api.getJiraInstances.mockResolvedValue(instance);
      api.getJiraBoards.mockResolvedValue([]);
      api.getJiraBoardSprints.mockResolvedValue([]);
    });

    it('reports a failed projects read with Retry instead of silently offering a free-text key', async () => {
      api.getJiraProjects.mockRejectedValueOnce(new Error('projects 500'));
      renderApp({});

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load JIRA projects — projects 500');
      api.getJiraProjects.mockResolvedValue([{ key: 'PROJ', name: 'Project' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByPlaceholderText('Search projects...')).toBeInTheDocument();
    });

    it('reports a failed boards read with Retry, not "Couldn\'t auto-detect boards"', async () => {
      api.getJiraProjects.mockResolvedValue([{ key: 'PROJ', name: 'Project' }]);
      api.getJiraBoards.mockRejectedValueOnce(new Error('boards 500'));
      renderApp({ projectKey: 'PROJ' });

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load JIRA boards — boards 500');
      expect(screen.queryByText(/auto-detect boards/)).not.toBeInTheDocument();

      api.getJiraBoards.mockResolvedValue([{ id: 7, name: 'Board', type: 'scrum' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('option', { name: /Board/ })).toBeInTheDocument();
    });

    it('reports a failed sprints read with Retry, not "No active sprint"', async () => {
      api.getJiraProjects.mockResolvedValue([{ key: 'PROJ', name: 'Project' }]);
      api.getJiraBoards.mockResolvedValue([{ id: 7, name: 'Board', type: 'scrum' }]);
      api.getJiraBoardSprints.mockRejectedValueOnce(new Error('sprints 500'));
      renderApp({ projectKey: 'PROJ', boardId: '7' });

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the board\'s sprints — sprints 500');
      expect(screen.queryByText(/No active sprint/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/No active sprint on this board/)).toBeInTheDocument();
    });
  });
});
