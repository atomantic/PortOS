import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  findUnacceptedPromptHistory,
  isShallowRepository,
  inspectShippedPromptHistory,
} from './shippedPromptHistory.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const historyAvailable = !isShallowRepository(repoRoot);

if (!historyAvailable) {
  console.warn(
    '⏭️ Skipping shipped stage-prompt history scan: checkout has shallow git history',
  );
}

describe('shipped stage-prompt history guard', () => {
  it('identifies historical hashes missing from every migration table', () => {
    expect(
      findUnacceptedPromptHistory({
        histories: { 'example.md': [{ hash: 'stranded', commit: 'abc' }] },
        accepted: { 'example.md': ['known-old'] },
        current: { 'example.md': 'current' },
      }),
    ).toEqual([{ file: 'example.md', hash: 'stranded', commit: 'abc' }]);
  });

  it('accepts current and migrated historical hashes', () => {
    expect(
      findUnacceptedPromptHistory({
        histories: {
          'example.md': [{ hash: 'known-old' }, { hash: 'current' }],
        },
        accepted: { 'example.md': ['known-old'] },
        current: { 'example.md': 'current' },
      }),
    ).toEqual([]);
  });

  it.skipIf(!historyAvailable)(
    'checks all shipped stage-prompt history on a full-history checkout',
    async () => {
      const result = await inspectShippedPromptHistory({
        repoRoot,
        migrationsDir: join(repoRoot, 'scripts', 'migrations'),
        stageDir: join(repoRoot, 'data.reference', 'prompts', 'stages'),
      });
      expect(result.stranded).toEqual([]);
    },
  );
});
