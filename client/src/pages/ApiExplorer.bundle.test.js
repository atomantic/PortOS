import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard: @scalar/api-reference-react must stay out of the client graph.
//
// That package owned ~half the client lockfile and ~3.24 MB of dist assets
// (Vue 3 + Vercel AI SDK, including GHSA-866g-f22w-33x8). The REST Reference
// tab now renders a native OpenAPI list. If Scalar is reintroduced, this file
// fails in two ways: the manifest pin (always), and the dist pin (CI after
// `npm run build --prefix client`).
const MANIFEST = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../package.json'),
  'utf8',
));

const isScalarAsset = (name) => {
  if (!/\.(js|css)$/.test(name)) return false;
  // Vite's eight-character content hash can contain hyphens and dependency
  // names: Loops-vue-yDU1.js is a React route, not a Vue chunk.
  const chunkName = name.replace(/(?:-[\w-]{8})?\.(?:js|css)$/, '');
  return chunkName.includes('Scalar') || /(^|[.-])vue(?:[.-]|$)/.test(chunkName);
};

const ASSETS_DIR = ['dist/assets', 'client/dist/assets']
  .map((rel) => resolve(process.cwd(), rel))
  .find(existsSync) ?? resolve(process.cwd(), 'dist/assets');

const hasBuild = existsSync(ASSETS_DIR);

describe('API Explorer Scalar removal', () => {
  it.each([
    ['Scalar-ABCD1234.js', true],
    ['Scalar-ABCD1234.css', true],
    ['vue-ABCD1234.js', true],
    ['vendor-vue-ABCD1234.js', true],
    ['vue.runtime-esm-ABCD1234.js', true],
    ['Loops-vue-yDU1.js', false],
    ['Example-Scalar12.css', false],
    ['Example-ABCD1234.js', false],
  ])('classifies the chunk name separately from its hash: %s', (name, expected) => {
    expect(isScalarAsset(name)).toBe(expected);
  });

  it('does not declare @scalar/api-reference-react on the client manifest', () => {
    const declared = {
      ...MANIFEST.dependencies,
      ...MANIFEST.devDependencies,
      ...MANIFEST.optionalDependencies,
    };
    expect(declared['@scalar/api-reference-react']).toBeUndefined();
  });
});

describe.skipIf(!hasBuild)('API Explorer bundle footprint', () => {
  it('emits no Scalar or Vue dist chunks', () => {
    const names = readdirSync(ASSETS_DIR).filter(isScalarAsset);
    expect(
      names,
      `Scalar/Vue chunks still in ${ASSETS_DIR}: ${names.join(', ') || '(none)'}. `
      + '@scalar/api-reference-react was removed in #7012 — do not reintroduce it.',
    ).toEqual([]);
  });
});
