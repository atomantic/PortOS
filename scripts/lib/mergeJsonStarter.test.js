import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeJsonStarter, mergeJsonStarterTargets } from './mergeJsonStarter.js';

const targets = [
  ['prompts/stage-config.json', 'stages'],
  ['prompts/variables.json', 'variables'],
  ['providers.json', 'providers'],
];

describe('mergeJsonStarter', () => {
  let root;
  let samplePath;
  let dataPath;
  let messages;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'merge-json-starter-'));
    samplePath = join(root, 'starter.json');
    dataPath = join(root, 'installed.json');
    messages = [];
    writeFileSync(samplePath, JSON.stringify({ entries: { shipped: { enabled: true } } }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(targets)('preserves present invalid maps byte-for-byte for %s', (_path, mergeKey) => {
    writeFileSync(samplePath, JSON.stringify({ [mergeKey]: { shipped: { enabled: true } } }));
    for (const invalid of ['false', '"custom"', '17', '["custom"]', 'null']) {
      const original = ` { "custom": true, "${mergeKey}": ${invalid} }\n`;
      writeFileSync(dataPath, original);

      const result = mergeJsonStarter({ samplePath, dataPath, mergeKey, displayPath: 'installed.json', log: (message) => messages.push(message) });

      expect(result.status).toBe('invalid-map');
      expect(readFileSync(dataPath, 'utf8')).toBe(original);
      expect(messages.at(-1)).toContain('present but is not an object');
    }
  });

  it.each(['null', 'false', '17', '"custom"', '["recoverable custom content"]'])('skips a non-object root (%s) with a warning and leaves its bytes untouched', (rootValue) => {
    const original = `${rootValue}\n`;
    writeFileSync(dataPath, original);

    const result = mergeJsonStarter({ samplePath, dataPath, mergeKey: 'entries', displayPath: 'installed.json', log: (message) => messages.push(message) });

    expect(result.status).toBe('invalid-document');
    expect(readFileSync(dataPath, 'utf8')).toBe(original);
    expect(messages).toEqual(['⚠️ Skipping JSON merge for installed.json: expected an object document']);
  });

  it('adds missing starter entries while retaining custom entries', () => {
    writeFileSync(dataPath, JSON.stringify({ entries: { custom: { kept: true } } }));

    const result = mergeJsonStarter({ samplePath, dataPath, mergeKey: 'entries', displayPath: 'installed.json', log: (message) => messages.push(message) });

    expect(result.added).toEqual(['shipped']);
    expect(JSON.parse(readFileSync(dataPath, 'utf8')).entries).toEqual({ custom: { kept: true }, shipped: { enabled: true } });
  });

  it('creates an absent map and adds starter entries', () => {
    writeFileSync(dataPath, JSON.stringify({ custom: true }));

    const result = mergeJsonStarter({ samplePath, dataPath, mergeKey: 'entries', displayPath: 'installed.json', log: (message) => messages.push(message) });

    expect(result.added).toEqual(['shipped']);
    expect(JSON.parse(readFileSync(dataPath, 'utf8'))).toEqual({ custom: true, entries: { shipped: { enabled: true } } });
  });

  describe('seed ledger across updates (#8712)', () => {
    let referenceDir;
    let dataDir;
    let ledgerPath;
    const targets = [{ relPath: 'providers.json', mergeKey: 'providers' }];
    const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const run = () => mergeJsonStarterTargets({ targets, referenceDir, dataDir, ledgerPath, log: (message) => messages.push(message) });

    beforeEach(() => {
      referenceDir = join(root, 'reference');
      dataDir = join(root, 'data');
      mkdirSync(referenceDir);
      mkdirSync(dataDir);
      ledgerPath = join(dataDir, 'setup-data-seeded.json');
      writeJson(join(referenceDir, 'providers.json'), { providers: { codex: { enabled: true }, lmstudio: { enabled: true } } });
    });

    it('bootstraps an install with no ledger: adds missing keys once and records the sample keys', () => {
      writeJson(join(dataDir, 'providers.json'), { providers: { lmstudio: { enabled: false } } });

      run();

      expect(readJson(join(dataDir, 'providers.json')).providers).toEqual({ lmstudio: { enabled: false }, codex: { enabled: true } });
      expect(readJson(ledgerPath)).toEqual({ 'providers.json': ['codex', 'lmstudio'] });
    });

    it('keeps a deleted shipped key deleted and still adds a key new in a later release', () => {
      writeJson(join(dataDir, 'providers.json'), { providers: { lmstudio: { enabled: true } } });
      writeJson(ledgerPath, { 'providers.json': ['codex', 'lmstudio'] });
      writeJson(join(referenceDir, 'providers.json'), { providers: { codex: { enabled: true }, lmstudio: { enabled: true }, newcomer: { enabled: true } } });

      run();
      run();

      expect(Object.keys(readJson(join(dataDir, 'providers.json')).providers)).toEqual(['lmstudio', 'newcomer']);
      expect(readJson(ledgerPath)).toEqual({ 'providers.json': ['codex', 'lmstudio', 'newcomer'] });
    });

    it('leaves an invalid merge map byte-for-byte unchanged and does not record the target', () => {
      const original = '{ "providers": ["custom"] }\n';
      writeFileSync(join(dataDir, 'providers.json'), original);

      run();

      expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).toBe(original);
      expect(existsSync(ledgerPath)).toBe(false);
    });
  });
});
