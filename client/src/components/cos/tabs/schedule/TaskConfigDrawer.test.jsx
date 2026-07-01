import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stub the three config sections + the identity header so the test pins the
// tabbed *layout* TaskConfigDrawer owns (which section shows on which tab, tab
// visibility, deep-link default) without pulling in each section's provider/API
// wiring. Each stub echoes a prop so we can assert the drawer still forwards the
// live config/props through unchanged.
vi.mock('./TaskHeader', () => ({
  default: ({ taskType }) => <div data-testid="task-header">{taskType}</div>,
}));
vi.mock('./PipelineStageConfig', () => ({
  default: ({ taskType }) => <div data-testid="stage-config">stages:{taskType}</div>,
}));
vi.mock('./GlobalConfigControls', () => ({
  default: ({ taskType }) => <div data-testid="global-config">global:{taskType}</div>,
}));
vi.mock('./PerAppOverrideList', () => ({
  default: ({ taskType }) => <div data-testid="override-list">overrides:{taskType}</div>,
}));

import TaskConfigDrawer from './TaskConfigDrawer';

const STAGED_CONFIG = {
  type: 'interval',
  taskMetadata: { pipeline: { stages: [{ name: 'Implement' }, { name: 'Review' }] } },
};
const APPS = [{ id: 'app-1', name: 'One' }, { id: 'app-2', name: 'Two', archived: true }];

function renderDrawer(props = {}, initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TaskConfigDrawer
        open
        taskType="do:next"
        config={STAGED_CONFIG}
        apps={APPS}
        providers={[]}
        onClose={() => {}}
        onUpdate={() => {}}
        onTrigger={() => {}}
        onReset={() => {}}
        onUpdateOverride={() => {}}
        onBulkToggleOverride={() => {}}
        {...props}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaskConfigDrawer tabbed layout', () => {
  it('renders the taskType as the drawer title and keeps the header on every tab', async () => {
    renderDrawer();
    expect(screen.getByRole('dialog', { name: 'do:next' })).toBeInTheDocument();
    expect(screen.getByTestId('task-header')).toHaveTextContent('do:next');
  });

  it('shows all three section tabs with stage/app counts when both are present', () => {
    renderDrawer();
    expect(screen.getByRole('tab', { name: /Stage config/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Global defaults/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Per-app overrides/ })).toBeInTheDocument();
    // Counts surface: 2 stages, 1 active (non-archived) app.
    expect(screen.getByRole('tab', { name: /Stage config/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Per-app overrides/ })).toHaveTextContent('1');
  });

  it('opens on Stage config and mounts only the active tab section', () => {
    renderDrawer();
    expect(screen.getByTestId('stage-config')).toBeInTheDocument();
    expect(screen.queryByTestId('global-config')).not.toBeInTheDocument();
    expect(screen.queryByTestId('override-list')).not.toBeInTheDocument();
  });

  it('switches to Global defaults and Per-app overrides on tab click', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: /Global defaults/ }));
    expect(screen.getByTestId('global-config')).toHaveTextContent('global:do:next');
    expect(screen.queryByTestId('stage-config')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Per-app overrides/ }));
    expect(screen.getByTestId('override-list')).toHaveTextContent('overrides:do:next');
    expect(screen.queryByTestId('global-config')).not.toBeInTheDocument();
  });

  it('honors a deep-linked active tab from the taskTab URL param', () => {
    renderDrawer({}, ['/?taskTab=overrides']);
    expect(screen.getByTestId('override-list')).toBeInTheDocument();
    expect(screen.queryByTestId('stage-config')).not.toBeInTheDocument();
  });

  it('degrades a stale/invalid taskTab param to the default tab', () => {
    renderDrawer({}, ['/?taskTab=bogus']);
    expect(screen.getByTestId('stage-config')).toBeInTheDocument();
  });

  it('hides the Stage config tab and defaults to Global when the task has no pipeline', () => {
    renderDrawer({ config: { type: 'interval' } });
    expect(screen.queryByRole('tab', { name: /Stage config/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('global-config')).toBeInTheDocument();
  });

  it('hides the Per-app overrides tab when there are no active apps', () => {
    renderDrawer({ apps: [{ id: 'a', name: 'A', archived: true }] });
    expect(screen.queryByRole('tab', { name: /Per-app overrides/ })).not.toBeInTheDocument();
  });

  it('renders nothing when config is not yet loaded', () => {
    const { container } = renderDrawer({ config: null });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
