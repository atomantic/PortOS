import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShellProviderLauncher, { launchableProviders } from './ShellProviderLauncher';

const tui = (overrides = {}) => ({
  id: 'claude-code-tui',
  name: 'Claude Code TUI',
  type: 'tui',
  enabled: true,
  tuiCommandLine: 'claude --dangerously-skip-permissions',
  ...overrides,
});

const open = (props = {}) => {
  const onLaunch = vi.fn();
  render(<ShellProviderLauncher providers={[tui()]} onLaunch={onLaunch} {...props} />);
  fireEvent.click(screen.getByLabelText('Launch an AI CLI'));
  return onLaunch;
};

describe('launchableProviders', () => {
  it('keeps only enabled TUI providers the server resolved a command line for', () => {
    const ids = launchableProviders([
      tui({ id: 'a' }),
      tui({ id: 'disabled', enabled: false }),
      // A CLI provider's args are headless (`--print`) — it has no interactive
      // form, and the server gives it no tuiCommandLine.
      { id: 'claude-code', name: 'Claude Code CLI', type: 'cli', enabled: true },
      { id: 'ollama', name: 'Ollama', type: 'api', enabled: true },
      // A TUI whose command the server could not resolve is not launchable.
      tui({ id: 'unresolved', tuiCommandLine: undefined }),
    ]).map((p) => p.id);
    expect(ids).toEqual(['a']);
  });

  it('sorts by display name so the list is stable as providers toggle', () => {
    const ids = launchableProviders([
      tui({ id: 'z', name: 'Zed TUI' }),
      tui({ id: 'a', name: 'Antigravity TUI' }),
      tui({ id: 'm', name: 'MTPLX TUI' }),
    ]).map((p) => p.id);
    expect(ids).toEqual(['a', 'm', 'z']);
  });

  it('tolerates a missing provider list', () => {
    expect(launchableProviders(undefined)).toEqual([]);
  });
});

describe('ShellProviderLauncher', () => {
  it('launches by provider ID, never by typing the command line', () => {
    const onLaunch = open();
    fireEvent.click(screen.getByText('Claude Code TUI'));
    // The ID is the whole point: the server pairs it with the provider's env.
    expect(onLaunch).toHaveBeenCalledWith('claude-code-tui');
  });

  it('shows the resolved command line so the user sees what will run', () => {
    open();
    expect(screen.getByText('claude --dangerously-skip-permissions')).toBeTruthy();
  });

  it('closes the menu after a launch', () => {
    open();
    fireEvent.click(screen.getByText('Claude Code TUI'));
    expect(screen.queryByText('Claude Code TUI')).toBeNull();
  });

  it('points at the Providers page when nothing is enabled', () => {
    render(<ShellProviderLauncher providers={[tui({ enabled: false })]} onLaunch={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Launch an AI CLI'));
    expect(screen.getByText(/No enabled TUI providers/)).toBeTruthy();
  });

  it('flags a provider the server says cannot run here, but still offers it', () => {
    const onLaunch = open({ providers: [tui({ prerequisitesMet: false })] });
    expect(screen.getByText('setup')).toBeTruthy();
    fireEvent.click(screen.getByText('Claude Code TUI'));
    expect(onLaunch).toHaveBeenCalledWith('claude-code-tui');
  });

  it('offers no filter box for a short list', () => {
    open();
    expect(screen.queryByLabelText('Filter providers')).toBeNull();
  });

  // The host loads /api/providers lazily — a Shell visit that never opens this
  // menu must not pay for the biggest payload on the page.
  it('asks the host to load providers on open, not on mount', () => {
    const onOpen = vi.fn();
    render(<ShellProviderLauncher providers={[]} onLaunch={vi.fn()} onOpen={onOpen} loading />);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Launch an AI CLI'));
    expect(onOpen).toHaveBeenCalled();
    // An in-flight load reads as loading, not as "you have no providers".
    expect(screen.getByText(/Loading providers/)).toBeTruthy();
    expect(screen.queryByText(/No enabled TUI providers/)).toBeNull();
  });

  it('filters a long list on name, id, or command line', () => {
    const many = [
      tui({ id: 'opencode-ollama-tui', name: 'OpenCode Ollama TUI', tuiCommandLine: 'opencode' }),
      tui({ id: 'codex-tui', name: 'Codex TUI', tuiCommandLine: 'codex --dangerously-bypass-approvals-and-sandbox' }),
      tui({ id: 'antigravity-tui', name: 'Antigravity TUI', tuiCommandLine: 'agy --dangerously-skip-permissions' }),
      tui({ id: 'grok-tui', name: 'Grok Build TUI', tuiCommandLine: 'grok' }),
      tui({ id: 'kimi-tui', name: 'Kimi Code TUI', tuiCommandLine: 'kimi --yolo' }),
      tui({ id: 'cursor-tui', name: 'Cursor Agent TUI', tuiCommandLine: 'cursor-agent --force' }),
    ];
    open({ providers: many });
    const filter = screen.getByLabelText('Filter providers');

    fireEvent.change(filter, { target: { value: 'ollama' } });
    expect(screen.getByText('OpenCode Ollama TUI')).toBeTruthy();
    expect(screen.queryByText('Codex TUI')).toBeNull();

    // Matches the command line, not just the display name — `agy` is how the
    // user knows Antigravity.
    fireEvent.change(filter, { target: { value: 'agy' } });
    expect(screen.getByText('Antigravity TUI')).toBeTruthy();
    expect(screen.queryByText('OpenCode Ollama TUI')).toBeNull();

    // Multi-word, any-order — the shared matcher, so this box behaves like
    // every other filter in the app.
    fireEvent.change(filter, { target: { value: 'tui opencode' } });
    expect(screen.getByText('OpenCode Ollama TUI')).toBeTruthy();
    expect(screen.queryByText('Codex TUI')).toBeNull();

    fireEvent.change(filter, { target: { value: 'nothing-matches' } });
    expect(screen.getByText(/No providers match/)).toBeTruthy();
  });

  it('closes on Escape', () => {
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Claude Code TUI')).toBeNull();
  });

  it("exposes popup state, moves focus into the panel, and returns it to the trigger on Escape", () => {
    open();
    const trigger = screen.getByLabelText("Launch an AI CLI");
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByText("Claude Code TUI").closest("button"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
