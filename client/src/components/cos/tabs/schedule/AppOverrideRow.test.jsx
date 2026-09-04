import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import AppOverrideRow from './AppOverrideRow';

const APP = { id: 'app-1', name: 'Acme' };

function renderRow({
  globalTaskMetadata = {},
  override = null,
  onUpdate = vi.fn().mockResolvedValue(undefined),
  taskType = 'feature-ideas',
  fileIssuesCapable,
  defaultFileIssues,
  doWorkRequiresWorktree,
  inheritedProviderText,
  providers,
} = {}) {
  render(
    <AppOverrideRow
      app={APP}
      taskType={taskType}
      globalIntervalType="daily"
      globalTaskMetadata={globalTaskMetadata}
      managedAgentOptions={[]}
      fileIssuesCapable={fileIssuesCapable}
      defaultFileIssues={defaultFileIssues}
      doWorkRequiresWorktree={doWorkRequiresWorktree}
      inheritedProviderText={inheritedProviderText}
      providers={providers}
      override={override}
      onUpdate={onUpdate}
    />
  );
  return onUpdate;
}

const prSelect = () => screen.queryByLabelText('After opening PR for Acme');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppOverrideRow — After opening PR override', () => {
  it('is absent when neither the app nor the global config opens a PR', () => {
    renderRow({ globalTaskMetadata: { useWorktree: true, openPR: false } });
    expect(prSelect()).not.toBeInTheDocument();
  });

  it('appears when the app override turns Open PR on for an otherwise-off task', () => {
    renderRow({ globalTaskMetadata: { openPR: false }, override: { taskMetadata: { openPR: true } } });
    expect(prSelect()).toBeInTheDocument();
  });

  it('names the inherited policy on the Inherit option', () => {
    renderRow({ globalTaskMetadata: { openPR: true, prCompletion: 'merge-on-green' } });
    expect(prSelect()).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Inherit (Merge on green CI)' })).toBeInTheDocument();
  });

  it('falls back to "app default" when the global config pins nothing', () => {
    renderRow({ globalTaskMetadata: { openPR: true } });
    expect(screen.getByRole('option', { name: 'Inherit (app default)' })).toBeInTheDocument();
  });

  it('writes the override without disturbing the app\'s other overrides', async () => {
    const onUpdate = renderRow({
      globalTaskMetadata: { openPR: true },
      override: { taskMetadata: { simplify: false } },
    });
    await act(async () => { fireEvent.change(prSelect(), { target: { value: 'leave-open' } }); });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'feature-ideas', {
      taskMetadata: { simplify: false, prCompletion: 'leave-open' },
    });
  });

  it('clears the override back to inherit', async () => {
    const onUpdate = renderRow({
      globalTaskMetadata: { openPR: true },
      override: { taskMetadata: { prCompletion: 'leave-open' } },
    });
    expect(prSelect()).toHaveValue('leave-open');
    await act(async () => { fireEvent.change(prSelect(), { target: { value: '' } }); });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'feature-ideas', { taskMetadata: null });
  });
});

