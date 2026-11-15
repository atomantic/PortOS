import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { md5 } from './_lib.js';
import {
  CUSTOMIZED_NOTICES_RELPATH,
  advanceShippedHashes,
  readReferencePromptHashes,
  readShippedHashes,
  reconcileShippedPrompts,
  serializeShippedHashes,
} from './shippedPromptHashes.js';
import { historicalPromptBodies, isShallowRepository } from './shippedPromptHistory.js';

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(migrationsDir, '..', '..');
const historyAvailable = !isShallowRepository(repoRoot);

const OLD = '# old shipped body\n';
const NEW = '# current shipped body\n';
const CUSTOM = '# my own edit\n';

let rootDir;
const write = (rel, body) => {
  mkdirSync(dirname(join(rootDir, rel)), { recursive: true });
  writeFileSync(join(rootDir, rel), body);
};
const read = (rel) => readFileSync(join(rootDir, rel), 'utf-8');
const writeTable = (table) => write('data.reference/prompts/shipped-hashes.json', serializeShippedHashes(table));

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'shipped-prompt-hashes-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('advanceShippedHashes', () => {
  it('retires the outgoing hash when a body changes', () => {
    const { table, retired } = advanceShippedHashes(
      { 'stages/a.md': { current: 'h1', retired: ['h0'] } },
      { 'stages/a.md': 'h2' },
    );
    expect(table).toEqual({ 'stages/a.md': { current: 'h2', retired: ['h0', 'h1'] } });
    expect(retired).toEqual([{ key: 'stages/a.md', hash: 'h1' }]);
  });

  it('adds a new prompt, and keeps the history of a removed one', () => {
    const { table, added } = advanceShippedHashes(
      { 'stages/gone.md': { current: 'g1', retired: ['g0'] } },
      { 'skills/new.md': 'n1' },
    );
    expect(table).toEqual({
      'skills/new.md': { current: 'n1', retired: [] },
      'stages/gone.md': { retired: ['g0', 'g1'] },
    });
    expect(added).toEqual(['skills/new.md']);
  });

  it('is a fixed point once current, and never duplicates a reverted hash', () => {
    const committed = { 'stages/a.md': { current: 'h1', retired: ['h0'] } };
    expect(advanceShippedHashes(committed, { 'stages/a.md': 'h1' }).table).toEqual(committed);
    const reverted = advanceShippedHashes(committed, { 'stages/a.md': 'h0' }).table;
    expect(reverted).toEqual({ 'stages/a.md': { current: 'h0', retired: ['h0', 'h1'] } });
  });
});

describe('reconcileShippedPrompts', () => {
  beforeEach(() => {
    write('data.reference/prompts/stages/a.md', NEW);
    writeTable({ 'stages/a.md': { current: md5(NEW), retired: [md5(OLD)] } });
  });

  it('replaces an untouched retired body with the current reference body', async () => {
    write('data/prompts/stages/a.md', OLD.replace(/\n/g, '\r\n'));
    const result = await reconcileShippedPrompts({ rootDir });
    expect(result.updated).toEqual(['stages/a.md']);
    expect(read('data/prompts/stages/a.md')).toBe(NEW);
  });

  it('leaves a customized body untouched and warns once per shipped body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('data/prompts/stages/a.md', CUSTOM);

    expect((await reconcileShippedPrompts({ rootDir })).customized).toEqual(['stages/a.md']);
    expect(read('data/prompts/stages/a.md')).toBe(CUSTOM);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('data/prompts/stages/a.md is customized');

    await reconcileShippedPrompts({ rootDir });
    expect(warn).toHaveBeenCalledTimes(1);

    // A new shipped body is news again.
    write('data.reference/prompts/stages/a.md', '# newer\n');
    writeTable({ 'stages/a.md': { current: md5('# newer\n'), retired: [md5(OLD), md5(NEW)] } });
    await reconcileShippedPrompts({ rootDir });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(read('data/prompts/stages/a.md')).toBe(CUSTOM);
  });

  it('still reconciles when the notice ledger is unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write(`data/${CUSTOMIZED_NOTICES_RELPATH}`, 'not json');
    write('data/prompts/stages/a.md', OLD);
    await reconcileShippedPrompts({ rootDir });
    expect(read('data/prompts/stages/a.md')).toBe(NEW);
  });

  it('skips a prompt missing from data/ or no longer shipped', async () => {
    writeTable({
      'stages/a.md': { current: md5(NEW), retired: [md5(OLD)] },
      'stages/gone.md': { retired: [md5(OLD)] },
    });
    write('data/prompts/stages/gone.md', OLD);
    const result = await reconcileShippedPrompts({ rootDir });
    expect(result).toEqual({ updated: [], customized: [] });
    expect(existsSync(join(rootDir, 'data/prompts/stages/a.md'))).toBe(false);
    expect(read('data/prompts/stages/gone.md')).toBe(OLD);
  });

  it('is a no-op without a hash table', async () => {
    rmSync(join(rootDir, 'data.reference/prompts/shipped-hashes.json'));
    write('data/prompts/stages/a.md', OLD);
    expect(await reconcileShippedPrompts({ rootDir })).toEqual({ updated: [], customized: [] });
    expect(read('data/prompts/stages/a.md')).toBe(OLD);
  });
});

