import { describe, it, expect } from 'vitest';
import { extractGatedRepo } from './hfErrors.js';

describe('extractGatedRepo', () => {
  it('pulls the repo from the GatedRepoError prose', () => {
    expect(extractGatedRepo('Access to model black-forest-labs/FLUX.2-klein-base-9B is restricted and you are not in the authorized list.'))
      .toBe('black-forest-labs/FLUX.2-klein-base-9B');
    expect(extractGatedRepo('Access to model meta-llama/Meta-Llama-3.1-8B-Instruct is restricted'))
      .toBe('meta-llama/Meta-Llama-3.1-8B-Instruct');
  });

  it('pulls the repo from the "Cannot access gated repo for url" form', () => {
    expect(extractGatedRepo('Cannot access gated repo for url https://huggingface.co/foo/bar/resolve/main/x.json'))
      .toBe('foo/bar');
  });

  it('tolerates a markdown backtick and strips a trailing .git', () => {
    expect(extractGatedRepo('Access to model `owner/name`')).toBe('owner/name');
    expect(extractGatedRepo('Cannot access gated repo for url https://huggingface.co/owner/name.git/'))
      .toBe('owner/name');
  });

  it('returns null for unrelated text and non-strings', () => {
    expect(extractGatedRepo('some unrelated traceback line')).toBeNull();
    expect(extractGatedRepo()).toBeNull();
    expect(extractGatedRepo(null)).toBeNull();
  });
});
