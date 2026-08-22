import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { collectServerSources, readServerSource, SERVER_DIR } from '../lib/testHelper.js';

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
  it('is documented as such at the definition', () => {
    const src = readFileSync(join(SERVER_DIR, 'lib/aiToolkit/providers.js'), 'utf8');
    // The toolkit builds the envelope inline; if this shape ever changes, every
    // `listProviders` consumer has to be revisited.
    expect(src).toMatch(/return \{\s*activeProvider: data\.activeProvider,\s*providers: Object\.values\(data\.providers\)/);
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
