import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AppTaskCard from './AppTaskCard';

const baseConfig = {
  enabled: true,
  type: 'daily',
  enabledAppCount: 3,
  totalAppCount: 5,
  globalRunCount: 12,
  globalLastRun: '2026-06-20T10:00:00Z',
  status: { nextRunAt: '2999-01-01T00:00:00Z' },
};

function renderCard(overrides = {}, props = {}) {
  const onTrigger = vi.fn();
  const onConfigure = vi.fn();
  render(
    <AppTaskCard
      taskType="code-review"
      config={{ ...baseConfig, ...overrides }}
      onTrigger={onTrigger}
      onConfigure={onConfigure}
      {...props}
    />
  );
  return { onTrigger, onConfigure };
}

describe('AppTaskCard', () => {
  it('shows app coverage prominently', () => {
    renderCard();
    expect(screen.getByText('3/5 apps')).toBeTruthy();
    expect(screen.getByText('App coverage')).toBeTruthy();
  });

  it('shows a future next-run countdown for active scheduled tasks', () => {
    renderCard();
    // timeUntil for a year-2999 date returns an "in …" string.
    expect(screen.getByText(/^in /)).toBeTruthy();
  });

  it('shows "Manual trigger only" for on-demand tasks', () => {
    renderCard({ type: 'on-demand' });
    expect(screen.getByText('Manual trigger only')).toBeTruthy();
  });

  it('shows "Paused" for disabled tasks', () => {
    renderCard({ enabled: false });
    expect(screen.getByText('Paused')).toBeTruthy();
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
});
