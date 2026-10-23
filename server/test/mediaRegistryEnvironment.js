import { observeTestProcesses } from '../../scripts/lib/testProcessAttribution.js';
import { observeOwnedBrowsers } from './ownedBrowserDiagnostics.js';
import { builtinEnvironments } from 'vitest/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Registry consumers persist during collection, before any test hook runs.
// Vitest skips afterAll for wholly skipped files; environment teardown still
// runs, including after collection failures. Own the fixture at that boundary.
export default {
  ...builtinEnvironments.node,
  name: 'portos-media-registry',
  viteEnvironment: 'ssr',
  async setup(global, options) {
    const node = await builtinEnvironments.node.setup(global, options);
    const disposeProcesses = observeTestProcesses(() => global.__vitest_worker__?.filepath);
    const disposeObservations = observeOwnedBrowsers(() => global.__vitest_worker__?.filepath);
    try {
      const prior = process.env.PORTOS_MEDIA_MODELS_FILE;
      const root = prior ? null : mkdtempSync(join(tmpdir(), 'portos-suite-media-'));
      if (root) process.env.PORTOS_MEDIA_MODELS_FILE = join(root, 'media-models.json');
      return {
        async teardown() {
          try {
            disposeObservations();
            disposeProcesses();
            if (root) {
              if (prior === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
              else process.env.PORTOS_MEDIA_MODELS_FILE = prior;
              rmSync(root, { recursive: true, force: true });
            }
          } finally {
            await node.teardown(global);
          }
        },
      };
    } catch (error) {
      // setup can fail before Vitest receives our teardown owner. Preserve that
      // original error while ending any partial diagnostic subscription.
      disposeObservations();
      disposeProcesses();
      throw error;
    }
  },
};
