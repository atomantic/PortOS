import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Bundle-footprint budget for @scalar/api-reference-react (Dev Tools → API Explorer).
//
// Scalar is lazy-loaded, so it never lands in the initial payload — but it still
// drags an entire second UI framework (Vue 3 + radix-vue + @headlessui/vue) and the
// Vercel AI SDK (via @scalar/agent-chat) into the build. `agent: { disabled: true }`
// in ScalarReference.jsx is a RUNTIME toggle: Rollup cannot tree-shake on it, so the
// agent chat interface is emitted as its own chunk regardless.
//
// Measured 2026-09-02 against a fresh `npm run build --prefix client`:
//   OperationBlock.vue-*.js            2,313,825 B
//   ScalarReference-*.js                 622,286 B
//   AgentScalarChatInterface.vue-*.js    202,239 B
//   ScalarReference-*.css                255,913 B
//   ---------------------------------------------
//   total                              3,394,263 B  (3.24 MB of 13.02 MB of assets)
//
// The budget leaves ~23% headroom for routine minor bumps. A failure is a signal to
// re-measure and decide deliberately — see the `@scalar/api-reference-react` entry in
// docs/DEPS.md — not an invitation to raise the number reflexively.
const SCALAR_BUDGET_BYTES = 4 * 1024 * 1024;

// Vite names these chunks after the module that pulls them in: our own
// ScalarReference entry, plus Scalar's Vue single-file components
// (`OperationBlock.vue-<hash>.js`). The `vue-` half is matched at a name boundary
// rather than only after a dot, so a Vue-runtime or `radix-vue` vendor chunk is
// counted too if Rollup ever splits one out. Nothing else in the client is authored
// in Vue, so anything Vue-named is Scalar-attributable by construction.
const isScalarAsset = (name) => /\.(js|css)$/.test(name)
  && (name.includes('Scalar') || /(^|[.-])vue-/.test(name));

// Anchors the matcher: this chunk is named after
// client/src/components/api-explorer/ScalarReference.jsx, the module ApiExplorer
// lazy-imports. If Vite's naming changes, the matcher would silently find nothing
// and report a 0-byte pass — this assertion fails loudly instead.
const ENTRY_CHUNK = /^ScalarReference-[^/]*\.js$/;

// `import.meta.url` is not usable here: the jsdom environment rewrites it to an http
// URL. Resolve from cwd instead — client/ under `npm test --prefix client`, but the
// repo root when a runner is pointed at the client project from above, so try both
// rather than silently skipping on a build that is present.
const ASSETS_DIR = ['dist/assets', 'client/dist/assets']
  .map((rel) => resolve(process.cwd(), rel))
  .find(existsSync) ?? resolve(process.cwd(), 'dist/assets');

const scalarAssets = () => readdirSync(ASSETS_DIR)
  .filter(isScalarAsset)
  .map((name) => ({ name, bytes: statSync(join(ASSETS_DIR, name)).size }))
  .sort((a, b) => b.bytes - a.bytes);

// Only the CI build job (and a local `npm run build`) produces dist/. The plain unit
// test run has nothing to measure, so skip rather than fail.
const hasBuild = existsSync(ASSETS_DIR);

describe.skipIf(!hasBuild)('API Explorer bundle footprint', () => {
  it('emits the Scalar entry chunk, so the size assertion is not vacuous', () => {
    const names = scalarAssets().map((asset) => asset.name);
    expect(
      names.some((name) => ENTRY_CHUNK.test(name)),
      `no ScalarReference-*.js chunk in ${ASSETS_DIR}. Either the lazy import in `
      + 'ApiExplorer.jsx was renamed/removed, or Vite changed its chunk naming — in '
      + 'both cases isScalarAsset in this test no longer measures anything. Found: '
      + `${names.join(', ') || '(no matching assets)'}`
    ).toBe(true);
  });

  it('keeps @scalar/api-reference-react under its bundle budget', () => {
    const assets = scalarAssets();
    const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const breakdown = assets.map((a) => `${a.name} ${a.bytes}B`).join(', ');
    expect(
      total,
      `Scalar-attributable assets total ${total}B, over the ${SCALAR_BUDGET_BYTES}B `
      + 'budget. Re-measure and decide deliberately before raising it — see the '
      + `@scalar/api-reference-react entry in docs/DEPS.md. Breakdown: ${breakdown}`
    ).toBeLessThanOrEqual(SCALAR_BUDGET_BYTES);
  });
});
