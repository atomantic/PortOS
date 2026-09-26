import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CodeReviewersTab from './CodeReviewersTab';
import * as api from '../../services/api';
import toast from '../ui/Toast';

vi.mock('../../services/api', () => ({
  getCodeReviewDefaults: vi.fn(),
  updateSettings: vi.fn(),
}));

const pickerData = vi.hoisted(() => ({ current: { ctxById: {} } }));
vi.mock('../../hooks/useReviewerModelOptions', () => ({ default: () => pickerData.current }));

vi.mock('../ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const renderTab = (ui, path = '/') => render(
  <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>,
);

const openFollowUp = async () => {
  fireEvent.click(await screen.findByRole('tab', { name: 'Follow-up' }));
};

describe('CodeReviewersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pickerData.current = { ctxById: {} };
  });

  afterEach(() => {
    cleanup();
  });

  it('round-trips configured provider model and effort pins without changing legacy defaults', async () => {
    pickerData.current = {
      loaded: true,
      providers: [
        { id: 'example-gpu', name: 'Example GPU', type: 'cli', command: 'claude', enabled: true, models: ['coder-a', 'coder-b'] },
        { id: 'disabled-api', name: 'Disabled API', type: 'api', enabled: false, models: ['other'] },
      ],
      optionsByReviewer: { 'provider:example-gpu': ['coder-a', 'coder-b'] },
      freeText: { 'provider:example-gpu': true },
    };
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['copilot'], codexModel: 'legacy-model', claudeEffort: 'medium' });
    api.updateSettings.mockResolvedValue({});
    const view = renderTab(<CodeReviewersTab />);
    const provider = await screen.findByLabelText('Provider');
    expect(screen.queryByRole('option', { name: 'Disabled API' })).not.toBeInTheDocument();
    fireEvent.change(provider, { target: { value: 'example-gpu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider reviewer' }));
    fireEvent.change(screen.getByLabelText('Model for Example GPU'), { target: { value: 'coder-b' } });
    fireEvent.change(screen.getByLabelText('Reasoning effort for Example GPU'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1));
    const saved = api.updateSettings.mock.calls[0][0].codeReview;
    expect(saved).toMatchObject({
      reviewers: ['provider:example-gpu', 'copilot'],
      providerModels: { 'provider:example-gpu': 'coder-b' },
      providerEfforts: { 'provider:example-gpu': 'high' },
      codexModel: 'legacy-model', claudeEffort: 'medium',
    });
    view.unmount();
    api.getCodeReviewDefaults.mockResolvedValue(saved);
    renderTab(<CodeReviewersTab />);
    expect(await screen.findByLabelText('Model for Example GPU')).toHaveValue('coder-b');
    expect(screen.getByLabelText('Reasoning effort for Example GPU')).toHaveValue('high');
    fireEvent.change(screen.getByLabelText('Reasoning effort for Example GPU'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    expect(api.updateSettings.mock.calls[1][0].codeReview).toMatchObject({
      providerModels: { 'provider:example-gpu': 'coder-b' }, providerEfforts: {},
      codexModel: 'legacy-model', claudeEffort: 'medium',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText('Remove Example GPU'));
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(3));
    expect(api.updateSettings.mock.calls[2][0].codeReview).toMatchObject({ reviewers: ['copilot'], providerModels: {}, providerEfforts: {} });
  });

  it('edits persisted tier priority, shares pins across memberships, and saves only nonempty tiers', async () => {
    const token = 'provider:example-gpu';
    pickerData.current = {
      loaded: true, providers: [{ id: 'example-gpu', name: 'Example GPU', enabled: true, command: 'codex', models: ['custom-coder'] }],
      optionsByReviewer: { [token]: ['custom-coder'] },
    };
    api.getCodeReviewDefaults.mockResolvedValue({
      // The active runtime tier is intentionally not the configured Primary.
      reviewers: ['codex'], reviewerFallbackGroups: [[token, 'ollama'], ['codex']],
      providerModels: { [token]: 'custom-coder' }, providerEfforts: { [token]: 'high' },
      optionalReviewers: [token, '@example-bot'], reviewerMaxRounds: { [token]: 1, '@example-bot': 2 },
      usernames: ['example-bot'], stopMode: 'consensus', reviewerApplies: true,
    });
    api.updateSettings.mockResolvedValue({});
    const view = renderTab(<CodeReviewersTab />);
    const primary = await screen.findByRole('region', { name: 'Primary' });
    expect(within(primary).getByLabelText('Model for Example GPU')).toHaveValue('custom-coder');
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Fallback reviewer groups')).not.toBeInTheDocument();
    const fallback = screen.getByRole('region', { name: 'Fallback 1' });
    fireEvent.change(within(fallback).getByLabelText('Provider'), { target: { value: 'example-gpu' } });
    fireEvent.click(within(fallback).getByText('Add provider reviewer'));
    expect(screen.getAllByLabelText('Model for Example GPU')).toHaveLength(2);
    fireEvent.change(within(fallback).getByLabelText('Provider'), { target: { value: 'example-gpu' } });
    expect(within(fallback).getByText('Add provider reviewer')).toBeDisabled();
    fireEvent.change(within(fallback).getByLabelText('Reasoning effort for Example GPU'), { target: { value: 'low' } });
    expect(within(primary).getByLabelText('Reasoning effort for Example GPU')).toHaveValue('low');
    fireEvent.click(within(primary).getByLabelText('Remove Example GPU'));
    expect(screen.getByLabelText('Model for Example GPU')).toHaveValue('custom-coder');
    fireEvent.change(screen.getByLabelText('Tier for codex in Fallback 1'), { target: { value: 'tier-0' } });
    fireEvent.click(screen.getByLabelText('Move Primary later'));
    fireEvent.click(screen.getByText('Add tier'));
    fireEvent.click(screen.getByText('Save defaults'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const saved = api.updateSettings.mock.lastCall[0].codeReview;
    expect(saved).toMatchObject({
      reviewers: [token], reviewerFallbackGroups: [[token], ['ollama', 'codex']],
      providerModels: { [token]: 'custom-coder' }, providerEfforts: { [token]: 'low' },
      optionalReviewers: [token, '@example-bot'], reviewerMaxRounds: { [token]: 1, '@example-bot': 2 },
      usernames: ['example-bot'], stopMode: 'consensus', reviewerApplies: true,
    });
    expect(screen.queryByRole('region', { name: 'Fallback 2' })).not.toBeInTheDocument();
    view.unmount();
    api.getCodeReviewDefaults.mockResolvedValue(saved);
    renderTab(<CodeReviewersTab />);
    fireEvent.click(await screen.findByText('Save defaults'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    expect(api.updateSettings.mock.lastCall[0].codeReview).toEqual(saved);
    await waitFor(() => expect(screen.getByText('Save defaults')).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText('Remove Primary'));
    expect(screen.queryByLabelText('Model for Example GPU')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove Primary'));
    fireEvent.click(screen.getByText('Save defaults'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(3));
    expect(api.updateSettings.mock.lastCall[0].codeReview).toMatchObject({
      reviewers: [], reviewerFallbackGroups: [], usernames: ['example-bot'], providerModels: {}, providerEfforts: {},
      optionalReviewers: ['@example-bot'], reviewerMaxRounds: { '@example-bot': 2 },
    });
  });

  it('respects explicit empty groups despite a legacy roster and gates failed or in-flight saves', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['codex'], reviewerFallbackGroups: [], usernames: ['example-bot'] });
    let rejectSave;
    api.updateSettings.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderTab(<CodeReviewersTab />);
    fireEvent.click(await screen.findByText('Save defaults'));
    expect(screen.getByText('Saving…')).toBeDisabled();
    expect(screen.getByText('Add tier')).toBeDisabled();
    expect(screen.getByLabelText('Remove @example-bot')).toBeDisabled();
    expect(api.updateSettings.mock.lastCall[0].codeReview).toMatchObject({ reviewers: [], reviewerFallbackGroups: [], usernames: ['example-bot'] });
    rejectSave(new Error('example failure'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('example failure')));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Remove @example-bot')).not.toBeDisabled();
    api.updateSettings.mockResolvedValue({});
    fireEvent.click(screen.getByText('Save defaults'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('does not enable save after a malformed defaults response', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['codex'], reviewerFallbackGroups: [['codex'], null] });
    renderTab(<CodeReviewersTab />);
    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    expect(screen.getByText('Save defaults')).toBeDisabled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('renders loading state initially and populates panel when fetch succeeds', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });

    renderTab(<CodeReviewersTab />);

    expect(screen.getByText('Loading defaults…')).toBeInTheDocument();

    expect(await screen.findByText('Save defaults')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledWith({ silent: true });
  });

  it('shows the last failed review attempt with the settings fix', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      reviewerConfigFaults: { ollama: { code: 'NO_MODEL', lastFailureAt: 123 } },
    });

    renderTab(<CodeReviewersTab />);

    expect(await screen.findByText(/ollama: the last review attempt failed \(NO_MODEL\)/)).toBeInTheDocument();
    expect(screen.getByText(/The next successful review clears this warning/)).toBeInTheDocument();
    expect(screen.getByText(/Select a model on Review chain/)).toBeInTheDocument();
  });

  it('identifies a provider access refusal and its configuration remedy', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['opencode', 'codex'],
      optionalReviewers: ['opencode'],
      reviewerConfigFaults: { opencode: { code: 'REVIEWER_ACCESS_DENIED', lastFailureAt: 123 } },
    });
    renderTab(<CodeReviewersTab />);
    expect(await screen.findByText(/opencode: the last review attempt failed/)).toHaveTextContent('Select an accessible service or model, or correct provider access.');
    expect(screen.getByText(/The next successful review clears this warning/)).toBeInTheDocument();
  });

  it('renders error banner with Retry button and disables Save button when fetch rejects', async () => {
    api.getCodeReviewDefaults.mockRejectedValue(new Error('Network error'));

    renderTab(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).toBeDisabled();
  });

  it('re-fetches defaults when Retry button is clicked and enables Save button on success', async () => {
    api.getCodeReviewDefaults
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        reviewers: ['codex'],
        usernames: [],
        optionalReviewers: [],
        reviewerMaxRounds: {},
        stopMode: 'consensus',
        reviewerApplies: false,
      });

    renderTab(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledTimes(2);
  });

  it('handles save when Save defaults button is clicked', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });
    api.updateSettings.mockResolvedValue({ success: true });

    renderTab(<CodeReviewersTab />);

    const saveBtn = await screen.findByRole('button', { name: 'Save defaults' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
  });

  // The goal-fidelity gate (#5994) — the second review, which asks whether a
  // finished run delivered the objective rather than whether the code is good.
  it('round-trips the goal-fidelity gate, and defaults an absent block to on', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
    });
    api.updateSettings.mockResolvedValue({});

    renderTab(<CodeReviewersTab />);
    await openFollowUp();
    const checkbox = await screen.findByLabelText(/Check finished runs against the task objective/);
    // An install that has never saved the block must read as ON — persisting a
    // stored `false` here would silently switch off a gate nobody turned off.
    expect(checkbox).toBeChecked();

    fireEvent.change(screen.getByLabelText('Local model runtime'), { target: { value: 'lmstudio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const [payload] = api.updateSettings.mock.calls[0];
    // The scalars are dropped when unset (absent = inherit), and so is the
    // trigger while neither action is armed — pinning it would freeze an
    // install on today's default forever. The follow-up BOOLEANS always ride:
    // false there is the user's OFF, not 'inherit', and dropping one would make
    // that switch un-clearable once it had been on.
    expect(payload.codeReview.goalFidelity).toEqual({
      enabled: true, backend: 'lmstudio', fileIssue: false, queueTask: false,
    });
  });

  it('sends an explicit off switch, and drops the unset pins rather than persisting empty ones', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
      goalFidelity: { enabled: true, backend: null, model: null, effort: null },
    });
    api.updateSettings.mockResolvedValue({});

    renderTab(<CodeReviewersTab />);
    await openFollowUp();
    fireEvent.click(await screen.findByLabelText(/Check finished runs against the task objective/));
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].codeReview.goalFidelity).toEqual({
      enabled: false, fileIssue: false, queueTask: false,
    });
  });

  // The follow-up half (#7690): what happens once the gate HAS a finding.
  it('round-trips the follow-up actions and their trigger', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
      goalFidelity: { enabled: true, fileIssue: true, queueTask: false, followUpOn: 'any-finding' },
    });
    api.updateSettings.mockResolvedValue({});

    renderTab(<CodeReviewersTab />);
    await openFollowUp();
    expect(await screen.findByLabelText(/File an issue on the project/)).toBeChecked();
    expect(screen.getByLabelText(/Queue an agent to reconcile it/)).not.toBeChecked();
    expect(screen.getByLabelText('Act on which verdicts')).toHaveValue('any-finding');

    fireEvent.click(screen.getByLabelText(/Queue an agent to reconcile it/));
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].codeReview.goalFidelity).toMatchObject({
      fileIssue: true, queueTask: true, followUpOn: 'any-finding',
    });
  });

  // Filing on someone's tracker and spawning an unattended run are each opt-in,
  // so an absent block must read as off — the mirror image of `enabled` above.
  it('defaults both follow-up actions to off when the stored block omits them', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
      goalFidelity: { enabled: true },
    });

    renderTab(<CodeReviewersTab />);
    await openFollowUp();
    expect(await screen.findByLabelText(/File an issue on the project/)).not.toBeChecked();
    expect(screen.getByLabelText(/Queue an agent to reconcile it/)).not.toBeChecked();
    // The trigger is meaningless until an action is armed.
    expect(screen.getByLabelText('Act on which verdicts')).toBeDisabled();
  });

  // Turning the gate off leaves no verdict for a follow-up to act on, so the
  // actions have to go inert with it rather than reading as still armed.
  it('disables the follow-up actions when the gate itself is off', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
      goalFidelity: { enabled: false, fileIssue: true },
    });

    renderTab(<CodeReviewersTab />);
    await openFollowUp();
    expect(await screen.findByLabelText(/File an issue on the project/)).toBeDisabled();
    expect(screen.getByLabelText(/Queue an agent to reconcile it/)).toBeDisabled();
  });

  it('keeps tier instructions in one drawer and splits follow-up onto its own view', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      reviewerFallbackGroups: [['codex'], ['ollama']],
    });
    renderTab(<CodeReviewersTab />);
    expect(await screen.findByRole('region', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fallback 1' })).toBeInTheDocument();
    expect(screen.getAllByText(/One paused reviewer skips that whole tier/)).toHaveLength(1);
    expect(screen.queryByText(/Add a configured provider/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tool-free first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The first tier with every member unpaused/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Check finished runs against the task objective/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'How this works' }));
    const help = await screen.findByRole('dialog', { name: 'How code review works' });
    expect(within(help).getByText(/The first tier whose reviewers are all available runs/)).toBeInTheDocument();
    expect(within(help).getByText(/Follow-up is a second check/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close how code review works' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'How code review works' })).not.toBeInTheDocument());

    await openFollowUp();
    expect(screen.queryByRole('region', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Check finished runs against the task objective/)).toBeInTheDocument();
    expect(screen.getByText(/After a run ships, compare its diff/)).toBeInTheDocument();
  });

  it('sends an unknown task slug back to the review chain', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({ reviewers: ['codex'] });
    renderTab(<CodeReviewersTab />, '/models/code-reviewers/not-a-view');
    expect(await screen.findByRole('region', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Review chain' })).toHaveAttribute('aria-selected', 'true');
  });
});
