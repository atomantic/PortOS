import { builtinEnvironments } from 'vitest/runtime';
import { observeTestProcesses } from './lib/testProcessAttribution.js';

// Keep the observer in Node's environment realm: client transforms replace
// import.meta.url with HTTP URLs. Environment teardown also runs for skipped
// suites and failed collection, unlike an afterAll observer cleanup.
export default {
  ...builtinEnvironments['happy-dom'],
  name: 'portos-observed-happy-dom',
  async setup(global, options) {
    const environment = await builtinEnvironments['happy-dom'].setup(global, options);
    const dispose = observeTestProcesses(() => global.__vitest_worker__?.filepath);
    return {
      async teardown() {
        try { dispose(); }
        finally { await environment.teardown(global); }
      },
    };
  },
};
