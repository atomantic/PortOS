/**
 * The `glab` argv contract. One assertion per claim the module's doc makes —
 * the tree-wide enforcement that nobody re-spells the flag lives in
 * `server/lint-glab-list-flags.grit`.
 */

import { describe, it, expect } from 'vitest';
import { GLAB_JSON_ARGS, withGlabJson } from './glabArgs.js';

describe('GLAB_JSON_ARGS', () => {
  it('is the long --output form, never the per-subcommand `-F` shorthand', () => {
    // `-F` is `--output-format` (details|ids|urls) on `glab issue list` and
    // `--output` (text|json) everywhere else, so the shorthand silently returns
    // the human table there. `--output` means text-vs-json on every subcommand.
    expect(GLAB_JSON_ARGS).toEqual(['--output', 'json']);
  });

  it('is frozen — it is shared by every glab invocation in the process', () => {
    expect(Object.isFrozen(GLAB_JSON_ARGS)).toBe(true);
  });
});

describe('withGlabJson', () => {
  it('appends the JSON flag', () => {
    expect(withGlabJson(['issue', 'list', '--per-page', '100']))
      .toEqual(['issue', 'list', '--per-page', '100', '--output', 'json']);
  });

  it("does not mutate the caller's args", () => {
    const args = ['issue', 'list'];
    withGlabJson(args);
    expect(args).toEqual(['issue', 'list']);
  });

  it('returns a fresh array each call, so one call site cannot poison another', () => {
    const a = withGlabJson(['mr', 'list']);
    const b = withGlabJson(['mr', 'list']);
    expect(a).not.toBe(b);
    a.push('--merged');
    expect(b).toEqual(['mr', 'list', '--output', 'json']);
  });
});
