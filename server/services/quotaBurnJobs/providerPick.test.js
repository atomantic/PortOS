import { describe, expect, it } from 'vitest';

import { noProviderReason, providerForFamily } from './providerPick.js';

const cliProviders = [
  { id: 'grok-cli', type: 'cli', enabled: true },
  { id: 'claude-code', type: 'cli', enabled: true },
];

describe('providerForFamily', () => {
  it('matches an enabled CLI/TUI provider by family name', () => {
    expect(providerForFamily(cliProviders, { familyId: 'grok' })?.id).toBe('grok-cli');
  });

  it('honors an explicit pin and ignores API-type providers', () => {
    // The job exists to spend a SUBSCRIPTION window; an API provider bills per
    // token instead, so burning through it would cost real money.
    expect(providerForFamily(cliProviders, { familyId: 'grok', providerId: 'claude-code' })?.id).toBe('claude-code');
    expect(providerForFamily([{ id: 'grok-api', type: 'api', enabled: true }], { familyId: 'grok' })).toBeNull();
    expect(providerForFamily([{ id: 'grok-cli', type: 'cli', enabled: false }], { familyId: 'grok' })).toBeNull();
  });

  // A burn runs unattended for minutes on the user's own subscription — the TUI
  // is the one that can be watched in Active Agents and steered mid-run. Most
  // families register both, and the CLI sorts first, so a plain `find` picked
  // the unobservable one every time.
  it('prefers the TUI provider over the CLI in the same family', () => {
    const providers = [
      { id: 'grok-cli', type: 'cli', enabled: true },
      { id: 'grok-tui', type: 'tui', enabled: true },
    ];
    expect(providerForFamily(providers, { familyId: 'grok' })?.id).toBe('grok-tui');
    // Registry order must not decide it either way.
    expect(providerForFamily([...providers].reverse(), { familyId: 'grok' })?.id).toBe('grok-tui');
    // CLI-only families still resolve — the preference is not a requirement.
    expect(providerForFamily([{ id: 'grok-cli', type: 'cli', enabled: true }], { familyId: 'grok' })?.id).toBe('grok-cli');
    // An explicit pin still outranks the preference.
    expect(providerForFamily(providers, { familyId: 'grok', providerId: 'grok-cli' })?.id).toBe('grok-cli');
  });

  // The whole `agy` family was unreachable: its providers ship as
  // `antigravity-cli` / `antigravity-tui`, neither of which contains "agy", so a
  // configured Antigravity plan reported "no enabled CLI/TUI provider" forever —
  // under a quota card that was showing a healthy window, because that card's
  // matcher checks the command.
  it('matches on the provider BINARY, not just the id — the agy/antigravity case', () => {
    const providers = [
      { id: 'antigravity-cli', type: 'cli', enabled: true, command: 'agy' },
      { id: 'antigravity-tui', type: 'tui', enabled: true, command: 'agy' },
    ];
    expect(providerForFamily(providers, { familyId: 'agy' })?.id).toBe('antigravity-tui');
    // An absolute path still resolves by basename.
    expect(providerForFamily([{ id: 'custom', type: 'tui', enabled: true, command: '/opt/tools/agy' }], { familyId: 'agy' })?.id).toBe('custom');
    // And the id substring still works for a wrapper whose basename differs.
    expect(providerForFamily([{ id: 'grok-tui', type: 'tui', enabled: true, command: 'grok-wrapper.sh' }], { familyId: 'grok' })?.id).toBe('grok-tui');
    // An unrelated family must not be dragged in by either signal.
    expect(providerForFamily(providers, { familyId: 'codex' })).toBeNull();
  });

  it('never selects an ollama-backed wrapper — a local model has no window to burn', () => {
    // `claude-ollama-tui` matches the `claude` family and IS a TUI, so the
    // preference above would reach for it. It runs a local model: nothing
    // expires, nothing is spent, and the window it was supposed to drain goes
    // unused. Same exclusion `resolveEnabledFamilies` applies to the cards.
    const providers = [
      { id: 'claude-ollama-tui', type: 'tui', enabled: true, ollamaBacked: true },
      { id: 'opencode-mtplx-tui', type: 'tui', enabled: true, mtplxBacked: true },
      { id: 'opencode-lmstudio-tui', type: 'tui', enabled: true, lmstudioBacked: true },
      { id: 'claude-code-tui', type: 'tui', enabled: true },
      { id: 'claude-code', type: 'cli', enabled: true },
    ];
    expect(providerForFamily(providers, { familyId: 'claude' })?.id).toBe('claude-code-tui');
    // Not even by explicit pin — it cannot do the one thing the job is for.
    expect(providerForFamily(providers, { familyId: 'claude', providerId: 'claude-ollama-tui' })).toBeNull();
    expect(providerForFamily(providers, { familyId: 'claude', providerId: 'opencode-mtplx-tui' })).toBeNull();
    expect(providerForFamily(providers, { familyId: 'opencode', providerId: 'opencode-lmstudio-tui' })).toBeNull();
    expect(providerForFamily([providers[0]], { familyId: 'claude' })).toBeNull();
  });
});


describe('the cli preference for programmatic jobs', () => {
  it('flips the default without forking the helper', () => {
    // A programmatic job sends one headless prompt through the stage runner:
    // no agent session to watch or steer, so the TUI buys nothing and its
    // interactive startup is pure overhead.
    const providers = [
      { id: 'codex-tui', type: 'tui', enabled: true, command: 'codex' },
      { id: 'codex', type: 'cli', enabled: true, command: 'codex' },
    ];
    expect(providerForFamily(providers, { familyId: 'codex', prefer: 'cli' })?.id).toBe('codex');
    expect(providerForFamily(providers, { familyId: 'codex' })?.id).toBe('codex-tui');
    // The other type stays a fallback — a TUI-only family must not stop burning.
    expect(providerForFamily([providers[0]], { familyId: 'codex', prefer: 'cli' })?.id).toBe('codex-tui');
  });
});

describe('noProviderReason', () => {
  it('is one string so countPending and run cannot word the same refusal differently', () => {
    expect(noProviderReason({ id: 'claude' })).toContain('claude');
    expect(noProviderReason(undefined)).toContain('undefined');
  });
});
