/**
 * The Codex-harness-on-a-local-model contract (#6305).
 *
 * Codex 0.153.0 ships `--oss` / `--local-provider <lmstudio|ollama>`, so PortOS
 * swaps the model behind the Codex harness with a pair of per-invocation flags
 * instead of rewriting the user's `~/.codex/config.toml`. What this pins is the
 * ARGV — the one place the swap is expressed — plus the two ways it must fail
 * closed: a codex record marked with a runtime Codex cannot serve, and a Codex
 * binary too old to know the flags.
 */

import { describe, expect, it } from 'vitest';
import { buildCodexOssArgs } from './codex.js';
import {
  CODEX_OSS_MIN_VERSION,
  codexOssLocalProvider,
  codexUnsupportedLocalRuntime,
} from './providerModels.js';
import { applyCommandDefaults, buildVendorCliArgs, buildVendorSpawnConfig } from './providerVendors.js';
import { buildTuiInvocation } from './tuiHandshake.js';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from './agentExecutionProfiles.js';
import { providerPrerequisites, blocksRouting } from './providerPrerequisites.js';
import { isCodexSubscriptionProvider } from './codexAccount.js';

const codexCloud = { id: 'codex', type: 'cli', command: 'codex', args: [] };
const codexOllama = { id: 'codex-ollama', type: 'cli', command: 'codex', args: [], ollamaBacked: true };

// The flags, as one adjacent triple — codex rejects `--local-provider` on its own.
const ossTriple = ['--oss', '--local-provider', 'ollama'];
const hasOssTriple = (args) => {
  const i = args.indexOf('--oss');
  return i !== -1 && args.slice(i, i + 3).join(' ') === ossTriple.join(' ');
};

describe('codexOssLocalProvider / codexUnsupportedLocalRuntime', () => {
  it('maps the ollama marker onto codex\'s own --local-provider value', () => {
    expect(codexOssLocalProvider(codexOllama)).toBe('ollama');
    expect(codexUnsupportedLocalRuntime(codexOllama)).toBeNull();
  });

  it('is null for a cloud record and for a hosted gateway', () => {
    expect(codexOssLocalProvider(codexCloud)).toBeNull();
    // A gateway is an OpenCode namespace and a REMOTE API — never a local daemon.
    expect(codexOssLocalProvider({ ...codexCloud, gatewayBacked: 'openrouter' })).toBeNull();
    expect(codexUnsupportedLocalRuntime({ ...codexCloud, gatewayBacked: 'openrouter' })).toBeNull();
  });

  it('names a local runtime codex cannot serve rather than silently ignoring it', () => {
    // PortOS's marker axis carries five runtimes; codex serves two by name.
    // Returning null here would run the record against the OpenAI cloud while
    // the card claimed it was local.
    expect(codexOssLocalProvider({ ...codexCloud, vllmBacked: true })).toBeNull();
    expect(codexUnsupportedLocalRuntime({ ...codexCloud, vllmBacked: true })).toBe('vllm');
  });

  it('yields to a user who already pinned either flag in their provider args', () => {
    expect(buildCodexOssArgs(codexOllama, ['--oss'])).toEqual([]);
    expect(buildCodexOssArgs(codexOllama, ['--local-provider', 'ollama'])).toEqual([]);
    expect(buildCodexOssArgs(codexOllama, [])).toEqual(ossTriple);
  });
});

