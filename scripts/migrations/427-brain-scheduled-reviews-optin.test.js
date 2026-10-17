import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './427-brain-scheduled-reviews-optin.js';

let rootDir;
let dir;
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-brain-optin-'));
  dir = join(rootDir, 'data', 'brain');
  await mkdir(dir, { recursive: true });
});
afterEach(() => rm(rootDir, { recursive: true, force: true }));

const readMeta = async () => JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));

describe('427 brain scheduled-reviews opt-in', () => {
  it('enables, preserving settings, when a stored digest exists', async () => {
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ dailyDigestTime: '07:30' }));
    await writeFile(join(dir, 'digests.jsonl'), '{"id":"d1"}\n');
    expect(await migration.up({ rootDir })).toEqual({ enabled: true });
    expect(await readMeta()).toEqual({ dailyDigestTime: '07:30', scheduledReviewsEnabled: true });
  });

  it('enables when only a weekly review exists, even with no meta.json', async () => {
    await writeFile(join(dir, 'reviews.jsonl'), '{"id":"r1"}\n');
    expect(await migration.up({ rootDir })).toEqual({ enabled: true });
    expect(await readMeta()).toEqual({ scheduledReviewsEnabled: true });
  });

  it('leaves meta untouched when no digest or review is stored', async () => {
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ dailyDigestTime: '07:30' }));
    await writeFile(join(dir, 'digests.jsonl'), '');
    expect(await migration.up({ rootDir })).toEqual({ enabled: false });
    expect(await readMeta()).toEqual({ dailyDigestTime: '07:30' });
  });

  it('never overrides an explicit user choice', async () => {
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ scheduledReviewsEnabled: false }));
    await writeFile(join(dir, 'digests.jsonl'), '{"id":"d1"}\n');
    expect(await migration.up({ rootDir })).toEqual({ enabled: false });
    expect(await readMeta()).toEqual({ scheduledReviewsEnabled: false });
  });
});
