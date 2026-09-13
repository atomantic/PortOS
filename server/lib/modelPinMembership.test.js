import { describe, it, expect } from 'vitest';
import {
  localBackendForProvider,
  localRuntimeKind,
  modelPinIsOffered,
} from './modelPinMembership.js';
import { CODEX_CONFIGURED_DEFAULT } from './providerModels.js';
import { PORTS } from './ports.js';

describe('localRuntimeKind', () => {
  it('reads the explicit backing markers first', () => {
    expect(localRuntimeKind({ command: 'opencode', llamaBacked: true })).toBe('llama');
    expect(localRuntimeKind({ command: 'opencode', mtplxBacked: true })).toBe('mtplx');
    expect(localRuntimeKind({ command: 'opencode', vllmBacked: true })).toBe('vllm');
    expect(localRuntimeKind({ command: 'opencode', sglangBacked: true })).toBe('sglang');
    expect(localRuntimeKind({ command: 'opencode', ollamaBacked: true })).toBe('ollama');
    // claude-ollama is not an OpenCode provider but is still Ollama-backed.
    expect(localRuntimeKind({ command: 'claude', ollamaBacked: true })).toBe('ollama');
    // The marker is what makes a RENAMED LM Studio wrapper still resolve. The
    // name/endpoint fallback below would miss this record entirely — it carries
    // neither an `lmstudio` id/name nor a :1234 endpoint of its own.
    expect(localRuntimeKind({ command: 'opencode', name: 'Coding box', lmstudioBacked: true })).toBe('lmstudio');
  });

  it('treats OrcaRouter as remote, not a local daemon', () => {
    expect(localRuntimeKind({ command: 'opencode', orcarouterBacked: true })).toBeNull();
  });

  it('falls back to the endpoint/name heuristic for plain API providers', () => {
    expect(localRuntimeKind({ type: 'api', id: 'ollama', endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://localhost:1234/v1' })).toBe('lmstudio');
    expect(localRuntimeKind({ type: 'api', id: 'x', name: 'LM Studio local' })).toBe('lmstudio');
  });

  it('does NOT claim a peer machine daemon as a local runtime', () => {
    // A provider pointed at another box on the LAN/tailnet used to match on the
    // bare port, so the card offered to install Ollama HERE for a daemon that
    // lives — and may simply be switched off — over there.
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://192.0.2.10:11434/v1' })).toBeNull();
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://192.0.2.10:1234/v1' })).toBeNull();
    // Every loopback / bind-all spelling still resolves.
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://0.0.0.0:1234' })).toBe('lmstudio');
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://[::1]:1234/v1' })).toBe('lmstudio');
  });

  it('returns null for a remote provider and for junk input', () => {
    expect(localRuntimeKind({ type: 'api', id: 'openai', endpoint: 'https://api.openai.com/v1' })).toBeNull();
    expect(localRuntimeKind(null)).toBeNull();
    expect(localRuntimeKind('nope')).toBeNull();
  });

  it('recognizes Slotstream by id, name, and dedicated port — never 11434', () => {
    expect(localRuntimeKind({ id: 'slotstream' })).toBe('slotstream');
    expect(localRuntimeKind({ name: 'Slotstream (local)' })).toBe('slotstream');
    expect(localRuntimeKind({ endpoint: `http://127.0.0.1:${PORTS.SLOTSTREAM}/v1` })).toBe('slotstream');
    expect(localRuntimeKind({ endpoint: 'http://127.0.0.1:11434/v1' })).toBe('ollama');
  });

  // #6466 — the shipped `mtplx` API record (`type: 'api'`, no `mtplxBacked`
  // marker) is the one shape none of the earlier fallbacks reach, so it needs
  // its own id-based arm rather than a generic port check.
  it('recognizes the shipped mtplx API record by id, with no port arm', () => {
    expect(localRuntimeKind({ id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' })).toBe('mtplx');
    // :8000 is a generic port a user's own local API could equally be bound
    // to — MTPLX's is user-configurable, so an unrelated `id` on that same
    // port must never resolve as MTPLX the way slotstream's DEDICATED port
    // resolves above.
    expect(localRuntimeKind({ id: 'some-local-api', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' })).toBeNull();
  });
});

describe('modelPinIsOffered', () => {
  it('passes through when the provider lists no models of its own', () => {
    expect(modelPinIsOffered({ id: 'custom-api', models: [] }, 'anything')).toBe(true);
    expect(modelPinIsOffered({ id: 'custom-api' }, 'anything')).toBe(true);
  });

  it('validates a pin against the listed catalog for a non-local provider', () => {
    const provider = { id: 'openai', models: ['gpt-x', 'gpt-y'] };
    expect(modelPinIsOffered(provider, 'gpt-x')).toBe(true);
    expect(modelPinIsOffered(provider, 'gpt-z')).toBe(false);
  });

  it('passes through for a local-daemon provider, whatever the pin', () => {
    // Ollama/LM Studio's `models` array is a cached snapshot; the daemon on
    // this machine is the authority, so a pin outside the stale list must
    // still be considered offered.
    const provider = { command: 'opencode', ollamaBacked: true, models: ['stale-model'] };
    expect(modelPinIsOffered(provider, 'freshly-pulled-model')).toBe(true);
  });

  // #6466 — decision: the shipped mtplx API record is a pass-through too, once
  // `localRuntimeKind` names it. `mtplx serve` names its process after whatever
  // checkpoint is actually loaded, so the record's static `models` entry is the
  // same kind of stale snapshot Ollama's is — judging a pin against it would
  // reject a checkpoint that is installed and serving.
  it('passes through for the shipped mtplx API record, whatever the pin', () => {
    const provider = {
      id: 'mtplx',
      type: 'api',
      endpoint: 'http://127.0.0.1:8000/v1',
      models: ['mtplx-qwen38-27b-optimized-speed'],
    };
    expect(modelPinIsOffered(provider, 'a-different-checkpoint-the-daemon-now-serves')).toBe(true);
  });

  it('is id-based, not locality-gated, matching the existing ollama/slotstream id checks', () => {
    // `localRuntimeKind`'s id-based arms (ollama, slotstream, and now mtplx)
    // do not themselves check the endpoint's locality — the callers that need
    // that distinction (`isMtplxProvider`, `localRuntimeForProvider`) apply it
    // on top. `modelPinIsOffered` calls `localRuntimeKind` raw, so an `id:
    // 'mtplx'` record pointed at another machine passes through here exactly
    // as an `id: 'ollama'` one already does — not a new gap this issue opens.
    const provider = {
      id: 'mtplx',
      type: 'api',
      endpoint: 'http://192.0.2.10:8000/v1',
      models: ['mtplx-qwen38-27b-optimized-speed'],
    };
    expect(modelPinIsOffered(provider, 'a-different-checkpoint')).toBe(true);
  });
});

describe('localBackendForProvider', () => {
  // Moved here from services/localModelHealing.js, which now re-exports it —
  // these cases pin the behavior its healing path depends on.
  it('matches by id, name, and local endpoint port', () => {
    expect(localBackendForProvider({ id: 'ollama' })).toBe('ollama');
    expect(localBackendForProvider({ name: 'My Ollama' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(localBackendForProvider({ id: 'lmstudio' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'lm-studio' })).toBe('lmstudio');
    expect(localBackendForProvider({ endpoint: 'http://127.0.0.1:1234/v1' })).toBe('lmstudio');
  });

  it('declines a remote host, an unknown port, and junk', () => {
    expect(localBackendForProvider({ endpoint: 'http://192.0.2.10:11434/v1' })).toBeNull();
    expect(localBackendForProvider({ endpoint: 'http://localhost:9999' })).toBeNull();
    expect(localBackendForProvider({ id: 'anthropic', endpoint: 'https://api.anthropic.com/v1' })).toBeNull();
    expect(localBackendForProvider(null)).toBeNull();
  });
});

// #7327 — the agy base-id and OpenCode namespace tolerances used to live one
// level UP, in `modelPinReconcile.js`, so the retired-pin audit and the three
// spawn-time callers of this rule disagreed about the same pin. Each case below
// is one this rule REJECTED while the spawner it guards would have run the
// model happily.
describe('modelPinIsOffered — same model, spelled differently', () => {
  const AGY = {
    id: 'antigravity-cli',
    command: 'agy',
    models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high', 'claude-sonnet-4-6'],
  };

  it('accepts a bare agy base id against a suffix-only catalog', () => {
    // `resolveAntigravityModelAndEffort` splits a suffixed pin into exactly this
    // base plus `--effort` before spawning, so the base id IS what agy receives.
    // Rejecting it made `cliProviderRun` fall back to the provider default for a
    // model it would itself have spawned.
    expect(modelPinIsOffered(AGY, 'gemini-3.6-flash')).toBe(true);
    // A tier the base does not list is clamped by `antigravityModelEffortLevels`,
    // not a different model.
    expect(modelPinIsOffered(AGY, 'gemini-3.6-flash-medium')).toBe(true);
  });

  it('still rejects an agy pin whose BASE the catalog dropped', () => {
    // The tolerance is a spelling rule, not a laxer one: a retirement is still
    // a retirement at every tier.
    expect(modelPinIsOffered(AGY, 'gemini-3.5-flash')).toBe(false);
    expect(modelPinIsOffered(AGY, 'gemini-3.5-flash-low')).toBe(false);
  });

  it('confines the namespace tolerance to OpenCode providers', () => {
    // Ungated, `bare()` reduces any slash-bearing pin and matches it against a
    // bare catalog on ANY vendor, so these would read as offered and the three
    // spawn-time callers would hand the id to a CLI/API that rejects it. That
    // was harmless while this rule only fed the retired-pin audit — a missed
    // warning — and is a real over-permission now that it gates spawns.
    expect(modelPinIsOffered({ id: 'openai', models: ['gpt-4o'] }, 'custom/gpt-4o')).toBe(false);
    expect(modelPinIsOffered({ id: 'codex', command: 'codex', models: ['gpt-5'] }, 'openrouter/gpt-5')).toBe(false);
  });

  it('matches an OpenCode `namespace/model` catalog against a bare pin', () => {
    // Pins are stored BARE and namespaced at spawn by `prefixOpencodeModel`.
    // A gateway-backed OpenCode provider is NOT a local daemon, so it reaches
    // the exact comparison rather than the pass-through above.
    const gateway = {
      id: 'opencode-openrouter',
      command: 'opencode',
      gatewayBacked: 'openrouter',
      models: ['openrouter/claude-sonnet-4'],
    };
    expect(modelPinIsOffered(gateway, 'claude-sonnet-4')).toBe(true);
    expect(modelPinIsOffered(gateway, 'openrouter/claude-sonnet-4')).toBe(true);
    expect(modelPinIsOffered(gateway, 'claude-opus-4')).toBe(false);
  });

  it('does NOT pass a configured-default sentinel through', () => {
    // A sentinel is a posture, but only a CLI that HAS its own default can be
    // handed one — so "is this catalog missing it?" is the wrong question here,
    // and answering it `true` would let an API provider store a sentinel its
    // endpoint would reject as a model id. The retired-pin audit answers it one
    // level up (`providerCatalogListsModel`), and the pickers guard it with
    // `isConfiguredDefaultModel`.
    expect(modelPinIsOffered({ id: 'codex', models: ['gpt-5'] }, CODEX_CONFIGURED_DEFAULT)).toBe(false);
  });

  it('rejects a blank or non-string pin against a real catalog', () => {
    // "Nothing is pinned" is the AUDIT's question, answered one level up in
    // `modelPinReconcile.js`. Here the caller is asking what to hand a CLI, and
    // a blank id is not in the catalog.
    for (const pin of ['', '   ', null, undefined, 42]) {
      expect(modelPinIsOffered({ id: 'codex', models: ['gpt-5'] }, pin)).toBe(false);
    }
  });
});
