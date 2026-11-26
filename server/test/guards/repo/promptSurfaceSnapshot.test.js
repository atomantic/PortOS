/**
 * Fails when the rendered model-facing prompt surface (Persistent Mind tool
 * prompt, agent MCP manifest, voice and semantic tool schemas) drifts from the
 * committed snapshot, printing the token/tool delta so a review sees what a
 * description or schema edit costs every turn (#17395).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_OUT_DIR, diffSnapshots, readSnapshotDir } from '../../../../scripts/prompt-surface.js';
import { REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// The render owns a throwaway PORTOS_DATA_ROOT (NODE_ENV=test, file backend). Vitest's marker would
// make the runtime data-isolation backstop treat that root as live `data/` on a non-worktree checkout.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));

describe('prompt surface snapshot (#17395)', () => {
  it('matches a fresh deterministic render byte for byte', () => {
    // Use a fresh subprocess so runtime imports honor the throwaway data root.
    // Stream the file map back to avoid writing and rereading a scratch tree.
    const render = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/prompt-surface.js'), 'render', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: childEnv,
    });
    expect(render.status, render.stderr).toBe(0);
    const committed = readSnapshotDir(DEFAULT_OUT_DIR);
    const fresh = JSON.parse(render.stdout);
    const drift = Object.keys({ ...committed, ...fresh }).filter((file) => committed[file] !== fresh[file]);
    expect(drift.length === 0 ? [] : [diffSnapshots(committed, fresh), 'Run `npm run prompt-surface:render` and commit the result.'],
      'Prompt surface changed without updating server/test/fixtures/prompt-surface').toEqual([]);
  }, 60_000);

  it('never leaks host paths into the snapshot', () => {
    const text = Object.values(readSnapshotDir(DEFAULT_OUT_DIR)).join('\n');
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users/);
  });
});