describe('AppOverrideRow — issue exclude labels override', () => {
  const excludeLabelsInput = () => screen.queryByLabelText('Labels to leave for humans for Acme');

  it('is absent for a task type without the issue author filter', () => {
    renderRow({ taskType: 'feature-ideas' });
    expect(excludeLabelsInput()).not.toBeInTheDocument();
  });

  it('seeds from an existing override and commits a parsed list on blur', async () => {
    const onUpdate = renderRow({
      taskType: 'claim-issue',
      globalTaskMetadata: { issueExcludeLabels: [] },
      override: { taskMetadata: { issueExcludeLabels: ['good first issue'] } },
    });
    expect(excludeLabelsInput()).toHaveValue('good first issue');

    fireEvent.change(excludeLabelsInput(), { target: { value: 'good first issue, help wanted' } });
    await act(async () => { fireEvent.blur(excludeLabelsInput()); });

    expect(onUpdate).toHaveBeenCalledWith('app-1', 'claim-issue', {
      taskMetadata: { issueExcludeLabels: ['good first issue', 'help wanted'] },
    });
  });

  it('clears the override back to inherit when the input is emptied', async () => {
    const onUpdate = renderRow({
      taskType: 'claim-work',
      globalTaskMetadata: { issueExcludeLabels: ['good first issue'] },
      override: { taskMetadata: { issueExcludeLabels: ['help wanted'] } },
    });

    fireEvent.change(excludeLabelsInput(), { target: { value: '' } });
    await act(async () => { fireEvent.blur(excludeLabelsInput()); });

    expect(onUpdate).toHaveBeenCalledWith('app-1', 'claim-work', { taskMetadata: null });
  });

  describe('explicit-empty override ("None" checkbox)', () => {
    const noneCheckbox = () => screen.getByLabelText('None');

    it('is unchecked when there is no override, and when the override is a non-empty list', () => {
      renderRow({ taskType: 'claim-issue', globalTaskMetadata: { issueExcludeLabels: ['good first issue'] } });
      expect(noneCheckbox()).not.toBeChecked();
    });

    it('reflects an existing explicit-empty override distinctly from inherit — both render a blank text box', () => {
      renderRow({
        taskType: 'claim-issue',
        globalTaskMetadata: { issueExcludeLabels: ['good first issue'] },
        override: { taskMetadata: { issueExcludeLabels: [] } },
      });
      expect(excludeLabelsInput()).toHaveValue('');
      expect(noneCheckbox()).toBeChecked();
    });

    it('checking it submits an explicit empty array override, letting this app opt out of every inherited exclusion', async () => {
      const onUpdate = renderRow({
        taskType: 'claim-issue',
        globalTaskMetadata: { issueExcludeLabels: ['good first issue'] },
      });
      expect(noneCheckbox()).not.toBeChecked();

      await act(async () => { fireEvent.click(noneCheckbox()); });

      expect(onUpdate).toHaveBeenCalledWith('app-1', 'claim-issue', {
        taskMetadata: { issueExcludeLabels: [] },
      });
    });

    it('unchecking it clears the override back to inherit', async () => {
      const onUpdate = renderRow({
        taskType: 'claim-work',
        globalTaskMetadata: { issueExcludeLabels: ['good first issue'] },
        override: { taskMetadata: { issueExcludeLabels: [] } },
      });
      expect(noneCheckbox()).toBeChecked();

      await act(async () => { fireEvent.click(noneCheckbox()); });

      expect(onUpdate).toHaveBeenCalledWith('app-1', 'claim-work', { taskMetadata: null });
    });
  });
});

describe('AppOverrideRow — file issues only', () => {
  it('shows the Iss toggle for audit-capable tasks and hides it otherwise', () => {
    renderRow({ taskType: 'feature-ideas' });
    expect(screen.queryByRole('button', { name: /File issues only/i })).not.toBeInTheDocument();
  });

  it('toggles fileIssues as a per-app override', async () => {
    const onUpdate = renderRow({
      taskType: 'security',
      fileIssuesCapable: true,
      defaultFileIssues: false,
      globalTaskMetadata: { fileIssues: false },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /File issues only/i }));
    });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'security', {
      taskMetadata: { fileIssues: true, useWorktree: false, openPR: false, simplify: false },
    });
  });

  it('restores required worktree isolation in a per-app do-work override', async () => {
    const onUpdate = renderRow({
      taskType: 'module-hygiene',
      fileIssuesCapable: true,
      defaultFileIssues: true,
      doWorkRequiresWorktree: true,
      globalTaskMetadata: { fileIssues: true, useWorktree: false, openPR: false },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /File issues only/i }));
    });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'module-hygiene', {
      taskMetadata: { fileIssues: false, useWorktree: true },
    });
  });
});

describe('AppOverrideRow — branch-reconcile batch size', () => {
  it('allows an app to inherit or override the global branch batch', async () => {
    const onUpdate = renderRow({
      taskType: 'branch-reconcile',
      globalTaskMetadata: { branchesPerAgent: 3 },
      override: { taskMetadata: { branchesPerAgent: 2 } }
    });
    const select = screen.getByLabelText('Branches per agent for Acme');
    expect(select).toHaveValue('2');
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'branch-reconcile', { taskMetadata: null });
  });
});

