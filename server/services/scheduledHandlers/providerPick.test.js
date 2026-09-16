import { describe, expect, it } from 'vitest';

import { isUnfamiliedBurn, noProviderReason, providerForFamily } from './providerPick.js';

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

  // A burn step's provider pin is optional, and an unset one INHERITS. What it
  // must never inherit is another family's subscription: the plan says "spend
  // the codex window", so a codex step with no codex provider registered has to
  // report nothing to burn rather than quietly draining the claude plan.
  it('resolves an unpinned step inside its own family, never falling back to another', () => {
    const providers = [
      { id: 'claude-code-tui', type: 'tui', enabled: true, command: 'claude' },
      { id: 'claude-code', type: 'cli', enabled: true, command: 'claude' },
      { id: 'antigravity-tui', type: 'tui', enabled: true, command: 'agy' },
    ];
    expect(providerForFamily(providers, { familyId: 'claude' })?.id).toBe('claude-code-tui');
    expect(providerForFamily(providers, { familyId: 'codex' })).toBeNull();
    expect(providerForFamily(providers, { familyId: 'grok', prefer: 'cli' })).toBeNull();
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


// A MANUAL maintenance run is not burning a window — it walks the ladder the
// user asked for, on the provider the user picked, and that picker offers every
// enabled process provider. So a provider in no family at all (an OpenCode TUI,
// a local-model wrapper) has to resolve, while the automatic sweep's guarantee
// that a step only ever spends its own family's window stays exactly as it was.
describe('an explicit pin outside every subscription family', () => {
  const providers = [
    { id: 'opencode-tui', type: 'tui', enabled: true, command: 'opencode' },
    { id: 'claude-ollama-tui', type: 'tui', enabled: true, command: 'claude', ollamaBacked: true },
    { id: 'opencode-lmstudio-tui', type: 'tui', enabled: false, command: 'opencode', lmstudioBacked: true },
    { id: 'claude-code-tui', type: 'tui', enabled: true, command: 'claude' },
    { id: 'grok-api', type: 'api', enabled: true },
  ];
  const pick = (providerId) => providerForFamily(providers, { familyId: null, providerId, unfamilied: true });

  it('resolves a family-less provider, including a local-runtime wrapper', () => {
    expect(pick('opencode-tui')?.id).toBe('opencode-tui');
    // The whole point of the mode: a local model has no window, which is a
    // disqualification for a burn and irrelevant to a maintenance ladder.
    expect(pick('claude-ollama-tui')?.id).toBe('claude-ollama-tui');
  });

  it('still requires an ENABLED, process-capable provider', () => {
    expect(pick('opencode-lmstudio-tui')).toBeNull();
    expect(pick('grok-api')).toBeNull();
    expect(pick('not-registered')).toBeNull();
  });

  it('resolves nothing without an explicit pin — there is no family left to match', () => {
    expect(providerForFamily(providers, { familyId: null, unfamilied: true })).toBeNull();
    expect(noProviderReason({ id: null, unfamilied: true })).toContain('must name the provider');
  });

  // The regression the mode must never become: the automatic sweep hands over a
  // real family record and never sets the flag, so a local wrapper stays refused
  // there however it is pinned.
  it('does not relax anything for a familied caller', () => {
    expect(providerForFamily(providers, { familyId: 'claude', providerId: 'claude-ollama-tui' })).toBeNull();
    expect(providerForFamily(providers, { familyId: 'claude', providerId: 'claude-ollama-tui', unfamilied: true })).toBeNull();
    expect(isUnfamiliedBurn({ id: 'claude' })).toBe(false);
    expect(isUnfamiliedBurn({ id: 'claude', unfamilied: true })).toBe(false);
    expect(isUnfamiliedBurn(undefined)).toBe(false);
    expect(isUnfamiliedBurn({ id: null, unfamilied: true })).toBe(true);
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