describe('codex argv carries the local backing on every recipe', () => {
  it('adds the flags to the headless one-shot argv, before the stdin marker', () => {
    const args = buildVendorCliArgs(codexOllama, [], { model: 'qwen3:8b', effort: null });
    expect(hasOssTriple(args)).toBe(true);
    expect(args.indexOf('--oss')).toBeGreaterThan(args.indexOf('exec'));
    expect(args.indexOf('--oss')).toBeLessThan(args.indexOf('-'));
    // The local model id still rides `--model`; the flags select the BACKEND.
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'qwen3:8b']);
  });

  it('adds them to the coding-agent spawn argv', () => {
    const { command, args } = buildVendorSpawnConfig(codexOllama, { effectiveModel: 'qwen3:8b' });
    expect(command).toBe('codex');
    expect(hasOssTriple(args)).toBe(true);
  });

  it('leaves a cloud codex argv untouched', () => {
    expect(buildVendorCliArgs(codexCloud, [], { model: 'gpt-5.6-terra', effort: null })).not.toContain('--oss');
    expect(buildVendorSpawnConfig(codexCloud, { effectiveModel: 'gpt-5.6-terra' }).args).not.toContain('--oss');
  });

  it('routes a renamed codex record through the codex recipe, not claude\'s fallback row', () => {
    // The vendor registry used to match codex by provider ID alone, so any
    // record other than the shipped `codex` fell through to claude's
    // unconditionally-true row and got `claude --print` argv on the codex binary.
    const renamed = { id: 'my-codex', type: 'cli', command: 'codex', args: [] };
    expect(buildVendorCliArgs(renamed, [], { model: null, effort: null })).toContain('exec');
  });
});

describe('the INTERACTIVE paths carry the backing too', () => {
  // Both TUI spawn paths (`buildTuiInvocation` here, `buildTuiSpawnConfig` in
  // agentTuiSpawning.js) share `applyCommandDefaults` as their posture step, so
  // that is the single place the backing has to land. Without it an attached
  // `codex-ollama` session reaches the OpenAI cloud while every headless run of
  // the same record goes to the daemon — the worst kind of split, because the
  // record and the card both still say "local".
  const codexOllamaTui = { id: 'codex-ollama-tui', type: 'tui', command: 'codex', args: [], ollamaBacked: true };

  it('emits the flags from the shared posture step both TUI paths call', () => {
    expect(hasOssTriple(applyCommandDefaults('codex', [], codexOllamaTui))).toBe(true);
    expect(applyCommandDefaults('codex', [], { id: 'codex-tui', type: 'tui', command: 'codex' })).not.toContain('--oss');
    // No provider at all is a cloud record's answer, never a crash.
    expect(applyCommandDefaults('codex', [])).not.toContain('--oss');
  });

  it('reaches the interactive invocation alongside the bypass posture', () => {
    const { command, args } = buildTuiInvocation(codexOllamaTui, 'qwen3:8b');
    expect(command).toBe('codex');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(hasOssTriple(args)).toBe(true);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'qwen3:8b']);
  });
});