// The per-app provider/model pin beats the task's own pin at spawn for EVERY task
// type (#4783) — so the Schedule page, where that task pin is chosen, both shows
// what an app is running on and lets it be changed there.
describe('AppOverrideRow — per-app provider pin', () => {
  const PROVIDERS = [
    { id: 'opencode-llama-tui', name: 'OpenCode (llama)', models: ['qwen-a'] },
    { id: 'claude-ollama-tui', name: 'Claude (ollama)', models: ['qwen-b'] },
  ];
  const INHERITED = 'OpenCode (llama) / qwen-a';
  const pinSelect = () => screen.getByLabelText('Provider for Acme');

  it('renders the app pin, on a task type with no buildTaskInput hook', () => {
    renderRow({
      taskType: 'feature-ideas',
      inheritedProviderText: INHERITED,
      providers: PROVIDERS,
      override: { enabled: true, providerId: 'claude-ollama-tui', model: 'qwen-b' },
    });
    expect(pinSelect()).toHaveValue('claude-ollama-tui');
    expect(screen.getByLabelText('Model')).toHaveValue('qwen-b');
  });

  it('names the task pin on the Inherit option when the app pins nothing', () => {
    renderRow({
      taskType: 'layered-intelligence',
      inheritedProviderText: INHERITED,
      providers: PROVIDERS,
      override: { enabled: true },
    });
    expect(pinSelect()).toHaveValue('');
    expect(screen.getByRole('option', { name: `Inherit (${INHERITED})` })).toBeInTheDocument();
  });

  it('clearing the provider sends explicit nulls so the app falls back to the task pin', async () => {
    const onUpdate = renderRow({
      taskType: 'layered-intelligence',
      inheritedProviderText: INHERITED,
      providers: PROVIDERS,
      override: { enabled: true, providerId: 'claude-ollama-tui', model: 'qwen-b' },
    });
    await act(async () => { fireEvent.change(pinSelect(), { target: { value: '' } }); });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'layered-intelligence', { providerId: null, model: null });
  });

  it('switching providers drops the model pinned for the previous one', async () => {
    const onUpdate = renderRow({
      taskType: 'ux',
      inheritedProviderText: INHERITED,
      providers: PROVIDERS,
      override: { enabled: true, providerId: 'claude-ollama-tui', model: 'qwen-b' },
    });
    await act(async () => { fireEvent.change(pinSelect(), { target: { value: 'opencode-llama-tui' } }); });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'ux', { providerId: 'opencode-llama-tui', model: null });
  });
});

describe('AppOverrideRow — enabled toggle', () => {
  // The switch is what turns the scheduled task on for the app; it is NOT an
  // "apply my overrides" flag. It carries no visible on/off text, so the
  // accessible name has to say which task, which app, and the current state.
  // The row renders the switch twice (a mobile slot and a desktop one), so both
  // are asserted rather than indexing into the list.
  it('names the task, the app, and the current state on every slot', () => {
    renderRow({ taskType: 'feature-ideas' });
    const off = screen.getAllByRole('switch', { name: 'feature-ideas enabled for Acme: off' });
    expect(off).toHaveLength(2);
    off.forEach(sw => expect(sw).toHaveAttribute('aria-checked', 'false'));

    cleanup();
    renderRow({ taskType: 'feature-ideas', override: { enabled: true } });
    const on = screen.getAllByRole('switch', { name: 'feature-ideas enabled for Acme: on' });
    expect(on).toHaveLength(2);
    on.forEach(sw => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('enables the task for the app while preserving its interval override', async () => {
    const onUpdate = renderRow({ override: { enabled: false, interval: 'on-demand' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch', { name: 'feature-ideas enabled for Acme: off' })[0]);
    });
    expect(onUpdate).toHaveBeenCalledWith('app-1', 'feature-ideas', { enabled: true, interval: 'on-demand' });
  });
});
