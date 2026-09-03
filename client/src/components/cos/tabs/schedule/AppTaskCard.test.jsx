import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The card's pins render a `highlightToolUse` ProviderModelSelector, which
// fetches the backends' authoritative tool-use capabilities. Park that scan
// unresolved: this suite is about the provider/model/effort pins, not the
// tool-use annotation (covered in ProviderModelSelector.test.jsx), and a scan
// that settles mid-test would land a state update outside act() in the
// synchronous cases below.
vi.mock('../../../../services/apiLocalLlm', () => ({
  getToolUseModels: vi.fn(() => new Promise(() => {})),
}));

import AppTaskCard from './AppTaskCard';

// `claude-code-*` ids carry the claude effort ladder (see effortLevelsForProvider).
const providers = [
  { id: 'claude-code', name: 'Claude Code', models: ['opus', 'sonnet'] },
  { id: 'gemini', name: 'Gemini', models: ['gemini-3-pro'] },
];

const baseConfig = {
  enabled: true,
  type: 'daily',
  enabledAppCount: 3,
  totalAppCount: 5,
  globalRunCount: 12,
  globalLastRun: '2026-06-20T10:00:00Z',
  status: { nextRunAt: '2999-01-01T00:00:00Z' },
};

function renderCard(overrides = {}, props = {}, taskType = 'code-review') {
  const onTrigger = vi.fn();
  const onConfigure = vi.fn();
  render(
    <AppTaskCard
      taskType={taskType}
      config={{ ...baseConfig, ...overrides }}
      onTrigger={onTrigger}
      onConfigure={onConfigure}
      {...props}
    />
  );
  return { onTrigger, onConfigure };
}

// Card with the inline provider/model/effort pins wired up.
function renderCardWithPins(overrides = {}, props = {}) {
  const onUpdate = props.onUpdate || vi.fn().mockResolvedValue(true);
  return { onUpdate, ...renderCard(overrides, { providers, ...props, onUpdate }) };
}