describe('the public-review recipe keeps its posture AND gains the backing', () => {
  it('emits the exact sandbox posture flags plus the local backing', () => {
    const { args } = buildVendorSpawnConfig(codexOllama, {
      effectiveModel: 'qwen3:8b',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    // The posture is the enforcement and must not shift because the backing did.
    expect(args.slice(0, 6)).toEqual([
      'exec', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', '--ignore-user-config',
    ]);
    // `--ignore-user-config` does not strip the pair: it is argv, not config.
    expect(hasOssTriple(args)).toBe(true);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('keeps a cloud codex public review byte-identical apart from the backing', () => {
    const local = buildVendorSpawnConfig(codexOllama, {
      effectiveModel: 'm', safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    }).args;
    const cloud = buildVendorSpawnConfig(codexCloud, {
      effectiveModel: 'm', safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    }).args;
    expect(local.filter((arg) => !ossTriple.includes(arg))).toEqual(cloud);
  });
});

// Codex's SECOND `--local-provider` value. It shipped unmapped because PortOS
// had no LM Studio backing marker; with `lmstudioBacked` on the axis (#6309) the
// table row is the whole change, and everything below has to follow from it —
// including the `codexLocalRuntime` finding no longer firing, which is the same
// switch that decides whether the record routes at all.
describe('the lmstudio marker rides the same seam as ollama', () => {
  const codexLmstudio = { id: 'codex-lmstudio', type: 'cli', command: 'codex', args: [], lmstudioBacked: true };
  const lmstudioTriple = ['--oss', '--local-provider', 'lmstudio'];
  const hasLmstudioTriple = (args) => {
    const i = args.indexOf('--oss');
    return i !== -1 && args.slice(i, i + 3).join(' ') === lmstudioTriple.join(' ');
  };

  it('maps the marker onto codex\'s own value rather than reporting it unsupported', () => {
    expect(codexOssLocalProvider(codexLmstudio)).toBe('lmstudio');
    expect(codexUnsupportedLocalRuntime(codexLmstudio)).toBeNull();
  });

  it('carries the flags on the ordinary and the public-review argv', () => {
    expect(hasLmstudioTriple(buildVendorCliArgs(codexLmstudio, [], { model: 'qwen3-coder-30b', effort: null }))).toBe(true);
    expect(hasLmstudioTriple(buildVendorSpawnConfig(codexLmstudio, { effectiveModel: 'qwen3-coder-30b' }).args)).toBe(true);
    const review = buildVendorSpawnConfig(codexLmstudio, {
      effectiveModel: 'qwen3-coder-30b',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    }).args;
    expect(review.slice(0, 6)).toEqual([
      'exec', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', '--ignore-user-config',
    ]);
    expect(hasLmstudioTriple(review)).toBe(true);
  });

  it('raises neither the unsupported-runtime nor the ChatGPT-account finding', () => {
    expect(providerPrerequisites(codexLmstudio, { codexOssSupport: { supported: true } }).missing).toEqual([]);
    expect(isCodexSubscriptionProvider(codexLmstudio)).toBe(false);
    expect(providerPrerequisites(codexLmstudio, {
      codexAccount: { status: 'signed-out' },
      codexOssSupport: { supported: true },
    }).missing).toEqual([]);
  });
});

describe('prerequisites fail closed and legibly', () => {
  it('reports nothing while the flag probe has not answered', () => {
    // `null` is NOT PROBED — an unprobed CLI must never take a working provider
    // out of the fallback chain.
    expect(providerPrerequisites(codexOllama, { codexOssSupport: null }).missing).toEqual([]);
    expect(providerPrerequisites(codexOllama, { codexOssSupport: { supported: true } }).met).toBe(true);
  });

  it('names the required CLI version when the installed codex has no --oss', () => {
    const { met, missing } = providerPrerequisites(codexOllama, { codexOssSupport: { supported: false } });
    expect(met).toBe(false);
    expect(missing).toEqual([
      { code: 'codexOss', label: `Codex CLI ${CODEX_OSS_MIN_VERSION}+ is required to run a local model (--oss)` },
    ]);
    // Blocking: no credential or config makes an absent flag exist, so routing
    // skips the candidate instead of dying on it mid-run.
    expect(blocksRouting(missing)).toBe(true);
  });

  it('blocks a codex record marked with a runtime codex cannot serve', () => {
    const { missing } = providerPrerequisites({ ...codexCloud, sglangBacked: true }, { codexOssSupport: { supported: true } });
    expect(missing.map((entry) => entry.code)).toEqual(['codexLocalRuntime']);
    expect(missing[0].label).toContain('sglang');
    expect(blocksRouting(missing)).toBe(true);
  });

  it('never charges a NON-codex provider with either finding', () => {
    const claudeOllama = { id: 'claude-ollama', type: 'cli', command: 'claude', ollamaBacked: true };
    expect(providerPrerequisites(claudeOllama, { codexOssSupport: { supported: false } }).missing).toEqual([]);
  });

  it('drops the ChatGPT-account prerequisite for a local-backed codex record', () => {
    // It generates its tokens on this machine and authenticates against
    // nothing, so "No ChatGPT account is signed in" would be a false accusation
    // — and would park the card in UNKNOWN awaiting a read that never matters.
    expect(isCodexSubscriptionProvider(codexCloud)).toBe(true);
    expect(isCodexSubscriptionProvider(codexOllama)).toBe(false);
    expect(providerPrerequisites(codexOllama, {
      codexAccount: { status: 'signed-out' },
      codexOssSupport: { supported: true },
    }).missing).toEqual([]);
  });
});
