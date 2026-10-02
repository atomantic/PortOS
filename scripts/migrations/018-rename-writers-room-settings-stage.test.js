import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './018-rename-writers-room-settings-stage.js';

// Keep real filesystem behavior except for the explicitly injected write failure.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const LEGACY = 'writers-room-settings';
const CURRENT = 'writers-room-places';
const seedPrompt = '# Example shipped places prompt\n';
const legacyPrompt = '# Customized legacy prompt\nKeep the quiet details.\n';
const seedConfig = { provider: 'example-default', model: 'default-model' };
const legacyConfig = { provider: 'example-custom', model: 'custom-model', variables: { tone: 'quiet' } };
const unrelated = { provider: 'example-other', model: 'other-model' };
let rootDir;
const promptPath = (stage) => join(rootDir, 'data/prompts/stages', `${stage}.md`);
const configPath = () => join(rootDir, 'data/prompts/stage-config.json');

async function install({ legacy = legacyPrompt, current = seedPrompt, oldEntry = legacyConfig, newEntry = seedConfig } = {}) {
  await writeFile(promptPath(LEGACY), legacy);
  if (current !== null) await writeFile(promptPath(CURRENT), current);
  await writeFile(configPath(), JSON.stringify({
    version: 1,
    stages: { before: unrelated, [LEGACY]: oldEntry, ...(newEntry === null ? {} : { [CURRENT]: newEntry }), after: unrelated },
  }));
}

async function expectInstalled(prompt, entry) {
  expect(await readFile(promptPath(CURRENT), 'utf8')).toBe(prompt);
  expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
    version: 1,
    stages: { before: unrelated, [CURRENT]: entry, after: unrelated },
  });
  await expect(readFile(promptPath(LEGACY))).rejects.toMatchObject({ code: 'ENOENT' });
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'migration-018-stage-'));
  await mkdir(join(rootDir, 'data/prompts/stages'), { recursive: true });
  await mkdir(join(rootDir, 'data.reference/prompts/stages'), { recursive: true });
  await writeFile(join(rootDir, 'data.reference/prompts/stages', `${CURRENT}.md`), seedPrompt);
  await writeFile(join(rootDir, 'data.reference/prompts/stage-config.json'), JSON.stringify({ stages: { [CURRENT]: seedConfig } }));
});

afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  await rm(rootDir, { recursive: true, force: true });
});

describe('migration 018 Writers Room stage rename', () => {
  it('preserves legacy customizations over setup-first seeds and replays without changing installed bytes', async () => {
    await install();

    await migration.up({ rootDir });

    await expectInstalled(legacyPrompt, legacyConfig);
    const promptBytes = await readFile(promptPath(CURRENT));
    const configBytes = await readFile(configPath());
    await migration.up({ rootDir });
    expect(await readFile(promptPath(CURRENT))).toEqual(promptBytes);
    expect(await readFile(configPath())).toEqual(configBytes);
    await expect(readFile(promptPath(LEGACY))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps deliberately customized destination prompt and provider choices authoritative', async () => {
    const current = '# Deliberately customized destination\n';
    const newEntry = { provider: 'example-destination', model: 'destination-model' };
    await install({ current, newEntry });

    await migration.up({ rootDir });

    await expectInstalled(current, newEntry);
  });

  it('promotes legacy customizations when neither destination artifact exists', async () => {
    await install({ current: null, newEntry: null });

    await migration.up({ rootDir });

    await expectInstalled(legacyPrompt, legacyConfig);
  });

  it('retains shipped destinations when the legacy artifacts are unchanged defaults', async () => {
    await install({ legacy: seedPrompt, oldEntry: seedConfig });

    await migration.up({ rootDir });

    await expectInstalled(seedPrompt, seedConfig);
  });

  it.each([null, seedPrompt])('retains the legacy copy and config if destination writing fails (destination: %s)', async (current) => {
    await install({ current });
    const configBytes = await readFile(configPath());
    const actual = await vi.importActual('fs/promises');
    vi.mocked(writeFile).mockImplementation(async (path, ...args) => {
      if (path === promptPath(CURRENT)) throw Object.assign(new Error('Injected destination write failure'), { code: 'EIO' });
      return actual.writeFile(path, ...args);
    });

    await expect(migration.up({ rootDir })).rejects.toMatchObject({ code: 'EIO' });

    expect(await readFile(promptPath(LEGACY), 'utf8')).toBe(legacyPrompt);
    expect(await readFile(configPath())).toEqual(configBytes);
    if (current === null) {
      await expect(readFile(promptPath(CURRENT))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(promptPath(CURRENT), 'utf8')).toBe(current);
    }
  });
});
