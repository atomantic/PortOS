import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './291-claude-sglang-providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const IDS = ['claude-sglang', 'claude-sglang-tui'];

describe('migration 291 — Claude SGLang providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-291-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds both Claude SGLang presets, disabled, without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['claude-sglang']).toMatchObject({
      name: 'Claude SGLang (Qwen3.8-27B)',
      type: 'cli',
      command: 'claude',
      args: ['--print'],
      endpoint: 'http://127.0.0.1:18021/v1',
      models: ['qwen3.8-27b'],
      defaultModel: 'qwen3.8-27b',
      sglangBacked: true,
      enabled: false,
    });
    expect(out.providers['claude-sglang-tui']).toMatchObject({
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      sglangBacked: true,
      enabled: false,
      tuiPromptDelayMs: 2500,
      tuiIdleTimeoutMs: 180000,
    });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('sets CLAUDE_CODE_ATTRIBUTION_HEADER to "0" on both presets', async () => {
    // Load-bearing, not cosmetic: with the attribution block present, Claude Code
    // prepends a per-request hash to the system prompt, which is the first token
    // to differ between turns — so SGLang's radix prefix cache misses and
    // re-prefills the whole conversation every turn.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      expect(out.providers[id].envVars.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
      // The nonessential-traffic flag is a SEPARATE control and does not remove
      // the attribution block — both are required.
      expect(out.providers[id].envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    }
  });

  it('points ANTHROPIC_BASE_URL at the server root, never a /v1 suffix', async () => {
    // The Anthropic SDK appends /v1/messages itself; a base URL that already ends
    // in /v1 404s in a way that reads as "model not found". The /v1 form belongs
    // on `endpoint`, which is the OpenAI-compatible listing the readiness probe
    // hits — the two URLs are deliberately different.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      const baseUrl = out.providers[id].envVars.ANTHROPIC_BASE_URL;
      expect(baseUrl).toBe('http://127.0.0.1:18021');
      expect(baseUrl).not.toMatch(/\/v\d+\/?$/);
      expect(out.providers[id].endpoint).toBe('http://127.0.0.1:18021/v1');
    }
  });

  it('ships a non-empty auth token, marked secret', async () => {
    // SGLang accepts any value unless started with --api-key, but the SDK rejects
    // an empty token before a request leaves the box. `secretEnvVars` mirrors what
    // migration 284 did for Claude Ollama.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      expect(out.providers[id].envVars.ANTHROPIC_AUTH_TOKEN).toBe('sglang');
      expect(out.providers[id].secretEnvVars).toContain('ANTHROPIC_AUTH_TOKEN');
    }
  });

  it('points every model tier at the one served model, with no [1m] suffix', async () => {
    // Native context is 262,144. Claiming the 1M beta while the serve line does
    // not raise --context-length would cap the window incorrectly the other way.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      const { envVars, models, defaultModel } = out.providers[id];
      for (const key of [
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
      ]) {
        expect(envVars[key]).toBe('qwen3.8-27b');
      }
      expect(models).toEqual(['qwen3.8-27b']);
      expect(defaultModel).toBe('qwen3.8-27b');
      expect(JSON.stringify(out.providers[id])).not.toContain('[1m]');
    }
  });

  it('never seeds a thinking default — CoS coding wants it off, but the operator chooses', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      expect(out.providers[id].thinking).toBeUndefined();
    }
  });

  it('leaves the OpenCode SGLang wrappers alone — the two harnesses share one daemon', async () => {
    const opencode = {
      id: 'opencode-sglang-tui', type: 'tui', command: 'opencode',
      endpoint: 'http://127.0.0.1:18021/v1', sglangBacked: true, enabled: true,
    };
    writeJson(providersPath, { providers: { 'opencode-sglang-tui': opencode } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['opencode-sglang-tui']).toEqual(opencode);
    expect(out.providers['claude-sglang-tui'].command).toBe('claude');
  });

  it('preserves an existing customized Claude SGLang provider', async () => {
    const existing = {
      id: 'claude-sglang-tui',
      name: 'Custom Claude SGLang TUI',
      type: 'tui',
      command: 'claude',
      endpoint: 'http://127.0.0.1:19000/v1',
      envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:19000' },
      enabled: true,
    };
    writeJson(providersPath, { providers: { 'claude-sglang-tui': existing } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['claude-sglang-tui']).toEqual(existing);
    // The sibling it did not already own is still added.
    expect(out.providers['claude-sglang']).toBeDefined();
  });

  it('is idempotent — a second run changes nothing', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');

    const second = await migration.up({ rootDir });
    expect(second).toMatchObject({ ok: true, reason: 'already-present', added: 0 });
    expect(readFileSync(providersPath, 'utf-8')).toBe(first);
  });

  it('ships the same records all three seed copies do', async () => {
    // Three populations, three sources: the migration upgrades an existing
    // install, data.reference seeds a fresh one, and providers.sample.json is
    // what loadProviders() falls through to when the install seed is absent. A
    // divergence gives those populations different providers.
    //
    // providersSeedParity.test.js already ties data.reference to the sample, but
    // only on the MODEL fields — and every acceptance criterion for these two
    // records lives in `envVars`, which that test documents as legitimately
    // divergent. So pin the env set here, per-id, rather than widening its scope.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const migrated = readJson(providersPath).providers;
    const reference = readJson(resolve(__dirname, '../../data.reference/providers.json')).providers;
    const sample = readJson(resolve(__dirname, '../../server/lib/aiToolkit/defaults/providers.sample.json')).providers;

    for (const id of IDS) {
      expect(migrated[id]).toEqual(reference[id]);
      expect(sample[id]?.envVars, `${id}.envVars diverged between data.reference and providers.sample.json`)
        .toEqual(migrated[id].envVars);
      expect(sample[id]?.secretEnvVars).toEqual(migrated[id].secretEnvVars);
      expect(sample[id]?.endpoint).toEqual(migrated[id].endpoint);
    }
  });
});