describe('AppTaskCard', () => {
  it('shows app coverage prominently', () => {
    renderCard();
    expect(screen.getByText('3/5 apps')).toBeTruthy();
    expect(screen.getByText('App coverage')).toBeTruthy();
  });

  it('shows the shipped task summary beneath the task name', () => {
    const summary = 'Review contributor changes before they merge';
    renderCard({ description: summary });
    expect(screen.getByText(summary)).toBeInTheDocument();
  });

  it('shows a future next-run countdown for active scheduled tasks', () => {
    renderCard();
    // timeUntil for a year-2999 date returns an "in …" string.
    expect(screen.getByText(/^in /)).toBeTruthy();
  });

  it('renders a clean Scheduled badge and next-run schedule description for cron tasks', () => {
    renderCard({ type: 'cron', cronExpression: '0 6 * * 1-5' }, {}, 'layered-intelligence');
    expect(screen.getByText('Scheduled')).toBeTruthy();
    // Perpetual is an ORTHOGONAL badge, so a plain cron task never shows one.
    expect(screen.queryByText('Perpetual')).toBeNull();
    expect(screen.getAllByTitle('Weekdays at 06:00 (0 6 * * 1-5)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^in .* · Weekdays at 06:00/)).toBeTruthy();
    expect(screen.getByText('layered-intelligence')).toBeTruthy();
  });

  it('shows "Manual trigger only" for on-demand tasks', () => {
    renderCard({ type: 'on-demand' });
    expect(screen.getByText('Manual trigger only')).toBeTruthy();
  });

  it('renders BOTH badges for a scheduled task that also drains perpetually', () => {
    renderCard({ type: 'cron', cronExpression: '0 6 * * 1-5', perpetual: true });
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText('Perpetual')).toBeTruthy();
  });

  it('shows "Paused" for disabled tasks', () => {
    renderCard({ enabled: false });
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('marks an automation-only task and removes direct actions', () => {
    const { onTrigger, onConfigure } = renderCard({
      invocation: {
        kind: 'subsidiary',
        visibility: 'visible',
        userInvokable: false,
        label: 'Automation-only',
        description: 'Runs from a parent automation.'
      }
    });
    expect(screen.getAllByText('Automation-only').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Run Now|Run on App/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Configure/i })).not.toBeInTheDocument();
    expect(onTrigger).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it('shows the dependency wait state', () => {
    renderCard({ status: { reason: 'waiting-on-dependencies', pendingDeps: ['build'] } });
    expect(screen.getByText(/waiting on build/)).toBeTruthy();
  });

  it('fires a global on-demand run when the task has no managed apps', () => {
    const { onTrigger, onConfigure } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Run Now/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure/ }));
    expect(onTrigger).toHaveBeenCalledWith('code-review');
    expect(onConfigure).toHaveBeenCalledWith('code-review');
  });

  it('runs with app context via the app picker when the task targets apps', () => {
    const apps = [{ id: 'app-1', name: 'Widget App' }, { id: 'app-2', name: 'Archived', archived: true }];
    const { onTrigger } = renderCard({}, { apps });
    // With apps present the quick action becomes a "Run on App" picker, not a contextless run.
    fireEvent.click(screen.getByRole('button', { name: /Run on App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Widget App/ }));
    expect(onTrigger).toHaveBeenCalledWith('code-review', 'app-1');
    // Archived apps are excluded from the picker.
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('does not trigger when improvement is disabled', () => {
    const { onTrigger } = renderCard({}, { improvementDisabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Run Now/i }));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('shows never-run state when no prior run', () => {
    renderCard({ globalLastRun: null });
    expect(screen.getByText('Never run')).toBeTruthy();
  });

  it('shows a swarm badge when swarmCount ≥ 2 and hides it otherwise', () => {
    renderCard({ taskMetadata: { swarmCount: 3 } });
    expect(screen.getByText('×3')).toBeTruthy();
    expect(screen.getByTitle(/Swarm mode/)).toBeTruthy();
  });

  it('hides the swarm badge when swarm is off (absent / 0)', () => {
    renderCard({ taskMetadata: { swarmCount: 0 } });
    expect(screen.queryByText(/^×\d/)).toBeNull();
    renderCard({});
    expect(screen.queryByText(/^×\d/)).toBeNull();
  });

  it('shows the configured branch batch badge on branch-reconcile', () => {
    renderCard({ taskMetadata: { branchesPerAgent: 4 } }, {}, 'branch-reconcile');
    expect(screen.getByText('×4')).toBeTruthy();
    expect(screen.getByTitle(/up to 4 branch/)).toBeTruthy();
  });

  it('omits the quick model pins when no onUpdate handler is supplied', () => {
    renderCard({}, { providers });
    expect(screen.queryByLabelText('Provider')).toBeNull();
  });

  describe('quick model pins', () => {
    it('persists a provider pick and clears the model + effort pins with it', async () => {
      const { onUpdate } = renderCardWithPins({ providerId: 'gemini', model: 'gemini-3-pro' });
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude-code' } });
      await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('code-review', {
        providerId: 'claude-code', model: null, effort: null,
      }));
      // Model options follow the newly picked provider.
      expect(screen.getByRole('option', { name: 'opus' })).toBeTruthy();
    });

    it('persists a model pick on its own', async () => {
      const { onUpdate } = renderCardWithPins({ providerId: 'claude-code' });
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'sonnet' } });
      await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('code-review', { model: 'sonnet' }));
    });

    it('clears a pin back to the provider default', async () => {
      const { onUpdate } = renderCardWithPins({ providerId: 'claude-code', model: 'opus' });
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
      await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('code-review', { model: null }));
    });

    it('offers effort only for effort-capable providers', () => {
      renderCardWithPins({ providerId: 'claude-code' });
      expect(screen.getByLabelText('Thinking effort')).toBeTruthy();
      expect(screen.getByRole('option', { name: 'xhigh' })).toBeTruthy();
    });

    it('hides effort for a provider with no ladder', () => {
      renderCardWithPins({ providerId: 'gemini' });
      expect(screen.queryByLabelText('Thinking effort')).toBeNull();
    });

    it('resolves model + effort options against the active provider when nothing is pinned', () => {
      renderCardWithPins({}, { activeProviderId: 'claude-code' });
      // Naming what "Default" resolves to is what makes the options below it readable.
      expect(screen.getByRole('option', { name: 'Default (active: Claude Code)' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'sonnet' })).toBeTruthy();
      expect(screen.getByLabelText('Thinking effort')).toBeTruthy();
    });

    it('falls back to a bare Default when the active provider is unknown', () => {
      renderCardWithPins();
      expect(within(screen.getByLabelText('Provider')).getByRole('option', { name: 'Default (active provider)' })).toBeTruthy();
      expect(screen.queryByLabelText('Thinking effort')).toBeNull();
    });

    it('hides a disabled provider from the picker unless the task is pinned to it', () => {
      const withDisabled = [...providers, { id: 'retired', name: 'Retired CLI', enabled: false }];
      renderCardWithPins({}, { providers: withDisabled });
      expect(screen.queryByRole('option', { name: 'Retired CLI' })).toBeNull();
      renderCardWithPins({ providerId: 'retired' }, { providers: withDisabled });
      expect(screen.getAllByRole('option', { name: 'Retired CLI' }).length).toBe(1);
    });

    it('keeps a pinned model the provider no longer lists selectable', () => {
      renderCardWithPins({ providerId: 'claude-code', model: 'retired-model' });
      expect(screen.getByLabelText('Model').value).toBe('retired-model');
    });

    it('blocks Run while a pin write is still in flight, then re-enables it', async () => {
      let resolveUpdate;
      const onUpdate = vi.fn(() => new Promise(resolve => { resolveUpdate = resolve; }));
      const { onTrigger } = renderCardWithPins({ providerId: 'claude-code' }, { onUpdate });

      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'sonnet' } });
      const run = screen.getByRole('button', { name: /Run Now/i });
      await waitFor(() => expect(run.disabled).toBe(true));
      fireEvent.click(run);
      expect(onTrigger).not.toHaveBeenCalled();

      resolveUpdate(true);
      await waitFor(() => expect(run.disabled).toBe(false));
      fireEvent.click(run);
      expect(onTrigger).toHaveBeenCalledWith('code-review');
    });

    it('rolls the selection back when the write fails', async () => {
      const onUpdate = vi.fn().mockResolvedValue(false);
      renderCardWithPins({ providerId: 'claude-code', model: 'opus' }, { onUpdate });
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'sonnet' } });
      await waitFor(() => expect(screen.getByLabelText('Model').value).toBe('opus'));
    });

    it('points pipeline tasks at the drawer instead of a card-level pin', () => {
      const { onConfigure } = renderCardWithPins({
        taskMetadata: { pipeline: { stages: [{ name: 'plan' }, { name: 'build' }] } },
      });
      expect(screen.queryByLabelText('Provider')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /set per stage \(2\)/ }));
      expect(onConfigure).toHaveBeenCalledWith('code-review');
    });
  });
});
