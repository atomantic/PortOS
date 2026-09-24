import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeJsonStarter } from './mergeJsonStarter.js';

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
});
