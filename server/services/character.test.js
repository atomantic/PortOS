import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory backing for the character.json read/write so the test exercises the
// real read-modify-save path without touching disk.
const store = vi.hoisted(() => ({ value: null }));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test-data' },
  ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(async (_file, fallback) => (store.value ?? fallback)),
  writeFile: vi.fn(),
  // atomicWrite replaced the raw writeFile(JSON.stringify) site (#1837); route
  // it through the mocked fs/promises.writeFile so the in-memory store update
  // (and read-modify-save round-trip) keeps working unchanged.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
}));

// character.js eagerly imports the jira/cos services at module load; stub them
// so the unit under test loads without their dependency graphs.
vi.mock('./jira.js', () => ({}));
vi.mock('./cos.js', () => ({}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (_path, contents) => {
    store.value = JSON.parse(contents);
  }),
}));

import * as characterService from './character.js';

describe('character setAvatar', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', avatarPath: null, xp: 0, level: 1 };
  });

  it('persists avatarPath onto the existing character and returns it', async () => {
    const updated = await characterService.setAvatar('/data/images/avatar.png');

    expect(updated.avatarPath).toBe('/data/images/avatar.png');
    // Other fields are preserved (read-modify-save, not a replace).
    expect(updated.name).toBe('Gandalf');
    expect(updated.class).toBe('Wizard');
    // And it was actually persisted.
    expect(store.value.avatarPath).toBe('/data/images/avatar.png');
  });
});
