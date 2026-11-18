import { describe, it, expect } from 'vitest';
import {
  CODEX_CONTEXT_WINDOW,
  GEMINI_CONTEXT_WINDOW,
  GROK_CONTEXT_WINDOW,
  KIMI_CONTEXT_WINDOW,
  catalogModelContextWindow,
  knownModelContextWindow,
  knownProviderContextWindow,
} from './providerContextWindows.js';

describe('providerContextWindows — known model windows', () => {
  it('resolves known model windows from the selected model id', () => {
    expect(knownModelContextWindow('gpt-5.5')).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownModelContextWindow('gpt-5.4')).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownModelContextWindow('gpt-5.4-mini')).toBe(400_000);
    expect(knownModelContextWindow('gpt-5.4-nano')).toBeNull();
    expect(knownModelContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(knownModelContextWindow('global.anthropic.claude-opus-5')).toBe(1_000_000);
    expect(knownModelContextWindow('claude-opus-4-8')).toBe(1_000_000);
    expect(knownModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(knownModelContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
    expect(knownModelContextWindow('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(knownModelContextWindow('gemini-2.5-pro')).toBe(GEMINI_CONTEXT_WINDOW);
    expect(knownModelContextWindow('unknown-model')).toBeNull();
  });
});

describe('providerContextWindows — known provider windows', () => {
  it('resolves configured-default provider windows by provider identity', () => {
    expect(knownProviderContextWindow({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'antigravity-cli', type: 'cli', command: 'agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    // A custom grok CLI/TUI without an explicit contextWindow resolves the
    // vendor's 256K — the browser's provider-card meter reads this same leaf.
    expect(knownProviderContextWindow({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'grok-tui', type: 'tui', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    // Kimi Code (K2's 256K window).
    expect(knownProviderContextWindow({ id: 'kimi-cli', type: 'cli', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'kimi-tui', type: 'tui', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
  });

  it('answers only for a CLI/TUI provider', () => {
    expect(knownProviderContextWindow({ id: 'codex', type: 'api', command: 'codex' })).toBeNull();
    expect(knownProviderContextWindow(null)).toBeNull();
  });

  it('normalizes command paths to the basename for vendor windows (#2337)', () => {
    // Absolute path to the binary (common when the service PATH can't resolve the CLI).
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'tui', command: '/usr/local/bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    // The shared vendor predicate also accepts the `antigravity` basename, so
    // the window agrees with the effort ladder for that spelling too.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/usr/local/bin/antigravity' })).toBe(GEMINI_CONTEXT_WINDOW);
    // Relative path.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: './bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    // Windows .exe suffix + backslash separators.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: 'C:\\tools\\grok.exe' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    // Unrelated custom command still falls through to null.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/mycli' })).toBeNull();
  });
});

describe('providerContextWindows — catalog windows', () => {
  it('reads the window a model refresh recorded for this model', () => {
    expect(catalogModelContextWindow({ modelContextWindows: { m: 1_000_000 } }, 'm')).toBe(1_000_000);
  });

  it('ignores a malformed or unrelated catalog entry instead of budgeting from it', () => {
    expect(catalogModelContextWindow({ modelContextWindows: { m: 0 } }, 'm')).toBeNull();
    expect(catalogModelContextWindow({ modelContextWindows: { m: 'lots' } }, 'm')).toBeNull();
    expect(catalogModelContextWindow({ modelContextWindows: { other: 1_000 } }, 'm')).toBeNull();
    expect(catalogModelContextWindow({ modelContextWindows: null }, 'm')).toBeNull();
    expect(catalogModelContextWindow({ modelContextWindows: { m: 1_000 } }, null)).toBeNull();
  });
});