// The acceptance contract: an install holding ANY body that ever shipped ends
// on today's body. Replays every historical version of every managed prompt
// through the real reference tree and table.
describe.skipIf(!historyAvailable)('every historically shipped body (full git history)', () => {
  const linkReference = () => symlinkSync(join(repoRoot, 'data.reference'), join(rootDir, 'data.reference'), 'dir');

  it('upgrades every historical body to the current reference body', async () => {
    linkReference();
    const live = await readReferencePromptHashes(repoRoot);
    const histories = historicalPromptBodies(repoRoot, Object.keys(live));
    const rounds = Math.max(...Object.values(histories).map((versions) => versions.length));
    expect(rounds).toBeGreaterThan(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    for (let round = 0; round < rounds; round++) {
      const placed = Object.entries(histories).filter(([, versions]) => versions[round]);
      for (const [key, versions] of placed) write(`data/prompts/${key}`, versions[round].body);
      const { customized } = await reconcileShippedPrompts({ rootDir });
      expect(customized).toEqual([]);
      const behind = placed.filter(([key]) => md5(read(`data/prompts/${key}`)) !== live[key]).map(([key]) => key);
      expect(behind, `round ${round}`).toEqual([]);
    }
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);

  // The frozen numbered chain still runs over the oldest shipped bodies, and
  // the reconciler then converges whatever it left behind.
  it('runs the frozen prompt migration chain on a simulated old install', async () => {
    linkReference();
    const live = await readReferencePromptHashes(repoRoot);
    const histories = historicalPromptBodies(repoRoot, Object.keys(live));
    for (const [key, versions] of Object.entries(histories)) {
      if (versions.length) write(`data/prompts/${key}`, versions.at(-1).body);
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const chain = readdirSync(migrationsDir)
      .filter((file) => /^\d.*\.js$/.test(file) && !file.endsWith('.test.js'))
      .filter((file) => readFileSync(join(migrationsDir, file), 'utf8').includes('makePromptReplaceMigration'))
      .sort();
    expect(chain.length).toBeGreaterThan(90);
    for (const file of chain) {
      const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
      await (mod.default ?? mod).up({ rootDir });
    }
    await reconcileShippedPrompts({ rootDir });

    const behind = Object.entries(histories)
      .filter(([key, versions]) => versions.length && md5(read(`data/prompts/${key}`)) !== live[key])
      .map(([key]) => key);
    expect(behind).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);
});

describe('committed table', () => {
  it('parses and is current for this checkout', async () => {
    const table = await readShippedHashes(repoRoot);
    const { table: advanced } = advanceShippedHashes(table, await readReferencePromptHashes(repoRoot));
    expect(serializeShippedHashes(advanced)).toBe(serializeShippedHashes(table));
  });
});
