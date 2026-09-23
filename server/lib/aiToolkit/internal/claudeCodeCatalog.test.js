import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_SURFACE,
  catalogAge,
  claudeConfigDir,
  isSupportedCatalog,
  selectCatalogModels,
  usesThirdPartyBackend,
  versionAtLeast,
} from './claudeCodeCatalog.js';

/**
 * Shape transcribed from a real `<configDir>/cache/model-catalog/*.json`
 * (schema `version: 2`) with invented model ids — the file carries the signed-in
 * account's entitlements, which never belong in a fixture.
 */
const catalogFile = ({ fetchedAt = 1_000, surface = CLAUDE_CODE_SURFACE, models = [], version = 2 } = {}) => ({
  version,
  fetchedAt,
  staleAt: fetchedAt + 3_600_000,
  catalog: { surface, config: { id: surface, models }, state: {} },
});

const model = (id, extra = {}) => ({ id, name: id, section: 'main', ...extra });

describe('claudeConfigDir', () => {
  it('prefers CLAUDE_CONFIG_DIR over the home default, matching the CLI', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/cc' }, '/home/example')).toBe('/opt/cc');
  });

  it('falls back to <home>/.claude', () => {
    expect(claudeConfigDir({}, '/home/example')).toBe('/home/example/.claude');
  });

  // The caller must skip the read rather than probe a path built from
  // `undefined` — an ENOENT there reads as "no catalog cached" and would hide a
  // genuinely broken environment behind the same message.
  it('answers null when neither an override nor a home directory is known', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, '')).toBeNull();
  });
});

describe('versionAtLeast', () => {
  it.each([
    ['2.1.280', '2.1.280', true],
    ['2.1.281', '2.1.280', true],
    ['2.1.279', '2.1.280', false],
    ['2.2.0', '2.1.999', true],
    ['10.0.0', '9.9.9', true],
  ])('%s vs floor %s → %s', (have, need, expected) => {
    expect(versionAtLeast(have, need)).toBe(expected);
  });

  it('treats a missing floor as no constraint', () => {
    expect(versionAtLeast('2.1.0', undefined)).toBe(true);
  });

  // A failed `claude --version` probe must widen the catalog, never empty it:
  // hiding every model is a worse error than offering one the binary rejects
  // with a legible message.
  it('treats an unreadable installed version as no constraint', () => {
    expect(versionAtLeast('', '2.1.280')).toBe(true);
  });
});

describe('isSupportedCatalog', () => {
  it('accepts the shipped schema version for the cc surface', () => {
    expect(isSupportedCatalog(catalogFile({ models: [model('a')] }))).toBe(true);
  });

  // The endpoint behind this file is internal and unversioned. Gating on the
  // file's own marker makes a future rewrite read as "no catalog" — which the
  // caller surfaces as an error that preserves the stored list — instead of
  // feeding a changed shape through the accessors.
  it.each([
    ['an unknown schema version', catalogFile({ version: 3, models: [model('a')] })],
    ['a different surface', catalogFile({ surface: 'web', models: [model('a')] })],
    ['a non-array models field', { version: 2, catalog: { surface: 'cc', config: { models: {} } } }],
    ['a null payload', null],
  ])('rejects %s', (_label, parsed) => {
    expect(isSupportedCatalog(parsed)).toBe(false);
  });
});

