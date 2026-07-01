import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

import * as api from '../../services/api';
import EditAppDrawer from './EditAppDrawer';

const APP = {
  id: 'app-1',
  name: 'My App',
  repoPath: '/repo',
  workTracker: 'auto',
};

// The drawer is now tabbed and deep-links its active tab via a URL search param
// (useDrawerTab), so every render needs a real router around it.
function renderDrawer(props = {}) {
  return render(
    <MemoryRouter>
      <EditAppDrawer app={APP} onClose={() => {}} onSave={() => {}} {...props} />
    </MemoryRouter>
  );
}

// Switch to a named tab pill (both a desktop tab button and a mobile <select>
// option render; target the tab button).
async function openTab(name) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

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

describe('EditAppDrawer tabbed layout', () => {
  it('opens on the General tab with the name field visible', async () => {
    renderDrawer();
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    // Work Tracker lives on a different tab, so it should not be mounted yet.
    expect(screen.queryByLabelText('Work Tracker')).not.toBeInTheDocument();
  });

  it('renders all six section tabs', async () => {
    renderDrawer();
    for (const label of ['General', 'Ports & TLS', 'Commands', 'Workflow', 'JIRA', 'DataDog']) {
      expect(await screen.findByRole('tab', { name: label })).toBeInTheDocument();
    }
  });
});

describe('EditAppDrawer work tracker selector', () => {
  it('renders a labeled select with the five tracker options on the Workflow tab', async () => {
    renderDrawer();
    await openTab('Workflow');

    const select = await screen.findByLabelText('Work Tracker');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('auto');

    const optionValues = Array.from(select.querySelectorAll('option')).map(o => o.value);
    expect(optionValues).toEqual(['auto', 'plan', 'github', 'gitlab', 'jira']);
  });

  it('shows the resolved auto target from the work-tracker endpoint', async () => {
    renderDrawer();
    await openTab('Workflow');

    await screen.findByLabelText('Work Tracker');
    expect(api.getAppWorkTracker).toHaveBeenCalledWith('app-1');
    await waitFor(() =>
      expect(screen.getByText(/Auto → GitHub Issues \(origin: github\.com\)/)).toBeInTheDocument()
    );
  });

  it('updates the selection locally and includes workTracker in the save payload', async () => {
    renderDrawer();
    await openTab('Workflow');

    const select = await screen.findByLabelText('Work Tracker');
    fireEvent.change(select, { target: { value: 'gitlab' } });
    expect(select).toHaveValue('gitlab');

    // The Save button lives in the footer and is present on every tab.
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.updateApp).toHaveBeenCalled());
    const [id, payload] = api.updateApp.mock.calls[0];
    expect(id).toBe('app-1');
    expect(payload.workTracker).toBe('gitlab');
  });
});

describe('EditAppDrawer required-field validation across tabs', () => {
  // The required Name/Repository Path inputs live on the General tab and are
  // unmounted while another tab is active, so browser `required` validation
  // can't block a Save from another tab. handleSubmit must validate explicitly.
  it('blocks Save from a non-General tab when Name is empty and surfaces General', async () => {
    renderDrawer({ app: { ...APP, name: '' } });
    await openTab('Workflow');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText('Name and Repository Path are required.')).toBeInTheDocument()
    );
    expect(api.updateApp).not.toHaveBeenCalled();
    // The General tab is surfaced so the offending field is visible again.
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });

  it('blocks Save when Repository Path is empty', async () => {
    renderDrawer({ app: { ...APP, repoPath: '   ' } });
    await openTab('Workflow');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText('Name and Repository Path are required.')).toBeInTheDocument()
    );
    expect(api.updateApp).not.toHaveBeenCalled();
  });
});
