import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createProviderService } from '../lib/aiToolkit/providers.js';
import { join } from 'path';
import { collectServerSources, readServerSource } from '../lib/testHelper.js';

/**
 * `getAllProviders()` resolves an ENVELOPE — `{ activeProvider, providers: [] }`
 * — not a bare array. Callers that forgot wrote `Array.isArray(providers)`
 * guards that are never true, and so silently resolved to an empty list:
 *
 *   - the capability matrix reported "no OpenCode TUI provider is configured"
 *     for every runtime, on installs that had one;
 *   - `runtimeApiKey` never found a key, so a vLLM behind VLLM_API_KEY 401'd on
 *     every sample.
 *
 * Both shipped green, because their suites mocked the call as a bare array. This
 * guard pins the envelope so a future reader cannot re-derive the wrong shape
 * from a mock, and points anyone who just wants the records at `listProviders`.
 */
describe('getAllProviders returns an envelope, not a list', () => {
  it('returns the active provider and resolved record list as an envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-envelope-'));
    try {
      const service = createProviderService({ dataDir: directory, providersFile: 'providers.json' });
      await service.createProvider({ id: 'example', name: 'Example', type: 'api', enabled: true });
      await service.setActiveProvider('example');
      const result = await service.getAllProviders();
      expect(Array.isArray(result)).toBe(false);
      expect(result).toMatchObject({ activeProvider: 'example', providers: [{ id: 'example' }] });
      expect(Array.isArray(result.providers)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('has a wrapper that unwraps it, so callers never need to know', async () => {
    const { listProviders } = await import('./providers.js');
    expect(typeof listProviders).toBe('function');
  });

  it('has no caller treating the envelope as an array', () => {
    // The mistake is narrow and specific: bind the RESULT to a name, then use
    // that name as a list — `Array.isArray(x)`, `x.find(`, `x.map(`, `x.filter(`.
    // Assigning the envelope and reading `x.providers` a few lines later is the
    // correct shape and must not be flagged, so the window looks at how the bound
    // name is actually USED rather than at the assignment alone.
    const WINDOW = 8;
    const offenders = [];
    for (const rel of collectServerSources()) {
      const src = readServerSource(rel);
      if (!src.includes('getAllProviders()')) continue;
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const bind = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await getAllProviders\(\)/);
        if (!bind) return;
        const name = bind[1];
        const window = lines.slice(i, i + WINDOW).join('\n');
        // Reading `.providers` off it anywhere in the window means the caller
        // knows it is an envelope.
        if (new RegExp(`\\b${name}[?.]*\\.providers\\b`).test(window)) return;
        const asList = new RegExp(`Array\\.isArray\\(\\s*${name}\\s*\\)|\\b${name}[?.]*\\.(?:find|map|filter|forEach|some|every)\\(`);
        if (asList.test(window)) offenders.push(`${rel}:${i + 1} — ${name}`);
      });
    }
    expect(
      offenders,
      'These bind getAllProviders() and then use it as a list. It resolves '
      + '{ activeProvider, providers } — use `listProviders()` from '
      + 'server/services/providers.js when you only want the records.',
    ).toEqual([]);
  });

  it('catches the mistake it is written to catch', () => {
    // A bypass probe: the guard above passing is only meaningful if this shape
    // would actually fail it.
    const bad = [
      'const providers = await getAllProviders().catch(() => []);',
      'const match = (Array.isArray(providers) ? providers : []).find((p) => p.id === x);',
    ].join('\n');
    const name = bad.match(/const\s+([\w$]+)\s*=\s*await getAllProviders\(\)/)[1];
    expect(new RegExp(`Array\\.isArray\\(\\s*${name}\\s*\\)`).test(bad)).toBe(true);
    expect(new RegExp(`\\b${name}[?.]*\\.providers\\b`).test(bad)).toBe(false);
  });
});
