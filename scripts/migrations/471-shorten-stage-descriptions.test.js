import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './471-shorten-stage-descriptions.js';

const shipped = JSON.parse(await readFile(new URL('../../data.reference/prompts/stage-config.json', import.meta.url), 'utf8'));
const stockDescription = 'Copy-edit pass on a Writers Room draft: paragraphing, dialogue formatting, whitespace, punctuation, and consistent chapter/scene markdown headings. Returns cleaned prose only.';

describe('stage description migration', () => {
  let rootDir;
  let installedPath;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-stage-descriptions-'));
    installedPath = join(rootDir, 'data/prompts/stage-config.json');
    const referencePath = join(rootDir, 'data.reference/prompts/stage-config.json');
    await mkdir(dirname(installedPath), { recursive: true });
    await mkdir(dirname(referencePath), { recursive: true });
    await writeFile(referencePath, JSON.stringify(shipped));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('refreshes matching descriptions once and preserves customized data', async () => {
    const installed = {
      stages: {
        'writers-room-format': { description: stockDescription, model: 'custom-model' },
        'writers-room-script': { description: 'Custom description' },
        'custom-stage': { description: stockDescription },
      },
      custom: true,
    };
    await writeFile(installedPath, JSON.stringify(installed));

    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const description = shipped.stages['writers-room-format'].description;
    expect(JSON.parse(await readFile(installedPath, 'utf8'))).toEqual({
      ...installed,
      stages: {
        ...installed.stages,
        'writers-room-format': { ...installed.stages['writers-room-format'], description },
      },
    });
    expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  });

  it('leaves a fresh install for setup-data to seed', async () => {
    expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
    await expect(readFile(installedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
