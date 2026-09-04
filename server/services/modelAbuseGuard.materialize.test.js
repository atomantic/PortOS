import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_REVIEW_INPUT_FILENAME, PUBLIC_REVIEW_PATCH_DIRNAME } from '../lib/agentScratchPaths.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Runs against the real filesystem on purpose: the materializers were only ever
// exercised through mocks, which is how a callback-style `chmod` from `node:fs`
// (throws synchronously when called without a callback) shipped and failed every
// Stage 2 spawn with "The \"cb\" argument must be of type function".
//
// Real filesystem, but not the INSTALL's filesystem: the snapshot writer lands
// under `PATHS.cos`, so without this redirect the suite deposited
// `public-review-inputs/<scanKey>.json` in the developer's live data/ tree —
// swept up by the afterEach only when nothing above it threw (#6176).
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-public-review-data-') }));
afterAll(cleanupTempDataRoots);

const { PATHS } = await import('../lib/fileUtils.js');
const {
  materializePublicReviewInput,
  materializePublicReviewPatches,
  writePublicReviewInputSnapshot,
  PUBLIC_REVIEW_PATCH_MANIFEST_FILENAME,
} = await import('./modelAbuseGuard.js');
const scanKey = 'a'.repeat(64);
const headSha = 'b'.repeat(40);
const pullRequests = [{
  number: 42,
  headSha,
  title: 'docs: example change',
  body: '',
  // Trailing newline already stripped, as the gh wrapper's stdout trim leaves it.
  diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+example',
}];

let workspace;
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  await rm(join(PATHS.cos, 'public-review-inputs', `${scanKey}.json`), { force: true });
});

describe('materializing the screened public-review snapshot', () => {
  it('writes the input file and the patch set read-only into the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'portos-public-review-'));
    expect(await writePublicReviewInputSnapshot({ scanKey, pullRequests })).toBe(true);

    expect(await materializePublicReviewInput({ scanKey, workspacePath: workspace })).toBe(true);
    const input = JSON.parse(await readFile(join(workspace, PUBLIC_REVIEW_INPUT_FILENAME), 'utf8'));
    expect(input.pullRequests.map((pr) => pr.number)).toEqual([42]);
    expect((await stat(join(workspace, PUBLIC_REVIEW_INPUT_FILENAME))).mode & 0o222).toBe(0);

    expect(await materializePublicReviewPatches({ scanKey, workspacePath: workspace, allowedPullRequestNumbers: [42] })).toBe(true);
    const manifest = JSON.parse(await readFile(join(workspace, PUBLIC_REVIEW_PATCH_DIRNAME, PUBLIC_REVIEW_PATCH_MANIFEST_FILENAME), 'utf8'));
    expect(manifest.patches).toEqual([expect.objectContaining({ number: 42, headSha, path: `${PUBLIC_REVIEW_PATCH_DIRNAME}/PR-42.patch` })]);
    // git apply rejects a patch whose last line has no newline ("corrupt patch").
    expect(await readFile(join(workspace, PUBLIC_REVIEW_PATCH_DIRNAME, 'PR-42.patch'), 'utf8')).toBe(`${pullRequests[0].diff}\n`);
    expect((await stat(join(workspace, PUBLIC_REVIEW_PATCH_DIRNAME, 'PR-42.patch'))).mode & 0o222).toBe(0);
  });
});
