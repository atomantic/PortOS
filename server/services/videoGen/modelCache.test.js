import { describe, it, expect, vi, beforeEach } from 'vitest';

// Target-shaping contract for the HF cache engine (issue #5711). These three
// behaviors used to be reachable only by driving /models/status, /models/verify
// and /models/:id/repair, so a regression in how a download target is scoped or
// keyed showed up as a wrong HTTP payload rather than a failing unit.

vi.mock('../../lib/mediaModels.js', () => ({
  repoForModel: vi.fn((m) => m.repo || null),
  getTextEncoderRepo: vi.fn(() => 'org/text-encoder'),
  isHfRepoId: vi.fn(() => true),
}));

vi.mock('../../lib/videoTextEncoders.js', () => ({
  downloadableVideoTextEncoders: vi.fn(() => []),
  downloadableVideoTextEncoder: vi.fn(() => null),
}));

vi.mock('../../lib/videoDraftDecoders.js', () => ({
  downloadableVideoDraftDecoders: vi.fn(() => []),
}));

vi.mock('../../lib/icLoraWeights.js', () => ({
  IC_LORA_MODE_VALUES: ['ic-control'],
  icLoraSpecForMode: vi.fn(() => null),
  icLoraRepos: vi.fn(() => []),
}));

vi.mock('./local.js', () => ({ listVideoModels: vi.fn() }));

import { modelDownloadTargets, targetKey, reposToVerify } from './modelCache.js';
import { listVideoModels } from './local.js';

const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);
const WAN = { id: 'wan_lightning', repo: 'org/wan-base', revision: REV_A };

beforeEach(() => {
  vi.mocked(listVideoModels).mockReturnValue([WAN]);
});

describe('videoGen model cache targets', () => {
  it('scopes an unlisted model repo to a whole-repo snapshot', () => {
    // No `repoFiles` means "snapshot the repo" — an empty `only` is what routes
    // the target to verifyModelCache instead of verifyCachedRepoFiles.
    expect(modelDownloadTargets({ id: 'ltx2', repo: 'org/ltx2' }))
      .toEqual([{ repo: 'org/ltx2', revision: null, only: [] }]);
  });

  it('keeps two same-repo targets that differ only by revision', () => {
    // The unscoped scan dedupes by targetKey. A collision there would drop one
    // pinned revision and let a stale repo report as fresh, so two models on
    // the same repo at different revisions must both survive.
    vi.mocked(listVideoModels).mockReturnValue([WAN, { ...WAN, id: 'wan_pinned', revision: REV_B }]);
    const wan = reposToVerify().filter((t) => t.repo === 'org/wan-base');
    expect(wan.map((t) => t.revision)).toEqual([REV_A, REV_B]);
    // …while an identical pair still collapses to one walk.
    vi.mocked(listVideoModels).mockReturnValue([WAN, { ...WAN, id: 'wan_clone' }]);
    expect(reposToVerify().filter((t) => t.repo === 'org/wan-base')).toHaveLength(1);
    // No revision keys the same as an explicit null one.
    const base = { repo: 'org/wan-base', only: [] };
    expect(targetKey({ ...base, revision: null })).toBe(targetKey(base));
  });

  it('covers the shared text encoder alongside the model repos on an unscoped scan', () => {
    expect(reposToVerify().map((t) => t.repo))
      .toEqual(['org/wan-base', 'org/text-encoder']);
    // Scoped to one model, only that model's repos are walked.
    expect(reposToVerify('wan_lightning').map((t) => t.repo)).toEqual(['org/wan-base']);
    expect(reposToVerify('nope')).toEqual([]);
  });
});
