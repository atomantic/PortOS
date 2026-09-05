/**
 * The routing-override probe. What it uniquely catches: a badge that fires on a
 * key the user did NOT set at the top level (a comment, a `[table]` entry, a
 * value quoted inside a multi-line string), and the sentinel collapse where an
 * unreadable config would be reported as "not overridden".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseCodexRoutingOverride,
  readCodexRoutingOverride,
  codexHomeDir,
  __resetCodexRoutingCache,
} from './codexUserConfig.js';

const withConfig = (contents) => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  if (contents !== null) writeFileSync(join(home, 'config.toml'), contents);
  return home;
};

const temps = [];
const tempHome = (contents) => {
  const home = withConfig(contents);
  temps.push(home);
  return home;
};

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
  __resetCodexRoutingCache();
  delete process.env.CODEX_HOME;
});

describe('parseCodexRoutingOverride', () => {
  it('reports each top-level routing key and the base URL it names', () => {
    expect(parseCodexRoutingOverride([
      'openai_base_url = "http://127.0.0.1:9999/v1"',
      'model_provider = "example-bridge"',
      'model_catalog_json = "/opt/example/models.json"',
      'model = "gpt-5.6-terra"',
    ].join('\n'))).toEqual({
      overridden: true,
      keys: ['openai_base_url', 'model_provider', 'model_catalog_json'],
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
  });

  it('ignores a commented assignment', () => {
    expect(parseCodexRoutingOverride('# openai_base_url = "http://example.invalid/v1"'))
      .toEqual({ overridden: false, keys: [], baseUrl: null });
  });

  it('ignores the same key inside a table — that is a different setting', () => {
    expect(parseCodexRoutingOverride([
      '[model_providers.example]',
      'openai_base_url = "http://example.invalid/v1"',
      'model_provider = "example"',
    ].join('\n'))).toEqual({ overridden: false, keys: [], baseUrl: null });
  });

  it('ignores an assignment quoted inside a multi-line string', () => {
    expect(parseCodexRoutingOverride([
      'notes = """',
      'openai_base_url = "http://example.invalid/v1"',
      '"""',
    ].join('\n'))).toEqual({ overridden: false, keys: [], baseUrl: null });
  });

  it('reports a quoted key, and a non-string base URL as no URL', () => {
    expect(parseCodexRoutingOverride('"openai_base_url" = 42'))
      .toEqual({ overridden: true, keys: ['openai_base_url'], baseUrl: null });
  });

  it('is empty for an empty file', () => {
    expect(parseCodexRoutingOverride('')).toEqual({ overridden: false, keys: [], baseUrl: null });
  });
});

describe('readCodexRoutingOverride', () => {
  it('reads config.toml from an explicit home', () => {
    const home = tempHome('openai_base_url = "http://127.0.0.1:9999/v1"\n');
    expect(readCodexRoutingOverride({ codexHome: home })).toEqual({
      overridden: true,
      keys: ['openai_base_url'],
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
  });

  it('treats an ABSENT config as a definite "not overridden"', () => {
    expect(readCodexRoutingOverride({ codexHome: tempHome(null) }))
      .toEqual({ overridden: false, keys: [], baseUrl: null });
  });

  it('returns the NOT-DETERMINED sentinel when the file cannot be read', () => {
    const home = tempHome(null);
    // A directory where the file should be: readable path, unreadable content.
    mkdirSync(join(home, 'config.toml'));
    expect(readCodexRoutingOverride({ codexHome: home })).toBeNull();
  });

  it('honors CODEX_HOME the way the Codex CLI does', () => {
    const home = tempHome('model_provider = "example-bridge"\n');
    process.env.CODEX_HOME = home;
    expect(codexHomeDir()).toBe(home);
    expect(readCodexRoutingOverride({ force: true })).toEqual({
      overridden: true,
      keys: ['model_provider'],
      baseUrl: null,
    });
  });
});