describe('selectCatalogModels', () => {
  it('returns the catalog ids in picker order', () => {
    const entries = [catalogFile({
      models: [model('alpha-3'), model('alpha-2'), model('alpha-1', { section: 'overflow' })],
    })];
    expect(selectCatalogModels(entries)).toEqual(['alpha-3', 'alpha-2', 'alpha-1']);
  });

  // The directory holds one file per signed-in account. Picking whichever
  // `readdir` returned first would make the answer depend on filesystem order.
  it('picks the freshest supported entry when several accounts are cached', () => {
    const entries = [
      catalogFile({ fetchedAt: 500, models: [model('stale-1')] }),
      catalogFile({ fetchedAt: 9_000, models: [model('fresh-1')] }),
    ];
    expect(selectCatalogModels(entries)).toEqual(['fresh-1']);
  });

  it('drops models the installed CLI is too old to select', () => {
    const entries = [catalogFile({
      models: [
        model('needs-new', { min_claude_code_version: '2.1.280' }),
        model('always-ok'),
      ],
    })];
    expect(selectCatalogModels(entries, { cliVersion: '2.1.200' })).toEqual(['always-ok']);
    expect(selectCatalogModels(entries, { cliVersion: '2.1.280' })).toEqual(['needs-new', 'always-ok']);
  });

  it('skips entries whose schema it does not understand', () => {
    const entries = [
      catalogFile({ fetchedAt: 9_000, version: 3, models: [model('unreadable')] }),
      catalogFile({ fetchedAt: 100, models: [model('readable')] }),
    ];
    expect(selectCatalogModels(entries)).toEqual(['readable']);
  });

  it.each([
    ['no entries', []],
    ['only unsupported entries', [catalogFile({ version: 99, models: [model('x')] })]],
    ['a supported entry with no ids', [catalogFile({ models: [{ name: 'no id' }] })]],
  ])('answers an empty list for %s so the caller can throw', (_label, entries) => {
    expect(selectCatalogModels(entries)).toEqual([]);
  });

  it('de-duplicates ids repeated across sections', () => {
    const entries = [catalogFile({ models: [model('dupe'), model('dupe', { section: 'overflow' })] })];
    expect(selectCatalogModels(entries)).toEqual(['dupe']);
  });
});

describe('catalogAge', () => {
  it('reports the chosen entry’s fetch stamp', () => {
    const entries = [catalogFile({ fetchedAt: 42 }), catalogFile({ fetchedAt: 4_242 })];
    expect(catalogAge(entries)).toBe(4_242);
  });

  it('answers null when nothing usable is cached', () => {
    expect(catalogAge([])).toBeNull();
  });

  // The two accessors must answer from the SAME entry: the log line reports the
  // age of the catalog whose ids were persisted. When they each filtered and
  // sorted separately the pair could drift and describe different files, so the
  // shared selector is pinned here rather than only in each accessor's own test.
  it('reports the age of the very entry whose ids were selected', () => {
    const entries = [
      catalogFile({ fetchedAt: 100, models: [model('from-older')] }),
      catalogFile({ fetchedAt: 9_000, models: [model('from-newer')] }),
      // Newest of all, but an unsupported schema — neither accessor may pick it.
      catalogFile({ fetchedAt: 50_000, version: 3, models: [model('from-unreadable')] }),
    ];
    expect(selectCatalogModels(entries)).toEqual(['from-newer']);
    expect(catalogAge(entries)).toBe(9_000);
  });
});

describe('usesThirdPartyBackend', () => {
  it.each([
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: 'true' }],
    ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: 'yes' }],
    ['Claude Platform on AWS', { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }],
  ])('recognizes a record pointed at %s', (_label, envVars) => {
    expect(usesThirdPartyBackend({ command: 'claude', envVars }, {})).toBe(true);
  });

  // `"0"` / `"false"` is how an install disables a marker it inherited from a
  // shared settings file. Reading those as "on" would hide the Refresh button
  // from a record that is in fact talking to claude.ai.
  it.each([
    ['0', { CLAUDE_CODE_USE_BEDROCK: '0' }],
    ['false', { CLAUDE_CODE_USE_BEDROCK: 'false' }],
    ['an empty string', { CLAUDE_CODE_USE_BEDROCK: '' }],
    ['no markers at all', { ANTHROPIC_MODEL: 'claude-opus-5' }],
    ['no envVars', undefined],
  ])('treats %s as first-party', (_label, envVars) => {
    expect(usesThirdPartyBackend({ command: 'claude', envVars }, {})).toBe(false);
  });

  it('checks inherited process settings and honors a provider-level off switch', () => {
    expect(usesThirdPartyBackend({ command: 'claude' }, { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
    expect(usesThirdPartyBackend(
      { command: 'claude', envVars: { CLAUDE_CODE_USE_BEDROCK: '0' } },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
    )).toBe(false);
  });
});
