import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindPrompt,
  mergePersistentMindPrompt,
  normalizePersistentMindPrompt,
  persistentMindPromptSchema,
} from './persistentMindPrompt.js';

describe('persistent mind prompt', () => {
  it('ships a useful default without enabling any runtime work', () => {
    expect(createDefaultPersistentMindPrompt()).toMatchObject({
      schemaVersion: 1,
      identity: expect.stringContaining('Chief of Staff'),
      instructions: expect.stringContaining('user-visible working note'),
    });
  });

  it('preserves intentional clears while defaulting absent fields', () => {
    expect(normalizePersistentMindPrompt({ identity: '' })).toMatchObject({
      identity: '',
      instructions: expect.stringContaining('Keep the conversation useful'),
    });
  });

  it('merges partial edits and rejects unknown API fields', () => {
    const prior = { identity: 'Example identity', instructions: 'Existing instructions' };
    expect(mergePersistentMindPrompt(prior, { instructions: 'Updated' })).toMatchObject({
      identity: 'Example identity', instructions: 'Updated',
    });
    expect(persistentMindPromptSchema.safeParse({ identity: 'ok', extra: true }).success).toBe(false);
  });
});
