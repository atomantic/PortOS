import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getJiraInstances: vi.fn(),
  getJiraProjects: vi.fn(),
  getJiraBoards: vi.fn(),
  getJiraBoardSprints: vi.fn(),
  getJiraIssue: vi.fn(),
  searchJiraEpics: vi.fn(),
  getMySprintTickets: vi.fn(),
  updateApp: vi.fn(),
}));

// The Kanban board is exercised by its own suite; stub it so this test is about
// the tab's composition (config + board) rather than the board's internals.
vi.mock('../../KanbanBoard', () => ({
  default: ({ tickets }) => <div data-testid="kanban">{tickets.length} tickets</div>,
}));

import * as api from '../../../services/api';
import JiraTab from './JiraTab';

const APP = {
  id: 'app-1',
  name: 'Widget',
  jira: { enabled: true, instanceId: 'inst-1', projectKey: 'PROJ', boardId: '12', issueType: 'Task', labels: ['cos-auto'], createPR: true },
};

const renderTab = (app = APP, onRefresh = () => {}) => render(
  <MemoryRouter>
    <JiraTab app={app} onRefresh={onRefresh} />
  </MemoryRouter>
);

beforeEach(() => {
  api.getJiraInstances.mockResolvedValue({ instances: { 'inst-1': { id: 'inst-1', name: 'Acme', baseUrl: 'https://acme.example.com' } } });
  api.getJiraProjects.mockResolvedValue([{ key: 'PROJ', name: 'Project' }]);
  api.getJiraBoards.mockResolvedValue([{ id: 12, name: 'Board', type: 'scrum' }]);
  api.getJiraBoardSprints.mockResolvedValue([{ name: 'Sprint 3' }]);
  api.getMySprintTickets.mockResolvedValue([{ key: 'PROJ-1', summary: 'Do a thing', status: 'To Do', statusCategory: 'To Do' }]);
  api.updateApp.mockResolvedValue({ ...APP });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('JiraTab', () => {
  it('renders the JIRA config form and the sprint board together', async () => {
    renderTab();

    expect(await screen.findByLabelText('JIRA Instance')).toBeInTheDocument();
    expect(await screen.findByTestId('kanban')).toHaveTextContent('1 tickets');
    expect(api.getMySprintTickets).toHaveBeenCalledWith('inst-1', 'PROJ', { silent: true });
  });

  it('saves ONLY the jira slice, so the PUT cannot touch other app fields', async () => {
    const onRefresh = vi.fn();
    renderTab(APP, onRefresh);

    fireEvent.click(await screen.findByRole('button', { name: /Save JIRA Settings/ }));

    await waitFor(() => expect(api.updateApp).toHaveBeenCalled());
    const [id, payload, options] = api.updateApp.mock.calls[0];
    expect(id).toBe('app-1');
    expect(Object.keys(payload)).toEqual(['jira']);
    expect(payload.jira).toMatchObject({ enabled: true, instanceId: 'inst-1', projectKey: 'PROJ', boardId: '12', labels: ['cos-auto'] });
    // Custom error UI lives in the panel, so the helper must not also toast.
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('collapses to just the config form when JIRA is not configured', async () => {
    renderTab({ id: 'app-2', name: 'No JIRA' });

    expect(await screen.findByText('Enable JIRA Integration')).toBeInTheDocument();
    expect(screen.queryByTestId('kanban')).not.toBeInTheDocument();
    expect(api.getMySprintTickets).not.toHaveBeenCalled();
  });

  it('says "couldn\'t load" with a retry when the sprint fetch fails', async () => {
    api.getMySprintTickets.mockRejectedValue(new Error('JIRA unreachable'));
    renderTab();

    expect(await screen.findByText(/Couldn't load sprint tickets — JIRA unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry loading sprint tickets/ })).toBeInTheDocument();
    expect(screen.queryByText(/No tickets assigned to you/)).not.toBeInTheDocument();
  });
});
