import { describe, expect, it } from 'vitest';
import { appendSceneTakes } from './takes.js';

const project = () => ({ id: 'mv-1', scenes: [{ sceneId: 's1' }] });

describe('take generation cost (#10157)', () => {
  it('stores a finite quote and its spend kind, and omits both when unpriced or invalid', () => {
    const input = { kind: 'video', source: 'generated' };
    const { appended } = appendSceneTakes(project(), 's1', [
      { ...input, assetId: 'a', costUsd: 0.4, spendKind: 'autoReview' },
      { ...input, assetId: 'b', costUsd: 0.1 },
      { ...input, assetId: 'c', costUsd: null },
      { ...input, assetId: 'd', costUsd: -3, spendKind: 'manual' },
    ]);
    expect(appended[0]).toMatchObject({ costUsd: 0.4, spendKind: 'autoReview' });
    expect(appended[1]).toMatchObject({ costUsd: 0.1, spendKind: 'manual' });
    expect(appended[2]).not.toHaveProperty('costUsd');
    expect(appended[3]).not.toHaveProperty('costUsd');
  });
});
