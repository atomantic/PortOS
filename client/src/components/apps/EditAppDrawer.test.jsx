import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock the API surface EditAppDrawer touches on mount, plus the work-tracker
// resolver and the update path used on save.
vi.mock('../../services/api', () => ({
  getJiraInstances: vi.fn(),
  getDatadogInstances: vi.fn(),
  getJiraProjects: vi.fn(),
  getAppWorkTracker: vi.fn(),
  updateApp: vi.fn(),
  upgradeAppTls: vi.fn(),
}));

// react-router-dom <Link> is rendered inside the JIRA section.
vi.mock('react-router-dom', () => ({
  Link: ({ children, ...rest }) => <a {...rest}>{children}</a>,
}));

import * as api from '../../services/api';
import EditAppDrawer from './EditAppDrawer';

const APP = {
  id: 'app-1',
  name: 'My App',
  repoPath: '/repo',
  workTracker: 'auto',
};

beforeEach(() => {
  api.getJiraInstances.mockResolvedValue({ instances: {} });
  api.getDatadogInstances.mockResolvedValue({ instances: {} });
  api.getJiraProjects.mockResolvedValue([]);
  api.getAppWorkTracker.mockResolvedValue({
    configured: 'auto',
    resolved: 'github',
    host: 'github.com',
    forge: 'gh',
    source: 'origin',
  });
  api.updateApp.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditAppDrawer work tracker selector', () => {
  it('renders a labeled select with the five tracker options', async () => {
    render(<EditAppDrawer app={APP} onClose={() => {}} onSave={() => {}} />);

    const select = await screen.findByLabelText('Work Tracker');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('auto');

    const optionValues = Array.from(select.querySelectorAll('option')).map(o => o.value);
    expect(optionValues).toEqual(['auto', 'plan', 'github', 'gitlab', 'jira']);
  });

  it('shows the resolved auto target from the work-tracker endpoint', async () => {
    render(<EditAppDrawer app={APP} onClose={() => {}} onSave={() => {}} />);

    await screen.findByLabelText('Work Tracker');
    expect(api.getAppWorkTracker).toHaveBeenCalledWith('app-1');
    await waitFor(() =>
      expect(screen.getByText(/Auto → GitHub Issues \(origin: github\.com\)/)).toBeInTheDocument()
    );
  });

  it('updates the selection locally and includes workTracker in the save payload', async () => {
    render(<EditAppDrawer app={APP} onClose={() => {}} onSave={() => {}} />);

    const select = await screen.findByLabelText('Work Tracker');
    fireEvent.change(select, { target: { value: 'gitlab' } });
    expect(select).toHaveValue('gitlab');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.updateApp).toHaveBeenCalled());
    const [id, payload] = api.updateApp.mock.calls[0];
    expect(id).toBe('app-1');
    expect(payload.workTracker).toBe('gitlab');
  });
});
