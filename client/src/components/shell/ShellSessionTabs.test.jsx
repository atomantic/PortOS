import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShellSessionTabs from './ShellSessionTabs';

const session = (overrides = {}) => ({
  sessionId: 'abcdef123456',
  cwd: '/home/user/example-app',
  createdAt: Date.now(),
  ...overrides,
});

const renderTabs = (sessions, props = {}) =>
  render(
    <ShellSessionTabs
      sessions={sessions}
      activeSessionId={sessions[0]?.sessionId}
      onSwitch={vi.fn()}
      onKill={vi.fn()}
      onNew={vi.fn()}
      {...props}
    />
  );

describe('ShellSessionTabs labels', () => {
  it('shows the folder name for a POSIX cwd', () => {
    renderTabs([session()]);
    expect(screen.getByText('example-app')).toBeTruthy();
  });

  it('shows the folder name for a Windows cwd, not the whole drive path', () => {
    renderTabs([session({ cwd: 'I:\\code\\example-app' })]);
    expect(screen.getByText('example-app')).toBeTruthy();
    expect(screen.queryByText('I:\\code\\example-app')).toBeNull();
  });

  it('ignores a trailing separator on either platform', () => {
    renderTabs([
      session({ sessionId: 'posix1', cwd: '/home/user/example-app/' }),
      session({ sessionId: 'win111', cwd: 'I:\\code\\other-app\\' }),
    ]);
    expect(screen.getByText('example-app')).toBeTruthy();
    expect(screen.getByText('other-app')).toBeTruthy();
  });

  it('falls back to the short session id when the cwd is a bare root', () => {
    renderTabs([session({ sessionId: 'abcdef123456', cwd: '/' })]);
    expect(screen.getByText('abcdef')).toBeTruthy();
  });

  it('keeps the drive segment for a Windows drive root', () => {
    renderTabs([session({ cwd: 'I:\\' })]);
    expect(screen.getByText('I:')).toBeTruthy();
  });

  it('prefers an explicit label over the cwd', () => {
    renderTabs([session({ label: 'Claude Code TUI' })]);
    expect(screen.getByText('Claude Code TUI')).toBeTruthy();
    expect(screen.queryByText('example-app')).toBeNull();
  });

  it('relabels when a cd moves the session cwd', () => {
    const { rerender } = renderTabs([session()]);
    expect(screen.getByText('example-app')).toBeTruthy();

    rerender(
      <ShellSessionTabs
        sessions={[session({ cwd: 'I:\\code\\other-app' })]}
        activeSessionId="abcdef123456"
        onSwitch={vi.fn()}
        onKill={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.getByText('other-app')).toBeTruthy();
    expect(screen.queryByText('example-app')).toBeNull();
  });

  it('kills a session without switching to it', () => {
    const onKill = vi.fn();
    const onSwitch = vi.fn();
    renderTabs([session()], { onKill, onSwitch });
    fireEvent.click(screen.getByRole('button', { name: 'Kill session example-app' }));
    expect(onKill).toHaveBeenCalledWith('abcdef123456');
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('uses non-nested native buttons with group, aria-current, live sr-only text, and session-specific close names', () => {
    const onSwitch = vi.fn();
    renderTabs([
      session({ sessionId: 's1', label: 'alpha' }),
      session({ sessionId: 's2', label: 'beta-run', external: true }),
    ], { activeSessionId: 's1', onSwitch });

    const group = screen.getByRole('group', { name: 'Shell sessions' });
    const buttons = group.querySelectorAll('button');
    for (const btn of buttons) {
      expect(btn.parentElement.closest('button, [role="button"]')).toBeNull();
    }

    const alphaTab = screen.getByRole('button', { name: /^alpha\b/ });
    const betaTab = screen.getByRole('button', { name: /^beta-run\b/ });
    expect(alphaTab.getAttribute('aria-current')).toBe('true');
    expect(betaTab.hasAttribute('aria-current')).toBe(false);
    expect(betaTab.textContent).toContain('Live');

    expect(screen.getByRole('button', { name: 'Kill session alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop run beta-run' })).toBeTruthy();

    fireEvent.click(betaTab);
    expect(onSwitch).toHaveBeenCalledWith('s2');
  });
});
