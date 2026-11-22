/**
 * Fails when the rendered model-facing prompt surface (Persistent Mind tool
 * prompt, agent MCP manifest, voice and semantic tool schemas) drifts from the
 * committed snapshot, printing the token/tool delta so a review sees what a
 * description or schema edit costs every turn (#17395).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OUT_DIR, diffSnapshots, readSnapshotDir } from '../../../../scripts/prompt-surface.js';
import { REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const tempRoots = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prompt surface snapshot (#17395)', () => {
  it('matches a fresh deterministic render byte for byte', () => {
    const out = mkdtempSync(join(tmpdir(), 'prompt-surface-guard-'));
    tempRoots.push(out);
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/prompt-surface.js'), 'render', '--out', out], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const committed = readSnapshotDir(DEFAULT_OUT_DIR);
    const fresh = readSnapshotDir(out);
    const drift = Object.keys({ ...committed, ...fresh }).filter((file) => committed[file] !== fresh[file]);
    expect(drift.length === 0 ? [] : [diffSnapshots(committed, fresh), 'Run `npm run prompt-surface:render` and commit the result.'],
      'Prompt surface changed without updating server/test/fixtures/prompt-surface').toEqual([]);
  }, 60_000);

  it('never leaks host paths into the snapshot', () => {
    const text = Object.values(readSnapshotDir(DEFAULT_OUT_DIR)).join('\n');
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/);
  });
});
