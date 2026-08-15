import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SlashDoRunDrawer from './SlashDoRunDrawer';

const api = vi.hoisted(() => ({
  getCodeReviewDefaults: vi.fn(),
  getProviders: vi.fn(),
  // Backs the reviewer table's Model column (useReviewerModelOptions).
  getLocalLlmStatus: vi.fn(),
  getAppWorkItems: vi.fn(),
  createSlashdoTask: vi.fn()
}));

vi.mock('../../services/api', () => api);

// The drawer's `highlightToolUse` picker fetches the backends' authoritative
// tool-use capabilities from apiLocalLlm directly (not through services/api),
// so stub it here or the suite makes a real network call. Parked unresolved —
// the annotation itself is covered in ProviderModelSelector.test.jsx.
vi.mock('../../services/apiLocalLlm', () => ({
  getToolUseModels: vi.fn(() => new Promise(() => {})),
}));

const renderDrawer = (props = {}) => render(
  <SlashDoRunDrawer
    open
    command="next"
    label="/do:next"
    appId="acme"
    appName="Acme App"
    onClose={vi.fn()}
    onQueued={vi.fn()}
    {...props}
  />
);

describe('SlashDoRunDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['copilot'], usernames: [], optionalReviewers: [] });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    api.getAppWorkItems.mockResolvedValue({
      tracker: 'github',
      issueAuthorFilter: 'self',
      items: [{ ref: '7', title: 'Fix the thing' }, { ref: '9', title: 'Add the other' }],
      count: 2,
      reason: 'actionable-issues',
      transient: false
    });
    api.createSlashdoTask.mockResolvedValue({ id: 'task-1', status: 'pending' });
  });

  it('queues an agent-picks run without fetching the tracker', async () => {
    const onQueued = vi.fn();
    renderDrawer({ onQueued });

    await userEvent.click(screen.getByRole('button', { name: /Queue \/do:next/ }));

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.getAppWorkItems).not.toHaveBeenCalled();
    const [command, appId, settings] = api.createSlashdoTask.mock.calls.at(-1);
    expect(command).toBe('next');
    expect(appId).toBe('acme');
    expect(settings.target).toBeUndefined();
    expect(settings.simplify).toBe(true);
    // Untouched reviewer controls must NOT pin a list — the server resolves the
    // app's configured claim-work reviewers instead.
    expect(settings.reviewers).toBeUndefined();
  });

  it('sends the reviewer list only once the user edits it', async () => {
    const onQueued = vi.fn();
    renderDrawer({ onQueued });

    await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Remove Copilot/ }));
    await userEvent.click(screen.getByRole('button', { name: /Queue \/do:next/ }));

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    const [, , settings] = api.createSlashdoTask.mock.calls.at(-1);
    expect(settings.reviewers).toEqual([]);
  });

  it('hides the stop-mode and reviewer-applies controls the claim flow cannot honor', async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());
    // Add a second, non-Copilot reviewer — the two flags render at 2+ / non-copilot.
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));

    expect(screen.queryByText('Stop mode:')).not.toBeInTheDocument();
    expect(screen.queryByText(/Reviewer applies fixes/)).not.toBeInTheDocument();
  });

  it('hides the reviewer picker entirely for a command that cannot honor it', async () => {
    // Only the `next` branch of POST /tasks/slashdo reads the reviewer fields —
    // every other `/do:*` body owns its own review/PR sequence. Rendering the
    // picker there would let the user pick a reviewer and a model and have the run
    // silently discard both.
    renderDrawer({ command: 'better', label: '/do:better' });

    await waitFor(() => expect(screen.getByText('Task settings')).toBeInTheDocument());
    expect(screen.queryByText('Reviewers (in order):')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub reviewers (gate merge):')).not.toBeInTheDocument();
  });

  it('never sends reviewer fields for a non-next command', async () => {
    renderDrawer({ command: 'better', label: '/do:better' });

    await waitFor(() => expect(screen.getByText('Task settings')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Queue/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalled());
    const [, , body] = api.createSlashdoTask.mock.calls[0];
    expect(body.reviewers).toBeUndefined();
    expect(body.reviewerModels).toBeUndefined();
    expect(body.reviewerMaxRounds).toBeUndefined();
  });

  it('lists the tracker items once "pick a specific" is chosen and sends the pinned ref', async () => {
    const onQueued = vi.fn();
    renderDrawer({ onQueued });

    await userEvent.click(screen.getByRole('radio', { name: /Pick a specific/ }));
    await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('radio', { name: /Add the other/ }));
    await userEvent.click(screen.getByRole('button', { name: /Queue \/do:next/ }));

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    const [, , settings] = api.createSlashdoTask.mock.calls.at(-1);
    expect(settings.target).toBe('9');
    expect(settings.issueAuthorFilter).toBe('self');
  });

  it('blocks submission until an item is selected in pick mode', async () => {
    renderDrawer();

    await userEvent.click(screen.getByRole('radio', { name: /Pick a specific/ }));
    await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Queue \/do:next/ })).toBeDisabled();
  });

  it('distinguishes an unreachable tracker from an empty queue', async () => {
    api.getAppWorkItems.mockResolvedValue({
      tracker: 'github', issueAuthorFilter: 'self', items: [], count: 0,
      reason: 'gh-list-failed', transient: true
    });
    renderDrawer();

    await userEvent.click(screen.getByRole('radio', { name: /Pick a specific/ }));

    await waitFor(() => expect(screen.getByText(/Couldn't reach the tracker/)).toBeInTheDocument());
  });

  it('stops re-requesting after a failed fetch instead of looping', async () => {
    api.getAppWorkItems.mockRejectedValue(new Error('boom'));
    renderDrawer();

    await userEvent.click(screen.getByRole('radio', { name: /Pick a specific/ }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(api.getAppWorkItems).toHaveBeenCalledTimes(1);
  });
});
