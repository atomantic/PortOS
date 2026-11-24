/**
 * Plan-board state transitions + blocked-step triage (CDO Phase 4, #2186).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiCreativeDirector.js', () => ({
  getCreativeToolCatalog: vi.fn(),
  setCreativeDirectorDirective: vi.fn(),
  replanCreativeDirectorProject: vi.fn(),
  updateCreativeDirectorPlanStep: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder.js', () => ({ listUniverseNames: vi.fn(async () => []) }));
vi.mock('../../services/apiPipeline.js', () => ({ listPipelineSeriesNames: vi.fn(async () => []) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import PlanTab from './PlanTab.jsx';
import {
  getCreativeToolCatalog,
  replanCreativeDirectorProject,
  updateCreativeDirectorPlanStep,
} from '../../services/apiCreativeDirector.js';
import toast from '../ui/Toast';
import { listUniverseNames } from '../../services/apiUniverseBuilder.js';
import { listPipelineSeriesNames } from '../../services/apiPipeline.js';

const CATALOG = {
  tools: [
    { id: 'pipeline_createSeries', costClass: 'free', longRunning: false, destructive: false },
    { id: 'story_generateStep', costClass: 'llm', longRunning: false, destructive: false },
    { id: 'media_enqueueImage', costClass: 'render', longRunning: true, destructive: false },
    { id: 'universe_delete', costClass: 'free', longRunning: false, destructive: true },
  ],
  mode: 'execute',
  budget: { withinBudget: true },
};

const directiveProject = (overrides = {}) => ({
  id: 'cd-1',
  name: 'Noir',
  status: 'rendering',
  directive: { goal: 'Produce a noir series', deliverables: ['story', 'covers'], constraints: { budgetCap: 50 } },
  plan: {
    steps: [
      { stepId: 'series', toolName: 'pipeline_createSeries', status: 'done', dependsOn: [], result: { seriesId: 's9' } },
      { stepId: 'draft', toolName: 'story_generateStep', status: 'running', dependsOn: ['series'] },
      { stepId: 'cover', toolName: 'media_enqueueImage', status: 'pending', dependsOn: ['draft'] },
    ],
  },
  runs: [{ kind: 'plan-step', stepId: 'series', startedAt: '2026-07-01T00:00:00Z', completedAt: '2026-07-01T00:01:00Z' }],
  ...overrides,
});

const renderTab = (project, onProjectUpdate = () => {}) =>
  render(<MemoryRouter><PlanTab project={project} onProjectUpdate={onProjectUpdate} /></MemoryRouter>);

// Drain the mount fetches (catalog/universes/series) inside act so their state
// updates can't land outside it after a test body that never awaits them.
const settle = () => act(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  getCreativeToolCatalog.mockResolvedValue(CATALOG);
});

describe('legacy project (no directive)', () => {
  it('offers to add a directive', async () => {
    renderTab({ id: 'cd-1', name: 'X', status: 'draft', directive: null, plan: null, runs: [] });
    expect(screen.getByText(/No production directive/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add a directive/i })).toBeTruthy();
    await settle();
  });
});

describe('plan board', () => {
  it('renders each step with its status + cost class badge', async () => {
    renderTab(directiveProject());
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    expect(screen.getByText('series')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('cover')).toBeTruthy();
    // done + running + pending statuses present
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    // cost badges (Render for the long-running image step)
    await waitFor(() => expect(screen.getAllByText('Render').length).toBeGreaterThan(0));
  });

  it('links a completed series step into the pipeline series route', async () => {
    renderTab(directiveProject());
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    const link = await screen.findByRole('link', { name: /Open series/i });
    expect(link.getAttribute('href')).toBe('/pipeline/series/s9');
  });

  it('shows the directive goal + deliverables + budget cap', async () => {
    renderTab(directiveProject());
    expect(screen.getByText('Produce a noir series')).toBeTruthy();
    expect(screen.getByText('story')).toBeTruthy();
    expect(screen.getByText('covers')).toBeTruthy();
    expect(screen.getByText(/Budget cap: 50/)).toBeTruthy();
    await settle();
  });

  it('renders a dry-run banner linking to /cos/config when creative autonomy is dry-run', async () => {
    getCreativeToolCatalog.mockResolvedValue({ ...CATALOG, mode: 'dry-run' });
    renderTab(directiveProject());
    await waitFor(() => expect(screen.getByText(/previewed/i)).toBeTruthy());
    const link = screen.getByRole('link', { name: /Chief of Staff .* Config/i });
    expect(link.getAttribute('href')).toBe('/cos/config');
    expect(screen.queryByText(/Settings/i)).toBeNull();
  });

  it('renders an off banner linking to /cos/config when creative autonomy is off', async () => {
    getCreativeToolCatalog.mockResolvedValue({ ...CATALOG, mode: 'off' });
    renderTab(directiveProject());
    await waitFor(() => expect(screen.getByText(/shown for review only/i)).toBeTruthy());
    const link = screen.getByRole('link', { name: /Chief of Staff .* Config/i });
    expect(link.getAttribute('href')).toBe('/cos/config');
    expect(screen.queryByText(/Settings/i)).toBeNull();
  });
});

describe('blocked-step triage', () => {
  const blockedProject = () => directiveProject({
    status: 'paused',
    failureReason: 'Step "draft" is blocked: awaiting human review',
    plan: {
      steps: [
        { stepId: 'series', toolName: 'pipeline_createSeries', status: 'done', dependsOn: [], result: { seriesId: 's9' } },
        { stepId: 'draft', toolName: 'story_generateStep', status: 'blocked', dependsOn: ['series'], result: { reason: 'awaiting human review' } },
      ],
    },
  });

  it('surfaces the pause reason and a resume affordance for the blocked step', async () => {
    renderTab(blockedProject());
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    expect(screen.getByText(/Plan paused/i)).toBeTruthy();
    // Rendered both in the pause banner (failureReason) and the step's result reason.
    expect(screen.getAllByText(/awaiting human review/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Resume .*draft/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Request re-plan/i })).toBeTruthy();
  });

  it('retries a blocked step and pushes the returned project up', async () => {
    const onProjectUpdate = vi.fn();
    updateCreativeDirectorPlanStep.mockResolvedValue({ id: 'cd-1', status: 'rendering', plan: { steps: [] } });
    renderTab(blockedProject(), onProjectUpdate);
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Resume .*draft/i }));
    await waitFor(() => expect(updateCreativeDirectorPlanStep).toHaveBeenCalledWith('cd-1', 'draft', 'retry', { silent: true }));
    await waitFor(() => expect(onProjectUpdate).toHaveBeenCalledWith({ id: 'cd-1', status: 'rendering', plan: { steps: [] } }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/re-queued/i));
  });

  it('requests a re-plan', async () => {
    const onProjectUpdate = vi.fn();
    replanCreativeDirectorProject.mockResolvedValue({ id: 'cd-1', status: 'planning', plan: null });
    renderTab(blockedProject(), onProjectUpdate);
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Request re-plan/i }));
    await waitFor(() => expect(replanCreativeDirectorProject).toHaveBeenCalledWith('cd-1', { silent: true }));
    await waitFor(() => expect(onProjectUpdate).toHaveBeenCalledWith({ id: 'cd-1', status: 'planning', plan: null }));
  });

  it('skips a pending step', async () => {
    updateCreativeDirectorPlanStep.mockResolvedValue({ id: 'cd-1', status: 'rendering', plan: { steps: [] } });
    renderTab(directiveProject());
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    // The pending 'cover' step has a Skip button.
    const skipButtons = screen.getAllByRole('button', { name: /^Skip$/i });
    fireEvent.click(skipButtons[skipButtons.length - 1]);
    await waitFor(() => expect(updateCreativeDirectorPlanStep).toHaveBeenCalledWith('cd-1', 'cover', 'skip', { silent: true }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/skipped/i));
  });
});

describe('approval affordances', () => {
  it('renders an Approve button for a budgeted step when over budget', async () => {
    getCreativeToolCatalog.mockResolvedValue({ ...CATALOG, budget: { withinBudget: false } });
    renderTab(directiveProject({
      plan: {
        steps: [
          { stepId: 'draft', toolName: 'story_generateStep', status: 'pending', dependsOn: [] },
        ],
      },
    }));
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Approve/i })).toBeTruthy();
    expect(screen.getByText(/Over the action budget/i)).toBeTruthy();
  });

  it('surfaces project-specific budget exhaustion for budgeted steps while keeping free steps clear', async () => {
    getCreativeToolCatalog.mockResolvedValue({
      ...CATALOG,
      budget: {
        withinBudget: false,
        exceeded: 'actions',
        reason: 'project-budget',
        project: { withinBudget: false, exceeded: 'actions', budgetCap: 2, used: 2 },
      },
    });
    renderTab(directiveProject({
      directive: { goal: 'Produce a noir series', deliverables: ['story'], constraints: { budgetCap: 2 } },
      plan: {
        steps: [
          { stepId: 'prep', toolName: 'pipeline_createSeries', status: 'pending', dependsOn: [] },
          { stepId: 'draft', toolName: 'story_generateStep', status: 'blocked', dependsOn: ['prep'], result: { reason: 'project-budget' } },
        ],
      },
    }));
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalledWith({ projectId: 'cd-1', silent: true }));
    expect(await screen.findByText(/2\/2 used today — exhausted/i)).toBeTruthy();
    expect(await screen.findByText(/project daily cap reached/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Approve/i })).toHaveLength(1);
  });

  it('displays budgetCap = 0 and DirectiveComposer stricter-cap label copy', async () => {
    render(
      <MemoryRouter initialEntries={['/?directive=edit']}>
        <PlanTab
          project={directiveProject({
            directive: { goal: 'Produce a noir series', deliverables: ['story'], constraints: { budgetCap: 0 } },
          })}
          onProjectUpdate={() => {}}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    expect(screen.getByText(/Budget cap: 0 actions\/day/i)).toBeTruthy();
    expect(screen.getByLabelText(/stricter of project cap and shared CoS daily cap applies/i)).toBeTruthy();
  });

  it('renders an Approve button for a destructive step', async () => {
    renderTab(directiveProject({
      plan: {
        steps: [
          { stepId: 'wipe', toolName: 'universe_delete', status: 'pending', dependsOn: [] },
        ],
      },
    }));
    await waitFor(() => expect(getCreativeToolCatalog).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Approve/i })).toBeTruthy();
    expect(screen.getByText(/Destructive step/i)).toBeTruthy();
  });
});

describe('directive composer pickers', () => {
  it('shows a retryable error when the universe read fails and fills the picker on retry', async () => {
    listUniverseNames.mockRejectedValueOnce(new Error('universes down')).mockResolvedValueOnce([{ id: 'u1', name: 'Example Universe' }]);
    render(<MemoryRouter initialEntries={['/?directive=edit']}><PlanTab project={directiveProject()} onProjectUpdate={() => {}} /></MemoryRouter>);
    expect(await screen.findByText(/Could not load universes — universes down/)).toBeTruthy();
    const seriesCalls = listPipelineSeriesNames.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Example Universe' })).toBeTruthy();
    expect(screen.queryByText(/Could not load universes/)).toBeNull();
    expect(listPipelineSeriesNames.mock.calls.length).toBe(seriesCalls);
  });
});
